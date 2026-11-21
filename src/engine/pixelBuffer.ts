import type { RGBA } from '../types'

export const MIN_CANVAS_SIZE = 1
export const MAX_CANVAS_SIZE = 256

export function createPixelBuffer(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4)
}

export function clonePixelBuffer(src: Uint8ClampedArray): Uint8ClampedArray {
  return new Uint8ClampedArray(src)
}

export function isInBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height
}

export function getPixelOffset(x: number, y: number, width: number): number {
  return (y * width + x) * 4
}

export function getPixel(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): RGBA {
  if (!isInBounds(x, y, width, height)) {
    return { r: 0, g: 0, b: 0, a: 0 }
  }
  const idx = (y * width + x) * 4
  return {
    r: buffer[idx],
    g: buffer[idx + 1],
    b: buffer[idx + 2],
    a: buffer[idx + 3],
  }
}

export function setPixel(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  color: RGBA
): void {
  if (!isInBounds(x, y, width, height)) return
  const idx = (y * width + x) * 4
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

export function pixelsMatchAt(
  buffer: Uint8ClampedArray,
  idxA: number,
  idxB: number
): boolean {
  const aA = buffer[idxA + 3]
  const aB = buffer[idxB + 3]
  if (aA === 0 && aB === 0) return true
  return (
    aA === aB &&
    buffer[idxA] === buffer[idxB] &&
    buffer[idxA + 1] === buffer[idxB + 1] &&
    buffer[idxA + 2] === buffer[idxB + 2]
  )
}

export function clearBuffer(buffer: Uint8ClampedArray): void {
  buffer.fill(0)
}

/**
 * Resize pixel buffer keeping top-left (0, 0) anchored and expanding/cropping right/bottom.
 */
export function resizePixelBuffer(
  src: Uint8ClampedArray,
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(newWidth, newHeight)
  const copyW = Math.min(oldWidth, newWidth)
  const copyH = Math.min(oldHeight, newHeight)

  for (let y = 0; y < copyH; y++) {
    const srcRowStart = y * oldWidth * 4
    const dstRowStart = y * newWidth * 4
    dst.set(src.subarray(srcRowStart, srcRowStart + copyW * 4), dstRowStart)
  }
  return dst
}

export function flipBufferHorizontal(
  src: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sIdx = (y * width + x) * 4
      const dIdx = (y * width + (width - 1 - x)) * 4
      dst[dIdx] = src[sIdx]
      dst[dIdx + 1] = src[sIdx + 1]
      dst[dIdx + 2] = src[sIdx + 2]
      dst[dIdx + 3] = src[sIdx + 3]
    }
  }
  return dst
}

export function flipBufferVertical(
  src: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(width, height)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    const sStart = y * rowBytes
    const dStart = (height - 1 - y) * rowBytes
    dst.set(src.subarray(sStart, sStart + rowBytes), dStart)
  }
  return dst
}

/**
 * Translate entire layer buffer by (dx, dy), clipping pixels that leave [0..width-1, 0..height-1].
 */
export function translateBuffer(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  dx: number,
  dy: number
): Uint8ClampedArray {
  const dst = createPixelBuffer(width, height)
  const shiftX = Math.trunc(dx)
  const shiftY = Math.trunc(dy)

  for (let y = 0; y < height; y++) {
    const ny = y + shiftY
    if (ny < 0 || ny >= height) continue
    for (let x = 0; x < width; x++) {
      const nx = x + shiftX
      if (nx < 0 || nx >= width) continue
      const sIdx = (y * width + x) * 4
      const dIdx = (ny * width + nx) * 4
      dst[dIdx] = src[sIdx]
      dst[dIdx + 1] = src[sIdx + 1]
      dst[dIdx + 2] = src[sIdx + 2]
      dst[dIdx + 3] = src[sIdx + 3]
    }
  }
  return dst
}
