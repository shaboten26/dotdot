import type { FloatingShapeState, SeamlessWrapMode, SymmetryMode } from '../types'
import { createPixelBuffer } from './pixelBuffer'
import { applyStampToBuffer } from './stamp'

export interface TransformedShapeBuffer {
  buffer: Uint8ClampedArray
  width: number
  height: number
  /** Top-left canvas X where this transformed buffer sits */
  left: number
  /** Top-left canvas Y where this transformed buffer sits */
  top: number
}

/**
 * Rotate a buffer by exact 90-degree increments (0, 90, 180, 270 clockwise) losslessly.
 */
function rotateExact90(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  turnsClockwise: number
): { buffer: Uint8ClampedArray; width: number; height: number } {
  const t = ((turnsClockwise % 4) + 4) % 4
  if (t === 0) {
    return { buffer: new Uint8ClampedArray(src), width: sw, height: sh }
  }
  if (t === 2) {
    const dst = createPixelBuffer(sw, sh)
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const sIdx = (y * sw + x) * 4
        const dIdx = ((sh - 1 - y) * sw + (sw - 1 - x)) * 4
        dst[dIdx] = src[sIdx]
        dst[dIdx + 1] = src[sIdx + 1]
        dst[dIdx + 2] = src[sIdx + 2]
        dst[dIdx + 3] = src[sIdx + 3]
      }
    }
    return { buffer: dst, width: sw, height: sh }
  }

  // 90 deg CW (t === 1) or 270 deg CW (t === 3) -> dimensions swap (sh x sw)
  const dw = sh
  const dh = sw
  const dst = createPixelBuffer(dw, dh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const sIdx = (y * sw + x) * 4
      const dx = t === 1 ? sh - 1 - y : y
      const dy = t === 1 ? x : sw - 1 - x
      const dIdx = (dy * dw + dx) * 4
      dst[dIdx] = src[sIdx]
      dst[dIdx + 1] = src[sIdx + 1]
      dst[dIdx + 2] = src[sIdx + 2]
      dst[dIdx + 3] = src[sIdx + 3]
    }
  }
  return { buffer: dst, width: dw, height: dh }
}

/**
 * Compute transformed shape buffer directly from the original `sourceBuffer` and cumulative `rotationDeg`
 * using strict nearest-neighbor inverse mapping (zero anti-aliasing, zero cumulative degradation).
 */
export function rasterizeTransformedShape(state: FloatingShapeState): TransformedShapeBuffer {
  const { sourceBuffer, sourceWidth: sw, sourceHeight: sh, offsetX, offsetY, rotationDeg } = state
  const normDeg = ((rotationDeg % 360) + 360) % 360

  const origCenterX = offsetX + sw / 2
  const origCenterY = offsetY + sh / 2

  // Fast path: 0° rotation preserves exact source pixels 1:1
  if (normDeg === 0) {
    return {
      buffer: new Uint8ClampedArray(sourceBuffer),
      width: sw,
      height: sh,
      left: offsetX,
      top: offsetY,
    }
  }

  // Special case: 1x1 pixel shape is rotationally invariant around its center!
  // Using (sw-1)/2 === 0 with ceil(cos+sin) === 2 would otherwise offset a 1x1 pixel out of center.
  if (sw === 1 && sh === 1) {
    return {
      buffer: new Uint8ClampedArray(sourceBuffer),
      width: 1,
      height: 1,
      left: offsetX,
      top: offsetY,
    }
  }

  if (normDeg % 90 === 0) {
    const turns = Math.round(normDeg / 90)
    const exact = rotateExact90(sourceBuffer, sw, sh, turns)
    const left = Math.round(origCenterX - exact.width / 2)
    const top = Math.round(origCenterY - exact.height / 2)
    return {
      buffer: exact.buffer,
      width: exact.width,
      height: exact.height,
      left,
      top,
    }
  }

  const rad = (normDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  // Expanded bounding box big enough to hold rotated rectangle without clipping corners
  const dw = Math.max(1, Math.ceil(Math.abs(sw * cos) + Math.abs(sh * sin)))
  const dh = Math.max(1, Math.ceil(Math.abs(sw * sin) + Math.abs(sh * cos)))
  const dst = createPixelBuffer(dw, dh)

  const scx = (sw - 1) / 2
  const scy = (sh - 1) / 2
  const dcx = (dw - 1) / 2
  const dcy = (dh - 1) / 2

  // Inverse rotation around center with nearest-neighbor sampling
  for (let dy = 0; dy < dh; dy++) {
    const ry = dy - dcy
    for (let dx = 0; dx < dw; dx++) {
      const rx = dx - dcx
      const sx = Math.round(rx * cos + ry * sin + scx)
      const sy = Math.round(-rx * sin + ry * cos + scy)

      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        const sIdx = (sy * sw + sx) * 4
        const a = sourceBuffer[sIdx + 3]
        if (a > 0) {
          const dIdx = (dy * dw + dx) * 4
          dst[dIdx] = sourceBuffer[sIdx]
          dst[dIdx + 1] = sourceBuffer[sIdx + 1]
          dst[dIdx + 2] = sourceBuffer[sIdx + 2]
          dst[dIdx + 3] = a
        }
      }
    }
  }

  const left = Math.round(origCenterX - dw / 2)
  const top = Math.round(origCenterY - dh / 2)

  return {
    buffer: dst,
    width: dw,
    height: dh,
    left,
    top,
  }
}

/**
 * Composite floating shape non-destructively onto a copy or target layer buffer.
 */
export function compositeFloatingShapeOntoLayer(
  targetLayer: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  shapeState: FloatingShapeState,
  selectionMask?: Uint8Array | null,
  symmetry: SymmetryMode = 'none',
  seamlessWrap: SeamlessWrapMode = 'none'
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(targetLayer)
  const transformed = rasterizeTransformedShape(shapeState)

  applyStampToBuffer(out, {
    canvasWidth,
    canvasHeight,
    stampWidth: transformed.width,
    stampHeight: transformed.height,
    stampData: transformed.buffer,
    topLeftX: transformed.left,
    topLeftY: transformed.top,
    flipX: false,
    flipY: false,
    symmetry,
    seamlessWrap,
    selectionMask,
  })

  return out
}
