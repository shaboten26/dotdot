import { unzlibSync } from 'fflate'
import {
  DOTDOT_PNG_META_KEYWORD,
  type DotDotPngMetadata,
} from './compositor'
import { rgbaToHex } from './color'
import {
  buildPaletteRgbaLut,
  convertRgbaBuffersToIndexed,
  indexedBufferToRgba,
  MAX_OPAQUE_PALETTE_COLORS,
} from './indexedPalette'
import type { ProjectPalette } from '../types'

export interface DecodedPngImage {
  width: number
  height: number
  /** Lossless 8-bit RGBA pixels of length `width * height * 4` */
  data: Uint8ClampedArray
  textChunks: Record<string, string>
}

export interface ScaleCandidate {
  scale: number
  restoredWidth: number
  restoredHeight: number
  fitsCanvasLimit: boolean
  source: 'metadata' | 'heuristic' | 'original'
}

export interface PngResolutionInspection {
  decoded: DecodedPngImage
  confidence: 'metadata' | 'heuristic' | 'none'
  metadata: DotDotPngMetadata | null
  metadataMismatchWarning: boolean
  recommendedScale: number
  candidates: ScaleCandidate[]
  exceedsCanvasAt1x: boolean
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10] as const

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilterPass(
  raw: Uint8Array,
  startOffset: number,
  passWidth: number,
  passHeight: number,
  bitsPerPixel: number
): { unfiltered: Uint8Array; nextOffset: number } {
  if (passWidth === 0 || passHeight === 0) {
    return { unfiltered: new Uint8Array(0), nextOffset: startOffset }
  }
  const stride = Math.ceil((passWidth * bitsPerPixel) / 8)
  const bppBytes = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const out = new Uint8Array(passHeight * stride)
  let pos = startOffset

  for (let y = 0; y < passHeight; y++) {
    if (pos >= raw.length) {
      throw new Error('CORRUPT_PNG: Truncated scanline data')
    }
    const filterType = raw[pos++]!
    const dstRow = y * stride
    const prevRow = (y - 1) * stride

    if (pos + stride > raw.length) {
      throw new Error('CORRUPT_PNG: Scanline exceeds decompressed IDAT length')
    }

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x]!
      const left = x >= bppBytes ? out[dstRow + x - bppBytes]! : 0
      const up = y > 0 ? out[prevRow + x]! : 0
      const upLeft = y > 0 && x >= bppBytes ? out[prevRow + x - bppBytes]! : 0

      let recon = rawByte
      if (filterType === 0) {
        recon = rawByte
      } else if (filterType === 1) {
        recon = (rawByte + left) & 0xff
      } else if (filterType === 2) {
        recon = (rawByte + up) & 0xff
      } else if (filterType === 3) {
        recon = (rawByte + ((left + up) >>> 1)) & 0xff
      } else if (filterType === 4) {
        recon = (rawByte + paethPredictor(left, up, upLeft)) & 0xff
      } else {
        throw new Error(`CORRUPT_PNG: Invalid PNG filter type ${filterType}`)
      }
      out[dstRow + x] = recon
    }
    pos += stride
  }

  return { unfiltered: out, nextOffset: pos }
}

