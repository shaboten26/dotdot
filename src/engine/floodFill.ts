import type {
  Connectivity,
  DitherPatternId,
  GradientSteps,
  GradientType,
  RGBA,
  SeamlessWrapMode,
  SymmetryMode,
} from '../types'
import { GRADIENT_PATTERN_STEPS, shouldDrawWithDither } from './dithering'
import { pixelsMatchAt } from './pixelBuffer'
import { expandSymmetricPoints, resolveCanvasPoint } from './symmetry'

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
 * When `seamlessWrap` is active (`'horizontal' | 'vertical' | 'both'`), connectivity wraps across the opposite canvas edge!
 */
export function computeConnectedRegion(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
  connectivity: Connectivity,
  selectionMask?: Uint8Array | null,
  seamlessWrap: SeamlessWrapMode = 'none'
): Uint8Array {
  const region = new Uint8Array(width * height)
  const resolvedSeed = resolveCanvasPoint(seedX, seedY, width, height, seamlessWrap)
  if (!resolvedSeed) return region

  const sx = resolvedSeed.x
  const sy = resolvedSeed.y
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
    const currIdx = queue[head++]!
    const cx = currIdx % width
    const cy = (currIdx - cx) / width

    for (let d = 0; d < dirs.length; d++) {
      const nextPt = resolveCanvasPoint(
        cx + dirs[d]![0],
        cy + dirs[d]![1],
        width,
        height,
        seamlessWrap
      )
      if (!nextPt) continue

      const nIdx = nextPt.y * width + nextPt.x
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
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
}

/**
 * Perform standard or dithered flood fill in-place on `buffer`.
 * Pixels where dither mask is '.' remain completely unchanged (original color & alpha kept).
 * Honors optional Symmetry (fills symmetric seed regions in a single atomic operation) and Seamless torus wrap.
 */
export function applyFloodFill(
  buffer: Uint8ClampedArray,
  options: NormalFillOptions
): void {
  const {
    width,
    height,
    seedX,
    seedY,
    color,
    connectivity,
    dither,
    selectionMask,
    symmetry = 'none',
    seamlessWrap = 'none',
  } = options

  const seeds = expandSymmetricPoints({ x: seedX, y: seedY }, width, height, symmetry)
  // Compute all seed regions against the initial pre-fill buffer so symmetric fills behave consistently
  // even when two symmetric seeds belong to separate regions of different or identical colors!
  const combinedRegion = new Uint8Array(width * height)
  for (const s of seeds) {
    const part = computeConnectedRegion(
      buffer,
      width,
      height,
      s.x,
      s.y,
      connectivity,
      selectionMask,
      seamlessWrap
    )
    for (let i = 0; i < combinedRegion.length; i++) {
      if (part[i] === 1) combinedRegion[i] = 1
    }
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const pIdx = rowOffset + x
      if (combinedRegion[pIdx] === 0) continue
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
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
}

function applySingleGradientPass(
  sourceBuffer: Uint8ClampedArray,
  targetBuffer: Uint8ClampedArray,
  options: Omit<GradientFillOptions, 'symmetry'>
): void {
  if (options.gradientType === 'radial') {
    applyRadialGradientPass(sourceBuffer, targetBuffer, options)
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
    seamlessWrap = 'none',
  } = options

  const region = computeConnectedRegion(
    sourceBuffer,
    width,
    height,
    startX,
    startY,
    connectivity,
    selectionMask,
    seamlessWrap
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
        if (x !== Math.trunc(startX) || y !== Math.trunc(startY)) continue
        stepIndex = 0
      } else {
        const dot = (x - startX) * vx + (y - startY) * vy
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

      const patternId = patternSeq[stepIndex]!
      if (!shouldDrawWithDither(patternId, x, y)) continue

      const bIdx = pIdx * 4
      if (color.a === 0) {
        targetBuffer[bIdx] = 0
        targetBuffer[bIdx + 1] = 0
        targetBuffer[bIdx + 2] = 0
        targetBuffer[bIdx + 3] = 0
      } else {
        targetBuffer[bIdx] = color.r
        targetBuffer[bIdx + 1] = color.g
        targetBuffer[bIdx + 2] = color.b
        targetBuffer[bIdx + 3] = color.a
      }
    }
  }
}

function applyRadialGradientPass(
  sourceBuffer: Uint8ClampedArray,
  targetBuffer: Uint8ClampedArray,
  options: Omit<GradientFillOptions, 'symmetry'>
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
    seamlessWrap = 'none',
  } = options

  const region = computeConnectedRegion(
    sourceBuffer,
    width,
    height,
    startX,
    startY,
    connectivity,
    selectionMask,
    seamlessWrap
  )

  const patternSeq = GRADIENT_PATTERN_STEPS[steps]
  const numSteps = patternSeq.length

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

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    for (let x = 0; x < width; x++) {
      const pIdx = rowOffset + x
      if (region[pIdx] === 0) continue

      let stepIndex = 0
      if (isZeroRadius) {
        if (x !== Math.trunc(startX) || y !== Math.trunc(startY)) continue
        stepIndex = 0
      } else {
        const nx = (x - startX) / rx
        const ny = (y - startY) / ry
        const normDist = Math.hypot(nx, ny)
        if (normDist > 1 + 1e-9) {
          continue
        }
        if (normDist <= 0) {
          stepIndex = 0
        } else {
          stepIndex = Math.min(
            numSteps - 1,
            Math.max(0, Math.round(normDist * (numSteps - 1)))
          )
        }
      }

      const patternId = patternSeq[stepIndex]!
      if (!shouldDrawWithDither(patternId, x, y)) continue

      const bIdx = pIdx * 4
      if (color.a === 0) {
        targetBuffer[bIdx] = 0
        targetBuffer[bIdx + 1] = 0
        targetBuffer[bIdx + 2] = 0
        targetBuffer[bIdx + 3] = 0
      } else {
        targetBuffer[bIdx] = color.r
        targetBuffer[bIdx + 1] = color.g
        targetBuffer[bIdx + 2] = color.b
        targetBuffer[bIdx + 3] = color.a
      }
    }
  }
}

export function applyGradientFloodFill(
  buffer: Uint8ClampedArray,
  options: GradientFillOptions
): void {
  const { width, height, startX, startY, endX, endY, symmetry = 'none' } = options
  if (symmetry === 'none') {
    applySingleGradientPass(buffer, buffer, options)
    return
  }

  const snapshot = new Uint8ClampedArray(buffer)
  const pairs: Array<{ sx: number; sy: number; ex: number; ey: number }> = [
    { sx: startX, sy: startY, ex: endX, ey: endY },
  ]
  const mxS = width - 1 - startX
  const mxE = width - 1 - endX
  const myS = height - 1 - startY
  const myE = height - 1 - endY

  if (symmetry === 'horizontal' || symmetry === 'quad') {
    pairs.push({ sx: mxS, sy: startY, ex: mxE, ey: endY })
  }
  if (symmetry === 'vertical' || symmetry === 'quad') {
    pairs.push({ sx: startX, sy: myS, ex: endX, ey: myE })
  }
  if (symmetry === 'quad') {
    pairs.push({ sx: mxS, sy: myS, ex: mxE, ey: myE })
  }

  for (const p of pairs) {
    applySingleGradientPass(snapshot, buffer, {
      ...options,
      startX: p.sx,
      startY: p.sy,
      endX: p.ex,
      endY: p.ey,
    })
  }
}

export function applyRadialGradientFloodFill(
  buffer: Uint8ClampedArray,
  options: GradientFillOptions
): void {
  applyGradientFloodFill(buffer, { ...options, gradientType: 'radial' })
}
