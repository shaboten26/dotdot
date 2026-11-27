import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerRuntime,
  ProjectPalette,
} from '../types'
import {
  clampFrameDurationMs,
  DEFAULT_FRAME_DURATION_MS,
  makeCellKey,
  SHORT_GIF_FRAME_WARNING_MS,
} from './animation'
import {
  DOTDOT_GIF_APP_AUTH_CODE,
  DOTDOT_GIF_APP_IDENTIFIER,
  type DotDotGifMetadata,
} from './gifEncoder'
import {
  buildPaletteRgbaLut,
  convertRgbaBuffersToIndexed,
  indexedBufferToRgba,
  type QuantizeRgbaSourceInput,
} from './indexedPalette'
import {
  downscaleByIntegerBlock,
  isExactUniformBlockScale,
  type ScaleCandidate,
} from './pngImport'
import { generateId } from '../utils/id'

export const GIF_HARD_MAX_DIMENSION = 4096
export const GIF_HARD_MAX_FRAMES = 600
export const GIF_HARD_MAX_TOTAL_PIXELS = 48_000_000
export const GIF_WARN_DIMENSION = 1024
export const GIF_WARN_FRAMES = 60

export interface CompositedGifFrame {
  /** 0-based frame index */
  index: number
  /** Full logical-screen composited RGBA buffer (`width * height * 4`) */
  rgba: Uint8ClampedArray
  /** Raw GIF delay in centiseconds (`1/100s`) from Graphic Control Extension (`0` if omitted) */
  rawDelayCs: number
  /** Resolved playback duration in milliseconds for dotdot timeline */
  durationMs: number
  /** True when raw GIF delay was `< 2` centiseconds (`0` or `1`, i.e. `< 20ms`) */
  wasVeryShortDelay: boolean
  /** GIF89a Disposal Method (`0..7`) applied AFTER displaying this frame */
  disposalMethod: number
  /** Sub-rectangle in logical screen coordinates */
  rect: { left: number; top: number; width: number; height: number }
  hasLocalColorTable: boolean
  hasTransparency: boolean
}

export interface DecodedGifAnimation {
  version: 'GIF87a' | 'GIF89a'
  width: number
  height: number
  hasGlobalColorTable: boolean
  globalColorCount: number
  frames: CompositedGifFrame[]
  /**
   * Loop count parsed from `NETSCAPE2.0` / `ANIMEXTS1.0`:
   * - `0`: infinite loop
   * - `>= 1`: finite repeat count
   * - `null`: no loop extension present (play once)
   */
  loopCount: number | null
  /** Mapped to dotdot's boolean `loopPlayback` (`true` for infinite or finite repeat > 0, `false` when play-once) */
  loopPlayback: boolean
  /** Non-null when GIF specifies a finite loop count (`>= 1`) that dotdot approximates as loop ON */
  finiteLoopCountNote: number | null
  totalDurationMs: number
  shortDelayFrameCount: number
  rawDotDotMetadata: string | null
}

export interface GifImportWarning {
  code:
    | 'large-dimensions'
    | 'many-frames'
    | 'very-short-delays'
    | 'finite-loop-approximated'
    | 'metadata-mismatch'
  detail?: string
}

export interface GifResolutionInspection {
  decoded: DecodedGifAnimation
  confidence: 'metadata' | 'heuristic' | 'none'
  metadata: DotDotGifMetadata | null
  metadataMismatchWarning: boolean
  recommendedScale: number
  candidates: ScaleCandidate[]
  exceedsCanvasAt1x: boolean
  warnings: GifImportWarning[]
}

export interface PreparedGifImportResult {
  width: number
  height: number
  scale: number
  palette: ProjectPalette
  layer: LayerRuntime
  frames: FrameMeta[]
  cels: CelMap
  celBuffers: Record<string, CelBufferRuntime>
  previewFramesRgba: Uint8ClampedArray[]
  originalOpaqueColorCount: number
  finalOpaqueColorCount: number
  wasQuantized: boolean
  totalDurationMs: number
  loopPlayback: boolean
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('GIF import cancelled')
    err.name = 'AbortError'
    throw err
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a))
  let y = Math.abs(Math.trunc(b))
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/**
 * Read GIF sub-blocks (`[len, ...bytes]*, 0x00`) starting at `startPos`.
 */