function unpackScanlinesToRgba(
  unfiltered: Uint8Array,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  plte: Uint8Array | null,
  trns: Uint8Array | null
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  if (width === 0 || height === 0) return out

  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : 4
  const bitsPerPixel = channels * bitDepth
  const stride = Math.ceil((width * bitsPerPixel) / 8)

  const readSample = (rowOffset: number, sampleIdx: number): number => {
    if (bitDepth === 8) {
      return unfiltered[rowOffset + sampleIdx]!
    }
    if (bitDepth === 16) {
      const hi = unfiltered[rowOffset + sampleIdx * 2]!
      const lo = unfiltered[rowOffset + sampleIdx * 2 + 1]!
      return Math.round(((hi << 8) | lo) / 257)
    }
    const bitPos = sampleIdx * bitDepth
    const byteIdx = rowOffset + (bitPos >>> 3)
    const shift = 8 - bitDepth - (bitPos & 7)
    const mask = (1 << bitDepth) - 1
    return (unfiltered[byteIdx]! >>> shift) & mask
  }

  const scaleSubByte = (val: number): number => {
    if (bitDepth === 1) return val * 255
    if (bitDepth === 2) return val * 85
    if (bitDepth === 4) return val * 17
    return val
  }

  // Transparent key color for Grayscale (0) / Truecolor (2)
  const transGray =
    colorType === 0 && trns && trns.length >= 2
      ? bitDepth === 16
        ? Math.round(((trns[0]! << 8) | trns[1]!) / 257)
        : scaleSubByte(trns[1]! & ((1 << bitDepth) - 1))
      : -1

  const hasTransRgb = colorType === 2 && trns && trns.length >= 6
  const transR = hasTransRgb
    ? bitDepth === 16
      ? Math.round(((trns![0]! << 8) | trns![1]!) / 257)
      : trns![1]!
    : -1
  const transG = hasTransRgb
    ? bitDepth === 16
      ? Math.round(((trns![2]! << 8) | trns![3]!) / 257)
      : trns![3]!
    : -1
  const transB = hasTransRgb
    ? bitDepth === 16
      ? Math.round(((trns![4]! << 8) | trns![5]!) / 257)
      : trns![5]!
    : -1

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride
    for (let x = 0; x < width; x++) {
      const dIdx = (y * width + x) * 4
      if (colorType === 6) {
        out[dIdx] = readSample(rowOff, x * 4)
        out[dIdx + 1] = readSample(rowOff, x * 4 + 1)
        out[dIdx + 2] = readSample(rowOff, x * 4 + 2)
        out[dIdx + 3] = readSample(rowOff, x * 4 + 3)
      } else if (colorType === 2) {
        const r = readSample(rowOff, x * 3)
        const g = readSample(rowOff, x * 3 + 1)
        const b = readSample(rowOff, x * 3 + 2)
        out[dIdx] = r
        out[dIdx + 1] = g
        out[dIdx + 2] = b
        out[dIdx + 3] =
          hasTransRgb && r === transR && g === transG && b === transB ? 0 : 255
      } else if (colorType === 3) {
        const pIdx = readSample(rowOff, x)
        if (!plte || pIdx * 3 + 2 >= plte.length) {
          out[dIdx] = 0
          out[dIdx + 1] = 0
          out[dIdx + 2] = 0
          out[dIdx + 3] = 0
        } else {
          out[dIdx] = plte[pIdx * 3]!
          out[dIdx + 1] = plte[pIdx * 3 + 1]!
          out[dIdx + 2] = plte[pIdx * 3 + 2]!
          out[dIdx + 3] = trns && pIdx < trns.length ? trns[pIdx]! : 255
        }
      } else if (colorType === 0) {
        const g = scaleSubByte(readSample(rowOff, x))
        out[dIdx] = g
        out[dIdx + 1] = g
        out[dIdx + 2] = g
        out[dIdx + 3] = g === transGray ? 0 : 255
      } else if (colorType === 4) {
        const g = readSample(rowOff, x * 2)
        const a = readSample(rowOff, x * 2 + 1)
        out[dIdx] = g
        out[dIdx + 1] = g
        out[dIdx + 2] = g
        out[dIdx + 3] = a
      }
    }
  }

  return out
}

/**
 * Pure-TS lossless PNG binary decoder supporting all PNG color types (`0, 2, 3, 4, 6`),
 * all 5 scanline filters (`None, Sub, Up, Average, Paeth`), Adam7 interlace, and `tEXt`/`zTXt`/`iTXt` metadata chunks.
 */
