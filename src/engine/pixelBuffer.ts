import {
  TRANSPARENT_INDEX,
  type LayerRuntime,
  type ProjectPalette,
  type ResizeAnchor,
  type RGBA,
} from '../types'
import { buildPaletteRgbaLut } from './indexedPalette'

export const MIN_CANVAS_SIZE = 1
export const MAX_CANVAS_SIZE = 256
export { TRANSPARENT_INDEX }

/**
 * Allocate a 1-byte-per-pixel Indexed Color buffer (`width * height`) initialized to `TRANSPARENT_INDEX` (`255`).
 */
export function createPixelBuffer(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(Math.max(0, Math.trunc(width) * Math.trunc(height)))
  buf.fill(TRANSPARENT_INDEX)
  return buf
}

export function clonePixelBuffer(src: Uint8Array): Uint8Array {
  return new Uint8Array(src)
}

export function isInBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height
}

export function getPixelOffset(x: number, y: number, width: number): number {
  return y * width + x
}

export function getPixelIndex(
  buffer: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  if (!isInBounds(x, y, width, height)) {
    return TRANSPARENT_INDEX
  }
  return buffer[y * width + x] ?? TRANSPARENT_INDEX
}

export function setPixelIndex(
  buffer: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  colorIndex: number
): void {
  if (!isInBounds(x, y, width, height)) return
  buffer[y * width + x] =
    colorIndex < 0 || colorIndex >= TRANSPARENT_INDEX
      ? TRANSPARENT_INDEX
      : colorIndex & 0xff
}

/**
 * Read RGBA value at `(x, y)` either from a temporary `Uint8ClampedArray` RGBA buffer (4 bytes/px, e.g. composited output)
 * or from a 1-byte `Uint8Array` Indexed Color buffer (using optional `paletteOrLut`).
 */
export function getPixel(
  buffer: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  paletteOrLut?: ProjectPalette | Uint8ClampedArray
): RGBA {
  if (!isInBounds(x, y, width, height)) {
    return { r: 0, g: 0, b: 0, a: 0 }
  }
  if (buffer instanceof Uint8ClampedArray && buffer.length === width * height * 4) {
    const idx = (y * width + x) * 4
    return {
      r: buffer[idx]!,
      g: buffer[idx + 1]!,
      b: buffer[idx + 2]!,
      a: buffer[idx + 3]!,
    }
  }
  const pIdx = buffer[y * width + x] ?? TRANSPARENT_INDEX
  if (pIdx === TRANSPARENT_INDEX) {
    return { r: 0, g: 0, b: 0, a: 0 }
  }
  if (paletteOrLut) {
    const lut =
      paletteOrLut instanceof Uint8ClampedArray
        ? paletteOrLut
        : buildPaletteRgbaLut(paletteOrLut)
    const off = pIdx * 4
    return {
      r: lut[off]!,
      g: lut[off + 1]!,
      b: lut[off + 2]!,
      a: lut[off + 3]!,
    }
  }
  return { r: pIdx, g: pIdx, b: pIdx, a: 255 }
}

export function setPixel(
  buffer: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  colorIndexOrRgba: number | RGBA
): void {
  if (!isInBounds(x, y, width, height)) return
  if (typeof colorIndexOrRgba === 'number') {
    setPixelIndex(buffer, width, height, x, y, colorIndexOrRgba)
    return
  }
  buffer[y * width + x] =
    colorIndexOrRgba.a === 0 ? TRANSPARENT_INDEX : colorIndexOrRgba.r & 0xff
}

export function pixelsMatchAt(
  buffer: Uint8Array,
  idxA: number,
  idxB: number
): boolean {
  return buffer[idxA] === buffer[idxB]
}

export function clearBuffer(buffer: Uint8Array): void {
  buffer.fill(TRANSPARENT_INDEX)
}

export function resizePixelBuffer(
  src: Uint8Array,
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number
): Uint8Array {
  const dst = createPixelBuffer(newWidth, newHeight)
  const copyW = Math.min(oldWidth, newWidth)
  const copyH = Math.min(oldHeight, newHeight)

  for (let y = 0; y < copyH; y++) {
    const srcRowStart = y * oldWidth
    const dstRowStart = y * newWidth
    dst.set(src.subarray(srcRowStart, srcRowStart + copyW), dstRowStart)
  }
  return dst
}

export function flipBufferHorizontal(
  src: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const dst = createPixelBuffer(width, height)
  for (let y = 0; y < height; y++) {
    const rowOff = y * width
    for (let x = 0; x < width; x++) {
      dst[rowOff + (width - 1 - x)] = src[rowOff + x]!
    }
  }
  return dst
}