function readSubBlocks(
  bytes: Uint8Array,
  startPos: number
): { data: Uint8Array; nextPos: number } {
  let pos = startPos
  const chunks: Uint8Array[] = []
  let total = 0

  while (pos < bytes.length) {
    const blockLen = bytes[pos++]!
    if (blockLen === 0) {
      break
    }
    if (pos + blockLen > bytes.length) {
      throw new Error('CORRUPT_GIF: Sub-block exceeds file bounds')
    }
    chunks.push(bytes.subarray(pos, pos + blockLen))
    total += blockLen
    pos += blockLen
  }

  if (chunks.length === 1) {
    return { data: chunks[0]!, nextPos: pos }
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.length
  }
  return { data: merged, nextPos: pos }
}

/**
 * GIF variable-width LZW decoder (supports `minCodeSize` 2..11, Clear code, EOI code, deferred clear).
 */
function decodeGifLzw(
  minCodeSize: number,
  compressed: Uint8Array,
  expectedPixels: number
): Uint8Array {
  const out = new Uint8Array(expectedPixels)
  if (expectedPixels <= 0) return out
  if (minCodeSize < 2 || minCodeSize > 11) {
    throw new Error(`CORRUPT_GIF: Invalid LZW minimum code size (${minCodeSize})`)
  }

  const MAX_DICT = 4096
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1

  const prefix = new Int32Array(MAX_DICT)
  const suffix = new Uint8Array(MAX_DICT)
  const stack = new Uint8Array(MAX_DICT + 1)

  let availCode = eoiCode + 1
  let codeSize = minCodeSize + 1
  let codeMask = (1 << codeSize) - 1
  let oldCode = -1
  let firstChar = 0

  const resetDict = () => {
    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1
      suffix[i] = i & 0xff
    }
    availCode = eoiCode + 1
    codeSize = minCodeSize + 1
    codeMask = (1 << codeSize) - 1
    oldCode = -1
  }

  resetDict()

  let bitBuf = 0
  let bitCount = 0
  let bytePos = 0
  let outPos = 0

  while (outPos < expectedPixels) {
    while (bitCount < codeSize && bytePos < compressed.length) {
      bitBuf |= compressed[bytePos++]! << bitCount
      bitCount += 8
    }
    if (bitCount < codeSize) {
      break
    }

    const code = bitBuf & codeMask
    bitBuf >>>= codeSize
    bitCount -= codeSize

    if (code === clearCode) {
      resetDict()
      continue
    }
    if (code === eoiCode) {
      break
    }

    if (oldCode === -1) {
      if (code >= clearCode) {
        // Malformed stream without valid initial root code
        break
      }
      out[outPos++] = suffix[code]!
      oldCode = code
      firstChar = suffix[code]!
      continue
    }

    const inCode = code
    let cur = code
    let sp = 0

    if (cur >= availCode) {
      if (cur > availCode) {
        throw new Error('CORRUPT_GIF: Invalid LZW code out of dictionary range')
      }
      stack[sp++] = firstChar
      cur = oldCode
    }

    while (cur >= clearCode) {
      if (sp >= MAX_DICT) {
        throw new Error('CORRUPT_GIF: LZW dictionary cycle detected')
      }
      stack[sp++] = suffix[cur]!
      cur = prefix[cur]!
      if (cur < 0) {
        throw new Error('CORRUPT_GIF: Broken LZW prefix chain')
      }
    }

    firstChar = suffix[cur]!
    stack[sp++] = firstChar

    if (availCode < MAX_DICT) {
      prefix[availCode] = oldCode
      suffix[availCode] = firstChar
      availCode++
      if (availCode === codeMask + 1 && availCode < MAX_DICT) {
        codeSize++
        codeMask = (1 << codeSize) - 1
      }
    }

    oldCode = inCode

    while (sp > 0 && outPos < expectedPixels) {
      out[outPos++] = stack[--sp]!
    }
  }

  return out
}

