import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  PlaybackDirection,
  ProjectPalette,
} from '../types'
import { hexToRgba } from './color'
import {
  compositeLayers,
  DEFAULT_TARGET_EXPORT_LONG_EDGE,
  getDefaultExportScale,
  getExportScaleOptions,
  MAX_EXPORT_DIMENSION,
} from './compositor'
import {
  computePlaybackFrameIndices,
  projectFrameLayers,
  roundDurationToGifMs,
} from './animation'

export type GifAlphaMode = 'dither' | 'matte'

export interface GifFrameInput {
  /** Unscaled 1x RGBA buffer of length `width * height * 4` */
  rgba: Uint8ClampedArray
  durationMs: number
}

export interface GifEncodeOptions {
  width: number
  height: number
  frames: readonly GifFrameInput[]
  /** Integer upscale multiplier (`1x`..max `<=4000px`). Defaults to `getDefaultExportScale(width, height)` (~2000px). */
  scale?: number
  /** Semi-transparent pixel handling (`0 < a < 255`): `'dither'` (4x4 Bayer) or `'matte'` (blend onto `matteColor`). */
  alphaMode?: GifAlphaMode
  /** Matte background hex (`#RRGGBB`) used when `alphaMode === 'matte'`. Default `'#221E2E'`. */
  matteColor?: string
  /** Playback direction applied when expanding `frames` (`'forward'`, `'reverse'`, `'pingpong'`). Default `'forward'`. */
  direction?: PlaybackDirection
  /** Loop infinitely (`true` -> NETSCAPE2.0 loop=0) or play once (`false` -> omit NETSCAPE2.0). Default `true`. */
  loop?: boolean
  /** Optional progress callback `(completedFrames, totalFrames)` */
  onProgress?: (completedFrames: number, totalFrames: number) => void
  /** Optional `AbortSignal` for user cancellation */
  signal?: AbortSignal
}

export interface GifTimelineExportOptions {
  width: number
  height: number
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  palette?: ProjectPalette
  scale?: number
  alphaMode?: GifAlphaMode
  matteColor?: string
  direction?: PlaybackDirection
  loop?: boolean
  onProgress?: (completedFrames: number, totalFrames: number) => void
  signal?: AbortSignal
}

export interface GifEncodeResult {
  gif: Uint8Array
  outWidth: number
  outHeight: number
  scale: number
  encodedFrameCount: number
  hasVeryShortFrameWarning: boolean
}

const BAYER_4X4: ReadonlyArray<number> = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]

class ByteWriter {
  private buf: Uint8Array
  private pos = 0

  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity)
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra
    if (needed <= this.buf.length) return
    let nextCap = this.buf.length * 2
    while (nextCap < needed) nextCap *= 2
    const next = new Uint8Array(nextCap)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  writeByte(b: number): void {
    this.ensure(1)
    this.buf[this.pos++] = b & 0xff
  }

  writeU16LE(v: number): void {
    this.ensure(2)
    this.buf[this.pos++] = v & 0xff
    this.buf[this.pos++] = (v >>> 8) & 0xff
  }

  writeBytes(bytes: Uint8Array | readonly number[]): void {
    this.ensure(bytes.length)
    if (bytes instanceof Uint8Array) {
      this.buf.set(bytes, this.pos)
      this.pos += bytes.length
    } else {
      for (let i = 0; i < bytes.length; i++) {
        this.buf[this.pos++] = bytes[i]! & 0xff
      }
    }
  }

  writeAscii(str: string): void {
    this.ensure(str.length)
    for (let i = 0; i < str.length; i++) {
      this.buf[this.pos++] = str.charCodeAt(i) & 0x7f
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

interface ColorBox {
  colors: Uint32Array
  counts: Uint32Array
  rMin: number
  rMax: number
  gMin: number
  gMax: number
  bMin: number
  bMax: number
  totalPixels: number
}

function computeBoxBounds(colors: Uint32Array, counts: Uint32Array): ColorBox {
  let rMin = 255
  let rMax = 0
  let gMin = 255
  let gMax = 0
  let bMin = 255
  let bMax = 0
  let totalPixels = 0

  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]!
    const r = (c >>> 16) & 0xff
    const g = (c >>> 8) & 0xff
    const b = c & 0xff
    if (r < rMin) rMin = r
    if (r > rMax) rMax = r
    if (g < gMin) gMin = g
    if (g > gMax) gMax = g
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
    totalPixels += counts[i]!
  }

  return { colors, counts, rMin, rMax, gMin, gMax, bMin, bMax, totalPixels }
}

