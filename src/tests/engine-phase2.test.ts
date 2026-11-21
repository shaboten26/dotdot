import { describe, expect, it } from 'vitest'
import { hexToHsv, hexToRgba, hsvToHex, normalizeHex, rgbaToHex } from '../engine/color'
import {
  ALL_DITHER_PATTERN_IDS,
  DITHER_PATTERNS,
  shouldDrawWithDither,
} from '../engine/dithering'
import {
  createPixelBuffer,
  flipBufferHorizontal,
  flipBufferVertical,
  getPixel,
  resizePixelBuffer,
  setPixel,
  translateBuffer,
} from '../engine/pixelBuffer'
import { stampBrushAt, stampPoints } from '../engine/brush'
import { expandStrokePoints, filterPixelPerfectPoints } from '../engine/pixelPerfect'
import { applyFloodFill, applyGradientFloodFill } from '../engine/floodFill'
import {
  computeShapeBounds,
  drawCubicBezier,
  drawLine,
  evaluateCubicBezier,
  rasterizeEllipse,
  rasterizeRectangle,
} from '../engine/rasterize'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const BLUE = { r: 0, g: 120, b: 255, a: 255 }
const GREEN = { r: 0, g: 200, b: 80, a: 255 }

function countColorPixels(
  buf: Uint8ClampedArray,
  w: number,
  h: number,
  color: { r: number; g: number; b: number; a: number }
): number {
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = getPixel(buf, w, h, x, y)
      if (p.r === color.r && p.g === color.g && p.b === color.b && p.a === color.a) {
        count++
      }
    }
  }
  return count
}

describe('Color & PixelBuffer', () => {
  it('converts between HEX, RGBA, and HSV accurately', () => {
    expect(normalizeHex('#f0a')).toBe('#FF00AA')
    expect(rgbaToHex(hexToRgba('#3498db'))).toBe('#3498DB')
    const hsv = hexToHsv('#FF0000')
    expect(hsv).toEqual({ h: 0, s: 100, v: 100 })
    expect(hsvToHex(120, 100, 100)).toBe('#00FF00')
  })

  it('resizes anchored at top-left (0,0) and flips/translates cleanly', () => {
    const buf = createPixelBuffer(4, 4)
    setPixel(buf, 4, 4, 1, 2, RED)
    const grown = resizePixelBuffer(buf, 4, 4, 8, 8)
    expect(getPixel(grown, 8, 8, 1, 2)).toEqual(RED)
    expect(getPixel(grown, 8, 8, 5, 5).a).toBe(0)

    const hFlip = flipBufferHorizontal(buf, 4, 4)
    expect(getPixel(hFlip, 4, 4, 2, 2)).toEqual(RED)

    const vFlip = flipBufferVertical(buf, 4, 4)
    expect(getPixel(vFlip, 4, 4, 1, 1)).toEqual(RED)

    const shifted = translateBuffer(buf, 4, 4, 2, 1)
    expect(getPixel(shifted, 4, 4, 3, 3)).toEqual(RED)
    // Out-of-bounds translation clips cleanly
    const clipped = translateBuffer(buf, 4, 4, 10, 0)
    expect(countColorPixels(clipped, 4, 4, RED)).toBe(0)
  })
})

describe('Dithering Engine (8 patterns, (0,0) anchored)', () => {
  it('matches exact specified densities across a 16x16 grid', () => {
    const expectedDensities: Record<number, number> = {
      1: 1.0,
      2: 0.875,
      3: 0.75,
      4: 0.625,
      5: 0.5,
      6: 0.375,
      7: 0.25,
      8: 0.125,
    }

    for (const id of ALL_DITHER_PATTERN_IDS) {
      let lit = 0
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (shouldDrawWithDither(id, x, y)) lit++
        }
      }
      expect(lit / 256).toBe(expectedDensities[id])
      expect(DITHER_PATTERNS[id].density).toBe(expectedDensities[id] * 100)
    }
  })

  it('produces identical result whether drawn in one pass or multiple separate strokes, preserving "." pixels', () => {
    const w = 8
    const h = 8
    const bufSingle = createPixelBuffer(w, h)
    const bufMulti = createPixelBuffer(w, h)

    // Pre-fill background with BLUE to verify '.' keeps existing pixels untouched
    applyFloodFill(bufSingle, {
      width: w,
      height: h,
      seedX: 0,
      seedY: 0,
      color: BLUE,
      connectivity: 4,
      dither: 1,
    })
    bufMulti.set(bufSingle)

    // Single fill with pattern 4 (62.5%)
    applyFloodFill(bufSingle, {
      width: w,
      height: h,
      seedX: 0,
      seedY: 0,
      color: RED,
      connectivity: 4,
      dither: 4,
    })

    // Multiple overlapping brush strokes covering the entire 8x8 canvas with pattern 4
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        stampBrushAt(bufMulti, x, y, {
          width: w,
          height: h,
          size: 4,
          shape: 'square',
          color: RED,
          dither: 4,
        })
      }
    }

    expect(Array.from(bufMulti)).toEqual(Array.from(bufSingle))
    // 62.5% of 64 = 40 RED pixels, remaining 24 stay BLUE (not transparent!)
    expect(countColorPixels(bufMulti, w, h, RED)).toBe(40)
    expect(countColorPixels(bufMulti, w, h, BLUE)).toBe(24)
  })
})

