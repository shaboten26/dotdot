import type {
  BrushShape,
  DitherPatternId,
  Point,
  RGBA,
  SeamlessWrapMode,
  SymmetryMode,
} from '../types'
import { stampPoints, type PatternTileSource } from './brush'
import { shouldDrawWithDither } from './dithering'
import { bresenhamLinePoints, filterPixelPerfectPoints } from './pixelPerfect'
import { expandSymmetricBounds, resolveCanvasPoint } from './symmetry'

export interface LineDrawOptions {
  width: number
  height: number
  size: number
  shape: BrushShape
  dither: DitherPatternId
  pixelPerfect?: boolean
  color: RGBA
  selectionMask?: Uint8Array | null
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
  patternTile?: PatternTileSource | null
}

/**
 * Draw straight pixel line from p0 to p1 using shared brush & dithering engine.
 * Supports out-of-canvas start/end coordinates and optional Pixel-Perfect L-corner filtering (Section 2 & 12).
 */
export function drawLine(
  buffer: Uint8ClampedArray,
  p0: Point,
  p1: Point,
  options: LineDrawOptions
): void {
  const rawPts = bresenhamLinePoints(p0.x, p0.y, p1.x, p1.y)
  const pts = options.pixelPerfect ? filterPixelPerfectPoints(rawPts) : rawPts
  stampPoints(buffer, pts, options)
}

/**
 * Evaluate cubic Bezier B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
 */
export function evaluateCubicBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number
): Point {
  const u = 1 - t
  const u2 = u * u
  const u3 = u2 * u
  const t2 = t * t
  const t3 = t2 * t

  return {
    x: u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x,
    y: u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y,
  }
}

/**
 * Raw 8-connected integer rasterization of a cubic Bezier curve before pixel-perfect pruning.
 */
export function rasterizeCubicBezierRawPoints(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): Point[] {
  const approxLength =
    Math.hypot(p1.x - p0.x, p1.y - p0.y) +
    Math.hypot(p2.x - p1.x, p2.y - p1.y) +
    Math.hypot(p3.x - p2.x, p3.y - p2.y)

  const segments = Math.max(48, Math.min(2048, Math.ceil(approxLength * 6)))
  const points: Point[] = []

  let prevX = Math.round(p0.x)
  let prevY = Math.round(p0.y)
  points.push({ x: prevX, y: prevY })

  for (let i = 1; i <= segments; i++) {
    const t = i / segments
    const pt = evaluateCubicBezier(p0, p1, p2, p3, t)
    const rx = Math.round(pt.x)
    const ry = Math.round(pt.y)

    if (rx === prevX && ry === prevY) continue

    const bridge = bresenhamLinePoints(prevX, prevY, rx, ry)
    for (let j = 1; j < bridge.length; j++) {
      points.push(bridge[j])
    }
    prevX = rx
    prevY = ry
  }

  return points
}

/**
 * Spec v2 Section 9:
 * Generate a 1px Pixel-Perfect cubic Bezier centerline:
 * - Eliminates L-shaped corner jaggies and redundant 2x2 pixel clumps
 * - Preserves 8-connected continuity from P0 to P3
 * - Zero anti-aliasing (strictly integer coordinates)
 */
export function rasterizeCubicBezierPoints(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): Point[] {
  const raw = rasterizeCubicBezierRawPoints(p0, p1, p2, p3)
  if (raw.length <= 2) return raw

  // Pass 1: Standard sequential L-corner removal
  const pass1 = filterPixelPerfectPoints(raw)
  if (pass1.length <= 2) return pass1

  // Pass 2: Suppress any remaining redundant corners or tight turn 2x2 clumps
  // while strictly preserving start point, end point, and 8-neighbor path connectivity.
  const out: Point[] = [pass1[0]]
  for (let i = 1; i < pass1.length - 1; i++) {
    const prev = out[out.length - 1]
    const curr = pass1[i]
    const next = pass1[i + 1]

    // Skip exact duplicate if any
    if (curr.x === prev.x && curr.y === prev.y) continue

    // If prev and next are already 8-connected (|dx|<=1 && |dy|<=1) and curr forms an L-elbow
    // (i.e. orthogonal to both prev and next, or collapsing a tight hairpin 2x2), prune curr
    const dxPN = Math.abs(next.x - prev.x)
    const dyPN = Math.abs(next.y - prev.y)
    const prevNext8Connected = dxPN <= 1 && dyPN <= 1 && (dxPN > 0 || dyPN > 0)

    const currOrthPrev =
      (curr.x === prev.x && Math.abs(curr.y - prev.y) === 1) ||
      (curr.y === prev.y && Math.abs(curr.x - prev.x) === 1)
    const currOrthNext =
      (curr.x === next.x && Math.abs(curr.y - next.y) === 1) ||
      (curr.y === next.y && Math.abs(curr.x - next.x) === 1)

    if (prevNext8Connected && currOrthPrev && currOrthNext) {
      continue
    }

    out.push(curr)
  }

  const last = pass1[pass1.length - 1]
  const tail = out[out.length - 1]
  if (tail.x !== last.x || tail.y !== last.y) {
    out.push(last)
  }

  return out
}