/**
 * Median-cut quantizer reducing unique 24-bit RGB colors down to `<= maxColors`.
 */
function medianCutPalette(
  uniqueRgb: Uint32Array,
  counts: Uint32Array,
  maxColors: number
): Uint32Array {
  if (uniqueRgb.length <= maxColors) {
    return uniqueRgb.slice()
  }

  const boxes: ColorBox[] = [computeBoxBounds(uniqueRgb, counts)]

  while (boxes.length < maxColors) {
    // Pick splittable box with largest channel range * log(population)
    let bestIdx = -1
    let bestScore = -1
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!
      if (box.colors.length <= 1) continue
      const rSpan = box.rMax - box.rMin
      const gSpan = box.gMax - box.gMin
      const bSpan = box.bMax - box.bMin
      const maxSpan = Math.max(rSpan, gSpan, bSpan)
      if (maxSpan <= 0) continue
      const score = maxSpan * Math.sqrt(box.totalPixels)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    if (bestIdx < 0) break

    const target = boxes[bestIdx]!
    const rSpan = target.rMax - target.rMin
    const gSpan = target.gMax - target.gMin
    const bSpan = target.bMax - target.bMin
    const shift = rSpan >= gSpan && rSpan >= bSpan ? 16 : gSpan >= bSpan ? 8 : 0

    const indices = Array.from({ length: target.colors.length }, (_, k) => k)
    indices.sort(
      (a, b) =>
        ((target.colors[a]! >>> shift) & 0xff) -
        ((target.colors[b]! >>> shift) & 0xff)
    )

    let acc = 0
    const half = target.totalPixels / 2
    let splitPos = Math.floor(indices.length / 2)
    for (let i = 0; i < indices.length - 1; i++) {
      acc += target.counts[indices[i]!]!
      if (acc >= half) {
        splitPos = i + 1
        break
      }
    }
    splitPos = Math.max(1, Math.min(indices.length - 1, splitPos))

    const leftColors = new Uint32Array(splitPos)
    const leftCounts = new Uint32Array(splitPos)
    for (let i = 0; i < splitPos; i++) {
      const idx = indices[i]!
      leftColors[i] = target.colors[idx]!
      leftCounts[i] = target.counts[idx]!
    }

    const rightLen = indices.length - splitPos
    const rightColors = new Uint32Array(rightLen)
    const rightCounts = new Uint32Array(rightLen)
    for (let i = 0; i < rightLen; i++) {
      const idx = indices[splitPos + i]!
      rightColors[i] = target.colors[idx]!
      rightCounts[i] = target.counts[idx]!
    }

    boxes.splice(
      bestIdx,
      1,
      computeBoxBounds(leftColors, leftCounts),
      computeBoxBounds(rightColors, rightCounts)
    )
  }

  const palette = new Uint32Array(boxes.length)
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!
    let rSum = 0
    let gSum = 0
    let bSum = 0
    let wSum = 0
    for (let j = 0; j < box.colors.length; j++) {
      const c = box.colors[j]!
      const w = box.counts[j]!
      rSum += ((c >>> 16) & 0xff) * w
      gSum += ((c >>> 8) & 0xff) * w
      bSum += (c & 0xff) * w
      wSum += w
    }
    const denom = Math.max(1, wSum)
    const r = Math.round(rSum / denom) & 0xff
    const g = Math.round(gSum / denom) & 0xff
    const b = Math.round(bSum / denom) & 0xff
    palette[i] = (r << 16) | (g << 8) | b
  }

  return palette
}

interface IndexedFrame1x {
  indices1x: Uint8Array
  /** Power-of-two padded RGB table of length `paletteSize * 3` (`paletteSize` in `2..256`) */
  colorTableBytes: Uint8Array
  /** `0..7` where `paletteSize = 1 << (colorTableSizeField + 1)` */
  colorTableSizeField: number
  hasTransparency: boolean
  transparentIndex: number
}

/**
 * Quantize a `width * height` RGBA buffer into `<= 256` indexed colors with 1-bit transparency.
 * - `'dither'`: 4x4 Bayer threshold converts semi-transparent `0 < a < 255` into crisp opaque/transparent pixels without muddying colors.
 * - `'matte'`: blends `0 < a < 255` onto `matteRgb` while keeping `a === 0` strictly transparent!
 */
