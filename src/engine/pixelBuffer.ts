import type { LayerRuntime, ResizeAnchor, RGBA } from '../types'

export const MIN_CANVAS_SIZE = 1
export const MAX_CANVAS_SIZE = 256

export function createPixelBuffer(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4)
}

export function clonePixelBuffer(src: Uint8ClampedArray): Uint8ClampedArray {
  return new Uint8ClampedArray(src)
}

export function isInBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height
}

export function getPixelOffset(x: number, y: number, width: number): number {
  return (y * width + x) * 4
}

export function getPixel(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): RGBA {
  if (!isInBounds(x, y, width, height)) {
    return { r: 0, g: 0, b: 0, a: 0 }
  }
  const idx = (y * width + x) * 4
  return {
    r: buffer[idx],
    g: buffer[idx + 1],
    b: buffer[idx + 2],
    a: buffer[idx + 3],
  }
}

export function setPixel(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  color: RGBA
): void {
  if (!isInBounds(x, y, width, height)) return
  const idx = (y * width + x) * 4
  if (color.a === 0) {
    buffer[idx] = 0
    buffer[idx + 1] = 0
    buffer[idx + 2] = 0
    buffer[idx + 3] = 0
  } else {
    buffer[idx] = color.r
    buffer[idx + 1] = color.g
    buffer[idx + 2] = color.b
    buffer[idx + 3] = color.a
  }
}

export function pixelsMatchAt(
  buffer: Uint8ClampedArray,
  idxA: number,
  idxB: number
): boolean {
  const aA = buffer[idxA + 3]
  const aB = buffer[idxB + 3]
  if (aA === 0 && aB === 0) return true
  return (
    aA === aB &&
    buffer[idxA] === buffer[idxB] &&
    buffer[idxA + 1] === buffer[idxB + 1] &&
    buffer[idxA + 2] === buffer[idxB + 2]
  )
}

export function clearBuffer(buffer: Uint8ClampedArray): void {
  buffer.fill(0)
}

/**
 * Resize pixel buffer keeping top-left (0, 0) anchored and expanding/cropping right/bottom.
 */
export function resizePixelBuffer(
  src: Uint8ClampedArray,
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(newWidth, newHeight)
  const copyW = Math.min(oldWidth, newWidth)
  const copyH = Math.min(oldHeight, newHeight)

  for (let y = 0; y < copyH; y++) {
    const srcRowStart = y * oldWidth * 4
    const dstRowStart = y * newWidth * 4
    dst.set(src.subarray(srcRowStart, srcRowStart + copyW * 4), dstRowStart)
  }
  return dst
}

export function flipBufferHorizontal(
  src: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sIdx = (y * width + x) * 4
      const dIdx = (y * width + (width - 1 - x)) * 4
      dst[dIdx] = src[sIdx]
      dst[dIdx + 1] = src[sIdx + 1]
      dst[dIdx + 2] = src[sIdx + 2]
      dst[dIdx + 3] = src[sIdx + 3]
    }
  }
  return dst
}

export function flipBufferVertical(
  src: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(width, height)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    const sStart = y * rowBytes
    const dStart = (height - 1 - y) * rowBytes
    dst.set(src.subarray(sStart, sStart + rowBytes), dStart)
  }
  return dst
}

/**
 * Translate fixed-size buffer by (dx, dy), clipping pixels that leave [0..width-1, 0..height-1].
 * Note: For non-destructive whole-layer moves, update `layer.offsetX` / `layer.offsetY` instead!
 */
export function translateBuffer(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  dx: number,
  dy: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(width, height)
  const shiftX = Math.trunc(dx)
  const shiftY = Math.trunc(dy)

  for (let y = 0; y < height; y++) {
    const ny = y + shiftY
    if (ny < 0 || ny >= height) continue
    for (let x = 0; x < width; x++) {
      const nx = x + shiftX
      if (nx < 0 || nx >= width) continue
      const sIdx = (y * width + x) * 4
      const dIdx = (ny * width + nx) * 4
      dst[dIdx] = src[sIdx]
      dst[dIdx + 1] = src[sIdx + 1]
      dst[dIdx + 2] = src[sIdx + 2]
      dst[dIdx + 3] = src[sIdx + 3]
    }
  }
  return dst
}

/**
 * Normalize a LayerRuntime's offset/dimensions safely (used for legacy v1 records too).
 */