/**
 * Deinterlace GIF 4-pass rows (`Pass 1: 0,+8`, `Pass 2: 4,+8`, `Pass 3: 2,+4`, `Pass 4: 1,+2`).
 */
function deinterlaceGifIndices(
  src: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const dst = new Uint8Array(width * height)
  const starts = [0, 4, 2, 1]
  const steps = [8, 8, 4, 2]
  let srcRow = 0
  for (let pass = 0; pass < 4; pass++) {
    for (let y = starts[pass]!; y < height; y += steps[pass]!) {
      if (srcRow < height) {
        const sOff = srcRow * width
        const dOff = y * width
        dst.set(src.subarray(sOff, sOff + width), dOff)
        srcRow++
      }
    }
  }
  return dst
}

/**
 * Resolve GIF centisecond delay (`1/100s`) into dotdot frame duration (`ms`).
 * Note: Most browsers & GIF tools treat `0` or `1` cs (`< 20ms`) as `100ms` fallback, OR `10ms` minimum.
 * Specifically:
 * - `rawDelayCs === 0`: standard GIF viewer default `100ms` (`wasVeryShortDelay = true`)
 * - `rawDelayCs === 1`: `10ms` (`MIN_FRAME_DURATION_MS`, `wasVeryShortDelay = true`)
 * - `rawDelayCs >= 2`: exact `rawDelayCs * 10` ms clamped to `[10..60000]`
 */
export function resolveGifDelayToDurationMs(rawDelayCs: number): {
  durationMs: number
  wasVeryShortDelay: boolean
} {
  if (rawDelayCs <= 0) {
    return {
      durationMs: DEFAULT_FRAME_DURATION_MS,
      wasVeryShortDelay: true,
    }
  }
  const ms = clampFrameDurationMs(rawDelayCs * 10)
  return {
    durationMs: ms,
    wasVeryShortDelay: ms < SHORT_GIF_FRAME_WARNING_MS,
  }
}

export interface DecodeGifOptions {
  signal?: AbortSignal
  onProgress?: (doneFrames: number, estimatedTotalFrames?: number) => void
  yieldEveryFrames?: number
}

/**
 * Pure-TS browser-local GIF87a / GIF89a binary decoder and spec-compliant frame compositor.
 * Handles:
 * - Logical Screen Descriptor & Global Color Table (GCT)
 * - Per-frame Local Color Table (LCT), sub-rectangle `(left, top, width, height)`, 4-pass Interlace
 * - Graphic Control Extension (delay time, transparent color index, Disposal Methods 0 / 1 / 2 / 3)
 * - NETSCAPE2.0 / ANIMEXTS1.0 loop count & DOTDOTMT1.0 resolution metadata extension
 */
