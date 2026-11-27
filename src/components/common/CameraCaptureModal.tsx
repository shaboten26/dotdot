import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { PaletteData, ProjectPalette, ProjectRecord } from '../../types'
import { createImportedProject, generateId } from '../../db/database'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../../engine/pixelBuffer'
import { normalizeProjectPalette } from '../../engine/indexedPalette'
import {
  AUTO_PALETTE_COLOR_COUNTS,
  CAMERA_SIZE_PRESETS,
  CameraPixelArtProcessor,
  DEFAULT_CAMERA_TRANSFORM_PARAMS,
  generateAutoPaletteFromRgbaSample,
  stopMediaStreamTracks,
  type AutoPaletteColorCount,
  type CameraBayeMatrixSize,
  type CameraEngineStatus,
  type CameraFinishMode,
  type CameraFitMode,
  type CameraTransformParams,
  type MinimalGpuLike,
} from '../../engine/webgpuCamera'
import { Modal } from './Modal'
import { PixelIcon } from './PixelIcon'
import { PixelSelect } from './PixelSelect'
import { PixelSlider } from './PixelSlider'
import { PixelCheckbox } from './PixelCheckbox'
import { CanvasSizePresetsPicker } from './CanvasSizePresetsPicker'
import { getCheckerboardStyle } from './PixelThumbnail'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

export interface CameraCaptureModalProps {
  open: boolean
  onClose: () => void
  palettes: readonly PaletteData[]
  checkerDark?: boolean
  onCreatedProject?: (project: ProjectRecord) => void
  onError?: (msg: string) => void
  /** Optional dependency injection for unit/UI testing of WebGPU vs Canvas2D fallback */
  gpuOverride?: MinimalGpuLike | null
}

type PaletteSourceMode = 'library' | 'auto'

