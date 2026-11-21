import { zlibSync, unzlibSync } from 'fflate'
import type { BlendMode, LayerRuntime } from '../types'
import { clampByte } from './color'
import { createPixelBuffer } from './pixelBuffer'

export const MAX_LAYERS = 50
export const MAX_EXPORT_DIMENSION = 2000

/**
 * Apply per-channel blend function for normalized [0..1] backdrop `b` and source `s`.
 */
export function blendChannel(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case 'normal':
      return s
    case 'multiply':
      return b * s
    case 'screen':
      return 1 - (1 - b) * (1 - s)
    case 'overlay':
      return b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)
    case 'darken':
      return Math.min(b, s)
    case 'lighten':
      return Math.max(b, s)
    case 'add':
      return Math.min(1, b + s)
    case 'difference':
      return Math.abs(b - s)
  }
}

/**
 * Porter-Duff source-over with W3C compositing blend mode for a single pixel.
 * Writes result into `out` at byte offset `idx`.
 */
function compositePixel(
  out: Uint8ClampedArray,
  idx: number,
  sr: number,
  sg: number,
  sb: number,
  saNorm: number,
  mode: BlendMode
): void {
  if (saNorm <= 0) return

  const daNorm = out[idx + 3] / 255
  if (daNorm <= 0) {
    out[idx] = sr
    out[idx + 1] = sg
    out[idx + 2] = sb
    out[idx + 3] = clampByte(saNorm * 255)
    return
  }

  const br = out[idx] / 255
  const bg = out[idx + 1] / 255
  const bb = out[idx + 2] / 255

  const srN = sr / 255
  const sgN = sg / 255
  const sbN = sb / 255

  const cr =
    mode === 'normal'
      ? srN
      : (1 - daNorm) * srN + daNorm * blendChannel(mode, br, srN)
  const cg =
    mode === 'normal'
      ? sgN
      : (1 - daNorm) * sgN + daNorm * blendChannel(mode, bg, sgN)
  const cb =
    mode === 'normal'
      ? sbN
      : (1 - daNorm) * sbN + daNorm * blendChannel(mode, bb, sbN)

  const outA = saNorm + daNorm * (1 - saNorm)
  if (outA <= 0) {
    out[idx] = 0
    out[idx + 1] = 0
    out[idx + 2] = 0
    out[idx + 3] = 0
    return
  }

  const outR = (saNorm * cr + daNorm * br * (1 - saNorm)) / outA
  const outG = (saNorm * cg + daNorm * bg * (1 - saNorm)) / outA
  const outB = (saNorm * cb + daNorm * bb * (1 - saNorm)) / outA

  out[idx] = clampByte(outR * 255)
  out[idx + 1] = clampByte(outG * 255)
  out[idx + 2] = clampByte(outB * 255)
  out[idx + 3] = clampByte(outA * 255)
}

export interface CompositeOptions {
  /** Optional override pixel buffer for a specific layer (used for live stroke / tool preview) */
  previewLayerOverride?: {
    layerId: string
    data: Uint8ClampedArray
  } | null
}

/**
 * Composite all layers from bottom (`index 0`) to top (`layers.length - 1`).
 * Used identically for both viewport canvas display and PNG export (Section 17-2).
 *
 * Supports:
 * - Layer visibility
 * - Layer opacity (0..100%)
 * - Blend modes (normal, multiply, screen, overlay, darken, lighten, add, difference)
 * - Clipping masks (clipped layers are constrained to the alpha of the base layer directly below the clipping group)
 */