export async function decodeGifAnimation(
  gifBytes: Uint8Array,
  options?: DecodeGifOptions
): Promise<DecodedGifAnimation> {
  if (!gifBytes || gifBytes.length < 14) {
    throw new Error('INVALID_GIF: File is too small to be a valid GIF image')
  }

  const sig = String.fromCharCode(
    gifBytes[0]!,
    gifBytes[1]!,
    gifBytes[2]!,
    gifBytes[3]!,
    gifBytes[4]!,
    gifBytes[5]!
  )
  if (sig !== 'GIF87a' && sig !== 'GIF89a') {
    throw new Error('INVALID_GIF: Missing GIF87a / GIF89a header signature')
  }

  const readU16 = (off: number) => gifBytes[off]! | (gifBytes[off + 1]! << 8)

  const screenWidth = readU16(6)
  const screenHeight = readU16(8)
  if (
    screenWidth <= 0 ||
    screenHeight <= 0 ||
    screenWidth > GIF_HARD_MAX_DIMENSION ||
    screenHeight > GIF_HARD_MAX_DIMENSION
  ) {
    throw new Error(
      `UNSUPPORTED_GIF_DIMENSIONS: ${screenWidth}×${screenHeight}px exceeds safe browser limit (${GIF_HARD_MAX_DIMENSION}px)`
    )
  }

  const packedLsd = gifBytes[10]!
  const hasGct = (packedLsd & 0x80) !== 0
  const gctSize = hasGct ? 1 << ((packedLsd & 0x07) + 1) : 0
  let pos = 13

  let globalColorTable: Uint8Array | null = null
  if (hasGct) {
    const gctByteLen = gctSize * 3
    if (pos + gctByteLen > gifBytes.length) {
      throw new Error('CORRUPT_GIF: Global Color Table exceeds file bounds')
    }
    globalColorTable = gifBytes.subarray(pos, pos + gctByteLen)
    pos += gctByteLen
  }

  // Compositing canvas (`screenWidth * screenHeight * 4`, initialized to transparent RGBA `[0,0,0,0]`)
  const canvasRgba = new Uint8ClampedArray(screenWidth * screenHeight * 4)
  // Saved canvas state for Disposal Method 3 ("Restore to Previous")
  let previousCanvasRgba: Uint8ClampedArray | null = null

  // Pending Graphic Control Extension state for the next image descriptor
  let gceDisposal = 0
  let gceHasTrans = false
  let gceTransIndex = 0
  let gceDelayCs = 0

  const resetGce = () => {
    gceDisposal = 0
    gceHasTrans = false
    gceTransIndex = 0
    gceDelayCs = 0
  }

  let loopCount: number | null = null
  let rawDotDotMetadata: string | null = null
  const frames: CompositedGifFrame[] = []
  const textDecoder = new TextDecoder('utf-8', { fatal: false })
  const yieldStep = Math.max(1, options?.yieldEveryFrames ?? 8)

  while (pos < gifBytes.length) {
    throwIfAborted(options?.signal)
    const introducer = gifBytes[pos++]!

    if (introducer === 0x3b) {
      // GIF Trailer
      break
    }

    if (introducer === 0x00) {
      // Stray padding byte tolerated by GIF readers
      continue
    }

    if (introducer === 0x21) {
      // Extension block
      if (pos >= gifBytes.length) {
        throw new Error('CORRUPT_GIF: Unexpected EOF in GIF extension header')
      }
      const label = gifBytes[pos++]!

      if (label === 0xf9) {
        // Graphic Control Extension
        const sub = readSubBlocks(gifBytes, pos)
        pos = sub.nextPos
        if (sub.data.length >= 4) {
          const packed = sub.data[0]!
          gceDisposal = (packed >>> 2) & 0x07
          gceHasTrans = (packed & 0x01) !== 0
          gceDelayCs = sub.data[1]! | (sub.data[2]! << 8)
          gceTransIndex = sub.data[3]!
        }
      } else if (label === 0xff) {
        // Application Extension
        if (pos >= gifBytes.length) {
          throw new Error('CORRUPT_GIF: Truncated Application Extension')
        }
        const appHeaderLen = gifBytes[pos++]!
        if (pos + appHeaderLen > gifBytes.length) {
          throw new Error('CORRUPT_GIF: Application Extension header exceeds bounds')
        }
        const appHeader = String.fromCharCode(
          ...Array.from(gifBytes.subarray(pos, pos + appHeaderLen))
        )
        pos += appHeaderLen
        const sub = readSubBlocks(gifBytes, pos)
        pos = sub.nextPos

        if (
          (appHeader === 'NETSCAPE2.0' || appHeader === 'ANIMEXTS1.0') &&
          sub.data.length >= 3 &&
          sub.data[0] === 0x01
        ) {
          loopCount = sub.data[1]! | (sub.data[2]! << 8)
        } else if (
          appHeader === `${DOTDOT_GIF_APP_IDENTIFIER}${DOTDOT_GIF_APP_AUTH_CODE}` &&
          sub.data.length > 0
        ) {
          rawDotDotMetadata = textDecoder.decode(sub.data)
        }
      } else {
        // Comment Extension (0xFE), Plain Text Extension (0x01), or unknown extension
        const sub = readSubBlocks(gifBytes, pos)
        pos = sub.nextPos
      }
      continue
    }

    if (introducer === 0x2c) {
      // Image Descriptor
      if (pos + 9 > gifBytes.length) {
        throw new Error('CORRUPT_GIF: Truncated Image Descriptor')
      }
      const left = readU16(pos)
      const top = readU16(pos + 2)
      const subW = readU16(pos + 4)
      const subH = readU16(pos + 6)
      const packedImg = gifBytes[pos + 8]!
      pos += 9

      if (subW <= 0 || subH <= 0) {
        throw new Error('CORRUPT_GIF: Zero-dimension GIF frame')
      }

      if (frames.length + 1 > GIF_HARD_MAX_FRAMES) {
        throw new Error(
          `TOO_MANY_GIF_FRAMES: Exceeds safe frame limit (${GIF_HARD_MAX_FRAMES} frames)`
        )
      }
      if (
        (frames.length + 1) * screenWidth * screenHeight >
        GIF_HARD_MAX_TOTAL_PIXELS
      ) {
        throw new Error(
          'GIF_MEMORY_LIMIT: Total animation pixel budget exceeds safe browser memory limit'
        )
      }

      const hasLct = (packedImg & 0x80) !== 0
      const interlaced = (packedImg & 0x40) !== 0
      const lctSize = hasLct ? 1 << ((packedImg & 0x07) + 1) : 0

      let localColorTable: Uint8Array | null = null
      if (hasLct) {
        const lctBytes = lctSize * 3
        if (pos + lctBytes > gifBytes.length) {
          throw new Error('CORRUPT_GIF: Local Color Table exceeds file bounds')
        }
        localColorTable = gifBytes.subarray(pos, pos + lctBytes)
        pos += lctBytes
      }

      if (pos >= gifBytes.length) {
        throw new Error('CORRUPT_GIF: Missing LZW minimum code size')
      }
      const lzwMinCodeSize = gifBytes[pos++]!
      const imageSub = readSubBlocks(gifBytes, pos)
      pos = imageSub.nextPos

      const rawIndices = decodeGifLzw(lzwMinCodeSize, imageSub.data, subW * subH)
      const frameIndices = interlaced
        ? deinterlaceGifIndices(rawIndices, subW, subH)
        : rawIndices

      const activePalette = localColorTable ?? globalColorTable
      const activeColorCount = localColorTable ? lctSize : gctSize

      // Snapshot canvas BEFORE painting current frame if Disposal Method === 3 ("Restore to Previous")
      if (gceDisposal === 3) {
        if (!previousCanvasRgba) {
          previousCanvasRgba = new Uint8ClampedArray(canvasRgba)
        } else {
          previousCanvasRgba.set(canvasRgba)
        }
      }

      // Composite current frame sub-rectangle onto `canvasRgba`
      for (let fy = 0; fy < subH; fy++) {
        const cy = top + fy
        if (cy < 0 || cy >= screenHeight) continue
        const srcRow = fy * subW
        const dstRow = cy * screenWidth

        for (let fx = 0; fx < subW; fx++) {
          const cx = left + fx
          if (cx < 0 || cx >= screenWidth) continue
          const cIdx = frameIndices[srcRow + fx]!

          // Transparent index in GCE leaves underlying canvas pixel untouched!
          if (gceHasTrans && cIdx === gceTransIndex) {
            continue
          }

          const dOff = (dstRow + cx) * 4
          if (activePalette && cIdx < activeColorCount) {
            const pOff = cIdx * 3
            canvasRgba[dOff] = activePalette[pOff]!
            canvasRgba[dOff + 1] = activePalette[pOff + 1]!
            canvasRgba[dOff + 2] = activePalette[pOff + 2]!
            canvasRgba[dOff + 3] = 255
          } else {
            canvasRgba[dOff] = 0
            canvasRgba[dOff + 1] = 0
            canvasRgba[dOff + 2] = 0
            canvasRgba[dOff + 3] = 255
          }
        }
      }

      // Capture completed composited frame for dotdot timeline
      const completedRgba = new Uint8ClampedArray(canvasRgba)
      const { durationMs, wasVeryShortDelay } =
        resolveGifDelayToDurationMs(gceDelayCs)

      frames.push({
        index: frames.length,
        rgba: completedRgba,
        rawDelayCs: gceDelayCs,
        durationMs,
        wasVeryShortDelay,
        disposalMethod: gceDisposal,
        rect: { left, top, width: subW, height: subH },
        hasLocalColorTable: hasLct,
        hasTransparency: gceHasTrans,
      })

      // Apply post-frame Disposal Method to `canvasRgba` for subsequent frames
      if (gceDisposal === 2) {
        // Restore to Background -> in transparent-capable GIF compositing (browsers / pixel editors), clear frame sub-rect to transparent `[0,0,0,0]`
        const x0 = Math.max(0, left)
        const y0 = Math.max(0, top)
        const x1 = Math.min(screenWidth, left + subW)
        const y1 = Math.min(screenHeight, top + subH)
        for (let cy = y0; cy < y1; cy++) {
          const rowBase = cy * screenWidth
          for (let cx = x0; cx < x1; cx++) {
            const off = (rowBase + cx) * 4
            canvasRgba[off] = 0
            canvasRgba[off + 1] = 0
            canvasRgba[off + 2] = 0
            canvasRgba[off + 3] = 0
          }
        }
      } else if (gceDisposal === 3 && previousCanvasRgba) {
        // Restore to Previous -> revert canvas state prior to this frame
        canvasRgba.set(previousCanvasRgba)
      }
      // Disposal 0 (Unspecified) & 1 (Do Not Dispose): keep `canvasRgba` as-is

      resetGce()
      options?.onProgress?.(frames.length)
      if (frames.length % yieldStep === 0) {
        await yieldToMain()
      }
      continue
    }

    throw new Error(
      `CORRUPT_GIF: Unexpected block introducer 0x${introducer.toString(16)}`
    )
  }

  if (frames.length === 0) {
    throw new Error('INVALID_GIF: GIF contains no decodable image frames')
  }

  const totalDurationMs = frames.reduce((acc, f) => acc + f.durationMs, 0)
  const shortDelayFrameCount = frames.filter((f) => f.wasVeryShortDelay).length
  const loopPlayback =
    frames.length <= 1 ? true : loopCount !== null && loopCount >= 0
  const finiteLoopCountNote =
    frames.length > 1 && loopCount !== null && loopCount > 0 ? loopCount : null

  return {
    version: sig,
    width: screenWidth,
    height: screenHeight,
    hasGlobalColorTable: hasGct,
    globalColorCount: gctSize,
    frames,
    loopCount,
    loopPlayback,
    finiteLoopCountNote,
    totalDurationMs,
    shortDelayFrameCount,
    rawDotDotMetadata,
  }
}

