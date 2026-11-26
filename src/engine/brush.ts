import type {
  BrushShape,
  DitherPatternId,
  Point,
  RGBA,
  SeamlessWrapMode,
  SymmetryMode,
} from '../types'
import { shouldDrawWithDither } from './dithering'
import { expandSymmetricPoints, resolveCanvasPoint } from './symmetry'

const stampCache = new Map<string, Point[]>()

/**
 * Generate relative pixel offsets for a brush of given size (1..64) and shape ('square' | 'circle').
 * Symmetry is preserved for both odd and even brush diameters.
 */
export function getBrushOffsets(size: number, shape: BrushShape): readonly Point[] {
  const clampedSize = Math.max(1, Math.min(64, Math.round(size)))
  const key = `${clampedSize}:${shape}`
  const cached = stampCache.get(key)
  if (cached) return cached

  const offsets: Point[] = []
  if (clampedSize === 1) {
    offsets.push({ x: 0, y: 0 })
    stampCache.set(key, offsets)
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
    // Circle: measure distance from exact geometric center of [start .. end]
    const center = (start + end) / 2
    // Slightly forgiving radius (+0.15) produces classic crisp pixel-art circles at small sizes (2,3,4,5...)
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

  stampCache.set(key, offsets)
  return offsets
}

export interface PatternTileSource {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

export interface StampOptions {
  width: number
  height: number
  size: number
  shape: BrushShape
  color: RGBA
  dither?: DitherPatternId
  erase?: boolean
  selectionMask?: Uint8Array | null
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
  patternTile?: PatternTileSource | null
}

function stampSingleCenter(
  buffer: Uint8ClampedArray,
  cx: number,
  cy: number,
  offsets: readonly Point[],
  options: StampOptions,
  mirrorX = false,
  mirrorY = false
): void {
  const {
    width,
    height,
    color,
    dither = 1,
    erase = false,
    selectionMask = null,
    seamlessWrap = 'none',
    patternTile = null,
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
      const idx = pIndex * 4
      buffer[idx] = 0
      buffer[idx + 1] = 0
      buffer[idx + 2] = 0
      buffer[idx + 3] = 0
      continue
    }

    if (!shouldDrawWithDither(dither, px, py)) continue

    if (patternTile && patternTile.width > 0 && patternTile.height > 0) {
      const tx = ((px % patternTile.width) + patternTile.width) % patternTile.width
      const ty = ((py % patternTile.height) + patternTile.height) % patternTile.height
      const sIdx = (ty * patternTile.width + tx) * 4
      const sa = patternTile.data[sIdx + 3]!
      // Transparent pixels inside a pattern brush motif keep existing canvas pixels untouched
      if (sa === 0) continue
      const idx = pIndex * 4
      buffer[idx] = patternTile.data[sIdx]!
      buffer[idx + 1] = patternTile.data[sIdx + 1]!
      buffer[idx + 2] = patternTile.data[sIdx + 2]!
      buffer[idx + 3] = sa
      continue
    }

    const idx = pIndex * 4
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
}

/**
 * Stamp brush at center (cx, cy) onto target RGBA buffer, honoring optional Symmetry,
 * Seamless torus wrap, and Pattern Brush tiling.
 */
export function stampBrushAt(
  buffer: Uint8ClampedArray,
  cx: number,
  cy: number,
  options: StampOptions
): void {
  const { width, height, size, shape, symmetry = 'none' } = options
  const offsets = getBrushOffsets(size, shape)

  if (symmetry === 'none') {
    stampSingleCenter(buffer, cx, cy, offsets, options, false, false)
    return
  }

  const centers = expandSymmetricPoints({ x: cx, y: cy }, width, height, symmetry)
  for (let c = 0; c < centers.length; c++) {
    const pt = centers[c]!
    const mx = pt.x !== Math.round(cx)
    const my = pt.y !== Math.round(cy)
    stampSingleCenter(buffer, pt.x, pt.y, offsets, options, mx, my)
  }
}

/**
 * Paint a list of center points onto buffer using brush stamp options.
 */
export function stampPoints(
  buffer: Uint8ClampedArray,
  points: readonly Point[],
  options: StampOptions
): void {
  for (let i = 0; i < points.length; i++) {
    stampBrushAt(buffer, points[i]!.x, points[i]!.y, options)
  }
}
