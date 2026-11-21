import type { Point } from '../types'

/**
 * Bresenham integer line points between p0 and p1 (inclusive).
 */
export function bresenhamLinePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const points: Point[] = []
  let cx = Math.round(x0)
  let cy = Math.round(y0)
  const tx = Math.round(x1)
  const ty = Math.round(y1)

  const dx = Math.abs(tx - cx)
  const dy = -Math.abs(ty - cy)
  const sx = cx < tx ? 1 : -1
  const sy = cy < ty ? 1 : -1
  let err = dx + dy

  while (true) {
    points.push({ x: cx, y: cy })
    if (cx === tx && cy === ty) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      cx += sx
    }
    if (e2 <= dx) {
      err += dx
      cy += sy
    }
  }
  return points
}

/**
 * Expand raw input pointer samples into a continuous 8-connected pixel path
 * by interpolating gaps with Bresenham segments and removing consecutive duplicates.
 */
export function expandStrokePoints(rawSamples: readonly Point[]): Point[] {
  if (rawSamples.length === 0) return []
  const expanded: Point[] = [{ x: Math.round(rawSamples[0].x), y: Math.round(rawSamples[0].y) }]

  for (let i = 1; i < rawSamples.length; i++) {
    const prev = expanded[expanded.length - 1]
    const nextX = Math.round(rawSamples[i].x)
    const nextY = Math.round(rawSamples[i].y)
    if (prev.x === nextX && prev.y === nextY) continue

    const seg = bresenhamLinePoints(prev.x, prev.y, nextX, nextY)
    for (let j = 1; j < seg.length; j++) {
      expanded.push(seg[j])
    }
  }
  return expanded
}

/**
 * Independent Pixel-Perfect stroke filter (L-corner removal algorithm).
 *
 * Removes unnecessary 90-degree corner double-pixels along diagonal transitions:
 * If P[c-1] -> P[c] is 4-connected (cardinal step) AND P[c] -> P[c+1] is 4-connected (cardinal step)
 * AND P[c-1] -> P[c+1] are diagonally adjacent (|dx|===1 && |dy|===1),
 * then P[c] is an L-shaped jaggie corner and is skipped.
 */
export function filterPixelPerfectPoints(rawSamples: readonly Point[]): Point[] {
  const path = expandStrokePoints(rawSamples)
  if (path.length <= 2) return path

  const result: Point[] = []
  let c = 0

  while (c < path.length) {
    if (c > 0 && c + 1 < path.length) {
      const prev = result[result.length - 1]
      const curr = path[c]
      const next = path[c + 1]

      const step1Cardinal =
        (prev.x === curr.x && Math.abs(prev.y - curr.y) === 1) ||
        (prev.y === curr.y && Math.abs(prev.x - curr.x) === 1)

      const step2Cardinal =
        (curr.x === next.x && Math.abs(curr.y - next.y) === 1) ||
        (curr.y === next.y && Math.abs(curr.x - next.x) === 1)

      const diagJump =
        Math.abs(next.x - prev.x) === 1 && Math.abs(next.y - prev.y) === 1

      if (step1Cardinal && step2Cardinal && diagJump) {
        // Skip curr, emit next directly, and advance past next so we don't over-prune
        result.push(next)
        c += 2
        continue
      }
    }

    result.push(path[c])
    c += 1
  }

  return result
}