/**
 * Verify whether `scale` (`k x k` uniform pixel block) holds across EVERY composited frame in the GIF.
 */
export function isUniformBlockScaleAcrossAllFrames(
  frames: ReadonlyArray<{ rgba: Uint8ClampedArray | Uint8Array }>,
  width: number,
  height: number,
  scale: number
): boolean {
  if (scale <= 1) return true
  if (width % scale !== 0 || height % scale !== 0) return false
  if (frames.length === 0) return false

  for (let i = 0; i < frames.length; i++) {
    if (!isExactUniformBlockScale(frames[i]!.rgba, width, height, scale)) {
      return false
    }
  }
  return true
}

function hasMultipleDistinctPixelsAcrossFrames(
  frames: ReadonlyArray<{ rgba: Uint8ClampedArray | Uint8Array }>
): boolean {
  if (frames.length === 0) return false
  const first = frames[0]!.rgba
  if (first.length < 4) return false
  const r0 = first[0]!
  const g0 = first[1]!
  const b0 = first[2]!
  const a0 = first[3]!

  for (const frame of frames) {
    const data = frame.rgba
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a0 === 0 && a === 0) continue
      if (a !== a0 || data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0) {
        return true
      }
    }
  }
  return false
}

/**
 * Decode and inspect a GIF animation for:
 * 1. Verified `DOTDOTMT1.0` Application Extension metadata (checked against logical screen size AND all composited frames)
 * 2. Multi-frame integer uniform block scale candidates (`k >= 2` dividing `gcd(width, height)` verified across ALL frames)
 * 3. Warnings for oversized dimensions, high frame counts, `<20ms` delays, finite loop approximation, or mismatched metadata.
 */
