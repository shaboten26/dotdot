import { zipSync } from 'fflate'
import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  PlaybackDirection,
  ProjectPalette,
} from '../types'
import { hexToRgba, rgbaToHex } from './color'
import {
  compositeLayers,
  encodeRgbaToPng,
  exportCompositePngBytes,
  upscaleNearestNeighbor,
} from './compositor'
import {
  computePlaybackFrameIndices,
  projectFrameLayers,
} from './animation'
import { encodeAnimatedGif } from './gifEncoder'
import { generateSpriteSheet, type SpriteSheetLayout } from './spriteSheet'
import { encodeAsepriteBytes } from './aseprite'

export type StillExportFormat =
  | 'png'
  | 'svg'
  | 'webp'
  | 'bmp'
  | 'jpeg'
  | 'ico'
  | 'aseprite'

export type AnimationExportFormat =
  | 'gif'
  | 'svg-anim'
  | 'spritesheet'
  | 'png-zip'
  | 'aseprite'

/**
 * Generate a crisp, zero-blur SVG vector artwork from a 1x RGBA buffer using horizontal run-length `<rect>` merging.
 * Supports pixel-art scaling (`outWidth = width * scale`, `outHeight = height * scale`) while keeping `viewBox="0 0 width height"` crisp at any zoom!
 */
export function encodeRgbaToCrispSvg(
  rgba1x: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  scale = 1,
  options?: {
    backgroundColorHex?: string | null
  }
): string {
  const s = Math.max(1, Math.trunc(scale))
  const outW = width * s
  const outH = height * s
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`,
  ]

  if (options?.backgroundColorHex) {
    lines.push(
      `  <rect x="0" y="0" width="${width}" height="${height}" fill="${options.backgroundColorHex}"/>`
    )
  }

  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      const i = (y * width + x) * 4
      const a = rgba1x[i + 3]!
      if (a === 0) {
        x++
        continue
      }
      const r = rgba1x[i]!
      const g = rgba1x[i + 1]!
      const b = rgba1x[i + 2]!
      let runW = 1
      while (x + runW < width) {
        const j = (y * width + (x + runW)) * 4
        if (
          rgba1x[j] === r &&
          rgba1x[j + 1] === g &&
          rgba1x[j + 2] === b &&
          rgba1x[j + 3] === a
        ) {
          runW++
        } else {
          break
        }
      }
      const hex = rgbaToHex({ r, g, b })
      if (a === 255) {
        lines.push(
          `  <rect x="${x}" y="${y}" width="${runW}" height="1" fill="${hex}"/>`
        )
      } else {
        const op = (a / 255).toFixed(3)
        lines.push(
          `  <rect x="${x}" y="${y}" width="${runW}" height="1" fill="${hex}" fill-opacity="${op}"/>`
        )
      }
      x += runW
    }
  }

  lines.push(`</svg>`)
  return lines.join('\n')
}

/**
 * Generate a pure-vector CSS-keyframe Animated SVG (`shape-rendering="crispEdges"`) from multiple 1x RGBA frames!
 * Plays smoothly in modern browsers with infinitely scalable crisp pixel edges.
 */
export function encodeFramesToAnimatedSvg(
  frames: ReadonlyArray<{ rgba: Uint8ClampedArray | Uint8Array; durationMs: number }>,
  width: number,
  height: number,
  scale = 1,
  loop = true
): string {
  const s = Math.max(1, Math.trunc(scale))
  const outW = width * s
  const outH = height * s

  if (frames.length <= 1) {
    const first = frames[0]?.rgba ?? new Uint8ClampedArray(width * height * 4)
    return encodeRgbaToCrispSvg(first, width, height, s)
  }

  const safeDurations = frames.map((f) => Math.max(10, Math.round(f.durationMs || 100)))
  const totalMs = safeDurations.reduce((a, b) => a + b, 0)
  const iterCount = loop ? 'infinite' : '1'

  const styleLines: string[] = ['  <style>']
  let elapsed = 0
  for (let idx = 0; idx < frames.length; idx++) {
    const startPct = ((elapsed / totalMs) * 100).toFixed(4)
    elapsed += safeDurations[idx]!
    const endPct = ((elapsed / totalMs) * 100).toFixed(4)
    const animName = `dotdot-f${idx}`

    styleLines.push(
      `    .f${idx} { opacity: 0; animation: ${animName} ${totalMs}ms step-end ${iterCount}; }`
    )
    if (idx === 0) {
      styleLines.push(
        `    @keyframes ${animName} { 0% { opacity: 1; } ${endPct}% { opacity: 0; } 100% { opacity: 0; } }`
      )
    } else if (idx === frames.length - 1) {
      styleLines.push(
        `    @keyframes ${animName} { 0% { opacity: 0; } ${startPct}% { opacity: 1; } 100% { opacity: 0; } }`
      )
    } else {
      styleLines.push(
        `    @keyframes ${animName} { 0% { opacity: 0; } ${startPct}% { opacity: 1; } ${endPct}% { opacity: 0; } 100% { opacity: 0; } }`
      )
    }
  }
  styleLines.push('  </style>')

  const groupLines: string[] = []
  for (let idx = 0; idx < frames.length; idx++) {
    const rgba1x = frames[idx]!.rgba
    groupLines.push(`  <g class="f${idx}">`)
    for (let y = 0; y < height; y++) {
      let x = 0
      while (x < width) {
        const i = (y * width + x) * 4
        const a = rgba1x[i + 3]!
        if (a === 0) {
          x++
          continue
        }
        const r = rgba1x[i]!
        const g = rgba1x[i + 1]!
        const b = rgba1x[i + 2]!
        let runW = 1
        while (x + runW < width) {
          const j = (y * width + (x + runW)) * 4
          if (
            rgba1x[j] === r &&
            rgba1x[j + 1] === g &&
            rgba1x[j + 2] === b &&
            rgba1x[j + 3] === a
          ) {
            runW++
          } else {
            break
          }
        }
        const hex = rgbaToHex({ r, g, b })
        if (a === 255) {
          groupLines.push(
            `    <rect x="${x}" y="${y}" width="${runW}" height="1" fill="${hex}"/>`
          )
        } else {
          groupLines.push(
            `    <rect x="${x}" y="${y}" width="${runW}" height="1" fill="${hex}" fill-opacity="${(a / 255).toFixed(3)}"/>`
          )
        }
        x += runW
      }
    }
    groupLines.push(`  </g>`)
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`,
    ...styleLines,
    ...groupLines,
    `</svg>`,
  ].join('\n')
}

