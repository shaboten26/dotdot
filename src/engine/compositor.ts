import { zlibSync, unzlibSync } from 'fflate'
import {
  TRANSPARENT_INDEX,
  type BlendMode,
  type LayerRuntime,
  type ProjectPalette,
} from '../types'
import { clampByte, rgbaToHex } from './color'
import {
  addColorToIndexedPalette,
  BAYER_4X4,
  buildPaletteRgbaLut,
  findExactFixedIndex,
  findNearestFixedIndex,
  normalizeProjectPalette,
} from './indexedPalette'
import { extractLayerCanvasView } from './pixelBuffer'

export const MAX_LAYERS = 100
export const MAX_EXPORT_DIMENSION = 4000
export const DEFAULT_TARGET_EXPORT_LONG_EDGE = 2000

const FALLBACK_DEFAULT_PALETTE: ProjectPalette = normalizeProjectPalette({
  name: 'Default',
  colors: ['#000000', '#FFFFFF'],
})

export function createRgbaBuffer(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(Math.max(0, Math.trunc(width) * Math.trunc(height) * 4))
}

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

  const daNorm = out[idx + 3]! / 255
  if (daNorm <= 0) {
    out[idx] = sr
    out[idx + 1] = sg
    out[idx + 2] = sb
    out[idx + 3] = clampByte(saNorm * 255)
    return
  }

  const br = out[idx]! / 255
  const bg = out[idx + 1]! / 255
  const bb = out[idx + 2]! / 255

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
  /** Palette or prebuilt 1024-byte RGBA LUT used to resolve 1-byte pixel indices */
  palette?: ProjectPalette | Uint8ClampedArray
  /** Optional canvas-space 1-byte Indexed Color override buffer (`width * height`) for live stroke preview */
  previewLayerOverride?: {
    layerId: string
    data: Uint8Array
  } | null
}

function resolveLut(
  paletteOrLut?: ProjectPalette | Uint8ClampedArray
): Uint8ClampedArray {
  if (!paletteOrLut) {
    return buildPaletteRgbaLut(FALLBACK_DEFAULT_PALETTE)
  }
  if (paletteOrLut instanceof Uint8ClampedArray) {
    return paletteOrLut
  }
  return buildPaletteRgbaLut(paletteOrLut)
}

function resolveLayerIndexedCanvasBuffer(
  layer: LayerRuntime,
  width: number,
  height: number,
  override?: CompositeOptions['previewLayerOverride']
): Uint8Array {
  if (override && override.layerId === layer.id) {
    return override.data
  }
  return extractLayerCanvasView(layer, width, height)
}

/**
 * Composite all 1-byte Indexed Color layers from bottom (`index 0`) to top (`layers.length - 1`)
 * into a temporary `Uint8ClampedArray` RGBA buffer (`width * height * 4`) for viewport display or export.
 * Preserves layer opacity (`0..100`), all 8 blend modes, and clipping masks (Section 7-5).
 */
export function compositeLayers(
  layers: readonly LayerRuntime[],
  width: number,
  height: number,
  options?: CompositeOptions
): Uint8ClampedArray {
  const result = createRgbaBuffer(width, height)
  const totalPixels = width * height
  const override = options?.previewLayerOverride
  const lut = resolveLut(options?.palette)

  let i = 0
  while (i < layers.length) {
    const baseLayer = layers[i]!

    let groupEnd = i + 1
    while (groupEnd < layers.length && layers[groupEnd]!.clipping) {
      groupEnd++
    }

    const hasClippedChildren = groupEnd > i + 1

    if (!baseLayer.visible || baseLayer.opacity <= 0) {
      i = groupEnd
      continue
    }

    const baseIndices = resolveLayerIndexedCanvasBuffer(
      baseLayer,
      width,
      height,
      override
    )
    const baseOpacityNorm = Math.max(0, Math.min(100, baseLayer.opacity)) / 100

    if (!hasClippedChildren) {
      for (let p = 0; p < totalPixels; p++) {
        const pIdx = baseIndices[p]!
        if (pIdx === TRANSPARENT_INDEX) continue
        const lutOff = pIdx * 4
        if (lut[lutOff + 3] === 0) continue
        compositePixel(
          result,
          p * 4,
          lut[lutOff]!,
          lut[lutOff + 1]!,
          lut[lutOff + 2]!,
          baseOpacityNorm,
          baseLayer.blendMode
        )
      }
    } else {
      const groupBuf = createRgbaBuffer(width, height)
      for (let p = 0; p < totalPixels; p++) {
        const pIdx = baseIndices[p]!
        if (pIdx === TRANSPARENT_INDEX) continue
        const lutOff = pIdx * 4
        if (lut[lutOff + 3] === 0) continue
        const idx = p * 4
        groupBuf[idx] = lut[lutOff]!
        groupBuf[idx + 1] = lut[lutOff + 1]!
        groupBuf[idx + 2] = lut[lutOff + 2]!
        groupBuf[idx + 3] = 255
      }

      for (let c = i + 1; c < groupEnd; c++) {
        const clipLayer = layers[c]!
        if (!clipLayer.visible || clipLayer.opacity <= 0) continue
        const clipIndices = resolveLayerIndexedCanvasBuffer(
          clipLayer,
          width,
          height,
          override
        )
        const clipOp = Math.max(0, Math.min(100, clipLayer.opacity)) / 100

        for (let p = 0; p < totalPixels; p++) {
          const bPIdx = baseIndices[p]!
          if (bPIdx === TRANSPARENT_INDEX || lut[bPIdx * 4 + 3] === 0) continue
          const cPIdx = clipIndices[p]!
          if (cPIdx === TRANSPARENT_INDEX) continue
          const cLutOff = cPIdx * 4
          if (lut[cLutOff + 3] === 0) continue
          compositePixel(
            groupBuf,
            p * 4,
            lut[cLutOff]!,
            lut[cLutOff + 1]!,
            lut[cLutOff + 2]!,
            clipOp,
            clipLayer.blendMode
          )
        }
      }

      for (let p = 0; p < totalPixels; p++) {
        const bPIdx = baseIndices[p]!
        if (bPIdx === TRANSPARENT_INDEX || lut[bPIdx * 4 + 3] === 0) continue
        const idx = p * 4
        compositePixel(
          result,
          idx,
          groupBuf[idx]!,
          groupBuf[idx + 1]!,
          groupBuf[idx + 2]!,
          baseOpacityNorm,
          baseLayer.blendMode
        )
      }
    }

    i = groupEnd
  }

  return result
}

