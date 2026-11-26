import {
  TRANSPARENT_INDEX,
  type ClipboardBuffer,
  type Connectivity,
  type LayerRuntime,
  type OutlineMode,
  type Point,
  type ProjectPalette,
  type RGBA,
  type WorldSelectionMask,
} from '../types'
import { resolveDrawColorIndex } from './brush'
import { computeConnectedRegion } from './floodFill'
import {
  extractUsedColorMap,
  remapClipboardToTargetPalette,
} from './indexedPalette'
import {
  createPixelBuffer,
  isInBounds,
  stampBufferIntoLayerWorld,
} from './pixelBuffer'
import { buildFilledEllipseMask, computeShapeBounds } from './rasterize'

export function cloneWorldSelectionMask(
  ws: WorldSelectionMask | null | undefined
): WorldSelectionMask | null {
  if (!ws) return null
  return {
    originX: ws.originX,
    originY: ws.originY,
    width: ws.width,
    height: ws.height,
    mask: new Uint8Array(ws.mask),
  }
}

export function hasAnySelectedWorldPixel(
  ws: WorldSelectionMask | null | undefined
): boolean {
  if (!ws || ws.width <= 0 || ws.height <= 0) return false
  for (let i = 0; i < ws.mask.length; i++) {
    if (ws.mask[i] !== 0) return true
  }
  return false
}

export function canvasMaskToWorldSelection(
  mask: Uint8Array | null,
  canvasWidth: number,
  canvasHeight: number
): WorldSelectionMask | null {
  if (!mask || mask.length !== canvasWidth * canvasHeight) return null
  const bounds = getSelectionBounds(mask, canvasWidth, canvasHeight)
  if (!bounds) return null

  const trimmed = new Uint8Array(bounds.width * bounds.height)
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      if (mask[y * canvasWidth + x] !== 0) {
        trimmed[(y - bounds.minY) * bounds.width + (x - bounds.minX)] = 1
      }
    }
  }
  return {
    originX: bounds.minX,
    originY: bounds.minY,
    width: bounds.width,
    height: bounds.height,
    mask: trimmed,
  }
}

export function projectWorldSelectionToCanvasMask(
  ws: WorldSelectionMask | null | undefined,
  canvasWidth: number,
  canvasHeight: number
): Uint8Array | null {
  if (!ws || !hasAnySelectedWorldPixel(ws)) return null
  const out = createSelectionMask(canvasWidth, canvasHeight)
  const startLx = Math.max(0, -ws.originX)
  const endLx = Math.min(ws.width, canvasWidth - ws.originX)
  const startLy = Math.max(0, -ws.originY)
  const endLy = Math.min(ws.height, canvasHeight - ws.originY)
  if (startLx >= endLx || startLy >= endLy) return null

  let anyVisible = false
  for (let ly = startLy; ly < endLy; ly++) {
    const cy = ws.originY + ly
    for (let lx = startLx; lx < endLx; lx++) {
      if (ws.mask[ly * ws.width + lx] !== 0) {
        out[cy * canvasWidth + (ws.originX + lx)] = 1
        anyVisible = true
      }
    }
  }
  return anyVisible ? out : null
}

export function shiftWorldSelectionMask(
  ws: WorldSelectionMask,
  dx: number,
  dy: number
): WorldSelectionMask {
  return {
    originX: ws.originX + Math.trunc(dx),
    originY: ws.originY + Math.trunc(dy),
    width: ws.width,
    height: ws.height,
    mask: new Uint8Array(ws.mask),
  }
}

export function mergeWorldSelectionMasks(
  existing: WorldSelectionMask | null | undefined,
  addition: WorldSelectionMask | null | undefined
): WorldSelectionMask | null {
  const hasA = hasAnySelectedWorldPixel(existing)
  const hasB = hasAnySelectedWorldPixel(addition)
  if (!hasA && !hasB) return null
  if (!hasA) return cloneWorldSelectionMask(addition)
  if (!hasB) return cloneWorldSelectionMask(existing)

  const a = existing!
  const b = addition!
  const minX = Math.min(a.originX, b.originX)
  const minY = Math.min(a.originY, b.originY)
  const maxX = Math.max(a.originX + a.width, b.originX + b.width)
  const maxY = Math.max(a.originY + a.height, b.originY + b.height)
  const uW = Math.max(1, maxX - minX)
  const uH = Math.max(1, maxY - minY)
  const unionMask = new Uint8Array(uW * uH)

  for (let ly = 0; ly < a.height; ly++) {
    const uy = a.originY + ly - minY
    for (let lx = 0; lx < a.width; lx++) {
      if (a.mask[ly * a.width + lx] !== 0) {
        unionMask[uy * uW + (a.originX + lx - minX)] = 1
      }
    }
  }
  for (let ly = 0; ly < b.height; ly++) {
    const uy = b.originY + ly - minY
    for (let lx = 0; lx < b.width; lx++) {
      if (b.mask[ly * b.width + lx] !== 0) {
        unionMask[uy * uW + (b.originX + lx - minX)] = 1
      }
    }
  }

  return {
    originX: minX,
    originY: minY,
    width: uW,
    height: uH,
    mask: unionMask,
  }
}

