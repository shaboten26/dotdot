import type { CelBufferRuntime, CelMap, FrameMeta, LayerMeta } from '../types'
import { getCelReferenceCountMap, makeCellKey } from './animation'

export type LoadWarningLevel = 'normal' | 'caution' | 'high'

export interface ProjectLoadEstimate {
  canvasWidth: number
  canvasHeight: number
  layerCount: number
  frameCount: number
  totalGridCells: number
  emptyCellCount: number
  independentCellCount: number
  linkedCellCount: number
  uniqueCelBufferCount: number
  /** Actual 1-byte Indexed Color memory bytes stored across unique `celBuffers` (Empty = 0, Linked counted ONCE!) */
  actualCelMemoryBytes: number
  /** Estimated expanded frame RGBA bytes when rendering all frames for GIF export */
  expandedFramesBytes: number
  level: LoadWarningLevel
}

export const CAUTION_CEL_MEMORY_BYTES = 24 * 1024 * 1024 // 24 MB
export const HIGH_CEL_MEMORY_BYTES = 64 * 1024 * 1024 // 64 MB
export const CAUTION_EXPANDED_GIF_BYTES = 48 * 1024 * 1024 // 48 MB
export const HIGH_EXPANDED_GIF_BYTES = 128 * 1024 * 1024 // 128 MB

/**
 * Phase 13: Estimate real memory & GIF export load WITHOUT any artificial frame count cap!
 * Strictly distinguishes:
 * - Empty cels -> 0 bytes
 * - Linked cels -> shared `CelBufferRuntime` counted ONCE regardless of how many frames link to it!
 * - Independent cels -> counted per unique buffer
 */
export function estimateProjectLoad(params: {
  canvasWidth: number
  canvasHeight: number
  layers: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  exportScale?: number
}): ProjectLoadEstimate {
  const {
    canvasWidth,
    canvasHeight,
    layers,
    frames,
    cels,
    celBuffers,
    exportScale = 1,
  } = params

  const refCounts = getCelReferenceCountMap(cels)
  let emptyCellCount = 0
  let independentCellCount = 0
  let linkedCellCount = 0
  const countedBufferIds = new Set<string>()
  let actualCelMemoryBytes = 0

  for (const layer of layers) {
    for (const frame of frames) {
      const ref = cels[makeCellKey(layer.id, frame.id)]
      if (!ref || ref.kind === 'empty' || !celBuffers[ref.celId]) {
        emptyCellCount++
        continue
      }
      const rc = refCounts.get(ref.celId) ?? 1
      if (rc >= 2) {
        linkedCellCount++
      } else {
        independentCellCount++
      }

      if (!countedBufferIds.has(ref.celId)) {
        countedBufferIds.add(ref.celId)
        actualCelMemoryBytes += celBuffers[ref.celId]!.data.byteLength
      }
    }
  }

  const outW = Math.max(1, canvasWidth * Math.max(1, exportScale))
  const outH = Math.max(1, canvasHeight * Math.max(1, exportScale))
  const expandedFramesBytes = frames.length * outW * outH * 4

  let level: LoadWarningLevel = 'normal'
  if (
    actualCelMemoryBytes >= HIGH_CEL_MEMORY_BYTES ||
    expandedFramesBytes >= HIGH_EXPANDED_GIF_BYTES
  ) {
    level = 'high'
  } else if (
    actualCelMemoryBytes >= CAUTION_CEL_MEMORY_BYTES ||
    expandedFramesBytes >= CAUTION_EXPANDED_GIF_BYTES
  ) {
    level = 'caution'
  }

  return {
    canvasWidth,
    canvasHeight,
    layerCount: layers.length,
    frameCount: frames.length,
    totalGridCells: layers.length * frames.length,
    emptyCellCount,
    independentCellCount,
    linkedCellCount,
    uniqueCelBufferCount: countedBufferIds.size,
    actualCelMemoryBytes,
    expandedFramesBytes,
    level,
  }
}