/**
 * Merge `upper` layer down into `lower` layer across the UNION of both layers' world-space bounding boxes,
 * returning a 1-byte Indexed Color buffer and updated `ProjectPalette` (allocates blended colors up to 255 max,
 * falling back to nearest perceptual palette color when palette is full).
 */
export function mergeTwoLayers(
  lower: LayerRuntime,
  upper: LayerRuntime,
  width: number,
  height: number,
  palette: ProjectPalette = FALLBACK_DEFAULT_PALETTE
): {
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
  data: Uint8Array
  nextPalette: ProjectPalette
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

  // Fast pure-indexed path when both layers are 100% opaque normal blend!
  let workingPalette = normalizeProjectPalette(palette)
  if (
    lower.opacity >= 100 &&
    upper.opacity >= 100 &&
    upper.blendMode === 'normal'
  ) {
    const out = new Uint8Array(unionW * unionH)
    out.fill(TRANSPARENT_INDEX)
    for (let ly = 0; ly < lH; ly++) {
      const ny = lOy - minY + ly
      const nx = lOx - minX
      out.set(lower.data.subarray(ly * lW, (ly + 1) * lW), ny * unionW + nx)
    }
    for (let uy = 0; uy < uH; uy++) {
      const ny = uOy - minY + uy
      for (let ux = 0; ux < uW; ux++) {
        const val = upper.data[uy * uW + ux]!
        if (val === TRANSPARENT_INDEX) continue
        const nx = uOx - minX + ux
        if (nx < 0 || ny < 0 || nx >= unionW || ny >= unionH) continue
        const dstIdx = ny * unionW + nx
        if (upper.clipping && out[dstIdx] === TRANSPARENT_INDEX) continue
        out[dstIdx] = val
      }
    }
    return {
      offsetX: minX,
      offsetY: minY,
      dataWidth: unionW,
      dataHeight: unionH,
      data: out,
      nextPalette: workingPalette,
    }
  }

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

  const mergedRgba = compositeLayers(
    [shiftedLower, shiftedUpper],
    unionW,
    unionH,
    { palette: workingPalette }
  )

  const outIndices = new Uint8Array(unionW * unionH)
  outIndices.fill(TRANSPARENT_INDEX)
  const hexCache = new Map<string, number>()

  for (let p = 0; p < unionW * unionH; p++) {
    const off = p * 4
    const a = mergedRgba[off + 3]!
    if (a === 0) continue
    if (a < 255) {
      const x = p % unionW
      const y = (p - x) / unionW
      const threshold = (BAYER_4X4[(y & 3) * 4 + (x & 3)]! + 0.5) * (255 / 16)
      if (a < threshold) continue
    }
    const r = mergedRgba[off]!
    const g = mergedRgba[off + 1]!
    const b = mergedRgba[off + 2]!
    const hex = rgbaToHex({ r, g, b }).toUpperCase()
    let fixedIdx = hexCache.get(hex)
    if (fixedIdx === undefined) {
      const exact = findExactFixedIndex(workingPalette, hex)
      if (exact >= 0) {
        fixedIdx = exact
      } else {
        const added = addColorToIndexedPalette(workingPalette, hex)
        if (added) {
          workingPalette = added.palette
          fixedIdx = added.fixedIndex
        } else {
          fixedIdx = findNearestFixedIndex(workingPalette, r, g, b)
        }
      }
      hexCache.set(hex, fixedIdx)
    }
    outIndices[p] = fixedIdx
  }

  return {
    offsetX: minX,
    offsetY: minY,
    dataWidth: unionW,
    dataHeight: unionH,
    data: outIndices,
    nextPalette: workingPalette,
  }
}