export function quantizeRgbaFrame1x(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMode: GifAlphaMode,
  matteRgb: { r: number; g: number; b: number }
): IndexedFrame1x {
  const pixelCount = width * height
  const resolvedRgb = new Int32Array(pixelCount) // -1 = transparent, else 0xRRGGBB
  const histogram = new Map<number, number>()
  let hasTransparency = false

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    const bayerRow = (y & 3) << 2
    for (let x = 0; x < width; x++) {
      const p = rowOffset + x
      const i = p * 4
      const a = rgba[i + 3]!

      if (a === 0) {
        resolvedRgb[p] = -1
        hasTransparency = true
        continue
      }

      let r = rgba[i]!
      let g = rgba[i + 1]!
      let b = rgba[i + 2]!

      if (a < 255) {
        if (alphaMode === 'dither') {
          const threshold = ((BAYER_4X4[bayerRow + (x & 3)]! + 0.5) * 255) / 16
          if (a < threshold) {
            resolvedRgb[p] = -1
            hasTransparency = true
            continue
          }
          // Keep pure foreground RGB (no semi-transparent color muddying)
        } else {
          // Matte blend onto `matteRgb`
          const alphaNorm = a / 255
          const inv = 1 - alphaNorm
          r = Math.round(r * alphaNorm + matteRgb.r * inv)
          g = Math.round(g * alphaNorm + matteRgb.g * inv)
          b = Math.round(b * alphaNorm + matteRgb.b * inv)
        }
      }

      const rgb24 = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
      resolvedRgb[p] = rgb24
      histogram.set(rgb24, (histogram.get(rgb24) ?? 0) + 1)
    }
  }

  const maxOpaqueColors = hasTransparency ? 255 : 256
  const uniqueLen = histogram.size
  const uniqueColors = new Uint32Array(uniqueLen)
  const uniqueCounts = new Uint32Array(uniqueLen)
  let ptr = 0
  for (const [rgb24, count] of histogram.entries()) {
    uniqueColors[ptr] = rgb24
    uniqueCounts[ptr] = count
    ptr++
  }

  const opaquePalette =
    uniqueLen === 0
      ? new Uint32Array([0x000000])
      : medianCutPalette(uniqueColors, uniqueCounts, maxOpaqueColors)

  // Map every unique color in `histogram` to its exact or nearest index in `opaquePalette`
  const colorToIndex = new Map<number, number>()
  if (uniqueLen <= maxOpaqueColors) {
    for (let i = 0; i < opaquePalette.length; i++) {
      colorToIndex.set(opaquePalette[i]!, i)
    }
  } else {
    for (let u = 0; u < uniqueLen; u++) {
      const c = uniqueColors[u]!
      const cr = (c >>> 16) & 0xff
      const cg = (c >>> 8) & 0xff
      const cb = c & 0xff
      let bestIdx = 0
      let bestDist = Infinity
      for (let p = 0; p < opaquePalette.length; p++) {
        const pc = opaquePalette[p]!
        const dr = cr - ((pc >>> 16) & 0xff)
        const dg = cg - ((pc >>> 8) & 0xff)
        const db = cb - (pc & 0xff)
        const dist = dr * dr * 3 + dg * dg * 4 + db * db * 2
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = p
          if (dist === 0) break
        }
      }
      colorToIndex.set(c, bestIdx)
    }
  }

  const totalUsedSlots = opaquePalette.length + (hasTransparency ? 1 : 0)
  let pow2 = 2
  let sizeField = 0
  while (pow2 < totalUsedSlots && pow2 < 256) {
    pow2 <<= 1
    sizeField++
  }

  const transparentIndex = hasTransparency ? opaquePalette.length : 0
  const colorTableBytes = new Uint8Array(pow2 * 3)
  for (let i = 0; i < opaquePalette.length; i++) {
    const c = opaquePalette[i]!
    colorTableBytes[i * 3] = (c >>> 16) & 0xff
    colorTableBytes[i * 3 + 1] = (c >>> 8) & 0xff
    colorTableBytes[i * 3 + 2] = c & 0xff
  }

  const indices1x = new Uint8Array(pixelCount)
  for (let p = 0; p < pixelCount; p++) {
    const rgb24 = resolvedRgb[p]!
    if (rgb24 < 0) {
      indices1x[p] = transparentIndex
    } else {
      indices1x[p] = colorToIndex.get(rgb24) ?? 0
    }
  }

  return {
    indices1x,
    colorTableBytes,
    colorTableSizeField: sizeField,
    hasTransparency,
    transparentIndex,
  }
}

