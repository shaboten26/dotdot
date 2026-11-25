import { zlibSync, unzlibSync } from 'fflate'
import type { BlendMode, LayerRuntime } from '../types'
import { clampByte } from './color'
import { createPixelBuffer, extractLayerCanvasView } from './pixelBuffer'

export const MAX_LAYERS = 100
export const MAX_EXPORT_DIMENSION = 4000
export const DEFAULT_TARGET_EXPORT_LONG_EDGE = 2000

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
  /** Optional canvas-space override pixel buffer (`width * height * 4`) for a specific layer */
  previewLayerOverride?: {
    layerId: string
    data: Uint8ClampedArray
  } | null
}

/**
 * Sample `[0..width-1, 0..height-1]` canvas view for a layer (honoring `offsetX`, `offsetY`, `dataWidth`, `dataHeight`).
 */
function resolveLayerCanvasBuffer(
  layer: LayerRuntime,
  width: number,
  height: number,
  override?: CompositeOptions['previewLayerOverride']
): Uint8ClampedArray {
  if (override && override.layerId === layer.id) {
    return override.data
  }
  return extractLayerCanvasView(layer, width, height)
}

/**
 * Composite all layers from bottom (`index 0`) to top (`layers.length - 1`) onto `[0..width-1, 0..height-1]`.
 * Off-canvas pixels stored inside each layer's backing buffer remain safely preserved!
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

    let groupEnd = i + 1
    while (groupEnd < layers.length && layers[groupEnd].clipping) {
      groupEnd++
    }

    const hasClippedChildren = groupEnd > i + 1

    if (!baseLayer.visible || baseLayer.opacity <= 0) {
      i = groupEnd
      continue
    }

    const baseData = resolveLayerCanvasBuffer(baseLayer, width, height, override)
    const baseOpacityNorm = Math.max(0, Math.min(100, baseLayer.opacity)) / 100

    if (!hasClippedChildren) {
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
        const clipData = resolveLayerCanvasBuffer(clipLayer, width, height, override)
        const clipOp = Math.max(0, Math.min(100, clipLayer.opacity)) / 100

        for (let p = 0; p < totalPixels; p++) {
          const idx = p * 4
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
 * Merge `upper` layer down into `lower` layer across the UNION of both layers' world-space bounding boxes
 * so off-canvas pixels on either layer are preserved!
 */
export function mergeTwoLayers(
  lower: LayerRuntime,
  upper: LayerRuntime,
  width: number,
  height: number
): {
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
  data: Uint8ClampedArray
} {
  const lOx = lower.offsetX ?? 0
  const lOy = lower.offsetY ?? 0
  const lW = lower.dataWidth ?? width
  const lH = lower.dataHeight ?? height

  const uOx = upper.offsetX ?? 0
  const uOy = upper.offsetY ?? 0
  const uW = upper.dataWidth ?? width
  const uH = upper.dataHeight ?? height

  const minX = Math.min(0, lOx, upper.clipping ? lOx : uOx)
  const minY = Math.min(0, lOy, upper.clipping ? lOy : uOy)
  const maxX = Math.max(width, lOx + lW, upper.clipping ? lOx + lW : uOx + uW)
  const maxY = Math.max(height, lOy + lH, upper.clipping ? lOy + lH : uOy + uH)

  const unionW = Math.max(1, maxX - minX)
  const unionH = Math.max(1, maxY - minY)

  // Shift both layers into the union coordinate frame `[0..unionW, 0..unionH]`
  const shiftedLower: LayerRuntime = {
    ...lower,
    offsetX: lOx - minX,
    offsetY: lOy - minY,
    dataWidth: lW,
    dataHeight: lH,
    blendMode: 'normal',
    clipping: false,
  }
  const shiftedUpper: LayerRuntime = {
    ...upper,
    offsetX: uOx - minX,
    offsetY: uOy - minY,
    dataWidth: uW,
    dataHeight: uH,
  }

  const mergedData = compositeLayers([shiftedLower, shiftedUpper], unionW, unionH)
  return {
    offsetX: minX,
    offsetY: minY,
    dataWidth: unionW,
    dataHeight: unionH,
    data: mergedData,
  }
}

export interface ExportScaleOption {
  scale: number
  width: number
  height: number
  label: string
}

/**
 * Compute all valid integer upscale multipliers where neither width nor height exceeds `maxDimension` (default 4000px).
 * `1x` is always included.
 */
export function getExportScaleOptions(
  width: number,
  height: number,
  maxDimension = MAX_EXPORT_DIMENSION
): ExportScaleOption[] {
  const options: ExportScaleOption[] = []
  const maxSide = Math.max(1, Math.max(width, height))
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
 * Compute initial default integer export scale whose output long edge is <= 2000px
 * and as close as possible to 2000px (`Math.max(1, Math.floor(2000 / max(canvasWidth, canvasHeight)))`),
 * clamped to valid options `<= 4000px`.
 * Shared across both PNG and GIF exports.
 * Examples:
 * - `256 × 256` -> `7x` (`1792 × 1792px`)
 * - `128 × 128` -> `15x` (`1920 × 1920px`)
 * - `96 × 96`   -> `20x` (`1920 × 1920px`)
 * - `80 × 80`   -> `25x` (`2000 × 2000px`)
 * - `64 × 64`   -> `31x` (`1984 × 1984px`)
 * - `32 × 32`   -> `62x` (`1984 × 1984px`)
 */
export function getDefaultExportScale(
  width: number,
  height: number,
  targetLongEdge = DEFAULT_TARGET_EXPORT_LONG_EDGE,
  maxDimension = MAX_EXPORT_DIMENSION
): number {
  const options = getExportScaleOptions(width, height, maxDimension)
  if (options.length === 0) return 1

  const maxSide = Math.max(1, Math.max(width, height))
  const maxAllowed = options[options.length - 1]!.scale
  const floorScale = Math.max(1, Math.floor(targetLongEdge / maxSide))
  return Math.min(maxAllowed, floorScale)
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

    const templateRow = dst.subarray(firstDestRowStart, firstDestRowStart + rowByteLen)
    for (let sy = 1; sy < s; sy++) {
      dst.set(templateRow, firstDestRowStart + sy * rowByteLen)
    }
  }

  return { data: dst, width: outW, height: outH }
}

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
 */
export function encodeRgbaToPng(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = new Uint8Array(13)
  writeUint32BE(ihdrData, 0, width)
  writeUint32BE(ihdrData, 4, height)
  ihdrData[8] = 8
  ihdrData[9] = 6
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdrChunk = makePngChunk('IHDR', ihdrData)

  const stride = width * 4
  const rawScanlines = new Uint8Array(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const dstStart = y * (1 + stride)
    rawScanlines[dstStart] = 0
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
 * Full pipeline: composite layers onto `[0..width-1, 0..height-1]` and export scaled nearest-neighbor PNG bytes.
 */
export function exportCompositePngBytes(
  layers: readonly LayerRuntime[],
  width: number,
  height: number,
  scale: number
): { png: Uint8Array; outWidth: number; outHeight: number } {
  const maxSide = Math.max(width, height)
  const clampedScale = Math.max(
    1,
    Math.min(Math.floor(MAX_EXPORT_DIMENSION / maxSide), Math.trunc(scale))
  )
  const flat = compositeLayers(layers, width, height)
  const scaled = upscaleNearestNeighbor(flat, width, height, clampedScale)
  const png = encodeRgbaToPng(scaled.data, scaled.width, scaled.height)
  return {
    png,
    outWidth: scaled.width,
    outHeight: scaled.height,
  }
}