export function normalizeLayerGeometry(
  layer: {
    offsetX?: number
    offsetY?: number
    dataWidth?: number
    dataHeight?: number
    data: Uint8ClampedArray
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
 * Extract the visible `[0..canvasW-1, 0..canvasH-1]` window of a layer in canvas space.
 * Pixels stored outside the canvas remain untouched in `layer.data`!
 */
export function extractLayerCanvasView(
  layer: Pick<LayerRuntime, 'offsetX' | 'offsetY' | 'dataWidth' | 'dataHeight' | 'data'>,
  canvasWidth: number,
  canvasHeight: number
): Uint8ClampedArray {
  const ox = layer.offsetX ?? 0
  const oy = layer.offsetY ?? 0
  const lw = layer.dataWidth ?? canvasWidth
  const lh = layer.dataHeight ?? canvasHeight

  if (
    ox === 0 &&
    oy === 0 &&
    lw === canvasWidth &&
    lh === canvasHeight &&
    layer.data.length === canvasWidth * canvasHeight * 4
  ) {
    return new Uint8ClampedArray(layer.data)
  }

  const out = createPixelBuffer(canvasWidth, canvasHeight)
  const startCx = Math.max(0, ox)
  const endCx = Math.min(canvasWidth, ox + lw)
  const startCy = Math.max(0, oy)
  const endCy = Math.min(canvasHeight, oy + lh)

  if (startCx >= endCx || startCy >= endCy) return out

  const spanBytes = (endCx - startCx) * 4
  for (let cy = startCy; cy < endCy; cy++) {
    const ly = cy - oy
    const lx = startCx - ox
    const srcOff = (ly * lw + lx) * 4
    const dstOff = (cy * canvasWidth + startCx) * 4
    out.set(layer.data.subarray(srcOff, srcOff + spanBytes), dstOff)
  }

  return out
}

/**
 * Write a modified `[0..canvasW-1, 0..canvasH-1]` canvas-space buffer back into `layer`
 * WITHOUT erasing any off-canvas pixels stored outside `[0..canvasW-1, 0..canvasH-1]`.
 * Automatically expands the layer's backing buffer if `layer` was previously shifted away from `[0..canvasW, 0..canvasH]`.
 */
export function writeLayerCanvasView(
  layer: LayerRuntime,
  editedCanvasView: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number
): LayerRuntime {
  const ox = layer.offsetX ?? 0
  const oy = layer.offsetY ?? 0
  const lw = layer.dataWidth ?? canvasWidth
  const lh = layer.dataHeight ?? canvasHeight

  // Fast path when backing buffer already covers [0..canvasWidth, 0..canvasHeight]
  if (ox <= 0 && oy <= 0 && ox + lw >= canvasWidth && oy + lh >= canvasHeight) {
    const nextData = new Uint8ClampedArray(layer.data)
    const rowBytes = canvasWidth * 4
    for (let cy = 0; cy < canvasHeight; cy++) {
      const ly = cy - oy
      const lx = 0 - ox
      const dstOff = (ly * lw + lx) * 4
      const srcOff = cy * rowBytes
      nextData.set(editedCanvasView.subarray(srcOff, srcOff + rowBytes), dstOff)
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

  // Expand backing rectangle to union of [ox..ox+lw, oy..oy+lh] and [0..canvasWidth, 0..canvasHeight]
  const newMinX = Math.min(ox, 0)
  const newMinY = Math.min(oy, 0)
  const newMaxX = Math.max(ox + lw, canvasWidth)
  const newMaxY = Math.max(oy + lh, canvasHeight)
  const newW = Math.max(1, newMaxX - newMinX)
  const newH = Math.max(1, newMaxY - newMinY)

  const nextData = createPixelBuffer(newW, newH)

  // 1. Copy all existing layer pixels (preserving off-canvas pixels!)
  const oldRowBytes = lw * 4
  for (let ly = 0; ly < lh; ly++) {
    const worldY = oy + ly
    const ny = worldY - newMinY
    const nx = ox - newMinX
    const srcOff = ly * oldRowBytes
    const dstOff = (ny * newW + nx) * 4
    nextData.set(layer.data.subarray(srcOff, srcOff + oldRowBytes), dstOff)
  }

  // 2. Overwrite the [0..canvasWidth, 0..canvasHeight] canvas window with editedCanvasView
  const canvasRowBytes = canvasWidth * 4
  for (let cy = 0; cy < canvasHeight; cy++) {
    const ny = cy - newMinY
    const nx = 0 - newMinX
    const srcOff = cy * canvasRowBytes
    const dstOff = (ny * newW + nx) * 4
    nextData.set(editedCanvasView.subarray(srcOff, srcOff + canvasRowBytes), dstOff)
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
 * Write arbitrary world-space RGBA buffer `[srcX..srcX+srcW, srcY..srcY+srcH]` onto `layer`
 * WITHOUT clipping pixels outside `[0..canvasW, 0..canvasH]`!
 * Used when committing a Selection Move that may have been dragged partially outside the canvas.
 */
export function stampBufferIntoLayerWorld(
  baseLayer: LayerRuntime,
  srcBuffer: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  worldOriginX: number,
  worldOriginY: number
): LayerRuntime {
  const ox = baseLayer.offsetX
  const oy = baseLayer.offsetY
  const lw = baseLayer.dataWidth
  const lh = baseLayer.dataHeight

  // Find bounding box of non-transparent pixels in srcBuffer so we only expand if needed
  let minSx = srcWidth
  let minSy = srcHeight
  let maxSx = -1
  let maxSy = -1
  for (let sy = 0; sy < srcHeight; sy++) {
    for (let sx = 0; sx < srcWidth; sx++) {
      if (srcBuffer[(sy * srcWidth + sx) * 4 + 3] > 0) {
        if (sx < minSx) minSx = sx
        if (sx > maxSx) maxSx = sx
        if (sy < minSy) minSy = sy
        if (sy > maxSy) maxSy = sy
      }
    }
  }
  if (maxSx < minSx || maxSy < minSy) {
    return { ...baseLayer, data: new Uint8ClampedArray(baseLayer.data) }
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
  const oldRowBytes = lw * 4
  for (let ly = 0; ly < lh; ly++) {
    const ny = oy + ly - newMinY
    const nx = ox - newMinX
    const srcOff = ly * oldRowBytes
    const dstOff = (ny * newW + nx) * 4
    nextData.set(baseLayer.data.subarray(srcOff, srcOff + oldRowBytes), dstOff)
  }

  for (let sy = minSy; sy <= maxSy; sy++) {
    const worldY = worldOriginY + sy
    const ny = worldY - newMinY
    for (let sx = minSx; sx <= maxSx; sx++) {
      const sOff = (sy * srcWidth + sx) * 4
      const sa = srcBuffer[sOff + 3]
      if (sa === 0) continue
      const worldX = worldOriginX + sx
      const nx = worldX - newMinX
      const dOff = (ny * newW + nx) * 4
      if (sa === 255 || nextData[dOff + 3] === 0) {
        nextData[dOff] = srcBuffer[sOff]
        nextData[dOff + 1] = srcBuffer[sOff + 1]
        nextData[dOff + 2] = srcBuffer[sOff + 2]
        nextData[dOff + 3] = sa
      } else {
        const srcA = sa / 255
        const dstA = nextData[dOff + 3] / 255
        const outA = srcA + dstA * (1 - srcA)
        nextData[dOff] = Math.round(
          (srcBuffer[sOff] * srcA + nextData[dOff] * dstA * (1 - srcA)) / outA
        )
        nextData[dOff + 1] = Math.round(
          (srcBuffer[sOff + 1] * srcA + nextData[dOff + 1] * dstA * (1 - srcA)) / outA
        )
        nextData[dOff + 2] = Math.round(
          (srcBuffer[sOff + 2] * srcA + nextData[dOff + 2] * dstA * (1 - srcA)) / outA
        )
        nextData[dOff + 3] = Math.round(outA * 255)
      }
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

/**
 * Flip layer horizontally or vertically around the canvas center `[0..canvasWidth-1]` / `[0..canvasHeight-1]`
 * while preserving off-canvas pixels symmetrically!
 */
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

  // World coordinate x maps to (canvasWidth - 1 - x).
  // Old layer covered [offsetX .. offsetX + dataWidth - 1], so flipped covers:
  // [canvasWidth - (offsetX + dataWidth) .. canvasWidth - 1 - offsetX].
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

/**
 * Section 5: Compute deterministic `(shiftX, shiftY)` for 9-way anchor canvas resize.
 *
 * Explicit odd-delta rule:
 * - Left / Top (`top-left`, `middle-left`, `bottom-left` / `top-*`): shift = `0`
 * - Center (`*-center`, `middle-*`, `center`): shift = `Math.floor((newSize - oldSize) / 2)`
 *   (When `newSize - oldSize` is positive odd, e.g. +1, extra 1px padding goes on right/bottom;
 *    when negative odd, e.g. -1, `Math.floor(-1 / 2) = -1` shifts content -1px symmetrically)
 * - Right / Bottom (`*-right` / `bottom-*`): shift = `newSize - oldSize`
 */
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

/**
 * Resize canvas across all layers using a 9-directional anchor:
 * - Shifts every layer by the exact same `(shiftX, shiftY)` so inter-layer relative positions NEVER drift.
 * - Expands backing buffers if needed to cover `[0..newWidth, 0..newHeight]` while keeping off-canvas pixel data non-destructively!
 */
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
        data: new Uint8ClampedArray(l.data),
      }
    }

    const nextData = createPixelBuffer(bw, bh)
    const rowBytes = lw * 4
    for (let ly = 0; ly < lh; ly++) {
      const ny = shiftedOy + ly - newMinY
      const nx = shiftedOx - newMinX
      const sOff = ly * rowBytes
      const dOff = (ny * bw + nx) * 4
      nextData.set(l.data.subarray(sOff, sOff + rowBytes), dOff)
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

/**
 * Count non-transparent pixels currently visible in `[0..oldWidth-1, 0..oldHeight-1]` across all layers
 * that will fall outside the new `[0..newWidth-1, 0..newHeight-1]` canvas after applying `anchor`.
 * Used to display a clear warning before cropping/shrinking the canvas (Section 5-2).
 */
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
        const a = view[(y * oldWidth + x) * 4 + 3]
        if (a === 0) continue
        const nx = x + shiftX
        if (nx < 0 || nx >= newWidth || ny < 0 || ny >= newHeight) {
          clippedCount++
        }
      }
    }
  }

  return clippedCount
}