export function flipBufferVertical(
  src: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const dst = createPixelBuffer(width, height)
  for (let y = 0; y < height; y++) {
    const sStart = y * width
    const dStart = (height - 1 - y) * width
    dst.set(src.subarray(sStart, sStart + width), dStart)
  }
  return dst
}

export function translateBuffer(
  src: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number
): Uint8Array {
  const dst = createPixelBuffer(width, height)
  const shiftX = Math.trunc(dx)
  const shiftY = Math.trunc(dy)

  for (let y = 0; y < height; y++) {
    const ny = y + shiftY
    if (ny < 0 || ny >= height) continue
    for (let x = 0; x < width; x++) {
      const nx = x + shiftX
      if (nx < 0 || nx >= width) continue
      dst[ny * width + nx] = src[y * width + x]!
    }
  }
  return dst
}

export function normalizeLayerGeometry(
  layer: {
    offsetX?: number
    offsetY?: number
    dataWidth?: number
    dataHeight?: number
    data?: Uint8Array | Uint8ClampedArray
  },
  fallbackWidth: number,
  fallbackHeight: number
): {
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
} {
  const dataWidth =
    typeof layer.dataWidth === 'number' && layer.dataWidth > 0
      ? Math.trunc(layer.dataWidth)
      : fallbackWidth
  const dataHeight =
    typeof layer.dataHeight === 'number' && layer.dataHeight > 0
      ? Math.trunc(layer.dataHeight)
      : fallbackHeight
  const offsetX =
    typeof layer.offsetX === 'number' && Number.isFinite(layer.offsetX)
      ? Math.trunc(layer.offsetX)
      : 0
  const offsetY =
    typeof layer.offsetY === 'number' && Number.isFinite(layer.offsetY)
      ? Math.trunc(layer.offsetY)
      : 0
  return { offsetX, offsetY, dataWidth, dataHeight }
}

/**
 * Extract the visible `[0..canvasW-1, 0..canvasH-1]` window of an indexed layer (`1 byte/pixel`).
 * Pixels stored outside the canvas remain untouched in `layer.data`!
 */
export function extractLayerCanvasView(
  layer: Pick<LayerRuntime, 'offsetX' | 'offsetY' | 'dataWidth' | 'dataHeight' | 'data'>,
  canvasWidth: number,
  canvasHeight: number
): Uint8Array {
  const ox = layer.offsetX ?? 0
  const oy = layer.offsetY ?? 0
  const lw = layer.dataWidth ?? canvasWidth
  const lh = layer.dataHeight ?? canvasHeight

  if (
    ox === 0 &&
    oy === 0 &&
    lw === canvasWidth &&
    lh === canvasHeight &&
    layer.data.length === canvasWidth * canvasHeight
  ) {
    return new Uint8Array(layer.data)
  }

  const out = createPixelBuffer(canvasWidth, canvasHeight)
  const startCx = Math.max(0, ox)
  const endCx = Math.min(canvasWidth, ox + lw)
  const startCy = Math.max(0, oy)
  const endCy = Math.min(canvasHeight, oy + lh)

  if (startCx >= endCx || startCy >= endCy) return out

  const span = endCx - startCx
  for (let cy = startCy; cy < endCy; cy++) {
    const ly = cy - oy
    const lx = startCx - ox
    const srcOff = ly * lw + lx
    const dstOff = cy * canvasWidth + startCx
    out.set(layer.data.subarray(srcOff, srcOff + span), dstOff)
  }

  return out
}

/**
 * Write a modified `[0..canvasW-1, 0..canvasH-1]` indexed canvas view back into `layer`
 * WITHOUT erasing any off-canvas pixels stored outside `[0..canvasW-1, 0..canvasH-1]`.
 */