export interface ExportScaleOption {
  scale: number
  width: number
  height: number
  label: string
}

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
      const r = src[sIdx]!
      const g = src[sIdx + 1]!
      const b = src[sIdx + 2]!
      const a = src[sIdx + 3]!

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
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
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

export const DOTDOT_PNG_META_KEYWORD = 'dotdot-meta'

export interface DotDotPngMetadata {
  app: 'dotdot'
  version: 1
  originalWidth: number
  originalHeight: number
  scale: number
  exportedWidth: number
  exportedHeight: number
}

function makeTextChunk(keyword: string, text: string): Uint8Array {
  const safeKey = keyword.replace(/[^\x20-\x7E]/g, '').slice(0, 79) || 'Comment'
  const encoder = new TextEncoder()
  const keyBytes = encoder.encode(safeKey)
  const valBytes = encoder.encode(text)
  const payload = new Uint8Array(keyBytes.length + 1 + valBytes.length)
  payload.set(keyBytes, 0)
  payload[keyBytes.length] = 0
  payload.set(valBytes, keyBytes.length + 1)
  return makePngChunk('tEXt', payload)
}

export function encodeRgbaToPng(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options?: {
    textChunks?: Record<string, string>
  }
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

  const extraTextChunks: Uint8Array[] = []
  if (options?.textChunks) {
    for (const [k, v] of Object.entries(options.textChunks)) {
      if (typeof v === 'string' && v.length > 0) {
        extraTextChunks.push(makeTextChunk(k, v))
      }
    }
  }

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

  const extraLen = extraTextChunks.reduce((acc, c) => acc + c.length, 0)
  const png = new Uint8Array(
    signature.length +
      ihdrChunk.length +
      extraLen +
      idatChunk.length +
      iendChunk.length
  )
  let offset = 0
  png.set(signature, offset)
  offset += signature.length
  png.set(ihdrChunk, offset)
  offset += ihdrChunk.length
  for (const tc of extraTextChunks) {
    png.set(tc, offset)
    offset += tc.length
  }
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
    ((png[off]! << 24) |
      (png[off + 1]! << 16) |
      (png[off + 2]! << 8) |
      png[off + 3]!) >>>
    0

  let pos = 8
  let width = 0
  let height = 0
  const idatParts: Uint8Array[] = []

  while (pos + 8 <= png.length) {
    const len = readU32(pos)
    const type = String.fromCharCode(
      png[pos + 4]!,
      png[pos + 5]!,
      png[pos + 6]!,
      png[pos + 7]!
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
 * Full pipeline: composite 1-byte Indexed Color layers via `palette` into temporary RGBA
 * and export scaled nearest-neighbor PNG bytes (Section 9-1).
 */
export function exportCompositePngBytes(
  layers: readonly LayerRuntime[],
  width: number,
  height: number,
  scale: number,
  options?: {
    palette?: ProjectPalette | Uint8ClampedArray
    embedMetadata?: boolean
  }
): { png: Uint8Array; outWidth: number; outHeight: number } {
  const maxSide = Math.max(1, Math.max(width, height))
  const clampedScale = Math.max(
    1,
    Math.min(Math.floor(MAX_EXPORT_DIMENSION / maxSide), Math.trunc(scale))
  )
  const flat = compositeLayers(layers, width, height, {
    palette: options?.palette,
  })
  const scaled = upscaleNearestNeighbor(flat, width, height, clampedScale)
  const metaPayload: DotDotPngMetadata = {
    app: 'dotdot',
    version: 1,
    originalWidth: width,
    originalHeight: height,
    scale: clampedScale,
    exportedWidth: scaled.width,
    exportedHeight: scaled.height,
  }
  const png = encodeRgbaToPng(
    scaled.data,
    scaled.width,
    scaled.height,
    options?.embedMetadata
      ? {
          textChunks: {
            [DOTDOT_PNG_META_KEYWORD]: JSON.stringify(metaPayload),
          },
        }
      : undefined
  )
  return {
    png,
    outWidth: scaled.width,
    outHeight: scaled.height,
  }
}
