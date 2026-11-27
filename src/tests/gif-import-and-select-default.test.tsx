import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../App'
import { db, initializeDatabase, loadProjectFull, resetAllAppData } from '../db/database'
import { encodeAnimatedGifSync } from '../engine/gifEncoder'
import {
  decodeGifAnimation,
  inspectGifForImport,
  prepareImportedGifAsIndexed,
} from '../engine/gifImport'
import { buildPaletteRgbaLut, indexedBufferToRgba } from '../engine/indexedPalette'
import { DEFAULT_TOOL_SETTINGS } from '../state/useEditorController'
import { TRANSLATIONS } from '../i18n/translations'

/**
 * Helper: Build a custom raw GIF89a binary stream with full control over:
 * - Global Color Table (GCT) vs per-frame Local Color Table (LCT)
 * - Sub-frame rectangles `(left, top, width, height)`
 * - Disposal Methods `0, 1, 2, 3`
 * - Transparent color flag/index & centisecond delays
 * - Interlacing
 */
function lzwEncodeRaw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  const outBytes: number[] = []
  let bitBuf = 0
  let bitCount = 0

  const emit = (code: number, width: number) => {
    bitBuf |= code << bitCount
    bitCount += width
    while (bitCount >= 8) {
      outBytes.push(bitBuf & 0xff)
      bitBuf >>>= 8
      bitCount -= 8
    }
  }

  // Simple uncompressed-style LZW emission with periodic clear so every index sequence is exact
  const codeWidth = minCodeSize + 1
  emit(clearCode, codeWidth)
  let symbolsSinceClear = 0
  const maxRun = (1 << minCodeSize) - 2
  for (let i = 0; i < indices.length; i++) {
    emit(indices[i]!, codeWidth)
    symbolsSinceClear++
    if (symbolsSinceClear >= Math.max(1, maxRun)) {
      emit(clearCode, codeWidth)
      symbolsSinceClear = 0
    }
  }
  emit(eoiCode, codeWidth)
  if (bitCount > 0) {
    outBytes.push(bitBuf & 0xff)
  }

  const subBlocks: number[] = [minCodeSize]
  let pos = 0
  while (pos < outBytes.length) {
    const chunk = Math.min(255, outBytes.length - pos)
    subBlocks.push(chunk)
    for (let i = 0; i < chunk; i++) {
      subBlocks.push(outBytes[pos + i]!)
    }
    pos += chunk
  }
  subBlocks.push(0x00)
  return new Uint8Array(subBlocks)
}

interface CustomRawGifFrameSpec {
  left: number
  top: number
  width: number
  height: number
  disposalMethod: number
  delayCs: number
  transparentIndex?: number | null
  localPaletteRgb?: Array<[number, number, number]>
  interlaced?: boolean
  indices: Uint8Array
}