export function compositeLayers(
  layers: readonly LayerRuntime[],
  width: number,
  height: number,
  options?: CompositeOptions
): Uint8ClampedArray {
  const result = createPixelBuffer(width, height)
  const totalPixels = width * height
  const override = options?.previewLayerOverride

  let i = 0
  while (i < layers.length) {
    const baseLayer = layers[i]
    const baseData =
      override && override.layerId === baseLayer.id ? override.data : baseLayer.data

    // Gather any consecutive clipping layers immediately above `baseLayer` (only if baseLayer itself is not an orphan bottom clip, though bottom layer ignores clipping)
    let groupEnd = i + 1
    while (groupEnd < layers.length && layers[groupEnd].clipping) {
      groupEnd++
    }

    const hasClippedChildren = groupEnd > i + 1

    if (!baseLayer.visible || baseLayer.opacity <= 0) {
      // When base of a clipping group is hidden or 0% opacity, all layers clipped to it are also masked out
      i = groupEnd
      continue
    }

    const baseOpacityNorm = Math.max(0, Math.min(100, baseLayer.opacity)) / 100

    if (!hasClippedChildren) {
      // Fast path: composite single layer directly onto `result`
      for (let p = 0; p < totalPixels; p++) {
        const idx = p * 4
        const rawA = baseData[idx + 3]
        if (rawA === 0) continue
        const effA = (rawA / 255) * baseOpacityNorm
        compositePixel(
          result,
          idx,
          baseData[idx],
          baseData[idx + 1],
          baseData[idx + 2],
          effA,
          baseLayer.blendMode
        )
      }
    } else {
      // Clipping group:
      // Start from unmultiplied base RGB (alpha = 1 inside base's non-zero region), blend clipped children onto base RGB,
      // then composite the resulting group pixel onto `result` using baseLayer's effective alpha & blendMode.
      const groupBuf = createPixelBuffer(width, height)
      for (let p = 0; p < totalPixels; p++) {
        const idx = p * 4
        if (baseData[idx + 3] === 0) continue
        groupBuf[idx] = baseData[idx]
        groupBuf[idx + 1] = baseData[idx + 1]
        groupBuf[idx + 2] = baseData[idx + 2]
        groupBuf[idx + 3] = 255
      }

      for (let c = i + 1; c < groupEnd; c++) {
        const clipLayer = layers[c]
        if (!clipLayer.visible || clipLayer.opacity <= 0) continue
        const clipData =
          override && override.layerId === clipLayer.id ? override.data : clipLayer.data
        const clipOp = Math.max(0, Math.min(100, clipLayer.opacity)) / 100

        for (let p = 0; p < totalPixels; p++) {
          const idx = p * 4
          // Constrained strictly by base layer's alpha > 0
          if (baseData[idx + 3] === 0) continue
          const cRawA = clipData[idx + 3]
          if (cRawA === 0) continue
          const cEffA = (cRawA / 255) * clipOp
          compositePixel(
            groupBuf,
            idx,
            clipData[idx],
            clipData[idx + 1],
            clipData[idx + 2],
            cEffA,
            clipLayer.blendMode
          )
        }
      }

      // Now composite the clipped group onto `result` with base layer's alpha & blend mode
      for (let p = 0; p < totalPixels; p++) {
        const idx = p * 4
        const rawA = baseData[idx + 3]
        if (rawA === 0) continue
        const effA = (rawA / 255) * baseOpacityNorm
        compositePixel(
          result,
          idx,
          groupBuf[idx],
          groupBuf[idx + 1],
          groupBuf[idx + 2],
          effA,
          baseLayer.blendMode
        )
      }
    }

    i = groupEnd
  }

  return result
}

/**
 * Merge `upper` layer down into `lower` layer, returning the merged pixel buffer
 * (preserving `lower`'s blendMode and clipping setting, normalizing merged layer opacity to 100%).
 */
export function mergeTwoLayers(
  lower: LayerRuntime,
  upper: LayerRuntime,
  width: number,
  height: number
): Uint8ClampedArray {
  const tempLower: LayerRuntime = {
    ...lower,
    blendMode: 'normal',
    clipping: false,
  }
  const tempUpper: LayerRuntime = {
    ...upper,
  }
  return compositeLayers([tempLower, tempUpper], width, height)
}

export interface ExportScaleOption {
  scale: number
  width: number
  height: number
  label: string
}

/**
 * Compute all valid integer upscale multipliers where neither width nor height exceeds 2000px.
 * 1x is always included.
 */
export function getExportScaleOptions(
  width: number,
  height: number,
  maxDimension = MAX_EXPORT_DIMENSION
): ExportScaleOption[] {
  const options: ExportScaleOption[] = []
  const maxSide = Math.max(width, height)
  const maxScale = Math.max(1, Math.floor(maxDimension / maxSide))

  for (let scale = 1; scale <= maxScale; scale++) {
    const w = width * scale
    const h = height * scale
    if (scale > 1 && (w > maxDimension || h > maxDimension)) break
    options.push({
      scale,
      width: w,
      height: h,
      label: `${scale}x (${w}×${h}px)`,
    })
  }
  return options
}

/**
 * Pure integer nearest-neighbor upscale of RGBA buffer.
 * Zero color interpolation or anti-aliasing.
 */
export function upscaleNearestNeighbor(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number
): { data: Uint8ClampedArray; width: number; height: number } {
  const s = Math.max(1, Math.trunc(scale))
  if (s === 1) {
    return { data: new Uint8ClampedArray(src), width, height }
  }

  const outW = width * s
  const outH = height * s
  const dst = new Uint8ClampedArray(outW * outH * 4)

  const rowByteLen = outW * 4

  for (let y = 0; y < height; y++) {
    const firstDestRowStart = y * s * rowByteLen
    // Fill the first scaled scanline for row `y`
    for (let x = 0; x < width; x++) {
      const sIdx = (y * width + x) * 4
      const r = src[sIdx]
      const g = src[sIdx + 1]
      const b = src[sIdx + 2]
      const a = src[sIdx + 3]

      let dIdx = firstDestRowStart + x * s * 4
      for (let sx = 0; sx < s; sx++) {
        dst[dIdx] = r
        dst[dIdx + 1] = g
        dst[dIdx + 2] = b
        dst[dIdx + 3] = a
        dIdx += 4
      }
    }

    // Copy that exact scanline `s - 1` more times vertically
    const templateRow = dst.subarray(firstDestRowStart, firstDestRowStart + rowByteLen)
    for (let sy = 1; sy < s; sy++) {
      dst.set(templateRow, firstDestRowStart + sy * rowByteLen)
    }
  }

  return { data: dst, width: outW, height: outH }
}