export function writeLayerCanvasView(
  layer: LayerRuntime,
  editedCanvasView: Uint8Array,
  canvasWidth: number,
  canvasHeight: number
): LayerRuntime {
  const ox = layer.offsetX ?? 0
  const oy = layer.offsetY ?? 0
  const lw = layer.dataWidth ?? canvasWidth
  const lh = layer.dataHeight ?? canvasHeight

  if (ox <= 0 && oy <= 0 && ox + lw >= canvasWidth && oy + lh >= canvasHeight) {
    const nextData = new Uint8Array(layer.data)
    for (let cy = 0; cy < canvasHeight; cy++) {
      const ly = cy - oy
      const lx = 0 - ox
      const dstOff = ly * lw + lx
      const srcOff = cy * canvasWidth
      nextData.set(editedCanvasView.subarray(srcOff, srcOff + canvasWidth), dstOff)
    }
    return {
      ...layer,
      offsetX: ox,
      offsetY: oy,
      dataWidth: lw,
      dataHeight: lh,
      data: nextData,
    }
  }

  const newMinX = Math.min(ox, 0)
  const newMinY = Math.min(oy, 0)
  const newMaxX = Math.max(ox + lw, canvasWidth)
  const newMaxY = Math.max(oy + lh, canvasHeight)
  const newW = Math.max(1, newMaxX - newMinX)
  const newH = Math.max(1, newMaxY - newMinY)

  const nextData = createPixelBuffer(newW, newH)

  for (let ly = 0; ly < lh; ly++) {
    const ny = oy + ly - newMinY
    const nx = ox - newMinX
    const srcOff = ly * lw
    const dstOff = ny * newW + nx
    nextData.set(layer.data.subarray(srcOff, srcOff + lw), dstOff)
  }

  for (let cy = 0; cy < canvasHeight; cy++) {
    const ny = cy - newMinY
    const nx = 0 - newMinX
    const srcOff = cy * canvasWidth
    const dstOff = ny * newW + nx
    nextData.set(editedCanvasView.subarray(srcOff, srcOff + canvasWidth), dstOff)
  }

  return {
    ...layer,
    offsetX: newMinX,
    offsetY: newMinY,
    dataWidth: newW,
    dataHeight: newH,
    data: nextData,
  }
}

/**
 * Write arbitrary world-space 1-byte Indexed Color buffer `[srcX..srcX+srcW, srcY..srcY+srcH]` onto `baseLayer`
 * WITHOUT clipping pixels outside `[0..canvasW, 0..canvasH]`.
 */
export function stampBufferIntoLayerWorld(
  baseLayer: LayerRuntime,
  srcBuffer: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  worldOriginX: number,
  worldOriginY: number
): LayerRuntime {
  const ox = baseLayer.offsetX
  const oy = baseLayer.offsetY
  const lw = baseLayer.dataWidth
  const lh = baseLayer.dataHeight

  let minSx = srcWidth
  let minSy = srcHeight
  let maxSx = -1
  let maxSy = -1
  for (let sy = 0; sy < srcHeight; sy++) {
    for (let sx = 0; sx < srcWidth; sx++) {
      if (srcBuffer[sy * srcWidth + sx] !== TRANSPARENT_INDEX) {
        if (sx < minSx) minSx = sx
        if (sx > maxSx) maxSx = sx
        if (sy < minSy) minSy = sy
        if (sy > maxSy) maxSy = sy
      }
    }
  }
  if (maxSx < minSx || maxSy < minSy) {
    return { ...baseLayer, data: new Uint8Array(baseLayer.data) }
  }

  const stampMinWorldX = worldOriginX + minSx
  const stampMinWorldY = worldOriginY + minSy
  const stampMaxWorldX = worldOriginX + maxSx + 1
  const stampMaxWorldY = worldOriginY + maxSy + 1

  const newMinX = Math.min(ox, stampMinWorldX)
  const newMinY = Math.min(oy, stampMinWorldY)
  const newMaxX = Math.max(ox + lw, stampMaxWorldX)
  const newMaxY = Math.max(oy + lh, stampMaxWorldY)
  const newW = Math.max(1, newMaxX - newMinX)
  const newH = Math.max(1, newMaxY - newMinY)

  const nextData = createPixelBuffer(newW, newH)
  for (let ly = 0; ly < lh; ly++) {
    const ny = oy + ly - newMinY
    const nx = ox - newMinX
    const srcOff = ly * lw
    const dstOff = ny * newW + nx
    nextData.set(baseLayer.data.subarray(srcOff, srcOff + lw), dstOff)
  }

  for (let sy = minSy; sy <= maxSy; sy++) {
    const ny = worldOriginY + sy - newMinY
    for (let sx = minSx; sx <= maxSx; sx++) {
      const val = srcBuffer[sy * srcWidth + sx]!
      if (val === TRANSPARENT_INDEX) continue
      const nx = worldOriginX + sx - newMinX
      nextData[ny * newW + nx] = val
    }
  }

  return {
    ...baseLayer,
    offsetX: newMinX,
    offsetY: newMinY,
    dataWidth: newW,
    dataHeight: newH,
    data: nextData,
  }
}