/**
 * Nearest-neighbor integer upscale of an indexed 1x pixel buffer (`width * height` -> `(width*scale) * (height*scale)`).
 */
export function upscaleIndexedNearestNeighbor(
  srcIndices: Uint8Array,
  width: number,
  height: number,
  scale: number
): Uint8Array {
  const s = Math.max(1, Math.trunc(scale))
  if (s === 1) return srcIndices
  const outW = width * s
  const outH = height * s
  const dst = new Uint8Array(outW * outH)

  for (let y = 0; y < height; y++) {
    const srcRowOffset = y * width
    const firstDstRowOffset = y * s * outW
    for (let x = 0; x < width; x++) {
      const val = srcIndices[srcRowOffset + x]!
      dst.fill(val, firstDstRowOffset + x * s, firstDstRowOffset + (x + 1) * s)
    }
    const firstRowSlice = dst.subarray(firstDstRowOffset, firstDstRowOffset + outW)
    for (let sy = 1; sy < s; sy++) {
      dst.set(firstRowSlice, firstDstRowOffset + sy * outW)
    }
  }

  return dst
}

/**
 * Fast GIF89a LZW encoder using an open-addressing hash table (`8192` slots for `4096` max dictionary entries)
 * writing directly into GIF 255-byte sub-blocks.
 */
function writeLzwCompressedImageData(
  writer: ByteWriter,
  indices: Uint8Array,
  colorTableSizeField: number
): void {
  const colorBits = colorTableSizeField + 1
  const minCodeSize = Math.max(2, colorBits)
  writer.writeByte(minCodeSize)

  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1

  // Hash table of size 8192 (prime-like power-of-two mask 8191): key = (prefix << 8) | suffix + 1
  const HASH_SIZE = 8192
  const HASH_MASK = HASH_SIZE - 1
  const hashKeys = new Int32Array(HASH_SIZE)
  const hashCodes = new Uint16Array(HASH_SIZE)

  const subBlock = new Uint8Array(255)
  let subLen = 0
  let bitBuf = 0
  let bitCount = 0

  const flushSubBlock = () => {
    if (subLen > 0) {
      writer.writeByte(subLen)
      writer.writeBytes(subBlock.subarray(0, subLen))
      subLen = 0
    }
  }

  const emitCode = (code: number, width: number) => {
    bitBuf |= code << bitCount
    bitCount += width
    while (bitCount >= 8) {
      subBlock[subLen++] = bitBuf & 0xff
      if (subLen === 255) {
        flushSubBlock()
      }
      bitBuf >>>= 8
      bitCount -= 8
    }
  }

  let nextCode = eoiCode + 1
  let codeSize = minCodeSize + 1
  let maxCodeForSize = 1 << codeSize

  const resetTable = () => {
    hashKeys.fill(0)
    nextCode = eoiCode + 1
    codeSize = minCodeSize + 1
    maxCodeForSize = 1 << codeSize
  }

  resetTable()
  emitCode(clearCode, codeSize)

  if (indices.length > 0) {
    let prefix = indices[0]!
    for (let i = 1; i < indices.length; i++) {
      const suffix = indices[i]!
      const key = ((prefix << 8) | suffix) + 1
      let slot = ((prefix << 5) ^ suffix) & HASH_MASK
      let foundCode = -1

      while (true) {
        const existingKey = hashKeys[slot]!
        if (existingKey === 0) break
        if (existingKey === key) {
          foundCode = hashCodes[slot]!
          break
        }
        slot = (slot + 1) & HASH_MASK
      }

      if (foundCode >= 0) {
        prefix = foundCode
      } else {
        emitCode(prefix, codeSize)
        if (nextCode < 4096) {
          hashKeys[slot] = key
          hashCodes[slot] = nextCode
          if (nextCode === maxCodeForSize && codeSize < 12) {
            codeSize++
            maxCodeForSize = 1 << codeSize
          }
          nextCode++
        } else {
          emitCode(clearCode, codeSize)
          resetTable()
        }
        prefix = suffix
      }
    }
    emitCode(prefix, codeSize)
  }

  emitCode(eoiCode, codeSize)
  if (bitCount > 0) {
    subBlock[subLen++] = bitBuf & 0xff
    if (subLen === 255) {
      flushSubBlock()
    }
  }
  flushSubBlock()
  writer.writeByte(0x00) // Block terminator
}

