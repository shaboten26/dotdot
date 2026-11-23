import type {
  Connectivity,
  DitherPatternId,
  GradientSteps,
  GradientType,
  RGBA,
} from '../types'
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
      if (color.a === 0) {
        buffer[bIdx] = 0
        buffer[bIdx + 1] = 0
        buffer[bIdx + 2] = 0
        buffer[bIdx + 3] = 0
      } else {
        buffer[bIdx] = color.r
        buffer[bIdx + 1] = color.g
        buffer[bIdx + 2] = color.b
        buffer[bIdx + 3] = color.a
      }
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
  /** Optional connectivity (defaults to 4-way for gradient mode) */
  connectivity?: Connectivity
  gradientType?: GradientType
  fixedRatio?: boolean
  steps: GradientSteps
  selectionMask?: Uint8Array | null
}

/**
 * Perform single-color density gradient fill inside the connected region starting at (startX, startY).
 *
 * Updated Specification (Section 16):
 * - Start point (`t <= 0`): solid fill (pattern 1, highest density).
 * - Start to End (`0 < t <= 1`): density decreases stepwise along vector `(end - start)`
 *   using 4-step `[1, 4, 6, 8]` or 8-step `[1, 2, 3, 4, 5, 6, 7, 8]`.
 * - End point (`t = 1`): final lowest-density gradient stage.
 * - Beyond End point (`t > 1`): NO gradient extension! Existing pixels remain completely untouched.
 * - When `start == end` (`lenSq === 0`), only pixels at `(startX, startY)` receive the fill.
 * - Applied ONLY inside the connected region seeded at `(startX, startY)`.
 * - Dithering masks remain anchored to canvas top-left `(0, 0)`.
 * - Pixels where the mask has `.` preserve their original pixel color & alpha.
 */
export function applyGradientFloodFill(
  buffer: Uint8ClampedArray,
  options: GradientFillOptions
): void {
  if (options.gradientType === 'radial') {
    applyRadialGradientFloodFill(buffer, options)
    return
  }

  const {
    width,
    height,
    startX,
    startY,
    endX,
    endY,
    color,
    connectivity = 4,
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
      if (lenSq === 0) {
        // Degenerate zero-length vector: only apply at the exact start=end pixel
        if (x !== Math.trunc(startX) || y !== Math.trunc(startY)) continue
        stepIndex = 0
      } else {
        // Normalized projection t: 0 at start point, 1 at end point
        const dot = (x - startX) * vx + (y - startY) * vy
        // Strictly stop at end point (dot > lenSq => t > 1 => keep existing pixel untouched!)
        if (dot > lenSq + 1e-9) {
          continue
        }
        const t = dot / lenSq
        if (t <= 0) {
          stepIndex = 0
        } else {
          stepIndex = Math.min(numSteps - 1, Math.max(0, Math.round(t * (numSteps - 1))))
        }
      }

      const patternId = patternSeq[stepIndex]
      if (!shouldDrawWithDither(patternId, x, y)) continue

      const bIdx = pIdx * 4
      if (color.a === 0) {
        buffer[bIdx] = 0
        buffer[bIdx + 1] = 0
        buffer[bIdx + 2] = 0
        buffer[bIdx + 3] = 0
      } else {
        buffer[bIdx] = color.r
        buffer[bIdx + 1] = color.g
        buffer[bIdx + 2] = color.b
        buffer[bIdx + 3] = color.a
      }
    }
  }
}

/**
 * Perform Pixel-Art Circular / Elliptical Gradient Fill (`gradientType === 'radial'`, Section 4-5):
 * - Center `(startX, startY)` has maximum opacity (`color.a`, e.g. 255) and steps outward toward `(endX, endY)` with decreasing alpha, becoming completely transparent (`alpha = 0` / untouched) outside perimeter `t > 1`.
 * - `fixedRatio = true` (1:1 ON): true circle of radius `hypot(endX - startX, endY - startY)`.
 * - `fixedRatio = false` (1:1 OFF): axis-aligned ellipse with independent radii `rx = |endX - startX|`, `ry = |endY - startY|`.
 * - Preserves crisp discrete pixel steps (`4` or `8` alpha bands), never blurs intermediate RGB colors on transparent pixels, and seamlessly supports the Transparent Color Slot (`color.a === 0` erases most strongly at center and fades out toward perimeter).
 */
export function applyRadialGradientFloodFill(
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
    connectivity = 4,
    fixedRatio = false,
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

  const dxEnd = endX - startX
  const dyEnd = endY - startY
  const circleRadius = Math.hypot(dxEnd, dyEnd)
  const absRx = Math.abs(dxEnd)
  const absRy = Math.abs(dyEnd)
  const isZeroRadius = fixedRatio
    ? circleRadius === 0
    : absRx === 0 && absRy === 0

  const rx = fixedRatio ? circleRadius : Math.max(0.5, absRx)
  const ry = fixedRatio ? circleRadius : Math.max(0.5, absRy)
  const bandCount = steps

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const pIdx = rowOffset + x
      if (region[pIdx] === 0) continue

      let normDist = 0
      if (isZeroRadius) {
        if (x !== Math.trunc(startX) || y !== Math.trunc(startY)) continue
        normDist = 0
      } else {
        const nx = (x - startX) / rx
        const ny = (y - startY) / ry
        normDist = Math.hypot(nx, ny)
        if (normDist > 1 + 1e-9) continue
      }

      const bandIdx = Math.min(
        bandCount - 1,
        Math.max(0, Math.floor(normDist * bandCount))
      )
      const strength = (bandCount - bandIdx) / bandCount
      const bIdx = pIdx * 4

      if (color.a === 0) {
        const dstA = buffer[bIdx + 3]!
        if (dstA === 0) continue
        const remainA = Math.round(dstA * (1 - strength))
        if (remainA <= 0) {
          buffer[bIdx] = 0
          buffer[bIdx + 1] = 0
          buffer[bIdx + 2] = 0
          buffer[bIdx + 3] = 0
        } else {
          buffer[bIdx + 3] = remainA
        }
      } else {
        const srcA = Math.max(1, Math.min(255, Math.round(color.a * strength)))
        const dstA = buffer[bIdx + 3]!
        if (dstA === 0 || srcA === 255) {
          buffer[bIdx] = color.r
          buffer[bIdx + 1] = color.g
          buffer[bIdx + 2] = color.b
          buffer[bIdx + 3] = srcA
        } else {
          const sa = srcA / 255
          const da = dstA / 255
          const outA = sa + da * (1 - sa)
          if (outA <= 0) {
            buffer[bIdx] = 0
            buffer[bIdx + 1] = 0
            buffer[bIdx + 2] = 0
            buffer[bIdx + 3] = 0
          } else {
            buffer[bIdx] = Math.round(
              (color.r * sa + buffer[bIdx]! * da * (1 - sa)) / outA
            )
            buffer[bIdx + 1] = Math.round(
              (color.g * sa + buffer[bIdx + 1]! * da * (1 - sa)) / outA
            )
            buffer[bIdx + 2] = Math.round(
              (color.b * sa + buffer[bIdx + 2]! * da * (1 - sa)) / outA
            )
            buffer[bIdx + 3] = Math.round(outA * 255)
          }
        }
      }
    }
  }
}