export function selectWorldRectangleMask(
  start: Point,
  end: Point
): WorldSelectionMask {
  const bounds = computeShapeBounds(start, end, false)
  const w = Math.max(1, Math.min(2048, bounds.width))
  const h = Math.max(1, Math.min(2048, bounds.height))
  const mask = new Uint8Array(w * h)
  mask.fill(1)
  return {
    originX: bounds.minX,
    originY: bounds.minY,
    width: w,
    height: h,
    mask,
  }
}

export function selectWorldEllipseMask(
  start: Point,
  end: Point
): WorldSelectionMask {
  const bounds = computeShapeBounds(start, end, false)
  const w = Math.max(1, Math.min(2048, bounds.width))
  const h = Math.max(1, Math.min(2048, bounds.height))
  const localEllipse = buildFilledEllipseMask(w, h)
  return {
    originX: bounds.minX,
    originY: bounds.minY,
    width: w,
    height: h,
    mask: localEllipse,
  }
}

function getLayerWorldPixelIndex(layer: LayerRuntime, wx: number, wy: number): number {
  const lx = wx - layer.offsetX
  const ly = wy - layer.offsetY
  if (lx < 0 || ly < 0 || lx >= layer.dataWidth || ly >= layer.dataHeight) {
    return TRANSPARENT_INDEX
  }
  return layer.data[ly * layer.dataWidth + lx] ?? TRANSPARENT_INDEX
}

export function extractWorldSelectionFromLayer(
  layer: LayerRuntime,
  ws: WorldSelectionMask
): {
  extractedBuffer: Uint8Array
  clearedLayer: LayerRuntime
} {
  const extractedBuffer = createPixelBuffer(ws.width, ws.height)
  const clearedData = new Uint8Array(layer.data)

  for (let sy = 0; sy < ws.height; sy++) {
    const wy = ws.originY + sy
    const ly = wy - layer.offsetY
    for (let sx = 0; sx < ws.width; sx++) {
      if (ws.mask[sy * ws.width + sx] === 0) continue
      const wx = ws.originX + sx
      const lx = wx - layer.offsetX
      if (lx >= 0 && ly >= 0 && lx < layer.dataWidth && ly < layer.dataHeight) {
        const sOff = ly * layer.dataWidth + lx
        const dOff = sy * ws.width + sx
        extractedBuffer[dOff] = layer.data[sOff]!
        clearedData[sOff] = TRANSPARENT_INDEX
      }
    }
  }

  return {
    extractedBuffer,
    clearedLayer: {
      ...layer,
      data: clearedData,
    },
  }
}

export function moveWorldSelectionOnLayer(
  layer: LayerRuntime,
  ws: WorldSelectionMask,
  dx: number,
  dy: number
): {
  nextLayer: LayerRuntime
  nextWorldSelection: WorldSelectionMask
} {
  const shiftX = Math.trunc(dx)
  const shiftY = Math.trunc(dy)
  const { extractedBuffer, clearedLayer } = extractWorldSelectionFromLayer(layer, ws)
  const nextWorldSelection = shiftWorldSelectionMask(ws, shiftX, shiftY)
  const nextLayer = stampBufferIntoLayerWorld(
    clearedLayer,
    extractedBuffer,
    ws.width,
    ws.height,
    nextWorldSelection.originX,
    nextWorldSelection.originY
  )
  return { nextLayer, nextWorldSelection }
}

export function copyWorldSelectionFromLayer(
  layer: LayerRuntime,
  ws: WorldSelectionMask,
  sourcePalette?: ProjectPalette,
  sourceProjectId?: string
): ClipboardBuffer | null {
  if (!hasAnySelectedWorldPixel(ws)) return null
  const data = createPixelBuffer(ws.width, ws.height)
  for (let sy = 0; sy < ws.height; sy++) {
    const wy = ws.originY + sy
    for (let sx = 0; sx < ws.width; sx++) {
      if (ws.mask[sy * ws.width + sx] === 0) continue
      data[sy * ws.width + sx] = getLayerWorldPixelIndex(layer, ws.originX + sx, wy)
    }
  }
  return {
    width: ws.width,
    height: ws.height,
    offsetX: ws.originX,
    offsetY: ws.originY,
    data,
    ...(sourceProjectId ? { sourceProjectId } : {}),
    ...(sourcePalette
      ? { sourceColorMap: extractUsedColorMap(data, sourcePalette) }
      : {}),
  }
}