function resolveValidatedScale(width: number, height: number, requestedScale?: number): number {
  const validOptions = getExportScaleOptions(width, height, MAX_EXPORT_DIMENSION)
  const maxAllowed = validOptions[validOptions.length - 1]?.scale ?? 1
  if (requestedScale === undefined) {
    return getDefaultExportScale(
      width,
      height,
      DEFAULT_TARGET_EXPORT_LONG_EDGE,
      MAX_EXPORT_DIMENSION
    )
  }
  return Math.max(1, Math.min(maxAllowed, Math.trunc(requestedScale)))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('GIF encoding aborted')
    err.name = 'AbortError'
    throw err
  }
}

function writeGifFrameBlock(
  writer: ByteWriter,
  indexed: IndexedFrame1x,
  width1x: number,
  height1x: number,
  scale: number,
  centiseconds: number
): void {
  const outW = width1x * scale
  const outH = height1x * scale

  // Graphic Control Extension (0x21 0xF9)
  // Disposal Method = 2 (Restore to background -> clears frame area to transparent before next frame!)
  const disposalMethod = 2
  const packedGce =
    ((disposalMethod & 0x07) << 2) | (indexed.hasTransparency ? 0x01 : 0x00)
  writer.writeByte(0x21)
  writer.writeByte(0xf9)
  writer.writeByte(0x04)
  writer.writeByte(packedGce)
  writer.writeU16LE(Math.max(1, Math.min(65535, centiseconds)))
  writer.writeByte(indexed.hasTransparency ? indexed.transparentIndex : 0)
  writer.writeByte(0x00)

  // Image Descriptor (0x2C) with Local Color Table
  writer.writeByte(0x2c)
  writer.writeU16LE(0) // left
  writer.writeU16LE(0) // top
  writer.writeU16LE(outW)
  writer.writeU16LE(outH)
  const packedImg = 0x80 | (indexed.colorTableSizeField & 0x07)
  writer.writeByte(packedImg)

  // Local Color Table
  writer.writeBytes(indexed.colorTableBytes)

  // Upscale 1x indices via crisp nearest-neighbor & LZW compress
  const scaledIndices = upscaleIndexedNearestNeighbor(
    indexed.indices1x,
    width1x,
    height1x,
    scale
  )
  writeLzwCompressedImageData(writer, scaledIndices, indexed.colorTableSizeField)
}

/**
 * Synchronous GIF89a encoder (ideal for deterministic unit tests and lightweight frames).
 */
