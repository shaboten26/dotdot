import type { Point, SeamlessWrapMode, SymmetryMode } from '../types'
import type { BoundingBox } from './rasterize'

/**
 * Wrap integer coordinate `(x, y)` onto `[0..width-1, 0..height-1]` according to `wrapMode`.
 * Returns `null` when out of bounds on a non-wrapped axis.
 */
export function resolveCanvasPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  wrapMode: SeamlessWrapMode = 'none'
): Point | null {
  if (width <= 0 || height <= 0) return null
  let rx = Math.trunc(x)
  let ry = Math.trunc(y)

  if (wrapMode === 'horizontal' || wrapMode === 'both') {
    rx = ((rx % width) + width) % width
  } else if (rx < 0 || rx >= width) {
    return null
  }

  if (wrapMode === 'vertical' || wrapMode === 'both') {
    ry = ((ry % height) + height) % height
  } else if (ry < 0 || ry >= height) {
    return null
  }

  return { x: rx, y: ry }
}

/**
 * Expand a single canvas/world point into deduplicated symmetric counterparts
 * around the exact canvas center `((width - 1) / 2, (height - 1) / 2)`.
 * - Odd sizes share the center pixel row/column without double-stamping.
 * - Even sizes reflect cleanly across the boundary between the middle two rows/columns.
 */
export function expandSymmetricPoints(
  pt: Point,
  width: number,
  height: number,
  mode: SymmetryMode = 'none'
): Point[] {
  const x = Math.round(pt.x)
  const y = Math.round(pt.y)
  if (mode === 'none') {
    return [{ x, y }]
  }

  const mx = width - 1 - x
  const my = height - 1 - y

  if (mode === 'horizontal') {
    return mx === x ? [{ x, y }] : [{ x, y }, { x: mx, y }]
  }

  if (mode === 'vertical') {
    return my === y ? [{ x, y }] : [{ x, y }, { x, y: my }]
  }

  // Quad 4-way symmetry (deduplicate center row/column overlaps)
  const out: Point[] = [{ x, y }]
  if (mx !== x) {
    out.push({ x: mx, y })
  }
  if (my !== y) {
    out.push({ x, y: my })
  }
  if (mx !== x && my !== y) {
    out.push({ x: mx, y: my })
  }
  return out
}

/**
 * Reflect a sequence of points into symmetric stroke paths (`1`, `2`, or `4` paths).
 */
export function expandSymmetricStrokePaths(
  points: readonly Point[],
  width: number,
  height: number,
  mode: SymmetryMode = 'none'
): Point[][] {
  if (mode === 'none' || points.length === 0) {
    return [points.map((p) => ({ x: p.x, y: p.y }))]
  }

  const mapPath = (fx: (x: number) => number, fy: (y: number) => number): Point[] =>
    points.map((p) => ({ x: fx(Math.round(p.x)), y: fy(Math.round(p.y)) }))

  const id = (v: number) => v
  const rx = (v: number) => width - 1 - v
  const ry = (v: number) => height - 1 - v

  if (mode === 'horizontal') {
    return [mapPath(id, id), mapPath(rx, id)]
  }
  if (mode === 'vertical') {
    return [mapPath(id, id), mapPath(id, ry)]
  }
  return [
    mapPath(id, id),
    mapPath(rx, id),
    mapPath(id, ry),
    mapPath(rx, ry),
  ]
}

/**
 * Expand an axis-aligned `BoundingBox` across active symmetry axes.
 */
export function expandSymmetricBounds(
  bounds: BoundingBox,
  width: number,
  height: number,
  mode: SymmetryMode = 'none'
): BoundingBox[] {
  if (mode === 'none') return [bounds]

  const makeBox = (minX: number, maxX: number, minY: number, maxY: number): BoundingBox => ({
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  })

  const mx0 = width - 1 - bounds.maxX
  const mx1 = width - 1 - bounds.minX
  const my0 = height - 1 - bounds.maxY
  const my1 = height - 1 - bounds.minY

  const candidates: BoundingBox[] = [bounds]
  if (mode === 'horizontal' || mode === 'quad') {
    candidates.push(makeBox(mx0, mx1, bounds.minY, bounds.maxY))
  }
  if (mode === 'vertical' || mode === 'quad') {
    candidates.push(makeBox(bounds.minX, bounds.maxX, my0, my1))
  }
  if (mode === 'quad') {
    candidates.push(makeBox(mx0, mx1, my0, my1))
  }

  const seen = new Set<string>()
  const unique: BoundingBox[] = []
  for (const b of candidates) {
    const k = `${b.minX}:${b.maxX}:${b.minY}:${b.maxY}`
    if (!seen.has(k)) {
      seen.add(k)
      unique.push(b)
    }
  }
  return unique
}
