import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../App'
import { db, initializeDatabase, loadProjectFull, resetAllAppData } from '../db/database'
import { normalizeProjectPalette, TRANSPARENT_INDEX } from '../engine/indexedPalette'
import {
  AUTO_PALETTE_COLOR_COUNTS,
  CameraPixelArtProcessor,
  computeAspectSampleMapping,
  computeAutoDitherModulation,
  convertRgbaFrameToPixelArtCpu,
  DEFAULT_CAMERA_TRANSFORM_PARAMS,
  generateAutoPaletteFromRgbaSample,
  precomputePaletteForCamera,
  type MinimalGpuDevice,
  type MinimalGpuLike,
} from '../engine/webgpuCamera'

/**
 * Helper: Build a deterministic mock WebGPU implementation that records resource allocations,
 * shader creation, dispatches, readbacks, and supports triggering `device.lost` + `destroy()`.
 */
function createMockWebGpuHarness(opts?: {
  failAdapter?: boolean
  failDevice?: boolean
}) {
  let createdBuffers = 0
  let destroyedBuffers = 0
  let createdTextures = 0
  let destroyedTextures = 0
  let computeDispatches = 0
  let renderDraws = 0
  let deviceDestroyed = 0
  let triggerLost: ((info: { reason?: string; message?: string }) => void) | null =
    null

  // Simulated index storage written during compute & read back ONLY on capture
  let simulatedIndicesU32 = new Uint32Array(256 * 256).fill(1)

  const makeDevice = (): MinimalGpuDevice => {
    const lostPromise = new Promise<{ reason?: string; message?: string }>(
      (resolve) => {
        triggerLost = resolve
      }
    )

    return {
      lost: lostPromise,
      destroy: () => {
        deviceDestroyed++
      },
      createShaderModule: ({ code }) => {
        expect(code).toContain('@compute')
        expect(code).toContain('csMain')
        expect(code).toContain('fsPresent')
        return { code }
      },
      createBuffer: ({ size }) => {
        createdBuffers++
        return {
          destroy: () => {
            destroyedBuffers++
          },
          mapAsync: async () => {},
          getMappedRange: () =>
            simulatedIndicesU32.buffer.slice(0, Math.max(4, size)),
          unmap: () => {},
        }
      },
      createTexture: () => {
        createdTextures++
        return {
          createView: () => ({}),
          destroy: () => {
            destroyedTextures++
          },
        }
      },
      createSampler: ({ magFilter, minFilter }) => {
        expect(magFilter).toBe('nearest')
        expect(minFilter).toBe('nearest')
        return {}
      },
      createComputePipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createRenderPipeline: () => ({
        getBindGroupLayout: () => ({}),
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          dispatchWorkgroups: () => {
            computeDispatches++
          },
          end: () => {},
        }),
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          draw: () => {
            renderDraws++
          },
          end: () => {},
        }),
        copyBufferToBuffer: () => {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: () => {},
        writeTexture: () => {},
        submit: () => {},
      },
    }
  }

  const gpu: MinimalGpuLike = {
    getPreferredCanvasFormat: () => 'bgra8unorm',
    requestAdapter: async () => {
      if (opts?.failAdapter) return null
      return {
        requestDevice: async () => {
          if (opts?.failDevice) {
            throw new Error('Simulated requestDevice failure')
          }
          return makeDevice()
        },
      }
    },
  }

  return {
    gpu,
    getStats: () => ({
      createdBuffers,
      destroyedBuffers,
      createdTextures,
      destroyedTextures,
      computeDispatches,
      renderDraws,
      deviceDestroyed,
    }),
    setSimulatedCaptureIndex: (val: number) => {
      simulatedIndicesU32.fill(val & 0xff)
    },
    fireDeviceLost: (message = 'Simulated GPU device lost') => {
      triggerLost?.({ reason: 'unknown', message })
    },
  }
}