function buildCustomGif89a(opts: {
  screenWidth: number
  screenHeight: number
  globalPaletteRgb?: Array<[number, number, number]>
  loopCount?: number | null
  frames: CustomRawGifFrameSpec[]
}): Uint8Array {
  const bytes: number[] = []
  const writeU16 = (v: number) => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff)
  }
  const writeAscii = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i))
  }

  writeAscii('GIF89a')
  writeU16(opts.screenWidth)
  writeU16(opts.screenHeight)

  let gctField = 0
  let gctPow2 = 0
  if (opts.globalPaletteRgb && opts.globalPaletteRgb.length > 0) {
    gctPow2 = 2
    while (gctPow2 < opts.globalPaletteRgb.length && gctPow2 < 256) {
      gctPow2 <<= 1
      gctField++
    }
    bytes.push(0x80 | 0x70 | gctField)
  } else {
    bytes.push(0x70)
  }
  bytes.push(0x00, 0x00)

  if (opts.globalPaletteRgb && gctPow2 > 0) {
    for (let i = 0; i < gctPow2; i++) {
      const rgb = opts.globalPaletteRgb[i] ?? [0, 0, 0]
      bytes.push(rgb[0], rgb[1], rgb[2])
    }
  }

  if (opts.loopCount !== undefined && opts.loopCount !== null) {
    bytes.push(0x21, 0xff, 0x0b)
    writeAscii('NETSCAPE2.0')
    bytes.push(
      0x03,
      0x01,
      opts.loopCount & 0xff,
      (opts.loopCount >>> 8) & 0xff,
      0x00
    )
  }

  for (const f of opts.frames) {
    const hasTrans =
      f.transparentIndex !== undefined && f.transparentIndex !== null
    const packedGce =
      ((f.disposalMethod & 0x07) << 2) | (hasTrans ? 0x01 : 0x00)
    bytes.push(
      0x21,
      0xf9,
      0x04,
      packedGce,
      f.delayCs & 0xff,
      (f.delayCs >>> 8) & 0xff,
      hasTrans ? f.transparentIndex! : 0,
      0x00
    )

    bytes.push(0x2c)
    writeU16(f.left)
    writeU16(f.top)
    writeU16(f.width)
    writeU16(f.height)

    let lctField = 0
    let lctPow2 = 0
    let packedImg = f.interlaced ? 0x40 : 0x00
    if (f.localPaletteRgb && f.localPaletteRgb.length > 0) {
      lctPow2 = 2
      while (lctPow2 < f.localPaletteRgb.length && lctPow2 < 256) {
        lctPow2 <<= 1
        lctField++
      }
      packedImg |= 0x80 | lctField
    }
    bytes.push(packedImg)

    if (f.localPaletteRgb && lctPow2 > 0) {
      for (let i = 0; i < lctPow2; i++) {
        const rgb = f.localPaletteRgb[i] ?? [0, 0, 0]
        bytes.push(rgb[0], rgb[1], rgb[2])
      }
    }

    const activeBits =
      lctPow2 > 0
        ? lctField + 1
        : gctPow2 > 0
          ? gctField + 1
          : 2
    const minCodeSize = Math.max(2, activeBits)

    let orderedIndices = f.indices
    if (f.interlaced) {
      const starts = [0, 4, 2, 1]
      const steps = [8, 8, 4, 2]
      const inter = new Uint8Array(f.width * f.height)
      let dstRow = 0
      for (let pass = 0; pass < 4; pass++) {
        for (let y = starts[pass]!; y < f.height; y += steps[pass]!) {
          inter.set(
            f.indices.subarray(y * f.width, (y + 1) * f.width),
            dstRow * f.width
          )
          dstRow++
        }
      }
      orderedIndices = inter
    }

    const lzw = lzwEncodeRaw(orderedIndices, minCodeSize)
    for (let i = 0; i < lzw.length; i++) bytes.push(lzw[i]!)
  }

  bytes.push(0x3b)
  return new Uint8Array(bytes)
}

function getRgbaAt(
  rgba: Uint8ClampedArray,
  width: number,
  x: number,
  y: number
): [number, number, number, number] {
  const i = (y * width + x) * 4
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!]
}