export function encodeAnimatedGifSync(options: GifEncodeOptions): GifEncodeResult {
  const {
    width,
    height,
    frames,
    alphaMode = 'dither',
    matteColor = '#221E2E',
    direction = 'forward',
    loop = true,
    onProgress,
    signal,
  } = options

  if (frames.length === 0) {
    throw new Error('At least 1 frame is required to encode GIF')
  }
  throwIfAborted(signal)

  const scale = resolveValidatedScale(width, height, options.scale)
  const outWidth = width * scale
  const outHeight = height * scale
  const matteRgba = hexToRgba(matteColor) ?? { r: 34, g: 30, b: 46, a: 255 }

  const sequence = computePlaybackFrameIndices(frames.length, direction, !loop)
  const writer = new ByteWriter(Math.max(65536, outWidth * outHeight))

  // GIF89a Header + Logical Screen Descriptor (no Global Color Table; each frame carries an exact Local Color Table)
  writer.writeAscii('GIF89a')
  writer.writeU16LE(outWidth)
  writer.writeU16LE(outHeight)
  writer.writeByte(0x70) // GCT=0, Color Resolution=7 (8 bits/channel), Sort=0, GCT Size=0
  writer.writeByte(0x00) // Background color index
  writer.writeByte(0x00) // Pixel aspect ratio

  // NETSCAPE2.0 Infinite Loop Application Extension (only when loop === true and sequence.length >= 1)
  if (loop) {
    writer.writeBytes([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, // "NETSCAPE2.0"
      0x03, 0x01,
      0x00, 0x00, // Loop count = 0 (infinite)
      0x00,
    ])
  }

  let hasVeryShortFrameWarning = false
  for (let sIdx = 0; sIdx < sequence.length; sIdx++) {
    throwIfAborted(signal)
    const srcFrame = frames[sequence[sIdx]!]!
    const { centiseconds, isVeryShort } = roundDurationToGifMs(srcFrame.durationMs)
    if (isVeryShort) hasVeryShortFrameWarning = true

    const indexed = quantizeRgbaFrame1x(
      srcFrame.rgba,
      width,
      height,
      alphaMode,
      matteRgba
    )
    writeGifFrameBlock(writer, indexed, width, height, scale, centiseconds)
    onProgress?.(sIdx + 1, sequence.length)
  }

  writer.writeByte(0x3b) // GIF Trailer
  return {
    gif: writer.toUint8Array(),
    outWidth,
    outHeight,
    scale,
    encodedFrameCount: sequence.length,
    hasVeryShortFrameWarning,
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Asynchronous GIF89a encoder that yields between frames so progress UI updates smoothly
 * and `AbortController` cancellation responds immediately even on large 4000px multi-frame exports!
 */
export async function encodeAnimatedGif(
  options: GifEncodeOptions
): Promise<GifEncodeResult> {
  const {
    width,
    height,
    frames,
    alphaMode = 'dither',
    matteColor = '#221E2E',
    direction = 'forward',
    loop = true,
    onProgress,
    signal,
  } = options

  if (frames.length === 0) {
    throw new Error('At least 1 frame is required to encode GIF')
  }
  throwIfAborted(signal)

  const scale = resolveValidatedScale(width, height, options.scale)
  const outWidth = width * scale
  const outHeight = height * scale
  const matteRgba = hexToRgba(matteColor) ?? { r: 34, g: 30, b: 46, a: 255 }

  const sequence = computePlaybackFrameIndices(frames.length, direction, !loop)
  const writer = new ByteWriter(Math.max(65536, outWidth * outHeight))

  writer.writeAscii('GIF89a')
  writer.writeU16LE(outWidth)
  writer.writeU16LE(outHeight)
  writer.writeByte(0x70)
  writer.writeByte(0x00)
  writer.writeByte(0x00)

  if (loop) {
    writer.writeBytes([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01,
      0x00, 0x00,
      0x00,
    ])
  }

  let hasVeryShortFrameWarning = false
  for (let sIdx = 0; sIdx < sequence.length; sIdx++) {
    throwIfAborted(signal)
    const srcFrame = frames[sequence[sIdx]!]!
    const { centiseconds, isVeryShort } = roundDurationToGifMs(srcFrame.durationMs)
    if (isVeryShort) hasVeryShortFrameWarning = true

    const indexed = quantizeRgbaFrame1x(
      srcFrame.rgba,
      width,
      height,
      alphaMode,
      matteRgba
    )
    writeGifFrameBlock(writer, indexed, width, height, scale, centiseconds)
    onProgress?.(sIdx + 1, sequence.length)

    if (sIdx < sequence.length - 1) {
      await yieldToEventLoop()
    }
  }

  throwIfAborted(signal)
  writer.writeByte(0x3b)
  return {
    gif: writer.toUint8Array(),
    outWidth,
    outHeight,
    scale,
    encodedFrameCount: sequence.length,
    hasVeryShortFrameWarning,
  }
}

/**
 * Convenience helper: composites every frame in a dotdot `TimelineState` (1-frame still or N-frame animation)
 * and encodes into an animated GIF89a with progress & cancel support.
 */
export async function exportTimelineAnimatedGif(
  opts: GifTimelineExportOptions
): Promise<GifEncodeResult> {
  const {
    width,
    height,
    layerMetas,
    frames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    palette,
    ...rest
  } = opts

  const frameInputs: GifFrameInput[] =
    frames.length >= 1 && Object.keys(cels).length > 0
      ? frames.map((f) => {
          const projected = projectFrameLayers(
            layerMetas,
            cels,
            celBuffers,
            f.id,
            width,
            height
          )
          return {
            rgba: compositeLayers(projected, width, height, { palette }),
            durationMs: f.durationMs,
          }
        })
      : [
          {
            rgba: compositeLayers(fallbackSingleFrameLayers ?? [], width, height, {
              palette,
            }),
            durationMs: frames[0]?.durationMs ?? 100,
          },
        ]

  return encodeAnimatedGif({
    width,
    height,
    frames: frameInputs,
    ...rest,
  })
}