export async function inspectGifForImport(
  gifBytes: Uint8Array,
  maxCanvasSize = 256,
  options?: DecodeGifOptions
): Promise<GifResolutionInspection> {
  const decoded = await decodeGifAnimation(gifBytes, options)
  throwIfAborted(options?.signal)

  const { width, height, frames, rawDotDotMetadata } = decoded
  const warnings: GifImportWarning[] = []

  if (width >= GIF_WARN_DIMENSION || height >= GIF_WARN_DIMENSION) {
    warnings.push({
      code: 'large-dimensions',
      detail: `${width}×${height}px`,
    })
  }
  if (frames.length >= GIF_WARN_FRAMES) {
    warnings.push({
      code: 'many-frames',
      detail: `${frames.length}`,
    })
  }
  if (decoded.shortDelayFrameCount > 0) {
    warnings.push({
      code: 'very-short-delays',
      detail: `${decoded.shortDelayFrameCount}`,
    })
  }
  if (decoded.finiteLoopCountNote !== null) {
    warnings.push({
      code: 'finite-loop-approximated',
      detail: `${decoded.finiteLoopCountNote}`,
    })
  }

  let parsedMeta: DotDotGifMetadata | null = null
  let metadataMismatchWarning = false

  if (rawDotDotMetadata) {
    try {
      const obj = JSON.parse(rawDotDotMetadata) as Partial<DotDotGifMetadata>
      if (
        obj &&
        obj.app === 'dotdot' &&
        typeof obj.originalWidth === 'number' &&
        typeof obj.originalHeight === 'number' &&
        typeof obj.scale === 'number' &&
        obj.originalWidth >= 1 &&
        obj.originalHeight >= 1 &&
        obj.scale >= 1
      ) {
        const expectedW = obj.originalWidth * obj.scale
        const expectedH = obj.originalHeight * obj.scale
        if (
          expectedW === width &&
          expectedH === height &&
          isUniformBlockScaleAcrossAllFrames(frames, width, height, obj.scale)
        ) {
          parsedMeta = {
            app: 'dotdot',
            version: 1,
            originalWidth: obj.originalWidth,
            originalHeight: obj.originalHeight,
            scale: obj.scale,
            exportedWidth: width,
            exportedHeight: height,
          }
        } else {
          metadataMismatchWarning = true
        }
      }
    } catch {
      metadataMismatchWarning = true
    }
  }

  if (metadataMismatchWarning) {
    warnings.push({ code: 'metadata-mismatch' })
  }

  const commonDiv = gcd(width, height)
  const validDivisors: number[] = []
  for (let k = 2; k <= commonDiv; k++) {
    if (commonDiv % k === 0) {
      throwIfAborted(options?.signal)
      if (isUniformBlockScaleAcrossAllFrames(frames, width, height, k)) {
        validDivisors.push(k)
      }
    }
  }

  const hasMultipleDistinct = hasMultipleDistinctPixelsAcrossFrames(frames)

  const candidates: ScaleCandidate[] = [
    {
      scale: 1,
      restoredWidth: width,
      restoredHeight: height,
      fitsCanvasLimit: width <= maxCanvasSize && height <= maxCanvasSize,
      source: parsedMeta && parsedMeta.scale === 1 ? 'metadata' : 'original',
    },
  ]

  for (const k of validDivisors) {
    const rw = width / k
    const rh = height / k
    candidates.push({
      scale: k,
      restoredWidth: rw,
      restoredHeight: rh,
      fitsCanvasLimit: rw <= maxCanvasSize && rh <= maxCanvasSize,
      source: parsedMeta && parsedMeta.scale === k ? 'metadata' : 'heuristic',
    })
  }

  let confidence: GifResolutionInspection['confidence'] = 'none'
  let recommendedScale = 1

  if (parsedMeta) {
    confidence = 'metadata'
    recommendedScale = parsedMeta.scale
  } else if (validDivisors.length > 0 && hasMultipleDistinct) {
    const fitting = validDivisors.filter(
      (k) => width / k <= maxCanvasSize && height / k <= maxCanvasSize
    )
    if (fitting.length > 0) {
      confidence = 'heuristic'
      recommendedScale = fitting[fitting.length - 1]!
    } else {
      confidence = 'heuristic'
      recommendedScale = validDivisors[validDivisors.length - 1]!
    }
  } else if (
    validDivisors.length > 0 &&
    !hasMultipleDistinct &&
    (width > maxCanvasSize || height > maxCanvasSize)
  ) {
    const fitting = validDivisors.find(
      (k) => width / k <= maxCanvasSize && height / k <= maxCanvasSize
    )
    if (fitting) {
      confidence = 'heuristic'
      recommendedScale = fitting
    }
  }

  return {
    decoded,
    confidence,
    metadata: parsedMeta,
    metadataMismatchWarning,
    recommendedScale,
    candidates,
    exceedsCanvasAt1x: width > maxCanvasSize || height > maxCanvasSize,
    warnings,
  }
}