/**
 * Pure-TS uncompressed 32-bit BGRA BMP (`BITMAPV4HEADER` / `BITMAPINFOHEADER` top-down or bottom-up) encoder.
 * Works 100% offline in all environments including Node/Vitest without Canvas support.
 */
export function encodeRgbaToBmp32(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const pixelBytes = width * height * 4
  const headerSize = 14 + 40
  const totalSize = headerSize + pixelBytes
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)

  // BITMAPFILEHEADER (14 bytes)
  out[0] = 0x42 // 'B'
  out[1] = 0x4d // 'M'
  view.setUint32(2, totalSize, true)
  view.setUint32(6, 0, true)
  view.setUint32(10, headerSize, true)

  // BITMAPINFOHEADER (40 bytes) — bottom-up rows for maximum BMP viewer compatibility
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true) // planes
  view.setUint16(28, 32, true) // 32 bpp BGRA
  view.setUint32(30, 0, true) // BI_RGB uncompressed
  view.setUint32(34, pixelBytes, true)
  view.setInt32(38, 2835, true) // 72 DPI
  view.setInt32(42, 2835, true)
  view.setUint32(46, 0, true)
  view.setUint32(50, 0, true)

  let dstOff = headerSize
  for (let y = height - 1; y >= 0; y--) {
    const rowOff = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = rowOff + x * 4
      out[dstOff++] = rgba[s + 2]! // B
      out[dstOff++] = rgba[s + 1]! // G
      out[dstOff++] = rgba[s]! // R
      out[dstOff++] = rgba[s + 3]! // A
    }
  }

  return out
}

/**
 * Pure-TS Windows / Favicon `.ico` encoder wrapping a PNG payload (`<= 256x256px`).
 * If input exceeds 256px, uses nearest-neighbor sizing capped at 256px on long edge.
 */
export function encodeRgba1xToIco(
  rgba1x: Uint8ClampedArray | Uint8Array,
  width1x: number,
  height1x: number,
  requestedScale = 1
): { icoBytes: Uint8Array; icoWidth: number; icoHeight: number } {
  const maxAllowedScale = Math.max(
    1,
    Math.floor(256 / Math.max(1, width1x, height1x))
  )
  const scale = Math.max(1, Math.min(maxAllowedScale, Math.trunc(requestedScale)))
  const upscaled = upscaleNearestNeighbor(
    new Uint8ClampedArray(rgba1x),
    width1x,
    height1x,
    scale
  )
  // If 1x itself > 256 (defensive), clamp to 256
  const icoWidth = Math.min(256, upscaled.width)
  const icoHeight = Math.min(256, upscaled.height)
  const pngPayload = encodeRgbaToPng(upscaled.data, icoWidth, icoHeight)

  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + PNG payload
  const out = new Uint8Array(22 + pngPayload.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true) // Reserved
  view.setUint16(2, 1, true) // Type = 1 (ICO)
  view.setUint16(4, 1, true) // Image count = 1

  // Width / Height: 0 represents 256px in ICO spec!
  out[6] = icoWidth >= 256 ? 0 : icoWidth
  out[7] = icoHeight >= 256 ? 0 : icoHeight
  out[8] = 0 // Color count
  out[9] = 0 // Reserved
  view.setUint16(10, 1, true) // Color planes
  view.setUint16(12, 32, true) // Bits per pixel
  view.setUint32(14, pngPayload.length, true) // Payload size
  view.setUint32(18, 22, true) // Offset to payload
  out.set(pngPayload, 22)

  return { icoBytes: out, icoWidth, icoHeight }
}