export function cutWorldSelectionFromLayer(
  layer: LayerRuntime,
  ws: WorldSelectionMask,
  sourcePalette?: ProjectPalette,
  sourceProjectId?: string
): { clipboard: ClipboardBuffer | null; nextLayer: LayerRuntime } {
  const clipboard = copyWorldSelectionFromLayer(layer, ws, sourcePalette, sourceProjectId)
  const { clearedLayer } = extractWorldSelectionFromLayer(layer, ws)
  return { clipboard, nextLayer: clearedLayer }
}

export function flipWorldSelectionOnLayer(
  layer: LayerRuntime,
  ws: WorldSelectionMask,
  direction: 'horizontal' | 'vertical'
): { nextLayer: LayerRuntime; nextWorldSelection: WorldSelectionMask } {
  const { extractedBuffer, clearedLayer } = extractWorldSelectionFromLayer(layer, ws)
  const flippedBuf = createPixelBuffer(ws.width, ws.height)
  const flippedMask = new Uint8Array(ws.width * ws.height)

  for (let sy = 0; sy < ws.height; sy++) {
    for (let sx = 0; sx < ws.width; sx++) {
      const sIdx = sy * ws.width + sx
      if (ws.mask[sIdx] === 0) continue
      const dx = direction === 'horizontal' ? ws.width - 1 - sx : sx
      const dy = direction === 'vertical' ? ws.height - 1 - sy : sy
      const dIdx = dy * ws.width + dx
      flippedMask[dIdx] = 1
      flippedBuf[dIdx] = extractedBuffer[sIdx]!
    }
  }

  const nextWorldSelection: WorldSelectionMask = {
    originX: ws.originX,
    originY: ws.originY,
    width: ws.width,
    height: ws.height,
    mask: flippedMask,
  }
  const nextLayer = stampBufferIntoLayerWorld(
    clearedLayer,
    flippedBuf,
    ws.width,
    ws.height,
    ws.originX,
    ws.originY
  )
  return { nextLayer, nextWorldSelection }
}

export function createSelectionMask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height)
}

export function cloneSelectionMask(mask: Uint8Array | null): Uint8Array | null {
  return mask ? new Uint8Array(mask) : null
}

export function hasAnySelectedPixel(mask: Uint8Array | null): boolean {
  if (!mask) return false
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) return true
  }
  return false
}

export function mergeSelectionMasks(
  existing: Uint8Array | null,
  addition: Uint8Array
): Uint8Array {
  if (!existing || existing.length !== addition.length) {
    return new Uint8Array(addition)
  }
  const out = new Uint8Array(addition.length)
  for (let i = 0; i < addition.length; i++) {
    out[i] = existing[i] || addition[i] ? 1 : 0
  }
  return out
}

export function invertSelectionMask(
  mask: Uint8Array | null,
  width: number,
  height: number
): Uint8Array {
  const len = width * height
  const out = new Uint8Array(len)
  if (!mask) {
    out.fill(1)
    return out
  }
  for (let i = 0; i < len; i++) {
    out[i] = mask[i] ? 0 : 1
  }
  return out
}

export function selectSameColor(
  layerBuffer: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  connectivity: Connectivity
): Uint8Array {
  return computeConnectedRegion(layerBuffer, width, height, seedX, seedY, connectivity, null)
}

export function selectRectangleMask(
  width: number,
  height: number,
  start: Point,
  end: Point
): Uint8Array {
  const mask = createSelectionMask(width, height)
  const bounds = computeShapeBounds(start, end, false)
  const x0 = Math.max(0, bounds.minX)
  const x1 = Math.min(width - 1, bounds.maxX)
  const y0 = Math.max(0, bounds.minY)
  const y1 = Math.min(height - 1, bounds.maxY)

  for (let y = y0; y <= y1; y++) {
    const row = y * width
    for (let x = x0; x <= x1; x++) {
      mask[row + x] = 1
    }
  }
  return mask
}