describe('Pen, Eraser & Pixel-Perfect Comparison', () => {
  it('removes L-corners in pixel-perfect mode compared to normal stroke', () => {
    // Staircase input path that produces L-jaggies in normal mode:
    // (0,0) -> (1,0) -> (1,1) -> (2,1) -> (2,2)
    const rawPath = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]

    const normalPts = expandStrokePoints(rawPath)
    const ppPts = filterPixelPerfectPoints(rawPath)

    expect(normalPts.length).toBe(5)
    // Pixel perfect removes the L-corners (1,0) and (2,1), leaving clean diagonal (0,0)->(1,1)->(2,2)
    expect(ppPts).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ])
  })

  it('supports square & circle brushes and eraser setting alpha to 0', () => {
    const buf = createPixelBuffer(10, 10)
    stampBrushAt(buf, 5, 5, {
      width: 10,
      height: 10,
      size: 3,
      shape: 'square',
      color: RED,
    })
    expect(countColorPixels(buf, 10, 10, RED)).toBe(9)

    // Circle size 3 removes corners or has symmetric count <= 9
    const bufCircle = createPixelBuffer(10, 10)
    stampBrushAt(bufCircle, 5, 5, {
      width: 10,
      height: 10,
      size: 5,
      shape: 'circle',
      color: RED,
    })
    const circleCount = countColorPixels(bufCircle, 10, 10, RED)
    expect(circleCount).toBeGreaterThan(12)
    expect(circleCount).toBeLessThan(25)

    // Erase center 3x3
    stampBrushAt(buf, 5, 5, {
      width: 10,
      height: 10,
      size: 3,
      shape: 'square',
      color: RED,
      erase: true,
    })
    expect(countColorPixels(buf, 10, 10, RED)).toBe(0)
    expect(getPixel(buf, 10, 10, 5, 5).a).toBe(0)
  })
})

describe('Flood Fill (4/8-connectivity & Gradient Fill)', () => {
  it('distinguishes 4-directional vs 8-directional connectivity across diagonal barriers', () => {
    const w = 4
    const h = 4
    const base = createPixelBuffer(w, h)
    // Draw diagonal barrier at (1,0) and (0,1), isolating (0,0) under 4-connectivity but connecting to (1,1) under 8-connectivity
    setPixel(base, w, h, 1, 0, BLUE)
    setPixel(base, w, h, 0, 1, BLUE)

    const buf4 = new Uint8ClampedArray(base)
    applyFloodFill(buf4, {
      width: w,
      height: h,
      seedX: 0,
      seedY: 0,
      color: RED,
      connectivity: 4,
      dither: 1,
    })
    expect(countColorPixels(buf4, w, h, RED)).toBe(1) // only (0,0)

    const buf8 = new Uint8ClampedArray(base)
    applyFloodFill(buf8, {
      width: w,
      height: h,
      seedX: 0,
      seedY: 0,
      color: RED,
      connectivity: 8,
      dither: 1,
    })
    expect(countColorPixels(buf8, w, h, RED)).toBe(14) // all 16 minus 2 BLUE barrier pixels
  })

  it('renders 4-step and 8-step density gradient strictly inside connected region with matching preview & commit', () => {
    const w = 32
    const h = 16
    const base = createPixelBuffer(w, h)
    // Vertical wall at x = 24 isolating right side
    for (let y = 0; y < h; y++) {
      setPixel(base, w, h, 24, y, GREEN)
    }

    const previewBuf = new Uint8ClampedArray(base)
    const commitBuf = new Uint8ClampedArray(base)

    const opts = {
      width: w,
      height: h,
      startX: 0,
      startY: 8,
      endX: 20,
      endY: 8,
      color: RED,
      connectivity: 4 as const,
      steps: 8 as const,
    }

    applyGradientFloodFill(previewBuf, opts)
    applyGradientFloodFill(commitBuf, opts)

    // Preview and commit match byte-for-byte
    expect(Array.from(previewBuf)).toEqual(Array.from(commitBuf))

    // Right of wall (x > 24) is untouched
    for (let y = 0; y < h; y++) {
      for (let x = 25; x < w; x++) {
        expect(getPixel(commitBuf, w, h, x, y).a).toBe(0)
      }
    }

    // Start column x=0 has 100% density (all 16 pixels RED)
    let col0Red = 0
    let col20Red = 0
    for (let y = 0; y < h; y++) {
      if (getPixel(commitBuf, w, h, 0, y).a === 255) col0Red++
      if (getPixel(commitBuf, w, h, 20, y).a === 255) col20Red++
    }
    expect(col0Red).toBe(16)
    expect(col20Red).toBeLessThan(col0Red)
  })
})