/**
 * Draw cubic Bezier curve onto buffer (Spec v2 Section 9):
 * - Size 1: draws the exact 1px pixel-perfect curve.
 * - Size >= 2: first generates the exact Size-1 pixel-perfect centerline, then thickens along
 *   that centerline using the selected brush shape ('circle' | 'square') and dithering.
 */
export function drawCubicBezier(
  buffer: Uint8ClampedArray,
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  options: LineDrawOptions
): void {
  const centerline1px = rasterizeCubicBezierPoints(p0, p1, p2, p3)
  stampPoints(buffer, centerline1px, options)
}

export interface BoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

/**
 * Compute integer bounding box from start point and end point, optionally enforcing 1:1 fixed aspect ratio.
 */
export function computeShapeBounds(
  start: Point,
  end: Point,
  fixedRatio: boolean
): BoundingBox {
  const x0 = Math.round(start.x)
  const y0 = Math.round(start.y)
  let x1 = Math.round(end.x)
  let y1 = Math.round(end.y)

  if (fixedRatio) {
    const dx = x1 - x0
    const dy = y1 - y0
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    x1 = x0 + (dx >= 0 ? side : -side)
    y1 = y0 + (dy >= 0 ? side : -side)
  }

  const minX = Math.min(x0, x1)
  const maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1)
  const maxY = Math.max(y0, y1)

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

export interface ShapeRasterOptions {
  width: number
  height: number
  filled: boolean
  strokeSize?: number
  dither?: DitherPatternId
  color: RGBA
  selectionMask?: Uint8Array | null
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
}

function plotShapePixel(
  buffer: Uint8ClampedArray,
  x: number,
  y: number,
  options: ShapeRasterOptions
): void {
  const {
    width,
    height,
    dither = 1,
    color,
    selectionMask,
    seamlessWrap = 'none',
  } = options
  const resolved = resolveCanvasPoint(x, y, width, height, seamlessWrap)
  if (!resolved) return
  const px = resolved.x
  const py = resolved.y
  const pIdx = py * width + px
  if (selectionMask && selectionMask[pIdx] === 0) return
  if (!shouldDrawWithDither(dither, px, py)) return

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

/**
 * Rasterize axis-aligned rectangle (filled or outline) with zero anti-aliasing.
 */
export function rasterizeRectangle(
  buffer: Uint8ClampedArray,
  bounds: BoundingBox,
  options: ShapeRasterOptions
): void {
  const stroke = Math.max(1, Math.round(options.strokeSize ?? 1))
  const boxes = expandSymmetricBounds(
    bounds,
    options.width,
    options.height,
    options.symmetry ?? 'none'
  )

  for (const box of boxes) {
    const { minX, minY, maxX, maxY } = box
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (options.filled) {
          plotShapePixel(buffer, x, y, options)
        } else {
          const onBorder =
            x - minX < stroke ||
            maxX - x < stroke ||
            y - minY < stroke ||
            maxY - y < stroke
          if (onBorder) {
            plotShapePixel(buffer, x, y, options)
          }
        }
      }
    }
  }
}

/**
 * Compute boolean mask of filled ellipse inside bounds [0..w-1, 0..h-1] with exact quadrant symmetry.
 */
export function buildFilledEllipseMask(w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  if (w <= 0 || h <= 0) return mask

  if (w === 1 || h === 1) {
    mask.fill(1)
    return mask
  }

  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const rx = w / 2
  const ry = h / 2

  for (let y = 0; y < h; y++) {
    const ny = (y - cy) / ry
    const ny2 = ny * ny
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / rx
      if (nx * nx + ny2 <= 1.0 + 1e-9) {
        mask[y * w + x] = 1
      }
    }
  }
  return mask
}

/**
 * Rasterize ellipse / circle inside `bounds` (filled or crisp pixel outline, no anti-aliasing).
 */
export function rasterizeEllipse(
  buffer: Uint8ClampedArray,
  bounds: BoundingBox,
  options: ShapeRasterOptions
): void {
  const boxes = expandSymmetricBounds(
    bounds,
    options.width,
    options.height,
    options.symmetry ?? 'none'
  )
  const stroke = Math.max(1, Math.round(options.strokeSize ?? 1))

  for (const box of boxes) {
    const { minX, minY, width: bw, height: bh } = box
    const outer = buildFilledEllipseMask(bw, bh)

    if (options.filled || bw <= stroke * 2 || bh <= stroke * 2) {
      for (let ly = 0; ly < bh; ly++) {
        for (let lx = 0; lx < bw; lx++) {
          if (outer[ly * bw + lx] === 1) {
            plotShapePixel(buffer, minX + lx, minY + ly, options)
          }
        }
      }
      continue
    }

    const innerW = bw - stroke * 2
    const innerH = bh - stroke * 2
    const inner = buildFilledEllipseMask(innerW, innerH)

    for (let ly = 0; ly < bh; ly++) {
      for (let lx = 0; lx < bw; lx++) {
        if (outer[ly * bw + lx] === 0) continue
        const ix = lx - stroke
        const iy = ly - stroke
        const insideInner =
          ix >= 0 && iy >= 0 && ix < innerW && iy < innerH && inner[iy * innerW + ix] === 1
        if (!insideInner) {
          plotShapePixel(buffer, minX + lx, minY + ly, options)
        }
      }
    }
  }
}