/**
 * Downscale all composited GIF frames by `scale` (`1` for raw size) and quantize/convert
 * the entire animation into a unified 1-byte Indexed Color (`0..254` + `255` transparent)
 * dotdot timeline + single layer (`layerName`).
 */
export function prepareImportedGifAsIndexed(
  decoded: DecodedGifAnimation,
  scale: number,
  options?: {
    paletteName?: string
    layerName?: string
    signal?: AbortSignal
  }
): PreparedGifImportResult {
  throwIfAborted(options?.signal)
  const safeScale = Math.max(1, Math.trunc(scale))
  const outWidth = Math.max(1, Math.floor(decoded.width / safeScale))
  const outHeight = Math.max(1, Math.floor(decoded.height / safeScale))

  const rgbaSources: QuantizeRgbaSourceInput[] = decoded.frames.map((frame, idx) => {
    const down = downscaleByIntegerBlock(
      frame.rgba,
      decoded.width,
      decoded.height,
      safeScale
    )
    return {
      id: `frame-${idx}`,
      width: outWidth,
      height: outHeight,
      rgba: down.data,
    }
  })

  throwIfAborted(options?.signal)
  const converted = convertRgbaBuffersToIndexed(rgbaSources, {
    name: options?.paletteName || 'GIF Palette',
    colors: [],
  })

  const lut = buildPaletteRgbaLut(converted.palette)
  const layerId = generateId('layer')
  const frames: FrameMeta[] = []
  const cels: CelMap = {}
  const celBuffers: Record<string, CelBufferRuntime> = {}
  const previewFramesRgba: Uint8ClampedArray[] = []

  for (let idx = 0; idx < decoded.frames.length; idx++) {
    throwIfAborted(options?.signal)
    const srcFrame = decoded.frames[idx]!
    const frameId = generateId('frame')
    const celId = generateId('cel')
    const indexedData =
      converted.buffers.get(`frame-${idx}`) ??
      new Uint8Array(outWidth * outHeight).fill(255)

    frames.push({
      id: frameId,
      durationMs: srcFrame.durationMs,
    })

    celBuffers[celId] = {
      id: celId,
      offsetX: 0,
      offsetY: 0,
      dataWidth: outWidth,
      dataHeight: outHeight,
      data: indexedData,
    }
    cels[makeCellKey(layerId, frameId)] = {
      kind: 'cel',
      celId,
    }
    previewFramesRgba.push(indexedBufferToRgba(indexedData, lut))
  }

  const firstFrameCel = Object.values(celBuffers)[0]
  const layer: LayerRuntime = {
    id: layerId,
    name:
      options?.layerName ||
      (decoded.frames.length > 1 ? 'GIF読み込み' : 'Layer 1'),
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
    clipping: false,
    offsetX: 0,
    offsetY: 0,
    dataWidth: outWidth,
    dataHeight: outHeight,
    data: firstFrameCel
      ? new Uint8Array(firstFrameCel.data)
      : new Uint8Array(outWidth * outHeight).fill(255),
  }

  return {
    width: outWidth,
    height: outHeight,
    scale: safeScale,
    palette: converted.palette,
    layer,
    frames,
    cels,
    celBuffers,
    previewFramesRgba,
    originalOpaqueColorCount: converted.originalOpaqueColorCount,
    finalOpaqueColorCount: converted.finalOpaqueColorCount,
    wasQuantized: converted.wasQuantized,
    totalDurationMs: decoded.totalDurationMs,
    loopPlayback: decoded.loopPlayback,
  }
}