describe('Line, Cubic Bezier & Shapes', () => {
  it('draws straight line with exact start and end points', () => {
    const buf = createPixelBuffer(16, 16)
    drawLine(buf, { x: 2, y: 3 }, { x: 13, y: 11 }, {
      width: 16,
      height: 16,
      size: 1,
      shape: 'square',
      dither: 1,
      color: RED,
    })
    expect(getPixel(buf, 16, 16, 2, 3)).toEqual(RED)
    expect(getPixel(buf, 16, 16, 13, 11)).toEqual(RED)
  })

  it('evaluates and rasterizes cubic Bezier curve influenced by control points P1, P2', () => {
    const mid = evaluateCubicBezier(
      { x: 0, y: 0 },
      { x: 0, y: 16 },
      { x: 16, y: 16 },
      { x: 16, y: 0 },
      0.5
    )
    expect(mid.x).toBeCloseTo(8, 5)
    expect(mid.y).toBeCloseTo(12, 5)

    const buf = createPixelBuffer(20, 20)
    drawCubicBezier(
      buf,
      { x: 1, y: 1 },
      { x: 1, y: 17 },
      { x: 17, y: 17 },
      { x: 17, y: 1 },
      { width: 20, height: 20, size: 1, shape: 'square', dither: 1, color: BLUE }
    )
    expect(getPixel(buf, 20, 20, 1, 1)).toEqual(BLUE)
    expect(getPixel(buf, 20, 20, 17, 1)).toEqual(BLUE)
    // Midpoint near (9, 13) should be hit, while chord midpoint (9, 1) is NOT hit
    expect(getPixel(buf, 20, 20, 9, 13)).toEqual(BLUE)
    expect(getPixel(buf, 20, 20, 9, 1).a).toBe(0)
  })

  it('rasterizes rectangles and ellipses with fixed-ratio option and zero anti-aliasing', () => {
    const boundsSquare = computeShapeBounds({ x: 2, y: 2 }, { x: 8, y: 5 }, true)
    expect(boundsSquare.width).toBe(boundsSquare.height)
    expect(boundsSquare.width).toBe(7)

    const buf = createPixelBuffer(16, 16)
    rasterizeRectangle(buf, boundsSquare, {
      width: 16,
      height: 16,
      filled: false,
      color: RED,
    })
    expect(getPixel(buf, 16, 16, 2, 2)).toEqual(RED)
    expect(getPixel(buf, 16, 16, 5, 5).a).toBe(0) // hollow interior

    const eBuf = createPixelBuffer(16, 16)
    const eBounds = computeShapeBounds({ x: 2, y: 4 }, { x: 13, y: 11 }, false)
    rasterizeEllipse(eBuf, eBounds, {
      width: 16,
      height: 16,
      filled: true,
      color: GREEN,
    })
    // Every pixel must have alpha 0 or 255 (strictly no anti-aliasing)
    for (let i = 3; i < eBuf.length; i += 4) {
      expect(eBuf[i] === 0 || eBuf[i] === 255).toBe(true)
    }
    expect(getPixel(eBuf, 16, 16, 7, 7)).toEqual(GREEN)

    // unused import guard check
    const ptsBuf = createPixelBuffer(4, 4)
    stampPoints(ptsBuf, [{ x: 0, y: 0 }], {
      width: 4,
      height: 4,
      size: 1,
      shape: 'square',
      color: RED,
    })
    expect(getPixel(ptsBuf, 4, 4, 0, 0)).toEqual(RED)
  })
})