export function decodePngLossless(pngBytes: Uint8Array): DecodedPngImage {
  if (!pngBytes || pngBytes.length < 33) {
    throw new Error('INVALID_PNG: File is too small to be a valid PNG image')
  }
  for (let i = 0; i < 8; i++) {
    if (pngBytes[i] !== PNG_SIG[i]) {
      throw new Error('INVALID_PNG: Missing PNG file signature')
    }
  }

  const readU32 = (off: number) =>
    ((pngBytes[off]! << 24) |
      (pngBytes[off + 1]! << 16) |
      (pngBytes[off + 2]! << 8) |
      pngBytes[off + 3]!) >>>
    0

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  let sawIhdr = false
  let plte: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idatParts: Uint8Array[] = []
  const textChunks: Record<string, string> = {}
  const decoder = new TextDecoder('utf-8', { fatal: false })

  while (pos + 8 <= pngBytes.length) {
    const len = readU32(pos)
    if (pos + 12 + len > pngBytes.length) {
      throw new Error('CORRUPT_PNG: Chunk length exceeds file bounds')
    }
    const type = String.fromCharCode(
      pngBytes[pos + 4]!,
      pngBytes[pos + 5]!,
      pngBytes[pos + 6]!,
      pngBytes[pos + 7]!
    )
    const data = pngBytes.subarray(pos + 8, pos + 8 + len)

    if (type === 'IHDR') {
      if (len < 13) throw new Error('CORRUPT_PNG: Invalid IHDR chunk')
      width = readU32(pos + 8)
      height = readU32(pos + 12)
      bitDepth = data[8]!
      colorType = data[9]!
      const compression = data[10]!
      const filter = data[11]!
      interlace = data[12]!
      if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
        throw new Error(`UNSUPPORTED_PNG_DIMENSIONS: ${width}x${height}`)
      }
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
        throw new Error('CORRUPT_PNG: Unsupported PNG header parameters')
      }
      sawIhdr = true
    } else if (type === 'PLTE') {
      plte = data
    } else if (type === 'tRNS') {
      trns = data
    } else if (type === 'IDAT') {
      idatParts.push(data)
    } else if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) {
        const key = decoder.decode(data.subarray(0, nul))
        const val = decoder.decode(data.subarray(nul + 1))
        textChunks[key] = val
      }
    } else if (type === 'zTXt') {
      const nul = data.indexOf(0)
      if (nul > 0 && nul + 2 <= data.length && data[nul + 1] === 0) {
        try {
          const key = decoder.decode(data.subarray(0, nul))
          const inflated = unzlibSync(data.subarray(nul + 2))
          textChunks[key] = decoder.decode(inflated)
        } catch {
          // ignore non-critical zTXt decompression failure
        }
      }
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0)
      if (nul > 0 && nul + 3 <= data.length) {
        const key = decoder.decode(data.subarray(0, nul))
        const compFlag = data[nul + 1]!
        let p = nul + 3
        const langEnd = data.indexOf(0, p)
        if (langEnd >= 0) {
          p = langEnd + 1
          const transEnd = data.indexOf(0, p)
          if (transEnd >= 0) {
            p = transEnd + 1
            try {
              const rawText =
                compFlag === 1 ? unzlibSync(data.subarray(p)) : data.subarray(p)
              textChunks[key] = decoder.decode(rawText)
            } catch {
              // ignore non-critical iTXt failure
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break
    }

    pos += 12 + len
  }

  if (!sawIhdr || idatParts.length === 0) {
    throw new Error('CORRUPT_PNG: Missing IHDR or IDAT image data')
  }

  const totalIdat = idatParts.reduce((acc, part) => acc + part.length, 0)
  const mergedIdat = new Uint8Array(totalIdat)
  let writeOff = 0
  for (const part of idatParts) {
    mergedIdat.set(part, writeOff)
    writeOff += part.length
  }

  let decompressed: Uint8Array
  try {
    decompressed = unzlibSync(mergedIdat)
  } catch {
    throw new Error('CORRUPT_PNG: Failed to decompress PNG image data')
  }

  const channels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : 4
  const bitsPerPixel = channels * bitDepth

  if (interlace === 0) {
    const { unfiltered } = unfilterPass(decompressed, 0, width, height, bitsPerPixel)
    const rgba = unpackScanlinesToRgba(
      unfiltered,
      width,
      height,
      bitDepth,
      colorType,
      plte,
      trns
    )
    return { width, height, data: rgba, textChunks }
  }

  // Adam7 7-pass progressive PNG support
  const ADAM7_X0 = [0, 4, 0, 2, 0, 1, 0]
  const ADAM7_DX = [8, 8, 4, 4, 2, 2, 1]
  const ADAM7_Y0 = [0, 0, 4, 0, 2, 0, 1]
  const ADAM7_DY = [8, 8, 8, 4, 4, 2, 2]
  const fullRgba = new Uint8ClampedArray(width * height * 4)
  let rawCursor = 0

  for (let pass = 0; pass < 7; pass++) {
    const x0 = ADAM7_X0[pass]!
    const dx = ADAM7_DX[pass]!
    const y0 = ADAM7_Y0[pass]!
    const dy = ADAM7_DY[pass]!
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0
    if (pw === 0 || ph === 0) continue

    const { unfiltered, nextOffset } = unfilterPass(
      decompressed,
      rawCursor,
      pw,
      ph,
      bitsPerPixel
    )
    rawCursor = nextOffset
    const subRgba = unpackScanlinesToRgba(
      unfiltered,
      pw,
      ph,
      bitDepth,
      colorType,
      plte,
      trns
    )

    for (let py = 0; py < ph; py++) {
      const dstY = y0 + py * dy
      for (let px = 0; px < pw; px++) {
        const dstX = x0 + px * dx
        const sIdx = (py * pw + px) * 4
        const dIdx = (dstY * width + dstX) * 4
        fullRgba[dIdx] = subRgba[sIdx]!
        fullRgba[dIdx + 1] = subRgba[sIdx + 1]!
        fullRgba[dIdx + 2] = subRgba[sIdx + 2]!
        fullRgba[dIdx + 3] = subRgba[sIdx + 3]!
      }
    }
  }

  return { width, height, data: fullRgba, textChunks }
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
 * Verify whether EVERY `k x k` block in `rgba` (`width x height`) consists of a strictly uniform RGBA value.
 * Transparent pixels (`a === 0`) are treated as matching any other `a === 0` pixel regardless of RGB noise.
 */
export function isExactUniformBlockScale(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  scale: number
): boolean {
  if (scale <= 1) return true
  if (width % scale !== 0 || height % scale !== 0) return false

  const blocksW = width / scale
  const blocksH = height / scale

  for (let by = 0; by < blocksH; by++) {
    const baseY = by * scale
    for (let bx = 0; bx < blocksW; bx++) {
      const baseX = bx * scale
      const firstIdx = (baseY * width + baseX) * 4
      const r0 = rgba[firstIdx]!
      const g0 = rgba[firstIdx + 1]!
      const b0 = rgba[firstIdx + 2]!
      const a0 = rgba[firstIdx + 3]!

      for (let dy = 0; dy < scale; dy++) {
        const rowOff = (baseY + dy) * width
        for (let dx = 0; dx < scale; dx++) {
          if (dx === 0 && dy === 0) continue
          const idx = (rowOff + baseX + dx) * 4
          const a = rgba[idx + 3]!
          if (a0 === 0 && a === 0) continue
          if (
            a !== a0 ||
            rgba[idx] !== r0 ||
            rgba[idx + 1] !== g0 ||
            rgba[idx + 2] !== b0
          ) {
            return false
          }
        }
      }
    }
  }

  return true
}

/**
 * Downsample an exact `scale x scale` nearest-neighbor upscaled buffer back to `1x` losslessly.
 */
export function downscaleByIntegerBlock(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  scale: number
): { width: number; height: number; data: Uint8ClampedArray } {
  const k = Math.max(1, Math.trunc(scale))
  if (k === 1) {
    return {
      width,
      height,
      data: new Uint8ClampedArray(rgba),
    }
  }
  const outW = Math.max(1, Math.floor(width / k))
  const outH = Math.max(1, Math.floor(height / k))
  const out = new Uint8ClampedArray(outW * outH * 4)

  for (let y = 0; y < outH; y++) {
    const sy = y * k
    for (let x = 0; x < outW; x++) {
      const sx = x * k
      const sIdx = (sy * width + sx) * 4
      const dIdx = (y * outW + x) * 4
      const a = rgba[sIdx + 3]!
      if (a === 0) {
        out[dIdx] = 0
        out[dIdx + 1] = 0
        out[dIdx + 2] = 0
        out[dIdx + 3] = 0
      } else {
        out[dIdx] = rgba[sIdx]!
        out[dIdx + 1] = rgba[sIdx + 1]!
        out[dIdx + 2] = rgba[sIdx + 2]!
        out[dIdx + 3] = a
      }
    }
  }

  return { width: outW, height: outH, data: out }
}

/**
 * Inspect a PNG byte buffer for:
 * 1. Deterministic `dotdot-meta` `tEXt` chunk (verified against image dimensions AND uniform pixel blocks so edited/blurred PNGs never false-trigger!)
 * 2. Heuristic integer `k x k` uniform pixel-block detection across all divisors of `gcd(width, height)`
 * 3. Safe fallback to `1x` original PNG size when uncertain or non-uniform.
 */
export function inspectPngForImport(
  pngBytes: Uint8Array,
  maxCanvasSize = 256
): PngResolutionInspection {
  const decoded = decodePngLossless(pngBytes)
  const { width, height, data, textChunks } = decoded

  let parsedMeta: DotDotPngMetadata | null = null
  let metadataMismatchWarning = false

  const rawMetaStr = textChunks[DOTDOT_PNG_META_KEYWORD]
  if (rawMetaStr) {
    try {
      const obj = JSON.parse(rawMetaStr) as Partial<DotDotPngMetadata>
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
          isExactUniformBlockScale(data, width, height, obj.scale)
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

  // Enumerate all exact uniform block divisors `k >= 2` of `gcd(width, height)`
  const commonDiv = gcd(width, height)
  const validDivisors: number[] = []
  for (let k = 2; k <= commonDiv; k++) {
    if (commonDiv % k === 0) {
      if (isExactUniformBlockScale(data, width, height, k)) {
        validDivisors.push(k)
      }
    }
  }

  // Check if entire image is a single solid/transparent color (avoid collapsing a blank 64x64 canvas to 1x1 by default!)
  let hasMultipleDistinctPixels = false
  if (width * height > 1) {
    const r0 = data[0]!
    const g0 = data[1]!
    const b0 = data[2]!
    const a0 = data[3]!
    for (let i = 4; i < data.length; i += 4) {
      const a = data[i + 3]!
      if (a0 === 0 && a === 0) continue
      if (a !== a0 || data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0) {
        hasMultipleDistinctPixels = true
        break
      }
    }
  }

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

  let confidence: PngResolutionInspection['confidence'] = 'none'
  let recommendedScale = 1

  if (parsedMeta) {
    confidence = 'metadata'
    recommendedScale = parsedMeta.scale
  } else if (validDivisors.length > 0 && hasMultipleDistinctPixels) {
    // Pick the largest uniform block scale `k` (i.e. finest true 1px pixel-art base grid) that fits `maxCanvasSize`
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
    !hasMultipleDistinctPixels &&
    (width > maxCanvasSize || height > maxCanvasSize)
  ) {
    // Solid oversized image: suggest smallest divisor that brings it within canvas limit
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
  }
}

/**
 * Extract up to `maxColors` (default 255 opaque colors; `255` reserved for transparent) unique `#RRGGBB` palette colors
 * from an RGBA buffer, ordered by frequency descending.
 */
export function extractPaletteColorsFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  fallbackPalette: readonly string[] = ['#000000', '#FFFFFF'],
  maxColors = MAX_OPAQUE_PALETTE_COLORS
): string[] {
  const counts = new Map<string, number>()
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const hex = rgbaToHex({
      r: rgba[i]!,
      g: rgba[i + 1]!,
      b: rgba[i + 2]!,
    }).toUpperCase()
    counts.set(hex, (counts.get(hex) ?? 0) + 1)
  }

  if (counts.size === 0) {
    return fallbackPalette.length > 0
      ? fallbackPalette.slice(0, maxColors)
      : ['#000000', '#FFFFFF']
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColors)
    .map(([hex]) => hex)
}

export interface ImportedPngIndexedPreview {
  width: number
  height: number
  /** 1-byte per pixel Indexed Color buffer (`width * height`) */
  indexedData: Uint8Array
  /** Resulting `ProjectPalette` (`<= 255` opaque colors) */
  palette: ProjectPalette
  /** Temporary RGBA preview of `indexedData` for before/after visual verification in UI */
  previewRgba: Uint8ClampedArray
  originalOpaqueColorCount: number
  finalOpaqueColorCount: number
  wasQuantized: boolean
  hadSemiTransparentPixels: boolean
  semiTransparentPixelCount: number
}

/**
 * Convert a downscaled/1x imported PNG RGBA buffer into 1-byte Indexed Color (`0..254` + `255` transparent)
 * with perceptual quantization (>255 colors) and 4x4 Bayer semi-transparent dithering (Section 9-2).
 */
export function prepareImportedPngAsIndexed(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  preferredPalette?: ProjectPalette | null
): ImportedPngIndexedPreview {
  const converted = convertRgbaBuffersToIndexed(
    [{ id: 'png', width, height, rgba }],
    preferredPalette
  )
  const indexedData = converted.buffers.get('png')!
  const lut = buildPaletteRgbaLut(converted.palette)
  const previewRgba = indexedBufferToRgba(indexedData, lut)

  return {
    width,
    height,
    indexedData,
    palette: converted.palette,
    previewRgba,
    originalOpaqueColorCount: converted.originalOpaqueColorCount,
    finalOpaqueColorCount: converted.finalOpaqueColorCount,
    wasQuantized: converted.wasQuantized,
    hadSemiTransparentPixels: converted.hadSemiTransparentPixels,
    semiTransparentPixelCount: converted.semiTransparentPixelCount,
  }
}