describe('Stage 1: GIF Import (Still, Animated, Disposal 0-3, Resolution Restore, Quantization) & Select Default (wand)', () => {
  beforeEach(async () => {
    window.history.pushState({}, '', '/')
    await resetAllAppData(db)
    await initializeDatabase(db)
  })

  afterEach(async () => {
    cleanup()
    await new Promise((r) => setTimeout(r, 25))
  })

  it('decodes 1-frame still GIF and multi-frame animated GIF with exact frame order, per-frame durations, and transparency', async () => {
    // 1-frame still GIF (4x4) with transparent background
    const stillRgba = new Uint8ClampedArray(4 * 4 * 4)
    // Put crimson pixel at (1, 2)
    const pOff = (2 * 4 + 1) * 4
    stillRgba[pOff] = 220
    stillRgba[pOff + 1] = 40
    stillRgba[pOff + 2] = 60
    stillRgba[pOff + 3] = 255

    const encodedStill = encodeAnimatedGifSync({
      width: 4,
      height: 4,
      scale: 1,
      frames: [{ rgba: stillRgba, durationMs: 150 }],
      loop: false,
    })

    const decodedStill = await decodeGifAnimation(encodedStill.gif)
    expect(decodedStill.frames.length).toBe(1)
    expect(decodedStill.width).toBe(4)
    expect(decodedStill.height).toBe(4)
    expect(getRgbaAt(decodedStill.frames[0]!.rgba, 4, 0, 0)).toEqual([0, 0, 0, 0])
    expect(getRgbaAt(decodedStill.frames[0]!.rgba, 4, 1, 2)).toEqual([
      220, 40, 60, 255,
    ])

    // 3-frame animated GIF with distinct per-frame durations (80ms, 240ms, 410ms)
    const f0 = new Uint8ClampedArray(4 * 4 * 4)
    const f1 = new Uint8ClampedArray(4 * 4 * 4)
    const f2 = new Uint8ClampedArray(4 * 4 * 4)
    f0.set([255, 0, 0, 255], 0)
    f1.set([0, 255, 0, 255], 4)
    f2.set([0, 0, 255, 255], 8)

    const encodedAnim = encodeAnimatedGifSync({
      width: 4,
      height: 4,
      scale: 1,
      loop: true,
      frames: [
        { rgba: f0, durationMs: 80 },
        { rgba: f1, durationMs: 240 },
        { rgba: f2, durationMs: 410 },
      ],
    })

    const decodedAnim = await decodeGifAnimation(encodedAnim.gif)
    expect(decodedAnim.frames.length).toBe(3)
    expect(decodedAnim.loopPlayback).toBe(true)
    expect(decodedAnim.frames.map((f) => f.durationMs)).toEqual([80, 240, 410])
    expect(getRgbaAt(decodedAnim.frames[0]!.rgba, 4, 0, 0)).toEqual([
      255, 0, 0, 255,
    ])
    expect(getRgbaAt(decodedAnim.frames[1]!.rgba, 4, 1, 0)).toEqual([
      0, 255, 0, 255,
    ])
    expect(getRgbaAt(decodedAnim.frames[2]!.rgba, 4, 2, 0)).toEqual([
      0, 0, 255, 255,
    ])
  })

  it('accurately composites Global & Local Color Tables, sub-rectangles, interlacing, and Disposal Methods 1, 2, and 3', async () => {
    // 4x4 logical screen with Global Color Table: [0: Trans, 1: Red, 2: Green, 3: Blue]
    // Frame 0 (Disposal 1 = Do Not Dispose): fills entire 4x4 with Red (idx 1)
    // Frame 1 (Disposal 3 = Restore to Previous, Local Color Table [0: Trans, 1: Yellow], interlaced sub-rect 2x2 at (1,1)):
    //   paints Yellow over (1..2, 1..2), so Frame 1 shows Red border + Yellow center; then Disposal 3 reverts canvas to pure Red!
    // Frame 2 (Disposal 2 = Restore to Background, sub-rect 2x2 at (0,0)):
    //   paints Blue (GCT idx 3) at (0..1, 0..1) over restored Red canvas; then Disposal 2 clears (0..1, 0..1) to transparent!
    // Frame 3 (Disposal 1, sub-rect 1x1 at (3,3)):
    //   paints Green (GCT idx 2) at (3,3); top-left (0..1, 0..1) must be transparent from Frame 2's Disposal 2, while (2,2) stays Red!
    const rawGif = buildCustomGif89a({
      screenWidth: 4,
      screenHeight: 4,
      globalPaletteRgb: [
        [0, 0, 0],
        [200, 20, 30], // 1: Red
        [30, 190, 50], // 2: Green
        [40, 80, 220], // 3: Blue
      ],
      loopCount: 3, // finite loop count -> preserved with finiteLoopCountNote = 3
      frames: [
        {
          left: 0,
          top: 0,
          width: 4,
          height: 4,
          disposalMethod: 1,
          delayCs: 10,
          transparentIndex: 0,
          indices: new Uint8Array(16).fill(1),
        },
        {
          left: 1,
          top: 1,
          width: 2,
          height: 2,
          disposalMethod: 3, // Restore to Previous
          delayCs: 12,
          transparentIndex: 0,
          interlaced: true,
          localPaletteRgb: [
            [0, 0, 0],
            [250, 220, 10], // 1: Yellow (LCT overrides GCT!)
          ],
          indices: new Uint8Array([1, 1, 1, 1]),
        },
        {
          left: 0,
          top: 0,
          width: 2,
          height: 2,
          disposalMethod: 2, // Restore to Background (clears 2x2 at 0,0 to transparent AFTER Frame 2)
          delayCs: 15,
          transparentIndex: 0,
          indices: new Uint8Array([3, 3, 3, 3]),
        },
        {
          left: 3,
          top: 3,
          width: 1,
          height: 1,
          disposalMethod: 1,
          delayCs: 1, // < 20ms short delay -> 10ms + shortDelayFrameCount warning
          transparentIndex: 0,
          indices: new Uint8Array([2]),
        },
      ],
    })

    const decoded = await decodeGifAnimation(rawGif)
    expect(decoded.frames.length).toBe(4)
    expect(decoded.finiteLoopCountNote).toBe(3)
    expect(decoded.shortDelayFrameCount).toBe(1)
    expect(decoded.frames[3]!.durationMs).toBe(10)

    // Frame 0: pure Red everywhere
    expect(getRgbaAt(decoded.frames[0]!.rgba, 4, 1, 1)).toEqual([
      200, 20, 30, 255,
    ])
    // Frame 1: Yellow at (1,1) via LCT, Red at (0,0)
    expect(getRgbaAt(decoded.frames[1]!.rgba, 4, 1, 1)).toEqual([
      250, 220, 10, 255,
    ])
    expect(getRgbaAt(decoded.frames[1]!.rgba, 4, 0, 0)).toEqual([
      200, 20, 30, 255,
    ])
    // Frame 2: Disposal 3 restored (1,1) back to Red! Meanwhile 2x2 sub-rect at (0,0) paints (0..1, 0..1) Blue while (2,2) stays Red!
    expect(getRgbaAt(decoded.frames[2]!.rgba, 4, 2, 2)).toEqual([
      200, 20, 30, 255,
    ])
    expect(getRgbaAt(decoded.frames[2]!.rgba, 4, 2, 1)).toEqual([
      200, 20, 30, 255,
    ])
    expect(getRgbaAt(decoded.frames[2]!.rgba, 4, 1, 1)).toEqual([
      40, 80, 220, 255,
    ])
    expect(getRgbaAt(decoded.frames[2]!.rgba, 4, 0, 0)).toEqual([
      40, 80, 220, 255,
    ])
    // Frame 3: Disposal 2 cleared (0..1, 0..1) to transparent, kept (2,2) Red, and painted (3,3) Green!
    expect(getRgbaAt(decoded.frames[3]!.rgba, 4, 0, 0)).toEqual([0, 0, 0, 0])
    expect(getRgbaAt(decoded.frames[3]!.rgba, 4, 1, 1)).toEqual([0, 0, 0, 0])
    expect(getRgbaAt(decoded.frames[3]!.rgba, 4, 2, 2)).toEqual([
      200, 20, 30, 255,
    ])
    expect(getRgbaAt(decoded.frames[3]!.rgba, 4, 3, 3)).toEqual([
      30, 190, 50, 255,
    ])
  })

  it('restores dotdot GIF metadata losslessly AND estimates external integer-upscaled GIFs across ALL frames without false positives', async () => {
    // A. dotdot metadata round-trip: 8x8 -> exported at 4x (32x32) -> detected as 'metadata' 8x8 (scale 4)
    const baseFrame0 = new Uint8ClampedArray(8 * 8 * 4)
    const baseFrame1 = new Uint8ClampedArray(8 * 8 * 4)
    baseFrame0.set([255, 80, 120, 255], 0)
    baseFrame1.set([40, 200, 180, 255], (3 * 8 + 5) * 4)

    const exportedWithMeta = encodeAnimatedGifSync({
      width: 8,
      height: 8,
      scale: 4,
      embedMetadata: true,
      frames: [
        { rgba: baseFrame0, durationMs: 120 },
        { rgba: baseFrame1, durationMs: 180 },
      ],
    })
    expect(exportedWithMeta.outWidth).toBe(32)
    expect(exportedWithMeta.outHeight).toBe(32)

    const metaInspection = await inspectGifForImport(exportedWithMeta.gif, 256)
    expect(metaInspection.confidence).toBe('metadata')
    expect(metaInspection.recommendedScale).toBe(4)
    expect(metaInspection.metadata?.originalWidth).toBe(8)
    expect(metaInspection.metadata?.originalHeight).toBe(8)

    const preparedFromMeta = prepareImportedGifAsIndexed(
      metaInspection.decoded,
      metaInspection.recommendedScale
    )
    expect(preparedFromMeta.width).toBe(8)
    expect(preparedFromMeta.height).toBe(8)
    expect(preparedFromMeta.frames.length).toBe(2)
    const lut = buildPaletteRgbaLut(preparedFromMeta.palette)
    const restoredF0 = indexedBufferToRgba(
      Object.values(preparedFromMeta.celBuffers)[0]!.data,
      lut
    )
    expect(getRgbaAt(restoredF0, 8, 0, 0)).toEqual([255, 80, 120, 255])

    // B. External GIF without metadata (`embedMetadata: false`): 6x6 upscaled 4x -> 24x24 -> heuristic detects scale 4!
    const exportedWithoutMeta = encodeAnimatedGifSync({
      width: 6,
      height: 6,
      scale: 4,
      embedMetadata: false,
      frames: [
        { rgba: baseFrame0.subarray(0, 6 * 6 * 4), durationMs: 100 },
        { rgba: baseFrame1.subarray(0, 6 * 6 * 4), durationMs: 100 },
      ],
    })
    const heuristicInspection = await inspectGifForImport(
      exportedWithoutMeta.gif,
      256
    )
    expect(heuristicInspection.confidence).toBe('heuristic')
    expect(heuristicInspection.metadata).toBeNull()
    expect(heuristicInspection.recommendedScale).toBe(4)

    // C. Multi-frame validation: Frame 0 is clean 4x blocks, but Frame 1 shifts by 2px (only 2x uniform across all frames!)
    const f0_8x8 = new Uint8ClampedArray(8 * 8 * 4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        f0_8x8.set([255, 0, 0, 255], (y * 8 + x) * 4)
      }
    }
    const f1_8x8 = new Uint8ClampedArray(8 * 8 * 4)
    // Shifted to (2..5, 2..5) -> breaks 4x4 grid alignment, only 2x2 grid holds!
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) {
        f1_8x8.set([0, 255, 0, 255], (y * 8 + x) * 4)
      }
    }
    const mixedScaleGif = encodeAnimatedGifSync({
      width: 8,
      height: 8,
      scale: 1,
      embedMetadata: false,
      frames: [
        { rgba: f0_8x8, durationMs: 100 },
        { rgba: f1_8x8, durationMs: 100 },
      ],
    })
    const mixedInspection = await inspectGifForImport(mixedScaleGif.gif, 256)
    expect(mixedInspection.confidence).toBe('heuristic')
    // Frame 0 alone would have suggested 4x, but Frame 1 restricts valid multi-frame uniform scale to 2x!
    expect(mixedInspection.recommendedScale).toBe(2)
    expect(mixedInspection.candidates.map((c) => c.scale)).toEqual([1, 2])
  })

  it('quantizes >255 opaque colors across multi-frame GIFs into <=255 indexed colors while preserving transparency (255)', async () => {
    // Frame 0 has 180 unique opaque colors + transparent pixel; Frame 1 has 180 different unique opaque colors -> 360 total unique colors!
    const w = 16
    const h = 16
    const f0 = new Uint8ClampedArray(w * h * 4)
    const f1 = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < 180; i++) {
      const off = i * 4
      f0[off] = (i * 37) & 0xff
      f0[off + 1] = (i * 73 + 20) & 0xff
      f0[off + 2] = 40
      f0[off + 3] = 255

      f1[off] = 200
      f1[off + 1] = (i * 53) & 0xff
      f1[off + 2] = (i * 97 + 11) & 0xff
      f1[off + 3] = 255
    }
    // Pixels 180..255 remain transparent (a=0)

    const gif360 = encodeAnimatedGifSync({
      width: w,
      height: h,
      scale: 1,
      embedMetadata: false,
      frames: [
        { rgba: f0, durationMs: 100 },
        { rgba: f1, durationMs: 100 },
      ],
    })

    const inspected = await inspectGifForImport(gif360.gif, 256)
    const prepared = prepareImportedGifAsIndexed(inspected.decoded, 1)

    expect(prepared.originalOpaqueColorCount).toBeGreaterThan(255)
    expect(prepared.finalOpaqueColorCount).toBeLessThanOrEqual(255)
    expect(prepared.wasQuantized).toBe(true)
    expect(prepared.palette.colors.length).toBeLessThanOrEqual(255)

    // Verify transparent pixel (index 255) stayed strictly transparent and was NOT counted as an opaque color
    const cel0 = Object.values(prepared.celBuffers)[0]!
    expect(cel0.data[250]).toBe(255)
  })

  it('rejects corrupt GIF bytes gracefully and never saves incomplete projects when cancelled', async () => {
    await expect(
      inspectGifForImport(new Uint8Array([0x47, 0x49, 0x46, 0x00]))
    ).rejects.toThrow(/INVALID_GIF/)

    await expect(
      inspectGifForImport(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    ).rejects.toThrow(/INVALID_GIF/)

    const beforeCount = await db.projects.count()
    const abortCtrl = new AbortController()
    abortCtrl.abort()

    const validGif = encodeAnimatedGifSync({
      width: 4,
      height: 4,
      scale: 1,
      frames: [{ rgba: new Uint8ClampedArray(4 * 4 * 4), durationMs: 100 }],
    })
    await expect(
      inspectGifForImport(validGif.gif, 256, { signal: abortCtrl.signal })
    ).rejects.toThrow(/cancelled/i)
    expect(await db.projects.count()).toBe(beforeCount)
  })

  it('imports an animated GIF from Gallery UI into a playable multi-frame indexed-v1 artwork and defaults Select tool to同色選択 (wand) while respecting saved user preference', async () => {
    // Verify static defaults & 3-language labels
    expect(DEFAULT_TOOL_SETTINGS.selectType).toBe('wand')
    expect(TRANSLATIONS.ja.selectWand).toBe('同色選択')
    expect(TRANSLATIONS.en.selectWand).toBeTruthy()
    expect(TRANSLATIONS.ko.selectWand).toBeTruthy()

    // Legacy settings with uncustomized preferredSelectType must normalize to 'wand'
    await db.settings.put({
      ...(await db.settings.get('app-settings'))!,
      id: 'app-settings',
      preferredSelectType: 'rect',
      preferredSelectTypeCustomized: false,
    })

    render(<App />)

    // Open Gallery Import Menu -> click GIF Import
    const importMenuBtn = await screen.findByTestId('gallery-import-menu-btn')
    fireEvent.click(importMenuBtn)
    const importGifBtn = await screen.findByTestId('gallery-import-gif-btn')
    fireEvent.click(importGifBtn)

    const fileInput = (await screen.findByTestId(
      'import-gif-file-input'
    )) as HTMLInputElement

    // Create a 2-frame 8x8 dotdot GIF exported at 4x (32x32)
    const frameA = new Uint8ClampedArray(8 * 8 * 4)
    const frameB = new Uint8ClampedArray(8 * 8 * 4)
    frameA.set([240, 60, 90, 255], 0)
    frameB.set([50, 180, 240, 255], (4 * 8 + 4) * 4)

    const gifRes = encodeAnimatedGifSync({
      width: 8,
      height: 8,
      scale: 4,
      embedMetadata: true,
      frames: [
        { rgba: frameA, durationMs: 110 },
        { rgba: frameB, durationMs: 220 },
      ],
    })

    const gifFile = new File([gifRes.gif.slice().buffer], 'walk_cycle.gif', {
      type: 'image/gif',
    })
    fireEvent.change(fileInput, { target: { files: [gifFile] } })

    // Verify metadata badge, raw size (32x32), restored size (8x8), frame count (2f), duration (330ms)
    expect(await screen.findByTestId('import-gif-meta-badge')).toBeTruthy()
    expect(screen.getByTestId('import-gif-raw-size').textContent).toContain(
      '32 × 32'
    )
    expect(screen.getByTestId('import-gif-after-size').textContent).toContain(
      '8 × 8'
    )
    expect(screen.getByTestId('import-gif-frame-count').textContent).toContain(
      '2'
    )
    expect(
      screen.getByTestId('import-gif-total-duration').textContent
    ).toContain('330')

    // Confirm import -> navigates directly to Editor with the new 2-frame 8x8 project!
    fireEvent.click(screen.getByTestId('import-gif-confirm-btn'))
    await screen.findByTestId('workspace-tab-tools')

    const projects = await db.projects.toArray()
    expect(projects.length).toBe(1)
    const createdProj = projects[0]!
    expect(createdProj.width).toBe(8)
    expect(createdProj.height).toBe(8)
    expect(createdProj.pixelFormat).toBe('indexed-v1')

    const loaded = (await loadProjectFull(createdProj.id, db))!
    expect(loaded.timeline.frames.length).toBe(2)
    expect(loaded.timeline.frames.map((f) => f.durationMs)).toEqual([110, 220])
    expect(loaded.layers[0]!.name).toBe('GIF読み込み')

    // Open Select tool options -> verify '同色選択' (`select-type-wand`) is active by default!
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(screen.getByTestId('tool-select'))
    const wandBtn = await screen.findByTestId('select-type-wand')
    expect(wandBtn.className).toContain('pixel-btn-active')
    expect(wandBtn.textContent).toContain('同色選択')

    // Explicitly choose Rectangle Select (`select-type-rect`) -> verify explicit user choice is saved and respected!
    const rectBtn = screen.getByTestId('select-type-rect')
    fireEvent.click(rectBtn)
    await waitFor(async () => {
      const savedSettings = await db.settings.get('app-settings')
      expect(savedSettings?.preferredSelectType).toBe('rect')
      expect(savedSettings?.preferredSelectTypeCustomized).toBe(true)
    })
  }, 20000)
})