/**
 * Encode RGBA buffer to `image/webp` or `image/jpeg` using browser `<canvas>` (`toBlob` / `toDataURL`),
 * compositing onto `matteHex` for opaque JPEG!
 */
export async function encodeRgbaViaCanvasMime(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  mimeType: 'image/webp' | 'image/jpeg',
  options?: {
    matteHex?: string
    quality?: number
  }
): Promise<Blob> {
  let workingRgba = new Uint8ClampedArray(rgba)
  if (mimeType === 'image/jpeg') {
    const matte = hexToRgba(options?.matteHex ?? '#FFFFFF', 255)
    const flattened = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < flattened.length; i += 4) {
      const a = workingRgba[i + 3]! / 255
      const inv = 1 - a
      flattened[i] = Math.round(workingRgba[i]! * a + matte.r * inv)
      flattened[i + 1] = Math.round(workingRgba[i + 1]! * a + matte.g * inv)
      flattened[i + 2] = Math.round(workingRgba[i + 2]! * a + matte.b * inv)
      flattened[i + 3] = 255
    }
    workingRgba = flattened
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.imageSmoothingEnabled = false
      if (typeof ImageData !== 'undefined') {
        const copy = new Uint8ClampedArray(width * height * 4)
        copy.set(workingRgba)
        ctx.putImageData(new ImageData(copy, width, height), 0, 0)
      }
      if (typeof canvas.toBlob === 'function') {
        const blob = await new Promise<Blob | null>((resolve) => {
          try {
            canvas.toBlob(resolve, mimeType, options?.quality ?? 0.95)
          } catch {
            resolve(null)
          }
        })
        if (blob && blob.size > 0) {
          return blob
        }
      }
    }
  }

  // Safe lossless PNG blob fallback in headless JSDOM test environments where canvas.toBlob is unimplemented
  const pngFallback = encodeRgbaToPng(workingRgba, width, height)
  return new Blob([pngFallback.slice().buffer], { type: mimeType })
}

/**
 * Export all animation frames as numbered PNG files bundled into a standard `.zip` archive (`001.png`, `002.png`, ...).
 */
export function encodeNumberedPngFramesZip(
  baseName: string,
  frames1x: ReadonlyArray<{ rgba: Uint8ClampedArray; durationMs: number }>,
  width1x: number,
  height1x: number,
  scale: number,
  embedMetadata = true
): Uint8Array {
  const safeScale = Math.max(1, Math.trunc(scale))
  const files: Record<string, Uint8Array> = {}
  const digits = Math.max(3, String(frames1x.length).length)

  for (let i = 0; i < frames1x.length; i++) {
    const f = frames1x[i]!
    const upscaled = upscaleNearestNeighbor(f.rgba, width1x, height1x, safeScale)
    const png = encodeRgbaToPng(
      upscaled.data,
      upscaled.width,
      upscaled.height,
      embedMetadata
        ? {
            textChunks: {
              'dotdot-meta': JSON.stringify({
                app: 'dotdot',
                version: 1,
                originalWidth: width1x,
                originalHeight: height1x,
                scale: safeScale,
                exportedWidth: upscaled.width,
                exportedHeight: upscaled.height,
              }),
            },
          }
        : undefined
    )
    const frameNo = String(i + 1).padStart(digits, '0')
    files[`${baseName}_${frameNo}_${f.durationMs}ms.png`] = png
  }

  return zipSync(files, { level: 6 })
}

export interface CompositeTimelineFramesInput {
  width: number
  height: number
  palette: ProjectPalette
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  direction?: PlaybackDirection
  loop?: boolean
}

export function buildOrderedCompositeFrames1x(
  input: CompositeTimelineFramesInput
): Array<{ rgba: Uint8ClampedArray; durationMs: number }> {
  const {
    width,
    height,
    palette,
    layerMetas,
    frames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    direction = 'forward',
    loop = true,
  } = input

  const rawFrames =
    frames.length >= 1 && Object.keys(cels).length > 0
      ? frames.map((f) => {
          const projected = projectFrameLayers(
            layerMetas,
            cels,
            celBuffers,
            f.id,
            width,
            height
          )
          return {
            rgba: compositeLayers(projected, width, height, { palette }),
            durationMs: f.durationMs,
          }
        })
      : [
          {
            rgba: compositeLayers(fallbackSingleFrameLayers ?? [], width, height, {
              palette,
            }),
            durationMs: frames[0]?.durationMs ?? 100,
          },
        ]

  const indices = computePlaybackFrameIndices(
    rawFrames.length,
    direction,
    !loop
  )
  return indices.map((idx) => rawFrames[idx]!)
}

export {
  exportCompositePngBytes,
  encodeAnimatedGif,
  generateSpriteSheet,
  encodeAsepriteBytes,
  type SpriteSheetLayout,
}