// Precomputed CRC32 table for standard PNG chunks
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function writeUint32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff
  buf[offset + 1] = (val >>> 16) & 0xff
  buf[offset + 2] = (val >>> 8) & 0xff
  buf[offset + 3] = val & 0xff
}

function makePngChunk(typeAscii: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  writeUint32BE(chunk, 0, data.length)
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = typeAscii.charCodeAt(i)
  }
  chunk.set(data, 8)
  const crcVal = crc32(chunk.subarray(4, 8 + data.length))
  writeUint32BE(chunk, 8 + data.length, crcVal)
  return chunk
}

/**
 * Lossless pure-JS 8-bit RGBA PNG encoder.
 * Guarantees exact pixel values and transparent background with zero browser color-profile shifts.
 */
export function encodeRgbaToPng(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR (13 bytes): width(4), height(4), bitDepth=8, colorType=6 (RGBA), compression=0, filter=0, interlace=0
  const ihdrData = new Uint8Array(13)
  writeUint32BE(ihdrData, 0, width)
  writeUint32BE(ihdrData, 4, height)
  ihdrData[8] = 8
  ihdrData[9] = 6
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdrChunk = makePngChunk('IHDR', ihdrData)

  // Raw scanlines: 1 filter byte (0 = None) + width * 4 RGBA bytes per row
  const stride = width * 4
  const rawScanlines = new Uint8Array(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const dstStart = y * (1 + stride)
    rawScanlines[dstStart] = 0 // Filter type 0 (None)
    const srcStart = y * stride
    rawScanlines.set(rgba.subarray(srcStart, srcStart + stride), dstStart + 1)
  }

  const compressed = zlibSync(rawScanlines, { level: 6 })
  const idatChunk = makePngChunk('IDAT', compressed)
  const iendChunk = makePngChunk('IEND', new Uint8Array(0))

  const png = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  )
  let offset = 0
  png.set(signature, offset)
  offset += signature.length
  png.set(ihdrChunk, offset)
  offset += ihdrChunk.length
  png.set(idatChunk, offset)
  offset += idatChunk.length
  png.set(iendChunk, offset)

  return png
}

/**
 * Minimal lossless PNG decoder (supports 8-bit RGBA filter=0 generated by encodeRgbaToPng)
 * used for automated round-trip tests.
 */
export function decodePngBasic(png: Uint8Array): {
  width: number
  height: number
  data: Uint8ClampedArray
} {
  const readU32 = (off: number) =>
    ((png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3]) >>> 0

  let pos = 8
  let width = 0
  let height = 0
  const idatParts: Uint8Array[] = []

  while (pos + 8 <= png.length) {
    const len = readU32(pos)
    const type = String.fromCharCode(
      png[pos + 4],
      png[pos + 5],
      png[pos + 6],
      png[pos + 7]
    )
    const chunkData = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = readU32(pos + 8)
      height = readU32(pos + 12)
    } else if (type === 'IDAT') {
      idatParts.push(chunkData)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  const totalIdat = idatParts.reduce((s, p) => s + p.length, 0)
  const mergedIdat = new Uint8Array(totalIdat)
  let off = 0
  for (const part of idatParts) {
    mergedIdat.set(part, off)
    off += part.length
  }

  const raw = unzlibSync(mergedIdat)
  const stride = width * 4
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride) + 1
    out.set(raw.subarray(rowStart, rowStart + stride), y * stride)
  }

  return { width, height, data: out }
}

/**
 * Full pipeline: composite layers and export scaled nearest-neighbor PNG bytes.
 */
export function exportCompositePngBytes(
  layers: readonly LayerRuntime[],
  width: number,
  height: number,
  scale: number
): { png: Uint8Array; outWidth: number; outHeight: number } {
  const maxSide = Math.max(width, height)
  const clampedScale = Math.max(1, Math.min(Math.floor(MAX_EXPORT_DIMENSION / maxSide), Math.trunc(scale)))
  const flat = compositeLayers(layers, width, height)
  const scaled = upscaleNearestNeighbor(flat, width, height, clampedScale)
  const png = encodeRgbaToPng(scaled.data, scaled.width, scaled.height)
  return {
    png,
    outWidth: scaled.width,
    outHeight: scaled.height,
  }
}