export function CameraCaptureModal({
  open,
  onClose,
  palettes,
  checkerDark = false,
  onCreatedProject,
  onError,
  gpuOverride,
}: CameraCaptureModalProps) {
  const { t } = useI18n()
  const { reducedMotion } = useApp()

  // Simple top-level state
  const [artworkName, setArtworkName] = useState('')
  const [canvasWidth, setCanvasWidth] = useState<number>(64)
  const [canvasHeight, setCanvasHeight] = useState<number>(64)
  const [paletteSource, setPaletteSource] = useState<PaletteSourceMode>('library')
  const [selectedPaletteId, setSelectedPaletteId] = useState<string>(
    () => palettes[0]?.id ?? ''
  )
  const [autoColorCount, setAutoColorCount] = useState<AutoPaletteColorCount>(16)
  const [lockedAutoPalette, setLockedAutoPalette] = useState<ProjectPalette | null>(
    null
  )
  const [finishMode, setFinishMode] = useState<CameraFinishMode>('auto')

  // Collapsible translucent settings overlay over the live viewfinder!
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [fitMode, setFitMode] = useState<CameraFitMode>(
    DEFAULT_CAMERA_TRANSFORM_PARAMS.fitMode
  )
  const [cropPanX, setCropPanX] = useState<number>(0)
  const [cropPanY, setCropPanY] = useState<number>(0)
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    'environment'
  )
  const [mirrorX, setMirrorX] = useState<boolean>(false)
  const [bayerSize, setBayerSize] = useState<CameraBayeMatrixSize>(4)
  const [ditherStrength, setDitherStrength] = useState<number>(100) // % (0..200)
  const [brightnessPct, setBrightnessPct] = useState<number>(0) // -40..+40
  const [contrastPct, setContrastPct] = useState<number>(100) // 50..180
  const [saturationPct, setSaturationPct] = useState<number>(100) // 0..200

  // Camera & GPU runtime state
  const [cameraActive, setCameraActive] = useState(false)
  const [startingCamera, setStartingCamera] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [engineStatus, setEngineStatus] = useState<CameraEngineStatus | null>(
    null
  )

  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<CameraPixelArtProcessor | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastFrameTimeRef = useRef<number>(0)
  const slowFrameStreakRef = useRef<number>(0)
  const dynamicIntervalMsRef = useRef<number>(1000 / 30)
  const autoPaletteSampledForCountRef = useRef<number | null>(null)

  const activeLibraryPalette = useMemo((): ProjectPalette => {
    const found =
      palettes.find((p) => p.id === selectedPaletteId) ?? palettes[0]
    return normalizeProjectPalette({
      name: found?.name ?? 'Standard',
      colors: found ? [...found.colors] : ['#1F1926', '#F3EDF7'],
      sourcePaletteId: found?.id,
      author: found?.author,
      sourceUrl: found?.sourceUrl,
    })
  }, [palettes, selectedPaletteId])

  const effectivePalette = useMemo((): ProjectPalette => {
    if (paletteSource === 'auto' && lockedAutoPalette) {
      return lockedAutoPalette
    }
    return activeLibraryPalette
  }, [paletteSource, lockedAutoPalette, activeLibraryPalette])

  const transformParams = useMemo(
    (): CameraTransformParams => ({
      canvasWidth: Math.max(
        MIN_CANVAS_SIZE,
        Math.min(MAX_CANVAS_SIZE, Math.round(canvasWidth || 64))
      ),
      canvasHeight: Math.max(
        MIN_CANVAS_SIZE,
        Math.min(MAX_CANVAS_SIZE, Math.round(canvasHeight || 64))
      ),
      fitMode,
      cropPanX: cropPanX / 100,
      cropPanY: cropPanY / 100,
      mirrorX,
      finishMode,
      bayerSize,
      ditherStrength: ditherStrength / 100,
      brightness: brightnessPct / 100,
      contrast: contrastPct / 100,
      saturation: saturationPct / 100,
    }),
    [
      canvasWidth,
      canvasHeight,
      fitMode,
      cropPanX,
      cropPanY,
      mirrorX,
      finishMode,
      bayerSize,
      ditherStrength,
      brightnessPct,
      contrastPct,
      saturationPct,
    ]
  )

  const transformParamsRef = useRef<CameraTransformParams>(transformParams)
  transformParamsRef.current = transformParams

  const stopCameraAndLoop = useCallback((disposeGpu: boolean) => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (streamRef.current) {
      stopMediaStreamTracks(streamRef.current)
      streamRef.current = null
    }
    if (videoRef.current) {
      try {
        videoRef.current.pause()
        videoRef.current.srcObject = null
      } catch {
        // ignore detached video cleanup errors
      }
    }
    setCameraActive(false)
    if (disposeGpu && processorRef.current) {
      processorRef.current.dispose()
      processorRef.current = null
      setEngineStatus(null)
    }
  }, [])

  // Reset modal cleanly on open, and ALWAYS stop tracks + free GPU on close/unmount
  useEffect(() => {
    if (open) {
      setSelectedPaletteId((prev) => prev || palettes[0]?.id || '')
      setCameraError(null)
      setCapturing(false)
      setStartingCamera(false)
      setSettingsOpen(false)
      setAdvancedOpen(false)
    } else {
      stopCameraAndLoop(true)
    }
    return () => {
      stopCameraAndLoop(true)
    }
  }, [open, palettes, stopCameraAndLoop])

  // Pause/stop camera & GPU loop immediately if page goes to background (critical on iPhone Safari / Home-Screen PWA)
  useEffect(() => {
    if (!open) return
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && streamRef.current) {
        stopCameraAndLoop(true)
      }
    }
    const handlePageHide = () => {
      stopCameraAndLoop(true)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [open, stopCameraAndLoop])

  // Sync palette into GPU/CPU processor whenever user switches palette or regenerates auto-palette
  useEffect(() => {
    if (processorRef.current) {
      processorRef.current.setPalette(effectivePalette)
    }
  }, [effectivePalette])

  const regenerateAutoPaletteNow = useCallback(
    (explicitCount?: AutoPaletteColorCount) => {
      const targetCount = explicitCount ?? autoColorCount
      const proc = processorRef.current
      const vid = videoRef.current
      if (!proc || !vid) return false
      const sampled = proc.extractBoundedRgbaFromVideo(vid, 256)
      if (!sampled) return false

      const generated = generateAutoPaletteFromRgbaSample(
        sampled.rgba,
        sampled.width,
        sampled.height,
        targetCount,
        transformParamsRef.current,
        `Camera Auto ${targetCount}`
      )
      setLockedAutoPalette(generated)
      autoPaletteSampledForCountRef.current = targetCount
      proc.setPalette(generated)
      return true
    },
    [autoColorCount]
  )

  // If user switches to `'auto'` palette mode or changes `autoColorCount` while camera is live,
  // generate once for that count and lock it immediately (never per-frame!)
  useEffect(() => {
    if (!cameraActive || paletteSource !== 'auto') return
    if (
      autoPaletteSampledForCountRef.current === autoColorCount &&
      lockedAutoPalette
    ) {
      return
    }
    regenerateAutoPaletteNow(autoColorCount)
  }, [
    cameraActive,
    paletteSource,
    autoColorCount,
    lockedAutoPalette,
    regenerateAutoPaletteNow,
  ])

  const startRenderLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
    }
    lastFrameTimeRef.current = 0
    slowFrameStreakRef.current = 0

    const status = processorRef.current?.getStatus()
    dynamicIntervalMsRef.current =
      status?.backend === 'webgpu' ? 1000 / 30 : 1000 / 18

    const tick = (now: number) => {
      const proc = processorRef.current
      const vid = videoRef.current
      if (!proc || !vid || !streamRef.current) {
        rafRef.current = null
        return
      }

      if (now - lastFrameTimeRef.current >= dynamicIntervalMsRef.current) {
        const t0 = performance.now()
        lastFrameTimeRef.current = now

        if (
          paletteSource === 'auto' &&
          autoPaletteSampledForCountRef.current !== autoColorCount
        ) {
          regenerateAutoPaletteNow(autoColorCount)
        }

        proc.renderVideoFrame(vid, transformParamsRef.current)
        const elapsed = performance.now() - t0

        // Adaptive FPS throttling: drop smoothly to ~16fps if frame work exceeds budget
        if (elapsed > 24) {
          slowFrameStreakRef.current = Math.min(
            10,
            slowFrameStreakRef.current + 1
          )
          if (slowFrameStreakRef.current >= 3) {
            dynamicIntervalMsRef.current = 1000 / 16
          }
        } else if (elapsed < 10 && slowFrameStreakRef.current > 0) {
          slowFrameStreakRef.current--
          if (slowFrameStreakRef.current === 0) {
            dynamicIntervalMsRef.current =
              proc.getStatus().backend === 'webgpu' ? 1000 / 30 : 1000 / 18
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [paletteSource, autoColorCount, regenerateAutoPaletteNow])

  const startCameraWithFacing = useCallback(
    async (requestedFacing: 'environment' | 'user') => {
      if (startingCamera) return
      setCameraError(null)

      const isLocalhost =
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1')
      if (
        typeof window !== 'undefined' &&
        window.isSecureContext === false &&
        !isLocalhost
      ) {
        const msg = t('cameraErrInsecureContext')
        setCameraError(msg)
        onError?.(msg)
        return
      }

      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        const msg = t('cameraErrNotFound')
        setCameraError(msg)
        onError?.(msg)
        return
      }

      setStartingCamera(true)
      stopCameraAndLoop(false)

      try {
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: requestedFacing },
              width: { ideal: 640 },
              height: { ideal: 640 },
            },
          })
        } catch (firstErr) {
          const errName = (firstErr as { name?: string })?.name ?? ''
          if (
            errName === 'OverconstrainedError' ||
            errName === 'ConstraintNotSatisfiedError'
          ) {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: true,
            })
          } else {
            throw firstErr
          }
        }

        streamRef.current = stream

        const vid = videoRef.current
        if (vid) {
          vid.srcObject = stream
          vid.setAttribute('playsinline', 'true')
          vid.muted = true
          try {
            await vid.play()
          } catch {
            // In test / headless environments `play()` may reject benignly
          }
        }

        if (!processorRef.current && displayCanvasRef.current) {
          const proc = new CameraPixelArtProcessor({
            ...(gpuOverride !== undefined ? { gpu: gpuOverride } : {}),
            onStatusChange: (st) => setEngineStatus(st),
          })
          processorRef.current = proc
          const st = await proc.initialize(displayCanvasRef.current)
          setEngineStatus(st)
          proc.setPalette(effectivePalette)
        } else if (processorRef.current) {
          processorRef.current.setPalette(effectivePalette)
        }

        if (paletteSource === 'auto' && videoRef.current && processorRef.current) {
          const sampled = processorRef.current.extractBoundedRgbaFromVideo(
            videoRef.current,
            256
          )
          if (sampled) {
            const generated = generateAutoPaletteFromRgbaSample(
              sampled.rgba,
              sampled.width,
              sampled.height,
              autoColorCount,
              transformParamsRef.current,
              `Camera Auto ${autoColorCount}`
            )
            setLockedAutoPalette(generated)
            autoPaletteSampledForCountRef.current = autoColorCount
            processorRef.current.setPalette(generated)
          }
        }

        if (videoRef.current && processorRef.current) {
          processorRef.current.renderVideoFrame(
            videoRef.current,
            transformParamsRef.current
          )
        }

        setCameraActive(true)
        startRenderLoop()
      } catch (err) {
        stopCameraAndLoop(false)
        const name = (err as { name?: string })?.name ?? ''
        let friendly = t('cameraErrGeneric')
        if (
          name === 'NotAllowedError' ||
          name === 'PermissionDeniedError' ||
          name === 'SecurityError'
        ) {
          friendly = t('cameraErrPermissionDenied')
        } else if (
          name === 'NotFoundError' ||
          name === 'DevicesNotFoundError'
        ) {
          friendly = t('cameraErrNotFound')
        } else if (
          name === 'NotReadableError' ||
          name === 'TrackStartError'
        ) {
          friendly = t('cameraErrInUse')
        }
        setCameraError(friendly)
        onError?.(friendly)
      } finally {
        setStartingCamera(false)
      }
    },
    [
      startingCamera,
      t,
      onError,
      stopCameraAndLoop,
      gpuOverride,
      effectivePalette,
      paletteSource,
      autoColorCount,
      startRenderLoop,
    ]
  )

  const handleToggleFacing = async () => {
    const nextFacing = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(nextFacing)
    setMirrorX(nextFacing === 'user')
    if (cameraActive) {
      await startCameraWithFacing(nextFacing)
    }
  }

  const handleCaptureArtwork = async () => {
    const proc = processorRef.current
    const vid = videoRef.current
    if (!proc || !cameraActive || capturing) return

    setCapturing(true)
    setCameraError(null)
    try {
      const sampled = vid
        ? proc.extractBoundedRgbaFromVideo(
            vid,
            proc.getStatus().backend === 'webgpu' ? 512 : 256
          )
        : null

      const captured = await proc.captureCurrentIndexedFrame(
        sampled?.rgba ?? null,
        sampled?.width ?? 0,
        sampled?.height ?? 0,
        transformParamsRef.current
      )

      const layerId = generateId('layer')
      const title =
        artworkName.trim() ||
        `${t('cameraDefaultArtworkName')} ${captured.width}×${captured.height}`

      const created = await createImportedProject({
        name: title.slice(0, 48),
        width: captured.width,
        height: captured.height,
        layers: [
          {
            id: layerId,
            name: 'Layer 1',
            visible: true,
            locked: false,
            opacity: 100,
            blendMode: 'normal',
            clipping: false,
            offsetX: 0,
            offsetY: 0,
            dataWidth: captured.width,
            dataHeight: captured.height,
            data: captured.indexedData,
          },
        ],
        activeLayerId: layerId,
        palette: captured.palette,
      })

      stopCameraAndLoop(true)
      onCreatedProject?.(created)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('cameraErrGeneric')
      setCameraError(msg)
      onError?.(msg)
    } finally {
      setCapturing(false)
    }
  }

  const paletteSelectOptions = useMemo(
    () =>
      palettes.map((p) => ({
        value: p.id,
        label: `${p.name} (${p.colors.length})`,
      })),
    [palettes]
  )

  return (
    <Modal
      open={open}
      title={t('cameraStudioTitle')}
      onClose={() => {
        stopCameraAndLoop(true)
        onClose()
      }}
      maxWidthClass="max-w-2xl"
    >
      <div className="space-y-2.5" data-testid="camera-capture-modal">
        {/* Hidden native video sink (iOS Safari PWA `playsInline` + `muted` compatible) */}
        <video
          ref={videoRef}
          playsInline
          muted
          className="hidden"
          data-testid="camera-hidden-video"
        />

        {/* ==================== LARGE CAMERA-APP VIEWFINDER STAGE ==================== */}
        <div
          style={getCheckerboardStyle(checkerDark, 12)}
          className="relative w-full h-[56dvh] sm:h-[62dvh] min-h-[300px] max-h-[600px] border-2 border-[var(--border-pixel)] bg-[var(--canvas-well)] p-2 flex items-center justify-center overflow-hidden"
          data-testid="camera-preview-stage"
        >
          <canvas
            ref={displayCanvasRef}
            width={transformParams.canvasWidth}
            height={transformParams.canvasHeight}
            className="max-w-full max-h-full object-contain pixelated border border-[var(--border-subtle)]"
            style={{
              imageRendering: 'pixelated',
              aspectRatio: `${transformParams.canvasWidth} / ${transformParams.canvasHeight}`,
              width:
                transformParams.canvasWidth >= transformParams.canvasHeight
                  ? '100%'
                  : 'auto',
              height:
                transformParams.canvasHeight > transformParams.canvasWidth
                  ? '100%'
                  : 'auto',
            }}
            data-testid="camera-preview-canvas"
          />

          {/* Top Status Pills (Size / Palette / Honest Backend Badge) */}
          <div className="absolute inset-x-2 top-2 z-10 flex flex-wrap items-center justify-between gap-1.5 pointer-events-none">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="px-2 py-0.5 bg-[var(--bg-surface)]/90 border border-[var(--border-pixel)] text-[11px] font-bold text-[var(--text-primary)]"
                data-testid="camera-selected-size-badge"
              >
                {transformParams.canvasWidth}×{transformParams.canvasHeight}px ·{' '}
                {effectivePalette.colors.length}c
              </span>

              {cameraActive && engineStatus && (
                <span
                  className={`px-2 py-0.5 border text-[10px] font-bold ${
                    engineStatus.backend === 'webgpu'
                      ? 'bg-[var(--bg-surface)]/90 border-[var(--accent-teal)] text-[var(--accent-teal)]'
                      : 'bg-[var(--bg-surface)]/90 border-[var(--accent-amber)] text-[var(--accent-amber)]'
                  }`}
                  data-testid="camera-backend-badge"
                  data-backend={engineStatus.backend}
                >
                  {engineStatus.backend === 'webgpu'
                    ? t('cameraBackendWebGpuBadge')
                    : t('cameraBackendCanvas2dBadge')}
                </span>
              )}
            </div>

            {cameraActive && paletteSource === 'auto' && lockedAutoPalette && (
              <span
                className="px-2 py-0.5 bg-[var(--bg-surface)]/90 border border-[var(--accent-primary)] text-[10px] font-bold text-[var(--accent-primary)]"
                data-testid="camera-palette-locked-badge"
              >
                {t('cameraPaletteLockedBadge')}
              </span>
            )}
          </div>

          {/* Idle Overlay Before Camera Starts (Large Camera Start Button) */}
          {!cameraActive && (
            <div className="absolute inset-0 z-10 bg-[var(--bg-surface)]/80 flex flex-col items-center justify-center gap-3 p-4 text-center">
              <PixelIcon
                name="camera"
                size={36}
                className="text-[var(--accent-primary)]"
              />
              <p className="text-xs text-[var(--text-secondary)] max-w-xs leading-relaxed">
                {t('cameraStudioSubtitle')}
              </p>
              <button
                type="button"
                disabled={startingCamera}
                onClick={() => void startCameraWithFacing(facingMode)}
                className="pixel-btn pixel-btn-active min-h-[56px] px-7 text-sm sm:text-base font-bold flex items-center gap-2.5"
                data-testid="camera-start-btn"
              >
                <PixelIcon name="camera" size={20} />
                <span>{t('cameraStartBtn')}</span>
              </button>
            </div>
          )}

          {/* ==================== COLLAPSIBLE TRANSLUCENT SETTINGS OVERLAY ==================== */}
          {/* Dims the viewfinder slightly (`bg-black/35`) while keeping the live pixel-art preview clearly visible behind & above the compact bottom sheet! */}
          <AnimatePresence>
            {settingsOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.16 }}
                  onClick={() => setSettingsOpen(false)}
                  className="absolute inset-0 z-20 bg-black/35 cursor-pointer"
                  data-testid="camera-settings-backdrop"
                />

                <motion.div
                  initial={
                    reducedMotion ? { opacity: 1 } : { opacity: 0, y: 16 }
                  }
                  animate={{ opacity: 1, y: 0 }}
                  exit={
                    reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }
                  }
                  transition={{ duration: reducedMotion ? 0 : 0.18 }}
                  className="absolute inset-x-2 bottom-2 z-30 max-h-[70%] flex flex-col bg-[var(--bg-surface)]/88 border-2 border-[var(--border-pixel)] overflow-hidden"
                  data-testid="camera-settings-overlay"
                >
                  {/* Sticky Overlay Header with 1-Tap Collapse Button */}
                  <div className="px-2.5 py-1.5 bg-[var(--bg-elevated)]/92 border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2 shrink-0">
                    <span className="text-[11px] font-bold text-[var(--text-primary)] truncate">
                      {t('cameraSettingsOpenBtn')} ({transformParams.canvasWidth}×
                      {transformParams.canvasHeight}px)
                    </span>
                    <button
                      type="button"
                      onClick={() => setSettingsOpen(false)}
                      className="pixel-btn pixel-btn-teal min-h-[30px] px-2.5 text-[11px] font-bold flex items-center gap-1 shrink-0"
                      data-testid="camera-settings-collapse-btn"
                    >
                      <PixelIcon name="arrowDown" size={12} />
                      <span>{t('cameraSettingsCloseBtn')}</span>
                    </button>
                  </div>

                  {/* Scrollable Translucent Settings Body — Live Canvas remains visible in upper viewfinder & through backdrop */}
                  <div className="p-2.5 overflow-y-auto overscroll-contain space-y-2.5 text-xs">
                    <p className="text-[10px] text-[var(--text-secondary)] leading-snug">
                      {t('cameraLivePreviewOverlayHint')}
                    </p>

                    {/* 1. Canvas Size Selection */}
                    <div className="space-y-1.5 p-2 bg-[var(--bg-elevated)]/85 border border-[var(--border-pixel)]">
                      <span className="text-[11px] font-bold text-[var(--text-secondary)] block">
                        {t('cameraCanvasSizeLabel')}
                      </span>
                      <div className="grid grid-cols-5 gap-1">
                        {CAMERA_SIZE_PRESETS.map((preset) => {
                          const active =
                            canvasWidth === preset.width &&
                            canvasHeight === preset.height
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => {
                                setCanvasWidth(preset.width)
                                setCanvasHeight(preset.height)
                              }}
                              className={`min-h-[30px] px-1 text-[11px] font-bold ${
                                active
                                  ? 'pixel-btn pixel-btn-active'
                                  : 'pixel-btn'
                              }`}
                              data-testid={`camera-size-preset-${preset.width}x${preset.height}`}
                            >
                              {preset.label}
                            </button>
                          )
                        })}
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <label className="space-y-0.5 text-xs">
                          <span className="text-[10px] font-bold text-[var(--text-secondary)]">
                            {t('widthPx')}
                          </span>
                          <input
                            type="number"
                            min={MIN_CANVAS_SIZE}
                            max={MAX_CANVAS_SIZE}
                            value={canvasWidth}
                            onChange={(e) =>
                              setCanvasWidth(
                                Math.max(
                                  MIN_CANVAS_SIZE,
                                  Math.min(
                                    MAX_CANVAS_SIZE,
                                    Number(e.target.value) || 1
                                  )
                                )
                              )
                            }
                            className="w-full min-h-[32px] px-2 text-xs font-bold pixel-input"
                            data-testid="camera-width-input"
                          />
                        </label>
                        <label className="space-y-0.5 text-xs">
                          <span className="text-[10px] font-bold text-[var(--text-secondary)]">
                            {t('heightPx')}
                          </span>
                          <input
                            type="number"
                            min={MIN_CANVAS_SIZE}
                            max={MAX_CANVAS_SIZE}
                            value={canvasHeight}
                            onChange={(e) =>
                              setCanvasHeight(
                                Math.max(
                                  MIN_CANVAS_SIZE,
                                  Math.min(
                                    MAX_CANVAS_SIZE,
                                    Number(e.target.value) || 1
                                  )
                                )
                              )
                            }
                            className="w-full min-h-[32px] px-2 text-xs font-bold pixel-input"
                            data-testid="camera-height-input"
                          />
                        </label>
                      </div>
                    </div>

                    {/* 2. Palette Selection & Fixed Auto-Palette Generation */}
                    <div className="space-y-1.5 p-2 bg-[var(--bg-elevated)]/85 border border-[var(--border-pixel)]">
                      <span className="text-[11px] font-bold text-[var(--text-secondary)] block">
                        {t('cameraPaletteSourceLabel')}
                      </span>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={() => setPaletteSource('library')}
                          className={`min-h-[34px] px-2 text-xs font-bold ${
                            paletteSource === 'library'
                              ? 'pixel-btn pixel-btn-active'
                              : 'pixel-btn'
                          }`}
                          data-testid="camera-palette-mode-library"
                        >
                          {t('cameraPaletteSourceLibrary')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaletteSource('auto')}
                          className={`min-h-[34px] px-2 text-xs font-bold ${
                            paletteSource === 'auto'
                              ? 'pixel-btn pixel-btn-active'
                              : 'pixel-btn'
                          }`}
                          data-testid="camera-palette-mode-auto"
                        >
                          {t('cameraPaletteSourceAuto')}
                        </button>
                      </div>

                      {paletteSource === 'library' ? (
                        <PixelSelect<string>
                          value={selectedPaletteId || (palettes[0]?.id ?? '')}
                          options={paletteSelectOptions}
                          onChange={setSelectedPaletteId}
                          ariaLabel={t('cameraPaletteSourceLibrary')}
                          className="w-full"
                          testId="camera-library-palette-select"
                        />
                      ) : (
                        <div className="space-y-1">
                          <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                            {t('cameraAutoPaletteCountLabel')}
                          </span>
                          <div className="grid grid-cols-6 gap-1">
                            {AUTO_PALETTE_COLOR_COUNTS.map((cnt) => (
                              <button
                                key={cnt}
                                type="button"
                                onClick={() => setAutoColorCount(cnt)}
                                className={`min-h-[30px] px-1 text-xs font-bold ${
                                  autoColorCount === cnt
                                    ? 'pixel-btn pixel-btn-teal'
                                    : 'pixel-btn'
                                }`}
                                data-testid={`camera-auto-count-${cnt}`}
                              >
                                {cnt}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <div
                        className="flex flex-wrap gap-0.5 pt-0.5 max-h-10 overflow-hidden"
                        data-testid="camera-active-palette-strip"
                      >
                        {effectivePalette.colors.slice(0, 32).map((hex, i) => (
                          <span
                            key={`${hex}-${i}`}
                            className="w-3 h-3 border border-[var(--border-pixel)]"
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                        {effectivePalette.colors.length > 32 && (
                          <span className="text-[10px] font-bold text-[var(--text-secondary)] px-1 self-center">
                            +{effectivePalette.colors.length - 32}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 3. Simple Finish Style (おまかせ / くっきり / レトロ) */}
                    <div className="space-y-1.5 p-2 bg-[var(--bg-elevated)]/85 border border-[var(--border-pixel)]">
                      <span className="text-[11px] font-bold text-[var(--text-secondary)] block">
                        {t('cameraFinishModeLabel')}
                      </span>
                      <div className="grid grid-cols-3 gap-1.5">
                        {(
                          [
                            ['auto', 'cameraFinishAuto'],
                            ['crisp', 'cameraFinishCrisp'],
                            ['retro', 'cameraFinishRetro'],
                          ] as const
                        ).map(([mode, labelKey]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setFinishMode(mode)}
                            className={`min-h-[34px] px-2 text-xs font-bold ${
                              finishMode === mode
                                ? 'pixel-btn pixel-btn-active'
                                : 'pixel-btn'
                            }`}
                            data-testid={`camera-finish-${mode}`}
                          >
                            {t(labelKey)}
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] text-[var(--text-secondary)]">
                        {finishMode === 'auto'
                          ? t('cameraFinishAutoDesc')
                          : finishMode === 'crisp'
                            ? t('cameraFinishCrispDesc')
                            : t('cameraFinishRetroDesc')}
                      </p>
                    </div>

                    {/* 4. Collapsible Detailed Settings */}
                    <div className="border border-[var(--border-pixel)] bg-[var(--bg-surface)]/90">
                      <button
                        type="button"
                        onClick={() => setAdvancedOpen((v) => !v)}
                        aria-expanded={advancedOpen}
                        className="w-full min-h-[36px] px-2.5 flex items-center justify-between text-xs font-bold cursor-pointer hover:bg-[var(--bg-elevated)]"
                        data-testid="camera-advanced-toggle-btn"
                      >
                        <span className="flex items-center gap-1.5">
                          <PixelIcon name="settings" size={13} />
                          <span>
                            {advancedOpen
                              ? t('cameraAdvancedToggleClose')
                              : t('cameraAdvancedToggleOpen')}
                          </span>
                        </span>
                        <PixelIcon
                          name={advancedOpen ? 'arrowUp' : 'arrowDown'}
                          size={12}
                        />
                      </button>

                      {advancedOpen && (
                        <div
                          className="p-2.5 border-t border-[var(--border-pixel)] space-y-2.5 bg-[var(--bg-elevated)]/90"
                          data-testid="camera-advanced-panel"
                        >
                          <input
                            type="text"
                            value={artworkName}
                            onChange={(e) => setArtworkName(e.target.value)}
                            placeholder={t('cameraDefaultArtworkName')}
                            maxLength={48}
                            className="w-full min-h-[34px] px-2.5 text-xs font-bold pixel-input select-text"
                            data-testid="camera-artwork-name-input"
                          />

                          <CanvasSizePresetsPicker
                            selectedWidth={canvasWidth}
                            selectedHeight={canvasHeight}
                            onSelectDimensions={(w, h) => {
                              setCanvasWidth(w)
                              setCanvasHeight(h)
                            }}
                          />

                          <div className="space-y-1.5">
                            <span className="text-xs font-bold text-[var(--text-secondary)] block">
                              {t('cameraAspectFitLabel')}
                            </span>
                            <div className="grid grid-cols-2 gap-1.5">
                              <button
                                type="button"
                                onClick={() => setFitMode('cover')}
                                className={`min-h-[32px] px-2 text-xs font-bold ${
                                  fitMode === 'cover'
                                    ? 'pixel-btn pixel-btn-active'
                                    : 'pixel-btn'
                                }`}
                                data-testid="camera-fit-cover-btn"
                              >
                                {t('cameraFitCover')}
                              </button>
                              <button
                                type="button"
                                onClick={() => setFitMode('contain')}
                                className={`min-h-[32px] px-2 text-xs font-bold ${
                                  fitMode === 'contain'
                                    ? 'pixel-btn pixel-btn-active'
                                    : 'pixel-btn'
                                }`}
                                data-testid="camera-fit-contain-btn"
                              >
                                {t('cameraFitContain')}
                              </button>
                            </div>

                            {fitMode === 'cover' && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                                <div>
                                  <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                                    {t('cameraCropPanXLabel')} ({cropPanX}%)
                                  </span>
                                  <PixelSlider
                                    min={-100}
                                    max={100}
                                    step={5}
                                    value={cropPanX}
                                    onChange={setCropPanX}
                                    ariaLabel={t('cameraCropPanXLabel')}
                                  />
                                </div>
                                <div>
                                  <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                                    {t('cameraCropPanYLabel')} ({cropPanY}%)
                                  </span>
                                  <PixelSlider
                                    min={-100}
                                    max={100}
                                    step={5}
                                    value={cropPanY}
                                    onChange={setCropPanY}
                                    ariaLabel={t('cameraCropPanYLabel')}
                                  />
                                </div>
                              </div>
                            )}
                          </div>

                          {paletteSource === 'auto' && (
                            <button
                              type="button"
                              disabled={!cameraActive}
                              onClick={() => {
                                regenerateAutoPaletteNow(autoColorCount)
                              }}
                              className="w-full min-h-[34px] px-3 pixel-btn pixel-btn-teal text-xs font-bold flex items-center justify-center gap-1.5"
                              data-testid="camera-regenerate-palette-btn"
                            >
                              <PixelIcon name="palette" size={14} />
                              <span>{t('cameraRegeneratePaletteBtn')}</span>
                            </button>
                          )}

                          {finishMode !== 'crisp' && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-bold text-[var(--text-secondary)]">
                                  {t('cameraBayerSizeLabel')}
                                </span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setBayerSize(4)}
                                    className={`min-h-[28px] px-2 text-xs font-bold ${
                                      bayerSize === 4
                                        ? 'pixel-btn pixel-btn-active'
                                        : 'pixel-btn'
                                    }`}
                                    data-testid="camera-bayer-4-btn"
                                  >
                                    {t('cameraBayer4x4')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setBayerSize(8)}
                                    className={`min-h-[28px] px-2 text-xs font-bold ${
                                      bayerSize === 8
                                        ? 'pixel-btn pixel-btn-active'
                                        : 'pixel-btn'
                                    }`}
                                    data-testid="camera-bayer-8-btn"
                                  >
                                    {t('cameraBayer8x8')}
                                  </button>
                                </div>
                              </div>

                              <div>
                                <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                                  {t('cameraDitherStrengthLabel')} (
                                  {ditherStrength}%)
                                </span>
                                <PixelSlider
                                  min={0}
                                  max={200}
                                  step={5}
                                  value={ditherStrength}
                                  onChange={setDitherStrength}
                                  ariaLabel={t('cameraDitherStrengthLabel')}
                                />
                              </div>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => void handleToggleFacing()}
                              className="min-h-[32px] px-3 pixel-btn text-xs font-bold flex items-center gap-1.5"
                              data-testid="camera-advanced-facing-btn"
                            >
                              <PixelIcon name="replace" size={13} />
                              <span>
                                {facingMode === 'environment'
                                  ? t('cameraFacingEnvironment')
                                  : t('cameraFacingUser')}
                              </span>
                            </button>
                            <PixelCheckbox
                              checked={mirrorX}
                              onChange={setMirrorX}
                              label={t('cameraMirrorXLabel')}
                              testId="camera-mirror-checkbox"
                            />
                          </div>

                          <div className="space-y-2 pt-1 border-t border-[var(--border-subtle)]">
                            <div>
                              <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                                {t('cameraBrightnessLabel')} (
                                {brightnessPct > 0
                                  ? `+${brightnessPct}`
                                  : brightnessPct}
                                )
                              </span>
                              <PixelSlider
                                min={-40}
                                max={40}
                                step={2}
                                value={brightnessPct}
                                onChange={setBrightnessPct}
                                ariaLabel={t('cameraBrightnessLabel')}
                              />
                            </div>
                            <div>
                              <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                                {t('cameraContrastLabel')} ({contrastPct}%)
                              </span>
                              <PixelSlider
                                min={50}
                                max={180}
                                step={5}
                                value={contrastPct}
                                onChange={setContrastPct}
                                ariaLabel={t('cameraContrastLabel')}
                              />
                            </div>
                            <div>
                              <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                                {t('cameraSaturationLabel')} ({saturationPct}%)
                              </span>
                              <PixelSlider
                                min={0}
                                max={200}
                                step={5}
                                value={saturationPct}
                                onChange={setSaturationPct}
                                ariaLabel={t('cameraSaturationLabel')}
                              />
                            </div>
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setCropPanX(0)
                                  setCropPanY(0)
                                  setDitherStrength(100)
                                  setBrightnessPct(0)
                                  setContrastPct(100)
                                  setSaturationPct(100)
                                }}
                                className="pixel-btn min-h-[28px] px-2.5 text-[11px] font-bold"
                                data-testid="camera-reset-adjustments-btn"
                              >
                                {t('cameraResetAdjustmentsBtn')}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Camera Error Banner */}
        {cameraError && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)] leading-relaxed"
            data-testid="camera-error-banner"
          >
            {cameraError}
          </div>
        )}

        {/* ==================== CAMERA DOCK BAR (LARGE SHUTTER + SETTINGS TOGGLE + FLIP/STOP) ==================== */}
        <div
          className="px-2 py-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex items-center justify-between gap-2"
          data-testid="camera-dock-bar"
        >
          {/* Left: Collapsible Settings Trigger (`設定・調整`) */}
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className={`min-h-[48px] px-3 text-xs font-bold flex items-center gap-1.5 ${
              settingsOpen ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
            }`}
            data-testid="camera-settings-toggle-btn"
          >
            <PixelIcon name="settings" size={16} />
            <span>{t('cameraSettingsOpenBtn')}</span>
          </button>

          {/* Center: Large Tactile Camera Shutter / Start Button (`min-h-[64px]`) */}
          {cameraActive ? (
            <button
              type="button"
              disabled={capturing}
              onClick={() => void handleCaptureArtwork()}
              className="flex-1 max-w-[260px] min-h-[64px] px-5 pixel-btn pixel-btn-active text-sm sm:text-base font-bold flex items-center justify-center gap-2.5"
              data-testid="camera-shutter-btn"
            >
              <PixelIcon name="camera" size={22} />
              <span>
                {capturing ? t('cameraCapturingLabel') : t('cameraCaptureBtn')}
              </span>
            </button>
          ) : (
            <button
              type="button"
              disabled={startingCamera}
              onClick={() => void startCameraWithFacing(facingMode)}
              className="flex-1 max-w-[260px] min-h-[60px] px-5 pixel-btn pixel-btn-active text-sm sm:text-base font-bold flex items-center justify-center gap-2"
              data-testid="camera-dock-start-btn"
            >
              <PixelIcon name="camera" size={20} />
              <span>{t('cameraStartBtn')}</span>
            </button>
          )}

          {/* Right: Flip Facing & Stop Camera */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={startingCamera || capturing}
              onClick={() => void handleToggleFacing()}
              title={t('cameraSwitchFacingBtn')}
              className="min-h-[48px] px-2.5 pixel-btn text-xs font-bold flex items-center gap-1"
              data-testid="camera-quick-switch-facing-btn"
            >
              <PixelIcon name="replace" size={16} />
              <span className="hidden sm:inline">
                {t('cameraSwitchFacingBtn')}
              </span>
            </button>

            {cameraActive && (
              <button
                type="button"
                disabled={capturing}
                onClick={() => stopCameraAndLoop(true)}
                title={t('cameraStopBtn')}
                className="min-h-[48px] px-2.5 pixel-btn pixel-btn-danger text-xs font-bold flex items-center justify-center"
                data-testid="camera-stop-btn"
              >
                <PixelIcon name="close" size={15} />
              </button>
            )}
          </div>
        </div>

        <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
          {t('cameraPrivacyNote')}
        </p>
      </div>
    </Modal>
  )
}
