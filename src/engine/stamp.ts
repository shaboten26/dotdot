import type {
  LayerRuntime,
  SeamlessWrapMode,
  SymmetryMode,
  WorldSelectionMask,
} from '../types'
import { extractWorldSelectionFromLayer } from './selection'
import { resolveCanvasPoint } from './symmetry'

export interface ExtractedStampPayload {
  width: number
  height: number
  data: Uint8Array
  hasOpaquePixels: boolean
}

/**
 * Extract selected pixels from `layer` into a compact 1x pixel-art stamp RGBA buffer.
 * Trims empty transparent outer margins automatically while preserving internal transparency.
 */
export function extractStampFromSelection(
  layer: LayerRuntime,
  worldSelection: WorldSelectionMask
): ExtractedStampPayload | null {
  if (worldSelection.width <= 0 || worldSelection.height <= 0) return null
  const { extractedBuffer } = extractWorldSelectionFromLayer(layer, worldSelection)
  const sw = worldSelection.width
  const sh = worldSelection.height

  let minX = sw
  let minY = sh
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const a = extractedBuffer[(y * sw + x) * 4 + 3]!
      if (a > 0) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    // Selection had no opaque pixels -> return null so UI can warn cleanly
    return {
      width: Math.min(256, sw),
      height: Math.min(256, sh),
      data: new Uint8Array(Math.min(256, sw) * Math.min(256, sh) * 4),
      hasOpaquePixels: false,
    }
  }

  const outW = Math.min(256, maxX - minX + 1)
  const outH = Math.min(256, maxY - minY + 1)
  const out = new Uint8Array(outW * outH * 4)

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sIdx = ((minY + y) * sw + (minX + x)) * 4
      const dIdx = (y * outW + x) * 4
      out[dIdx] = extractedBuffer[sIdx]!
      out[dIdx + 1] = extractedBuffer[sIdx + 1]!
      out[dIdx + 2] = extractedBuffer[sIdx + 2]!
      out[dIdx + 3] = extractedBuffer[sIdx + 3]!
    }
  }

  return {
    width: outW,
    height: outH,
    data: out,
    hasOpaquePixels: true,
  }
}

export interface StampRenderOptions {
  canvasWidth: number
  canvasHeight: number
  stampWidth: number
  stampHeight: number
  stampData: Uint8Array | Uint8ClampedArray
  topLeftX: number
  topLeftY: number
  flipX?: boolean
  flipY?: boolean
  symmetry?: SymmetryMode
  seamlessWrap?: SeamlessWrapMode
  selectionMask?: Uint8Array | null
}

function stampSingleInstance(
  buffer: Uint8ClampedArray,
  canvasWidth: number,
  canvasHeight: number,
  stampWidth: number,
  stampHeight: number,
  stampData: Uint8Array | Uint8ClampedArray,
  originX: number,
  originY: number,
  flipX: boolean,
  flipY: boolean,
  seamlessWrap: SeamlessWrapMode,
  selectionMask: Uint8Array | null | undefined,
  writtenSet: Set<number>
): void {
  for (let sy = 0; sy < stampHeight; sy++) {
    const srcY = flipY ? stampHeight - 1 - sy : sy
    for (let sx = 0; sx < stampWidth; sx++) {
      const srcX = flipX ? stampWidth - 1 - sx : sx
      const sIdx = (srcY * stampWidth + srcX) * 4
      const sa = stampData[sIdx + 3]!
      // Strictly preserve underlying pixels where stamp is transparent (`sa === 0`)
      if (sa === 0) continue

      const resolved = resolveCanvasPoint(
        originX + sx,
        originY + sy,
        canvasWidth,
        canvasHeight,
        seamlessWrap
      )
      if (!resolved) continue

      const pIdx = resolved.y * canvasWidth + resolved.x
      if (selectionMask && selectionMask[pIdx] === 0) continue
      if (writtenSet.has(pIdx)) continue
      writtenSet.add(pIdx)

      const dIdx = pIdx * 4
      const sr = stampData[sIdx]!
      const sg = stampData[sIdx + 1]!
      const sb = stampData[sIdx + 2]!

      if (sa === 255) {
        buffer[dIdx] = sr
        buffer[dIdx + 1] = sg
        buffer[dIdx + 2] = sb
        buffer[dIdx + 3] = 255
      } else {
        // Porter-Duff source-over if imported stamp has partial alpha
        const da = buffer[dIdx + 3]! / 255
        const sAlpha = sa / 255
        const outA = sAlpha + da * (1 - sAlpha)
        if (outA <= 0) continue
        buffer[dIdx] = Math.round((sr * sAlpha + buffer[dIdx]! * da * (1 - sAlpha)) / outA)
        buffer[dIdx + 1] = Math.round(
          (sg * sAlpha + buffer[dIdx + 1]! * da * (1 - sAlpha)) / outA
        )
        buffer[dIdx + 2] = Math.round(
          (sb * sAlpha + buffer[dIdx + 2]! * da * (1 - sAlpha)) / outA
        )
        buffer[dIdx + 3] = Math.round(outA * 255)
      }
    }
  }
}

/**
 * Render a 1x pixel stamp onto `buffer`, preserving transparent pixels and honoring
 * H/V flips, Symmetry (mirroring both position and flip orientation!), Seamless Wrap, and Selection Mask.
 */
export function applyStampToBuffer(
  buffer: Uint8ClampedArray,
  options: StampRenderOptions
): void {
  const {
    canvasWidth,
    canvasHeight,
    stampWidth,
    stampHeight,
    stampData,
    topLeftX,
    topLeftY,
    flipX = false,
    flipY = false,
    symmetry = 'none',
    seamlessWrap = 'none',
    selectionMask = null,
  } = options

  if (stampWidth <= 0 || stampHeight <= 0) return

  const instances: Array<{ ox: number; oy: number; fx: boolean; fy: boolean }> = [
    { ox: Math.round(topLeftX), oy: Math.round(topLeftY), fx: flipX, fy: flipY },
  ]

  const mirrorX = canvasWidth - Math.round(topLeftX) - stampWidth
  const mirrorY = canvasHeight - Math.round(topLeftY) - stampHeight

  if (symmetry === 'horizontal' || symmetry === 'quad') {
    instances.push({
      ox: mirrorX,
      oy: Math.round(topLeftY),
      fx: !flipX,
      fy: flipY,
    })
  }
  if (symmetry === 'vertical' || symmetry === 'quad') {
    instances.push({
      ox: Math.round(topLeftX),
      oy: mirrorY,
      fx: flipX,
      fy: !flipY,
    })
  }
  if (symmetry === 'quad') {
    instances.push({
      ox: mirrorX,
      oy: mirrorY,
      fx: !flipX,
      fy: !flipY,
    })
  }

  const seenInst = new Set<string>()
  const writtenSet = new Set<number>()
  for (const inst of instances) {
    const key = `${inst.ox}:${inst.oy}:${inst.fx ? 1 : 0}:${inst.fy ? 1 : 0}`
    if (seenInst.has(key)) continue
    seenInst.add(key)
    stampSingleInstance(
      buffer,
      canvasWidth,
      canvasHeight,
      stampWidth,
      stampHeight,
      stampData,
      inst.ox,
      inst.oy,
      inst.fx,
      inst.fy,
      seamlessWrap,
      selectionMask,
      writtenSet
    )
  }
}
