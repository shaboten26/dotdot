import { describe, expect, it } from 'vitest'
import {
  drawCubicBezier,
  rasterizeCubicBezierPoints,
  rasterizeCubicBezierRawPoints,
} from '../engine/rasterize'
import { createPixelBuffer, getPixel } from '../engine/pixelBuffer'
import type { Point } from '../types'

const INK = { r: 7, g: 7, b: 7, a: 255 }

function is8Connected(pts: readonly Point[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.abs(pts[i].x - pts[i - 1].x)
    const dy = Math.abs(pts[i].y - pts[i - 1].y)
    if (dx > 1 || dy > 1) return false
  }
  return true
}

function countLCornerTriples(pts: readonly Point[]): number {
  let count = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const curr = pts[i]
    const next = pts[i + 1]
    const orth1 =
      (prev.x === curr.x && Math.abs(prev.y - curr.y) === 1) ||
      (prev.y === curr.y && Math.abs(prev.x - curr.x) === 1)
    const orth2 =
      (curr.x === next.x && Math.abs(curr.y - next.y) === 1) ||
      (curr.y === next.y && Math.abs(curr.x - next.x) === 1)
    const diag =
      Math.abs(next.x - prev.x) === 1 && Math.abs(next.y - prev.y) === 1
    if (orth1 && orth2 && diag) count++
  }
  return count
}

describe('Spec v2 Section 9: Pixel-Perfect Cubic Bezier Curves (Size 1 & Size >= 2)', () => {
  const testCurves: Array<{
    name: string
    p0: Point
    p1: Point
    p2: Point
    p3: Point
  }> = [
    {
      name: 'near-straight diagonal curve',
      p0: { x: 2, y: 2 },
      p1: { x: 10, y: 9 },
      p2: { x: 20, y: 21 },
      p3: { x: 29, y: 28 },
    },
    {
      name: 'gentle arch curve',
      p0: { x: 2, y: 20 },
      p1: { x: 10, y: 4 },
      p2: { x: 22, y: 4 },
      p3: { x: 30, y: 20 },
    },
    {
      name: 'steep S-curve',
      p0: { x: 3, y: 3 },
      p1: { x: 29, y: 2 },
      p2: { x: 3, y: 30 },
      p3: { x: 29, y: 29 },
    },
  ]

  for (const c of testCurves) {
    it(`generates continuous 8-connected 1px pixel-perfect curve without L-corners for ${c.name}`, () => {
      const raw = rasterizeCubicBezierRawPoints(c.p0, c.p1, c.p2, c.p3)
      const pp = rasterizeCubicBezierPoints(c.p0, c.p1, c.p2, c.p3)

      // Exact start & end preserved
      expect(pp[0]).toEqual(c.p0)
      expect(pp[pp.length - 1]).toEqual(c.p3)

      // Continuous 8-connected path
      expect(is8Connected(pp)).toBe(true)

      // Raw rasterization has staircase L-corners; Pixel-Perfect eliminates them
      expect(pp.length).toBeLessThanOrEqual(raw.length)
      expect(countLCornerTriples(pp)).toBe(0)
    })

    it(`thickens ${c.name} for size >= 2 along the exact size-1 centerline with circle/square shapes and zero anti-aliasing`, () => {
      const w = 36
      const h = 36
      const buf1 = createPixelBuffer(w, h)
      const buf3Circle = createPixelBuffer(w, h)
      const buf3Square = createPixelBuffer(w, h)

      drawCubicBezier(buf1, c.p0, c.p1, c.p2, c.p3, {
        width: w,
        height: h,
        size: 1,
        shape: 'square',
        dither: 1,
        color: INK,
      })

      drawCubicBezier(buf3Circle, c.p0, c.p1, c.p2, c.p3, {
        width: w,
        height: h,
        size: 3,
        shape: 'circle',
        dither: 1,
        color: INK,
      })

      drawCubicBezier(buf3Square, c.p0, c.p1, c.p2, c.p3, {
        width: w,
        height: h,
        size: 3,
        shape: 'square',
        dither: 1,
        color: INK,
      })

      let count1 = 0
      let count3Circle = 0
      let count3Square = 0

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p1 = getPixel(buf1, w, h, x, y)
          const p3c = getPixel(buf3Circle, w, h, x, y)
          const p3s = getPixel(buf3Square, w, h, x, y)

          // Zero anti-aliasing: alpha is strictly 0 or 255
          expect(p1.a === 0 || p1.a === 255).toBe(true)
          expect(p3c.a === 0 || p3c.a === 255).toBe(true)
          expect(p3s.a === 0 || p3s.a === 255).toBe(true)

          // Every pixel on the size-1 centerline MUST be painted in both size-3 curves
          if (p1.a === 255) {
            count1++
            expect(p3c).toEqual(INK)
            expect(p3s).toEqual(INK)
          }
          if (p3c.a === 255) count3Circle++
          if (p3s.a === 255) count3Square++
        }
      }

      expect(count3Circle).toBeGreaterThan(count1)
      expect(count3Square).toBeGreaterThanOrEqual(count3Circle)
    })
  }
})