export function flipLayerAroundCanvas(
  layer: LayerRuntime,
  canvasWidth: number,
  canvasHeight: number,
  direction: 'horizontal' | 'vertical'
): LayerRuntime {
  const flippedData =
    direction === 'horizontal'
      ? flipBufferHorizontal(layer.data, layer.dataWidth, layer.dataHeight)
      : flipBufferVertical(layer.data, layer.dataWidth, layer.dataHeight)

  const nextOffsetX =
    direction === 'horizontal'
      ? canvasWidth - (layer.offsetX + layer.dataWidth)
      : layer.offsetX
  const nextOffsetY =
    direction === 'vertical'
      ? canvasHeight - (layer.offsetY + layer.dataHeight)
      : layer.offsetY

  return {
    ...layer,
    offsetX: nextOffsetX,
    offsetY: nextOffsetY,
    data: flippedData,
  }
}

export function computeResizeAnchorOffset(
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
  anchor: ResizeAnchor = 'center'
): { shiftX: number; shiftY: number } {
  const dw = Math.trunc(newWidth) - Math.trunc(oldWidth)
  const dh = Math.trunc(newHeight) - Math.trunc(oldHeight)

  let shiftX = 0
  if (anchor === 'top-center' || anchor === 'center' || anchor === 'bottom-center') {
    shiftX = Math.floor(dw / 2)
  } else if (anchor === 'top-right' || anchor === 'middle-right' || anchor === 'bottom-right') {
    shiftX = dw
  }

  let shiftY = 0
  if (anchor === 'middle-left' || anchor === 'center' || anchor === 'middle-right') {
    shiftY = Math.floor(dh / 2)
  } else if (anchor === 'bottom-left' || anchor === 'bottom-center' || anchor === 'bottom-right') {
    shiftY = dh
  }

  return { shiftX, shiftY }
}

export function resizeLayersWithAnchor(
  layers: readonly LayerRuntime[],
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
  anchor: ResizeAnchor = 'center'
): { layers: LayerRuntime[]; shiftX: number; shiftY: number } {
  const { shiftX, shiftY } = computeResizeAnchorOffset(
    oldWidth,
    oldHeight,
    newWidth,
    newHeight,
    anchor
  )

  const nextLayers = layers.map((l) => {
    const shiftedOx = (l.offsetX ?? 0) + shiftX
    const shiftedOy = (l.offsetY ?? 0) + shiftY
    const lw = l.dataWidth ?? oldWidth
    const lh = l.dataHeight ?? oldHeight

    const newMinX = Math.min(shiftedOx, 0)
    const newMinY = Math.min(shiftedOy, 0)
    const newMaxX = Math.max(shiftedOx + lw, newWidth)
    const newMaxY = Math.max(shiftedOy + lh, newHeight)
    const bw = Math.max(1, newMaxX - newMinX)
    const bh = Math.max(1, newMaxY - newMinY)

    if (newMinX === shiftedOx && newMinY === shiftedOy && bw === lw && bh === lh) {
      return {
        ...l,
        offsetX: shiftedOx,
        offsetY: shiftedOy,
        dataWidth: lw,
        dataHeight: lh,
        data: new Uint8Array(l.data),
      }
    }

    const nextData = createPixelBuffer(bw, bh)
    for (let ly = 0; ly < lh; ly++) {
      const ny = shiftedOy + ly - newMinY
      const nx = shiftedOx - newMinX
      const sOff = ly * lw
      const dOff = ny * bw + nx
      nextData.set(l.data.subarray(sOff, sOff + lw), dOff)
    }

    return {
      ...l,
      offsetX: newMinX,
      offsetY: newMinY,
      dataWidth: bw,
      dataHeight: bh,
      data: nextData,
    }
  })

  return { layers: nextLayers, shiftX, shiftY }
}

export function countPixelsOutsideResizedCanvas(
  layers: readonly LayerRuntime[],
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
  anchor: ResizeAnchor = 'center'
): number {
  const { shiftX, shiftY } = computeResizeAnchorOffset(
    oldWidth,
    oldHeight,
    newWidth,
    newHeight,
    anchor
  )
  let clippedCount = 0

  for (const layer of layers) {
    const view = extractLayerCanvasView(layer, oldWidth, oldHeight)
    for (let y = 0; y < oldHeight; y++) {
      const ny = y + shiftY
      for (let x = 0; x < oldWidth; x++) {
        if (view[y * oldWidth + x] === TRANSPARENT_INDEX) continue
        const nx = x + shiftX
        if (nx < 0 || nx >= newWidth || ny < 0 || ny >= newHeight) {
          clippedCount++
        }
      }
    }
  }

  return clippedCount
}
