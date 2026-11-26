import {
  TRANSPARENT_INDEX,
  type FloatingShapeState,
  type SeamlessWrapMode,
  type SymmetryMode,
} from '../types'
import { createPixelBuffer } from './pixelBuffer'
import { resolveCanvasPoint } from './symmetry'

export interface TransformedShapeBuffer {
  buffer: Uint8Array
  width: number
  height: number
  /** Top-left canvas X where this transformed buffer sits */
  left: number
  /** Top-left canvas Y where this transformed buffer sits */
  top: number
}

function rotateExact90(
  src: Uint8Array,
  sw: number,
  sh: number,
  turnsClockwise: number
): { buffer: Uint8Array; width: number; height: number } {
  const t = ((turnsClockwise % 4) + 4) % 4
  if (t === 0) {
    return { buffer: new Uint8Array(src), width: sw, height: sh }
  }
  if (t === 2) {
    const dst = createPixelBuffer(sw, sh)
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        dst[(sh - 1 - y) * sw + (sw - 1 - x)] = src[y * sw + x]!
      }
    }
    return { buffer: dst, width: sw, height: sh }
  }

  const dw = sh
  const dh = sw
  const dst = createPixelBuffer(dw, dh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const dx = t === 1 ? sh - 1 - y : y
      const dy = t === 1 ? x : sw - 1 - x
      dst[dy * dw + dx] = src[y * sw + x]!
    }
  }
  return { buffer: dst, width: dw, height: dh }
}

/**
 * Compute transformed shape 1-byte Indexed Color buffer directly from `sourceBuffer` and cumulative `rotationDeg`
 * using strict nearest-neighbor inverse mapping (zero anti-aliasing, zero cumulative degradation).
 */
export function rasterizeTransformedShape(state: FloatingShapeState): TransformedShapeBuffer {
  const { sourceBuffer, sourceWidth: sw, sourceHeight: sh, offsetX, offsetY, rotationDeg } = state
  const normDeg = ((rotationDeg % 360) + 360) % 360

  const origCenterX = offsetX + sw / 2
  const origCenterY = offsetY + sh / 2

  if (normDeg === 0) {
    return {
      buffer: new Uint8Array(sourceBuffer),
      width: sw,
      height: sh,
      left: offsetX,
      top: offsetY,
    }
  }

  if (sw === 1 && sh === 1) {
    return {
      buffer: new Uint8Array(sourceBuffer),
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

  const dw = Math.max(1, Math.ceil(Math.abs(sw * cos) + Math.abs(sh * sin)))
  const dh = Math.max(1, Math.ceil(Math.abs(sw * sin) + Math.abs(sh * cos)))
  const dst = createPixelBuffer(dw, dh)

  const scx = (sw - 1) / 2
  const scy = (sh - 1) / 2
  const dcx = (dw - 1) / 2
  const dcy = (dh - 1) / 2

  for (let dy = 0; dy < dh; dy++) {
    const ry = dy - dcy
    for (let dx = 0; dx < dw; dx++) {
      const rx = dx - dcx
      const sx = Math.round(rx * cos + ry * sin + scx)
      const sy = Math.round(-rx * sin + ry * cos + scy)

      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        const val = sourceBuffer[sy * sw + sx]!
        if (val !== TRANSPARENT_INDEX) {
          dst[dy * dw + dx] = val
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
 * Composite floating shape non-destructively onto a 1-byte Indexed Color layer buffer,
 * honoring optional Symmetry and Seamless torus wrap without depending on any custom stamp engine.
 */
export function compositeFloatingShapeOntoLayer(
  targetLayer: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  shapeState: FloatingShapeState,
  selectionMask?: Uint8Array | null,
  symmetry: SymmetryMode = 'none',
  seamlessWrap: SeamlessWrapMode = 'none'
): Uint8Array {
  const out = new Uint8Array(targetLayer)
  const transformed = rasterizeTransformedShape(shapeState)

  const placements: Array<{ x: number; y: number; mx: boolean; my: boolean }> = [
    { x: transformed.left, y: transformed.top, mx: false, my: false },
  ]
  const mirrorLeft = canvasWidth - (transformed.left + transformed.width)
  const mirrorTop = canvasHeight - (transformed.top + transformed.height)

  if (symmetry === 'horizontal' || symmetry === 'quad') {
    placements.push({ x: mirrorLeft, y: transformed.top, mx: true, my: false })
  }
  if (symmetry === 'vertical' || symmetry === 'quad') {
    placements.push({ x: transformed.left, y: mirrorTop, mx: false, my: true })
  }
  if (symmetry === 'quad') {
    placements.push({ x: mirrorLeft, y: mirrorTop, mx: true, my: true })
  }

  for (const pl of placements) {
    for (let sy = 0; sy < transformed.height; sy++) {
      const srcY = pl.my ? transformed.height - 1 - sy : sy
      for (let sx = 0; sx < transformed.width; sx++) {
        const srcX = pl.mx ? transformed.width - 1 - sx : sx
        const val = transformed.buffer[srcY * transformed.width + srcX]!
        if (val === TRANSPARENT_INDEX) continue

        const resolved = resolveCanvasPoint(
          pl.x + sx,
          pl.y + sy,
          canvasWidth,
          canvasHeight,
          seamlessWrap
        )
        if (!resolved) continue
        const pIdx = resolved.y * canvasWidth + resolved.x
        if (selectionMask && selectionMask[pIdx] === 0) continue
        out[pIdx] = val
      }
    }
  }

  return out
}
