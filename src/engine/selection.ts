import type { ClipboardBuffer, Connectivity, OutlineMode, Point, RGBA } from '../types'
import { computeConnectedRegion } from './floodFill'
import { createPixelBuffer, isInBounds } from './pixelBuffer'
import { buildFilledEllipseMask, computeShapeBounds } from './rasterize'

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
  layerBuffer: Uint8ClampedArray,
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

/**
 * Move selected pixels and selection mask simultaneously by (dx, dy) (e.g. 1px step).
 * Source selected pixels become transparent before shifted selected pixels are written.
 */
export function moveSelectionContent(
  layerBuffer: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number
): { nextBuffer: Uint8ClampedArray; nextMask: Uint8Array } {
  const nextBuffer = new Uint8ClampedArray(layerBuffer)
  const nextMask = createSelectionMask(width, height)

  // First clear all currently selected pixels on nextBuffer
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      const bIdx = i * 4
      nextBuffer[bIdx] = 0
      nextBuffer[bIdx + 1] = 0
      nextBuffer[bIdx + 2] = 0
      nextBuffer[bIdx + 3] = 0
    }
  }

  // Copy selected pixels and mask to shifted coordinates
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sIdx = y * width + x
      if (mask[sIdx] === 0) continue

      const nx = x + dx
      const ny = y + dy
      if (!isInBounds(nx, ny, width, height)) continue

      const dIdx = ny * width + nx
      nextMask[dIdx] = 1
      const sb = sIdx * 4
      const db = dIdx * 4
      nextBuffer[db] = layerBuffer[sb]
      nextBuffer[db + 1] = layerBuffer[sb + 1]
      nextBuffer[db + 2] = layerBuffer[sb + 2]
      nextBuffer[db + 3] = layerBuffer[sb + 3]
    }
  }

  return { nextBuffer, nextMask }
}

/**
 * Flip selected pixels and selection mask horizontally or vertically within selection's bounding box.
 */
export function flipSelectionContent(
  layerBuffer: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  direction: 'horizontal' | 'vertical'
): { nextBuffer: Uint8ClampedArray; nextMask: Uint8Array } {
  const bounds = getSelectionBounds(mask, width, height)
  if (!bounds) {
    return {
      nextBuffer: new Uint8ClampedArray(layerBuffer),
      nextMask: new Uint8Array(mask),
    }
  }

  const nextBuffer = new Uint8ClampedArray(layerBuffer)
  const nextMask = createSelectionMask(width, height)

  // Clear original selected pixels first
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      const bIdx = i * 4
      nextBuffer[bIdx] = 0
      nextBuffer[bIdx + 1] = 0
      nextBuffer[bIdx + 2] = 0
      nextBuffer[bIdx + 3] = 0
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
      const sb = sIdx * 4
      const db = dIdx * 4
      nextBuffer[db] = layerBuffer[sb]
      nextBuffer[db + 1] = layerBuffer[sb + 1]
      nextBuffer[db + 2] = layerBuffer[sb + 2]
      nextBuffer[db + 3] = layerBuffer[sb + 3]
    }
  }

  return { nextBuffer, nextMask }
}

/**
 * Copy selected pixels into internal clipboard buffer.
 */
export function copySelection(
  layerBuffer: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number
): ClipboardBuffer | null {
  const bounds = getSelectionBounds(mask, width, height)
  if (!bounds) return null

  const data = createPixelBuffer(bounds.width, bounds.height)
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const sIdx = y * width + x
      if (mask[sIdx] === 0) continue

      const sb = sIdx * 4
      const db = ((y - bounds.minY) * bounds.width + (x - bounds.minX)) * 4
      data[db] = layerBuffer[sb]
      data[db + 1] = layerBuffer[sb + 1]
      data[db + 2] = layerBuffer[sb + 2]
      data[db + 3] = layerBuffer[sb + 3]
    }
  }

  return {
    width: bounds.width,
    height: bounds.height,
    offsetX: bounds.minX,
    offsetY: bounds.minY,
    data,
  }
}

/**
 * Cut selected pixels: returns clipboard buffer + new layer buffer with selected pixels cleared.
 */
export function cutSelection(
  layerBuffer: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number
): { clipboard: ClipboardBuffer | null; nextBuffer: Uint8ClampedArray } {
  const clipboard = copySelection(layerBuffer, mask, width, height)
  const nextBuffer = new Uint8ClampedArray(layerBuffer)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      const bIdx = i * 4
      nextBuffer[bIdx] = 0
      nextBuffer[bIdx + 1] = 0
      nextBuffer[bIdx + 2] = 0
      nextBuffer[bIdx + 3] = 0
    }
  }
  return { clipboard, nextBuffer }
}

/**
 * Paste clipboard onto layer buffer at (destX, destY) and return updated buffer + selection mask of pasted pixels.
 */
