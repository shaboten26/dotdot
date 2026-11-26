import {
  TRANSPARENT_INDEX,
  type BrushShape,
  type DitherPatternId,
  type Point,
  type RGBA,
  type SeamlessWrapMode,
  type SymmetryMode,
} from '../types'
import { shouldDrawWithDither } from './dithering'
import { expandSymmetricPoints, resolveCanvasPoint } from './symmetry'

const brushOffsetCache = new Map<string, Point[]>()

/**
 * Generate relative pixel offsets for a brush of given size (1..64) and shape ('square' | 'circle').
 * Symmetry is preserved for both odd and even brush diameters.
 */
export function getBrushOffsets(size: number, shape: BrushShape): readonly Point[] {
  const clampedSize = Math.max(1, Math.min(64, Math.round(size)))
  const key = `${clampedSize}:${shape}`
  const cached = brushOffsetCache.get(key)
  if (cached) return cached

  const offsets: Point[] = []
  if (clampedSize === 1) {
    offsets.push({ x: 0, y: 0 })
    brushOffsetCache.set(key, offsets)
    return offsets
  }

  const start = -Math.floor((clampedSize - 1) / 2)
  const end = start + clampedSize - 1

  if (shape === 'square') {
    for (let dy = start; dy <= end; dy++) {
      for (let dx = start; dx <= end; dx++) {
        offsets.push({ x: dx, y: dy })
      }
    }
  } else {
    const center = (start + end) / 2
    const radius = clampedSize / 2
    const rSq = (radius - 0.05) * (radius - 0.05) + (clampedSize <= 3 ? 0.25 : 0.12)
    for (let dy = start; dy <= end; dy++) {
      for (let dx = start; dx <= end; dx++) {
        const distSq = (dx - center) * (dx - center) + (dy - center) * (dy - center)
        if (distSq <= rSq) {
          offsets.push({ x: dx, y: dy })
        }
      }
    }
  }

  brushOffsetCache.set(key, offsets)
  return offsets
}

export function resolveDrawColorIndex(
  colorIndex?: number,
  color?: number | RGBA,
  erase = false
): number {
  if (erase) return TRANSPARENT_INDEX
  if (typeof colorIndex === 'number') {
    return colorIndex < 0 || colorIndex >= TRANSPARENT_INDEX
      ? TRANSPARENT_INDEX
      : colorIndex & 0xff
  }
  if (typeof color === 'number') {
    return color < 0 || color >= TRANSPARENT_INDEX ? TRANSPARENT_INDEX : color & 0xff
  }
  if (color && typeof color === 'object') {
    return color.a === 0 ? TRANSPARENT_INDEX : color.r & 0xff
  }
  return 0
}

export interface StampOptions {
  width: number
  height: number
  size: number
  shape: BrushShape
  /** Fixed palette index (`0..254`) or `TRANSPARENT_INDEX` (`255`) */
  colorIndex?: number
  /** Optional fallback for callers passing index/RGBA */
  color?: number | RGBA
  dither?: DitherPatternId
  erase?: boolean
  selectionMask?: Uint8Array | null
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
}

function paintSingleCenter(
  buffer: Uint8Array,
  cx: number,
  cy: number,
  offsets: readonly Point[],
  options: StampOptions,
  targetIdx: number,
  mirrorX = false,
  mirrorY = false
): void {
  const {
    width,
    height,
    dither = 1,
    erase = false,
    selectionMask = null,
    seamlessWrap = 'none',
  } = options

  for (let i = 0; i < offsets.length; i++) {
    const ox = mirrorX ? -offsets[i]!.x : offsets[i]!.x
    const oy = mirrorY ? -offsets[i]!.y : offsets[i]!.y
    const resolved = resolveCanvasPoint(cx + ox, cy + oy, width, height, seamlessWrap)
    if (!resolved) continue

    const px = resolved.x
    const py = resolved.y
    const pIndex = py * width + px
    if (selectionMask && selectionMask[pIndex] === 0) continue

    if (erase) {
      buffer[pIndex] = TRANSPARENT_INDEX
      continue
    }

    if (!shouldDrawWithDither(dither, px, py)) continue
    buffer[pIndex] = targetIdx
  }
}

/**
 * Paint brush at center `(cx, cy)` onto target 1-byte Indexed Color buffer,
 * honoring optional Symmetry and Seamless torus wrap.
 */
export function stampBrushAt(
  buffer: Uint8Array,
  cx: number,
  cy: number,
  options: StampOptions
): void {
  const { width, height, size, shape, symmetry = 'none' } = options
  const offsets = getBrushOffsets(size, shape)
  const targetIdx = resolveDrawColorIndex(
    options.colorIndex,
    options.color,
    options.erase
  )

  if (symmetry === 'none') {
    paintSingleCenter(buffer, cx, cy, offsets, options, targetIdx, false, false)
    return
  }

  const centers = expandSymmetricPoints({ x: cx, y: cy }, width, height, symmetry)
  for (let c = 0; c < centers.length; c++) {
    const pt = centers[c]!
    const mx = pt.x !== Math.round(cx)
    const my = pt.y !== Math.round(cy)
    paintSingleCenter(buffer, pt.x, pt.y, offsets, options, targetIdx, mx, my)
  }
}

/**
 * Paint a list of center points onto a 1-byte Indexed Color buffer.
 */
export function stampPoints(
  buffer: Uint8Array,
  points: readonly Point[],
  options: StampOptions
): void {
  for (let i = 0; i < points.length; i++) {
    stampBrushAt(buffer, points[i]!.x, points[i]!.y, options)
  }
}