function makeTestGradientRgba(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4
      buf[off] = Math.round((x / Math.max(1, width - 1)) * 255)
      buf[off + 1] = Math.round((y / Math.max(1, height - 1)) * 255)
      buf[off + 2] = Math.round(((x + y) / Math.max(1, width + height - 2)) * 255)
      buf[off + 3] = 255
    }
  }
  return buf
}

describe('Stage 2 (feature/webgpu): Real-Time WebGPU Camera Pixel Art Studio, Palette Lock, Adaptive Dithering & Canvas 2D Fallback', () => {
  const originalGetUserMedia = navigator.mediaDevices?.getUserMedia
  const originalGetContext = HTMLCanvasElement.prototype.getContext

  beforeEach(async () => {
    window.history.pushState({}, '', '/')
    await resetAllAppData(db)
    await initializeDatabase(db)
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    if (navigator.mediaDevices && originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = originalGetUserMedia
    }
    HTMLCanvasElement.prototype.getContext = originalGetContext
    await new Promise((r) => setTimeout(r, 25))
  })

  it('generates perceptual auto-palettes for 8..255 colors, maps strictly to fixed palette indices, and keeps deterministic temporal dither stability', () => {
    const sample = makeTestGradientRgba(64, 64)

    for (const targetCount of AUTO_PALETTE_COLOR_COUNTS) {
      const autoPal = generateAutoPaletteFromRgbaSample(
        sample,
        64,
        64,
        targetCount
      )
      expect(autoPal.colors.length).toBeLessThanOrEqual(targetCount)
      expect(autoPal.colors.length).toBeGreaterThanOrEqual(2)
      expect(autoPal.colors.length).toBeLessThanOrEqual(255)
    }

    // Verify fixed 4-color palette mapping & temporal determinism (same input -> identical output across frames)
    const pal4 = normalizeProjectPalette({
      name: 'GameBoy Lavender',
      colors: ['#1F1926', '#5E4B78', '#A892C8', '#F4EFFA'],
    })
    const pre = precomputePaletteForCamera(pal4)
    const validFixedSet = new Set(pal4.displayOrder!)

    const crispRes1 = convertRgbaFrameToPixelArtCpu(
      sample,
      64,
      64,
      {
        ...DEFAULT_CAMERA_TRANSFORM_PARAMS,
        canvasWidth: 32,
        canvasHeight: 32,
        finishMode: 'crisp',
      },
      pre
    )
    const crispRes2 = convertRgbaFrameToPixelArtCpu(
      sample,
      64,
      64,
      {
        ...DEFAULT_CAMERA_TRANSFORM_PARAMS,
        canvasWidth: 32,
        canvasHeight: 32,
        finishMode: 'crisp',
      },
      pre
    )
    expect(Array.from(crispRes1.indexedData)).toEqual(
      Array.from(crispRes2.indexedData)
    )
    for (const idx of crispRes1.indexedData) {
      expect(validFixedSet.has(idx)).toBe(true)
    }

    // Verify Retro (ordered Bayer) vs Crisp produces tonal dither transitions while staying 100% temporally stable!
    const retroRes1 = convertRgbaFrameToPixelArtCpu(
      sample,
      64,
      64,
      {
        ...DEFAULT_CAMERA_TRANSFORM_PARAMS,
        canvasWidth: 32,
        canvasHeight: 32,
        finishMode: 'retro',
        bayerSize: 4,
      },
      pre
    )
    const retroRes2 = convertRgbaFrameToPixelArtCpu(
      sample,
      64,
      64,
      {
        ...DEFAULT_CAMERA_TRANSFORM_PARAMS,
        canvasWidth: 32,
        canvasHeight: 32,
        finishMode: 'retro',
        bayerSize: 4,
      },
      pre
    )
    expect(Array.from(retroRes1.indexedData)).toEqual(
      Array.from(retroRes2.indexedData)
    )
    // Retro dithering differs from flat crisp quantization on smooth gradients
    let diffCount = 0
    for (let i = 0; i < retroRes1.indexedData.length; i++) {
      if (retroRes1.indexedData[i] !== crispRes1.indexedData[i]) diffCount++
    }
    expect(diffCount).toBeGreaterThan(0)

    // Verify 'auto' ("おまかせ") suppresses dithering in deep shadows / bright highlights / exact matches, and activates in midtones with error
    expect(computeAutoDitherModulation(2, 20)).toBe(0) // very dark -> 0
    expect(computeAutoDitherModulation(98, 20)).toBe(0) // very bright -> 0
    const midExact = computeAutoDitherModulation(50, 1.0)
    const midHighError = computeAutoDitherModulation(50, 22.0)
    expect(midHighError).toBeGreaterThan(midExact * 3)
  })

  it('preserves aspect ratio without stretching in both contain (transparent letterbox) and cover (crop pan) modes', () => {
    // 16:9 wide source (160x90) onto 32x32 square canvas
    const wideRgba = new Uint8ClampedArray(160 * 90 * 4)
    for (let y = 0; y < 90; y++) {
      for (let x = 0; x < 160; x++) {
        const off = (y * 160 + x) * 4
        // Left half Red, Right half Blue
        wideRgba[off] = x < 80 ? 230 : 30
        wideRgba[off + 1] = 40
        wideRgba[off + 2] = x < 80 ? 40 : 230
        wideRgba[off + 3] = 255
      }
    }

    const pal = precomputePaletteForCamera(
      normalizeProjectPalette({
        name: 'RB',
        colors: ['#E62828', '#1E28E6'],
      })
    )

    // Contain mode: top row (y=0) and bottom row (y=31) must be letterboxed to TRANSPARENT_INDEX (255), center (16,16) opaque!
    const containRes = convertRgbaFrameToPixelArtCpu(
      wideRgba,
      160,
      90,
      {
        ...DEFAULT_CAMERA_TRANSFORM_PARAMS,
        canvasWidth: 32,
        canvasHeight: 32,
        fitMode: 'contain',
        finishMode: 'crisp',
      },
      pal
    )
    expect(containRes.indexedData[0]).toBe(TRANSPARENT_INDEX)
    expect(containRes.indexedData[31 * 32 + 16]).toBe(TRANSPARENT_INDEX)
    expect(containRes.indexedData[16 * 32 + 8]).toBe(0) // Red on left
    expect(containRes.indexedData[16 * 32 + 24]).toBe(1) // Blue on right

    // Cover mode with cropPanX = -1 (panned all the way left) vs +1 (panned all the way right)
    const mapLeft = computeAspectSampleMapping(160, 90, 32, 32, 'cover', -1, 0)
    const mapRight = computeAspectSampleMapping(160, 90, 32, 32, 'cover', 1, 0)
    expect(mapLeft.offsetX).toBeCloseTo(0, 5)
    expect(mapRight.offsetX).toBeGreaterThan(0.4)
  })

  it('runs WebGPU compute+present pipeline reusing GPU buffers across frames, recovers from GPU device loss, and falls back honestly to Canvas 2D when Adapter/Device fails', async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32

    // Mock `canvas.getContext('webgpu')` for the WebGPU path
    const origGetCtx = canvas.getContext.bind(canvas)
    vi.spyOn(canvas, 'getContext').mockImplementation(((contextId: string, opts?: unknown) => {
      if (contextId === 'webgpu') {
        return {
          configure: () => {},
          unconfigure: () => {},
          getCurrentTexture: () => ({ createView: () => ({}) }),
        } as unknown as RenderingContext
      }
      return origGetCtx(contextId as '2d', opts as CanvasRenderingContext2DSettings)
    }) as typeof canvas.getContext)

    const harness = createMockWebGpuHarness()
    harness.setSimulatedCaptureIndex(2)

    const proc = new CameraPixelArtProcessor({ gpu: harness.gpu })
    const status = await proc.initialize(canvas)
    expect(status.backend).toBe('webgpu')
    expect(status.fallbackReason).toBeNull()

    const pal = normalizeProjectPalette({
      name: 'Test3',
      colors: ['#111111', '#777777', '#EEEEEE'],
    })
    proc.setPalette(pal)

    const src = makeTestGradientRgba(64, 64)
    const params = {
      ...DEFAULT_CAMERA_TRANSFORM_PARAMS,
      canvasWidth: 32,
      canvasHeight: 32,
    }

    // Render 10 consecutive frames at same dimensions -> textures & buffers MUST be allocated only ONCE (zero per-frame memory churn!)
    for (let f = 0; f < 10; f++) {
      proc.renderFrameFromRgba(src, 64, 64, params)
    }
    const statsAfter10 = harness.getStats()
    expect(statsAfter10.computeDispatches).toBe(10)
    expect(statsAfter10.renderDraws).toBe(10)
    expect(statsAfter10.createdTextures).toBe(2) // 1 srcTexture + 1 previewTexture reused across all 10 frames!

    // Capture reads back simulated GPU index (2)
    const captured = await proc.captureCurrentIndexedFrame(src, 64, 64, params)
    expect(captured.width).toBe(32)
    expect(captured.height).toBe(32)
    expect(captured.indexedData[0]).toBe(2)

    // Simulate asynchronous GPU Device Loss -> processor recovers automatically!
    harness.fireDeviceLost('Simulated iOS background reset')
    await new Promise((r) => setTimeout(r, 30))
    expect(proc.getStatus().deviceLostRecoveries).toBe(1)
    expect(proc.getStatus().backend).toBe('webgpu')

    // Dispose frees GPU textures, buffers, and device cleanly
    proc.dispose()
    expect(harness.getStats().deviceDestroyed).toBeGreaterThanOrEqual(1)

    // Verify Adapter failure -> honest Canvas 2D fallback (`backend === 'canvas2d'`)
    const failAdapterHarness = createMockWebGpuHarness({ failAdapter: true })
    const fallbackCanvas = document.createElement('canvas')
    const procFallback = new CameraPixelArtProcessor({
      gpu: failAdapterHarness.gpu,
    })
    const fbStatus = await procFallback.initialize(fallbackCanvas)
    expect(fbStatus.backend).toBe('canvas2d')
    expect(fbStatus.fallbackReason).toContain('GPUAdapter')
    procFallback.setPalette(pal)
    const fbCapture = await procFallback.captureCurrentIndexedFrame(
      src,
      64,
      64,
      params
    )
    expect(fbCapture.indexedData.length).toBe(32 * 32)
    procFallback.dispose()

    // Verify Device failure -> honest Canvas 2D fallback
    const failDeviceHarness = createMockWebGpuHarness({ failDevice: true })
    const procDevFail = new CameraPixelArtProcessor({
      gpu: failDeviceHarness.gpu,
    })
    const devFailStatus = await procDevFail.initialize(
      document.createElement('canvas')
    )
    expect(devFailStatus.backend).toBe('canvas2d')
    procDevFail.dispose()
  })

  it('integrates cleanly in Gallery without cluttering Editor UI, handles camera permission/stop, locks auto-palette, and saves a 1-frame indexed-v1 artwork editable in Editor', async () => {
    let stopCalls = 0
    const mockTrack = {
      kind: 'video',
      stop: () => {
        stopCalls++
      },
    } as unknown as MediaStreamTrack

    const mockStream = {
      getTracks: () => [mockTrack],
    } as unknown as MediaStream

    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        writable: true,
        value: {},
      })
    }

    let getUserMediaCalls = 0
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      getUserMediaCalls++
      return mockStream
    })

    // Ensure offscreen sampling from hidden `<video>` returns a valid colorful frame in JSDOM
    vi.spyOn(
      CameraPixelArtProcessor.prototype,
      'extractBoundedRgbaFromVideo'
    ).mockImplementation(() => ({
      rgba: makeTestGradientRgba(64, 64),
      width: 64,
      height: 64,
    }))

    render(<App />)

    // Verify getUserMedia is NEVER called before explicit user action!
    const openCameraBtn = await screen.findByTestId('gallery-camera-capture-btn')
    expect(openCameraBtn.textContent).toContain('カメラから取り込む')
    fireEvent.click(openCameraBtn)

    await screen.findByTestId('camera-capture-modal')
    expect(getUserMediaCalls).toBe(0)
    // Settings overlay AND advanced panel are collapsed by default so the large camera viewfinder dominates!
    expect(screen.queryByTestId('camera-settings-overlay')).toBeNull()
    expect(screen.queryByTestId('camera-advanced-panel')).toBeNull()
    expect(screen.getByTestId('camera-preview-stage').className).toContain('h-[56dvh]')

    // Open translucent collapsible Settings overlay (`camera-settings-toggle-btn`) -> configure 32x32, Auto Palette (16 colors), Retro mode while live canvas stays mounted behind backdrop
    fireEvent.click(screen.getByTestId('camera-settings-toggle-btn'))
    expect(await screen.findByTestId('camera-settings-overlay')).toBeTruthy()
    expect(screen.getByTestId('camera-settings-backdrop').className).toContain('bg-black/35')
    expect(screen.getByTestId('camera-preview-canvas')).toBeTruthy()

    fireEvent.click(screen.getByTestId('camera-size-preset-32x32'))
    fireEvent.click(screen.getByTestId('camera-palette-mode-auto'))
    fireEvent.click(screen.getByTestId('camera-auto-count-16'))
    fireEvent.click(screen.getByTestId('camera-finish-retro'))

    // Collapse settings back down via 1-tap collapse button so full viewfinder is unobstructed!
    fireEvent.click(screen.getByTestId('camera-settings-collapse-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('camera-settings-overlay')).toBeNull()
    })

    // Explicitly press Start Camera -> requests getUserMedia & locks auto-palette
    fireEvent.click(screen.getByTestId('camera-start-btn'))

    const shutterBtn = await screen.findByTestId('camera-shutter-btn')
    expect(shutterBtn.className).toContain('min-h-[64px]')
    expect(getUserMediaCalls).toBe(1)
    expect(await screen.findByTestId('camera-palette-locked-badge')).toBeTruthy()
    // In JSDOM (no native WebGPU), honest Canvas 2D fallback badge is displayed
    expect(screen.getByTestId('camera-backend-badge').getAttribute('data-backend')).toBe(
      'canvas2d'
    )

    // Press Capture -> stops MediaStreamTrack immediately, saves 1-frame 32x32 `indexed-v1` artwork, and transitions to `/editor/:id`!
    fireEvent.click(shutterBtn)

    await screen.findByTestId('workspace-tab-tools')
    expect(stopCalls).toBeGreaterThanOrEqual(1)

    // Verify normal Editor screen has ZERO camera UI clutter!
    expect(screen.queryByTestId('camera-capture-modal')).toBeNull()
    expect(screen.queryByTestId('camera-shutter-btn')).toBeNull()

    // Verify saved project in IndexedDB is a standard 1-frame `indexed-v1` artwork with <=16 colors and can be drawn on normally
    const projects = await db.projects.toArray()
    expect(projects.length).toBe(1)
    const saved = projects[0]!
    expect(saved.width).toBe(32)
    expect(saved.height).toBe(32)
    expect(saved.pixelFormat).toBe('indexed-v1')
    expect(saved.palette.colors.length).toBeLessThanOrEqual(16)

    const full = (await loadProjectFull(saved.id, db))!
    expect(full.timeline.frames.length).toBe(1)
    expect(full.layers[0]!.data).toBeInstanceOf(Uint8Array)
    expect(full.layers[0]!.data.length).toBe(32 * 32)
  }, 20000)

  it('displays clear error message without crashing when camera permission is denied', async () => {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        writable: true,
        value: {},
      })
    }
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      const err = new Error('Permission denied')
      err.name = 'NotAllowedError'
      throw err
    })

    render(<App />)

    fireEvent.click(await screen.findByTestId('gallery-camera-capture-btn'))
    fireEvent.click(await screen.findByTestId('camera-start-btn'))

    const errBanner = await screen.findByTestId('camera-error-banner')
    expect(errBanner.textContent).toContain('拒否')
    // App remains interactive and zero incomplete projects were saved
    expect(await db.projects.count()).toBe(0)
  })
})