export function pasteClipboard(
  layerBuffer: Uint8ClampedArray,
  clipboard: ClipboardBuffer,
  width: number,
  height: number,
  destX?: number,
  destY?: number
): { nextBuffer: Uint8ClampedArray; nextMask: Uint8Array } {
  const nextBuffer = new Uint8ClampedArray(layerBuffer)
  const nextMask = createSelectionMask(width, height)

  const ox = destX ?? clipboard.offsetX
  const oy = destY ?? clipboard.offsetY

  for (let ly = 0; ly < clipboard.height; ly++) {
    const cy = oy + ly
    if (cy < 0 || cy >= height) continue
    for (let lx = 0; lx < clipboard.width; lx++) {
      const cx = ox + lx
      if (cx < 0 || cx >= width) continue

      const sb = (ly * clipboard.width + lx) * 4
      const sa = clipboard.data[sb + 3]
      if (sa === 0) continue

      const pIdx = cy * width + cx
      nextMask[pIdx] = 1
      const db = pIdx * 4
      if (sa === 255 || nextBuffer[db + 3] === 0) {
        nextBuffer[db] = clipboard.data[sb]
        nextBuffer[db + 1] = clipboard.data[sb + 1]
        nextBuffer[db + 2] = clipboard.data[sb + 2]
        nextBuffer[db + 3] = sa
      } else {
        const srcA = sa / 255
        const dstA = nextBuffer[db + 3] / 255
        const outA = srcA + dstA * (1 - srcA)
        nextBuffer[db] = Math.round(
          (clipboard.data[sb] * srcA + nextBuffer[db] * dstA * (1 - srcA)) / outA
        )
        nextBuffer[db + 1] = Math.round(
          (clipboard.data[sb + 1] * srcA + nextBuffer[db + 1] * dstA * (1 - srcA)) / outA
        )
        nextBuffer[db + 2] = Math.round(
          (clipboard.data[sb + 2] * srcA + nextBuffer[db + 2] * dstA * (1 - srcA)) / outA
        )
        nextBuffer[db + 3] = Math.round(outA * 255)
      }
    }
  }

  return { nextBuffer, nextMask }
}

/**
 * Compute outline mask around selection contour using two distinct algorithms (Section 7-4):
 *
 * 1) `normal`: 8-neighborhood (Chebyshev) morphological dilation around selection contour,
 *    filling diagonal corners cleanly for a full blocky frame.
 * 2) `pixelPerfect`: 4-neighborhood (Manhattan) contour shell with L-corner pruning so diagonal
 *    contours stay crisp 1px pixel-art outlines without heavy corner blocks.
 *
 * If the selection covers the entire canvas (no unselected exterior pixels exist),
 * falls back to drawing along the inner border of the selection so outline always produces visible output.
 */
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

  // Check if full-canvas selection (no exterior available)
  const useInnerBorder = selectedCount === total

  if (useInnerBorder) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const distEdge = Math.min(x, y, width - 1 - x, height - 1 - y)
        if (distEdge < thickness) {
          if (mode === 'pixelPerfect' && thickness === 1) {
            // Skip the 4 extreme corners on 1px inner pixel-perfect frame if desired, or keep clean border
            outline[y * width + x] = 1
          } else {
            outline[y * width + x] = 1
          }
        }
      }
    }
    return outline
  }

  if (mode === 'normal') {
    // Algorithm A (Normal): 8-connected iterative dilation around selection exterior
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
    // Algorithm B (Pixel-Perfect): 4-connected Manhattan dilation + corner cleanup pass
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

      // Prune redundant L-corners on this 1px shell where two orthogonal neighbors in the SAME ring
      // already bridge diagonally without exposing `current`
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x
          if (ring[idx] === 0) continue

          const hasLeft = x > 0 && ring[y * width + (x - 1)] === 1
          const hasRight = x + 1 < width && ring[y * width + (x + 1)] === 1
          const hasUp = y > 0 && ring[(y - 1) * width + x] === 1
          const hasDown = y + 1 < height && ring[(y + 1) * width + x] === 1

          // Only keep 4-connected contact with `current`; remove redundant outer staircase corners
          // when an L-bend is NOT directly orthogonally hugging two sides of `current`
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

/**
 * Draw outline onto layerBuffer around `mask` using specified mode, thickness, and color.
 */
export function applySelectionOutline(
  layerBuffer: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  mode: OutlineMode,
  size: number,
  color: RGBA
): Uint8ClampedArray {
  const nextBuffer = new Uint8ClampedArray(layerBuffer)
  const outlineMask = computeSelectionOutlineMask(mask, width, height, mode, size)

  for (let i = 0; i < outlineMask.length; i++) {
    if (outlineMask[i] === 0) continue
    const bIdx = i * 4
    nextBuffer[bIdx] = color.r
    nextBuffer[bIdx + 1] = color.g
    nextBuffer[bIdx + 2] = color.b
    nextBuffer[bIdx + 3] = color.a
  }

  return nextBuffer
}