export function selectEllipseMask(
  width: number,
  height: number,
  start: Point,
  end: Point
): Uint8Array {
  const mask = createSelectionMask(width, height)
  const bounds = computeShapeBounds(start, end, false)
  const localEllipse = buildFilledEllipseMask(bounds.width, bounds.height)

  for (let ly = 0; ly < bounds.height; ly++) {
    const cy = bounds.minY + ly
    if (cy < 0 || cy >= height) continue
    for (let lx = 0; lx < bounds.width; lx++) {
      const cx = bounds.minX + lx
      if (cx < 0 || cx >= width) continue
      if (localEllipse[ly * bounds.width + lx] === 1) {
        mask[cy * width + cx] = 1
      }
    }
  }
  return mask
}

export interface SelectionBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export function getSelectionBounds(
  mask: Uint8Array,
  width: number,
  height: number
): SelectionBounds | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (mask[row + x] !== 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) return null
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

export function moveSelectionContent(
  layerBuffer: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number
): { nextBuffer: Uint8Array; nextMask: Uint8Array } {
  const nextBuffer = new Uint8Array(layerBuffer)
  const nextMask = createSelectionMask(width, height)

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      nextBuffer[i] = TRANSPARENT_INDEX
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sIdx = y * width + x
      if (mask[sIdx] === 0) continue

      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(nx, ny, width, height)) continue

      const dIdx = ny * width + nx
      nextMask[dIdx] = 1
      nextBuffer[dIdx] = layerBuffer[sIdx]!
    }
  }

  return { nextBuffer, nextMask }
}

export function flipSelectionContent(
  layerBuffer: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  direction: 'horizontal' | 'vertical'
): { nextBuffer: Uint8Array; nextMask: Uint8Array } {
  const bounds = getSelectionBounds(mask, width, height)
  if (!bounds) {
    return {
      nextBuffer: new Uint8Array(layerBuffer),
      nextMask: new Uint8Array(mask),
    }
  }

  const nextBuffer = new Uint8Array(layerBuffer)
  const nextMask = createSelectionMask(width, height)

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      nextBuffer[i] = TRANSPARENT_INDEX
    }
  }

  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const sIdx = y * width + x
      if (mask[sIdx] === 0) continue

      const tx =
        direction === 'horizontal' ? bounds.maxX - (x - bounds.minX) : x
      const ty =
        direction === 'vertical' ? bounds.maxY - (y - bounds.minY) : y

      const dIdx = ty * width + tx
      nextMask[dIdx] = 1
      nextBuffer[dIdx] = layerBuffer[sIdx]!
    }
  }

  return { nextBuffer, nextMask }
}

export function copySelection(
  layerBuffer: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  sourcePalette?: ProjectPalette,
  sourceProjectId?: string
): ClipboardBuffer | null {
  const bounds = getSelectionBounds(mask, width, height)
  if (!bounds) return null

  const data = createPixelBuffer(bounds.width, bounds.height)
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const sIdx = y * width + x
      if (mask[sIdx] === 0) continue
      data[(y - bounds.minY) * bounds.width + (x - bounds.minX)] = layerBuffer[sIdx]!
    }
  }

  return {
    width: bounds.width,
    height: bounds.height,
    offsetX: bounds.minX,
    offsetY: bounds.minY,
    data,
    ...(sourceProjectId ? { sourceProjectId } : {}),
    ...(sourcePalette
      ? { sourceColorMap: extractUsedColorMap(data, sourcePalette) }
      : {}),
  }
}

export function cutSelection(
  layerBuffer: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  sourcePalette?: ProjectPalette,
  sourceProjectId?: string
): { clipboard: ClipboardBuffer | null; nextBuffer: Uint8Array } {
  const clipboard = copySelection(
    layerBuffer,
    mask,
    width,
    height,
    sourcePalette,
    sourceProjectId
  )
  const nextBuffer = new Uint8Array(layerBuffer)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      nextBuffer[i] = TRANSPARENT_INDEX
    }
  }
  return { clipboard, nextBuffer }
}

