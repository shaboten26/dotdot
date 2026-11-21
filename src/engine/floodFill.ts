import type { Connectivity, DitherPatternId, GradientSteps, RGBA } from '../types'
import { GRADIENT_PATTERN_STEPS, shouldDrawWithDither } from './dithering'
import { isInBounds, pixelsMatchAt } from './pixelBuffer'

const DIRS_4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

const DIRS_8: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/**
 * Extract connected same-color region starting at (seedX, seedY).
 * Returns Uint8Array mask of length width * height (1 = in connected region, 0 = outside).
 * If selectionMask is provided, flood fill is constrained inside selectionMask.
 */
export function computeConnectedRegion(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  connectivity: Connectivity,
  selectionMask?: Uint8Array | null
): Uint8Array {
  const region = new Uint8Array(width * height)
  const sx = Math.trunc(seedX)
  const sy = Math.trunc(seedY)
  if (!isInBounds(sx, sy, width, height)) return region

  const seedIdx = sy * width + sx
  if (selectionMask && selectionMask[seedIdx] === 0) return region

  const seedByteOffset = seedIdx * 4
  const dirs = connectivity === 8 ? DIRS_8 : DIRS_4

  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0

  region[seedIdx] = 1
  queue[tail++] = seedIdx

  while (head < tail) {
    const currIdx = queue[head++]
    const cx = currIdx % width
    const cy = (currIdx - cx) / width

    for (let d = 0; d < dirs.length; d++) {
      const nx = cx + dirs[d][0]
      const ny = cy + dirs[d][1]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue

      const nIdx = ny * width + nx
      if (region[nIdx] === 1) continue
      if (selectionMask && selectionMask[nIdx] === 0) continue

      if (pixelsMatchAt(buffer, seedByteOffset, nIdx * 4)) {
        region[nIdx] = 1
        queue[tail++] = nIdx
      }
    }
  }

  return region
}

export interface NormalFillOptions {
  width: number
  height: number
  seedX: number
  seedY: number
  color: RGBA
  connectivity: Connectivity
  dither: DitherPatternId
  selectionMask?: Uint8Array | null
}

/**
 * Perform standard or dithered flood fill in-place on `buffer`.
 * Pixels where dither mask is '.' remain completely unchanged (original color & alpha kept).
 */
export function applyFloodFill(
  buffer: Uint8ClampedArray,
  options: NormalFillOptions
): void {
  const { width, height, seedX, seedY, color, connectivity, dither, selectionMask } = options
  const region = computeConnectedRegion(
    buffer,
    width,
    height,
    seedX,
    seedY,
    connectivity,
    selectionMask
  )

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const pIdx = rowOffset + x
      if (region[pIdx] === 0) continue
      if (!shouldDrawWithDither(dither, x, y)) continue

      const bIdx = pIdx * 4
      buffer[bIdx] = color.r
      buffer[bIdx + 1] = color.g
      buffer[bIdx + 2] = color.b
      buffer[bIdx + 3] = color.a
    }
  }
}

export interface GradientFillOptions {
  width: number
  height: number
  startX: number
  startY: number
  endX: number
  endY: number
  color: RGBA
  connectivity: Connectivity
  steps: GradientSteps
  selectionMask?: Uint8Array | null
}

/**
 * Perform single-color density gradient fill inside the connected region starting at (startX, startY).
 *
 * Rules (Section 4-3):
 * - Same selected color throughout; density decreases stepwise from start (solid pattern 1) to end (pattern 8).
 * - 4-step uses patterns [1, 4, 6, 8]; 8-step uses [1, 2, 3, 4, 5, 6, 7, 8].
 * - Applied ONLY inside the connected region seeded at (startX, startY).
 * - Step at (x, y) is determined strictly by scalar projection along vector (end - start),
 *   so pixels at the same projection position always receive the same density step.
 * - Start point receives solid fill (step 0 -> pattern 1) and end point receives lowest density (last step -> pattern 8).
 * - Dithering masks remain anchored to canvas top-left (0, 0).
 * - Pixels where the mask has '.' preserve their original pixel color & alpha.
 */
export function applyGradientFloodFill(
  buffer: Uint8ClampedArray,
  options: GradientFillOptions
): void {
  const {
    width,
    height,
    startX,
    startY,
    endX,
    endY,
    color,
    connectivity,
    steps,
    selectionMask,
  } = options

  const region = computeConnectedRegion(
    buffer,
    width,
    height,
    startX,
    startY,
    connectivity,
    selectionMask
  )

  const patternSeq = GRADIENT_PATTERN_STEPS[steps]
  const numSteps = patternSeq.length

  const vx = endX - startX
  const vy = endY - startY
  const lenSq = vx * vx + vy * vy

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const pIdx = rowOffset + x
      if (region[pIdx] === 0) continue

      let stepIndex = 0
      if (lenSq > 0) {
        // Normalized projection t: 0 at start point, 1 at end point
        const t = ((x - startX) * vx + (y - startY) * vy) / lenSq
        if (t <= 0) {
          stepIndex = 0
        } else if (t >= 1) {
          stepIndex = numSteps - 1
        } else {
          // Map (0, 1) evenly across steps so start=0 and end=numSteps-1
          stepIndex = Math.min(numSteps - 1, Math.max(0, Math.round(t * (numSteps - 1))))
        }
      }

      const patternId = patternSeq[stepIndex]
      if (!shouldDrawWithDither(patternId, x, y)) continue

      const bIdx = pIdx * 4
      buffer[bIdx] = color.r
      buffer[bIdx + 1] = color.g
      buffer[bIdx + 2] = color.b
      buffer[bIdx + 3] = color.a
    }
  }
}