export function pasteClipboard(
  layerBuffer: Uint8Array,
  clipboard: ClipboardBuffer,
  width: number,
  height: number,
  destX?: number,
  destY?: number,
  targetPalette?: ProjectPalette,
  targetProjectId?: string
): { nextBuffer: Uint8Array; nextMask: Uint8Array; nextPalette?: ProjectPalette } {
  const nextBuffer = new Uint8Array(layerBuffer)
  const nextMask = createSelectionMask(width, height)

  let srcData = clipboard.data
  let nextPalette: ProjectPalette | undefined
  if (
    targetPalette &&
    clipboard.sourceColorMap &&
    (!targetProjectId || clipboard.sourceProjectId !== targetProjectId)
  ) {
    const remapped = remapClipboardToTargetPalette(
      clipboard.data,
      clipboard.sourceColorMap,
      targetPalette
    )
    srcData = remapped.remappedData
    nextPalette = remapped.nextPalette
  }

  const ox = destX ?? clipboard.offsetX
  const oy = destY ?? clipboard.offsetY

  for (let ly = 0; ly < clipboard.height; ly++) {
    const cy = oy + ly
    if (cy < 0 || cy >= height) continue
    for (let lx = 0; lx < clipboard.width; lx++) {
      const cx = ox + lx
      if (cx < 0 || cx >= width) continue

      const val = srcData[ly * clipboard.width + lx]!
      if (val === TRANSPARENT_INDEX) continue

      const pIdx = cy * width + cx
      nextMask[pIdx] = 1
      nextBuffer[pIdx] = val
    }
  }

  return {
    nextBuffer,
    nextMask,
    ...(nextPalette ? { nextPalette } : {}),
  }
}

export function computeSelectionOutlineMask(
  mask: Uint8Array,
  width: number,
  height: number,
  mode: OutlineMode,
  size: number
): Uint8Array {
  const thickness = Math.max(1, Math.min(32, Math.round(size)))
  const total = width * height
  const outline = new Uint8Array(total)

  let selectedCount = 0
  for (let i = 0; i < total; i++) {
    if (mask[i] !== 0) selectedCount++
  }
  if (selectedCount === 0) return outline

  const useInnerBorder = selectedCount === total

  if (useInnerBorder) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const distEdge = Math.min(x, y, width - 1 - x, height - 1 - y)
        if (distEdge < thickness) {
          outline[y * width + x] = 1
        }
      }
    }
    return outline
  }

  if (mode === 'normal') {
    let current = new Uint8Array(mask)
    for (let step = 0; step < thickness; step++) {
      const next = new Uint8Array(current)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (current[y * width + x] === 0) continue
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy
            if (ny < 0 || ny >= height) continue
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx
              if (nx < 0 || nx >= width) continue
              const nIdx = ny * width + nx
              if (mask[nIdx] === 0) {
                outline[nIdx] = 1
              }
              next[nIdx] = 1
            }
          }
        }
      }
      current = next
    }
  } else {
    let current = new Uint8Array(mask)
    const dirs4 = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const

    for (let step = 0; step < thickness; step++) {
      const ring = new Uint8Array(total)
      const next = new Uint8Array(current)

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (current[y * width + x] === 0) continue
          for (let d = 0; d < 4; d++) {
            const nx = x + dirs4[d][0]
            const ny = y + dirs4[d][1]
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
            const nIdx = ny * width + nx
            if (current[nIdx] === 0) {
              ring[nIdx] = 1
              next[nIdx] = 1
            }
          }
        }
      }

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x
          if (ring[idx] === 0) continue

          const hasLeft = x > 0 && ring[y * width + (x - 1)] === 1
          const hasRight = x + 1 < width && ring[y * width + (x + 1)] === 1
          const hasUp = y > 0 && ring[(y - 1) * width + x] === 1
          const hasDown = y + 1 < height && ring[(y + 1) * width + x] === 1

          let touchesCurrentCount = 0
          for (let d = 0; d < 4; d++) {
            const nx = x + dirs4[d][0]
            const ny = y + dirs4[d][1]
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && current[ny * width + nx] === 1) {
              touchesCurrentCount++
            }
          }

          if (
            touchesCurrentCount === 0 &&
            ((hasLeft && hasUp) || (hasRight && hasUp) || (hasLeft && hasDown) || (hasRight && hasDown))
          ) {
            ring[idx] = 0
          }
        }
      }

      for (let i = 0; i < total; i++) {
        if (ring[i] === 1 && mask[i] === 0) {
          outline[i] = 1
        }
      }
      current = next
    }
  }

  return outline
}

export function applySelectionOutline(
  layerBuffer: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  mode: OutlineMode,
  size: number,
  colorIndexOrRgba: number | RGBA
): Uint8Array {
  const nextBuffer = new Uint8Array(layerBuffer)
  const outlineMask = computeSelectionOutlineMask(mask, width, height, mode, size)
  const targetIdx =
    typeof colorIndexOrRgba === 'number'
      ? resolveDrawColorIndex(colorIndexOrRgba, undefined, false)
      : resolveDrawColorIndex(undefined, colorIndexOrRgba, false)

  for (let i = 0; i < outlineMask.length; i++) {
    if (outlineMask[i] === 0) continue
    nextBuffer[i] = targetIdx
  }

  return nextBuffer
}
