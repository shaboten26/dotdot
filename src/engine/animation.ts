import {
  TRANSPARENT_INDEX,
  type CelBufferRuntime,
  type CelMap,
  type CelRef,
  type FrameMeta,
  type LayerMeta,
  type LayerRuntime,
  type PlaybackDirection,
} from '../types'
import { createPixelBuffer } from './pixelBuffer'
import { generateId } from '../utils/id'

export const DEFAULT_FRAME_DURATION_MS = 100
export const MIN_FRAME_DURATION_MS = 10
export const MAX_FRAME_DURATION_MS = 60000
export const SHORT_GIF_FRAME_WARNING_MS = 20

export type CellStateKind = 'empty' | 'independent' | 'linked'

export interface TimelineState {
  frames: FrameMeta[]
  cels: CelMap
  celBuffers: Record<string, CelBufferRuntime>
  activeFrameId: string
  defaultFrameDurationMs: number
  playbackDirection: PlaybackDirection
  loopPlayback: boolean
}

export function makeCellKey(layerId: string, frameId: string): string {
  return `${layerId}:${frameId}`
}

export function clampFrameDurationMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_FRAME_DURATION_MS
  return Math.max(
    MIN_FRAME_DURATION_MS,
    Math.min(MAX_FRAME_DURATION_MS, Math.round(ms))
  )
}

export function roundDurationToGifMs(ms: number): {
  centiseconds: number
  roundedMs: number
  isVeryShort: boolean
} {
  const safeMs = clampFrameDurationMs(ms)
  const cs = Math.max(1, Math.round(safeMs / 10))
  return {
    centiseconds: cs,
    roundedMs: cs * 10,
    isVeryShort: safeMs < SHORT_GIF_FRAME_WARNING_MS,
  }
}

export function hasAnyOpaquePixel(data: Uint8Array | Uint8ClampedArray): boolean {
  if (data instanceof Uint8ClampedArray) {
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true
    }
    return false
  }
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== TRANSPARENT_INDEX) return true
  }
  return false
}

export function hasAnySemiTransparentPixel(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i]!
    if (a > 0 && a < 255) return true
  }
  return false
}

export function createSingleFrameTimelineFromLayers(
  layers: readonly LayerRuntime[],
  options?: {
    frameId?: string
    defaultFrameDurationMs?: number
    playbackDirection?: PlaybackDirection
    loopPlayback?: boolean
  }
): TimelineState {
  const defaultDuration = clampFrameDurationMs(
    options?.defaultFrameDurationMs ?? DEFAULT_FRAME_DURATION_MS
  )
  const frameId = options?.frameId ?? 'frame-1'
  const cels: CelMap = {}
  const celBuffers: Record<string, CelBufferRuntime> = {}

  for (const layer of layers) {
    const celId = generateId('cel')
    celBuffers[celId] = {
      id: celId,
      offsetX: layer.offsetX ?? 0,
      offsetY: layer.offsetY ?? 0,
      dataWidth: layer.dataWidth,
      dataHeight: layer.dataHeight,
      data: new Uint8Array(layer.data),
    }
    cels[makeCellKey(layer.id, frameId)] = { kind: 'cel', celId }
  }

  return {
    frames: [{ id: frameId, durationMs: defaultDuration }],
    cels,
    celBuffers,
    activeFrameId: frameId,
    defaultFrameDurationMs: defaultDuration,
    playbackDirection: options?.playbackDirection ?? 'forward',
    loopPlayback: options?.loopPlayback ?? true,
  }
}

export function countCelReferences(cels: CelMap): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const ref of Object.values(cels)) {
    if (ref?.kind === 'cel') {
      counts[ref.celId] = (counts[ref.celId] ?? 0) + 1
    }
  }
  return counts
}

export function getCelReferenceCountMap(cels: CelMap): Map<string, number> {
  const map = new Map<string, number>()
  for (const ref of Object.values(cels)) {
    if (ref?.kind === 'cel') {
      map.set(ref.celId, (map.get(ref.celId) ?? 0) + 1)
    }
  }
  return map
}

export function getCellStateKind(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  layerId: string,
  frameId: string,
  refCountMap?: ReadonlyMap<string, number>
): CellStateKind {
  const ref = cels[makeCellKey(layerId, frameId)]
  if (!ref || ref.kind === 'empty') return 'empty'
  if (!celBuffers[ref.celId]) return 'empty'
  const count = refCountMap
    ? (refCountMap.get(ref.celId) ?? 0)
    : (getCelReferenceCountMap(cels).get(ref.celId) ?? 0)
  return count >= 2 ? 'linked' : 'independent'
}

export function getLinkedFrameIdsForCell(
  frames: readonly FrameMeta[],
  cels: CelMap,
  layerId: string,
  frameId: string
): string[] {
  const ref = cels[makeCellKey(layerId, frameId)]
  if (!ref || ref.kind === 'empty') return []
  const targetCelId = ref.celId
  const linked: string[] = []
  for (const f of frames) {
    const r = cels[makeCellKey(layerId, f.id)]
    if (r?.kind === 'cel' && r.celId === targetCelId) {
      linked.push(f.id)
    }
  }
  return linked
}

export function projectFrameLayers(
  layerMetas: readonly LayerMeta[],
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  frameId: string,
  canvasWidth: number,
  canvasHeight: number
): LayerRuntime[] {
  return layerMetas.map((meta) => {
    const ref = cels[makeCellKey(meta.id, frameId)]
    if (ref?.kind === 'cel') {
      const cb = celBuffers[ref.celId]
      if (cb) {
        return {
          ...meta,
          locked: Boolean(meta.locked),
          offsetX: cb.offsetX,
          offsetY: cb.offsetY,
          dataWidth: cb.dataWidth,
          dataHeight: cb.dataHeight,
          data: cb.data,
        }
      }
    }
    return {
      ...meta,
      locked: Boolean(meta.locked),
      offsetX: 0,
      offsetY: 0,
      dataWidth: canvasWidth,
      dataHeight: canvasHeight,
      data: createPixelBuffer(canvasWidth, canvasHeight),
    }
  })
}

export function pruneUnreferencedCelBuffers(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
): Record<string, CelBufferRuntime> {
  const referenced = new Set<string>()
  for (const ref of Object.values(cels)) {
    if (ref?.kind === 'cel') {
      referenced.add(ref.celId)
    }
  }
  const next: Record<string, CelBufferRuntime> = {}
  for (const [id, buf] of Object.entries(celBuffers)) {
    if (referenced.has(id)) {
      next[id] = buf
    }
  }
  return next
}

export function setCellToEmpty(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  layerId: string,
  frameId: string
): { cels: CelMap; celBuffers: Record<string, CelBufferRuntime> } {
  const key = makeCellKey(layerId, frameId)
  const nextCels: CelMap = { ...cels, [key]: { kind: 'empty' } }
  return {
    cels: nextCels,
    celBuffers: pruneUnreferencedCelBuffers(nextCels, celBuffers),
  }
}

export function unlinkCellToIndependent(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  layerId: string,
  frameId: string
): { cels: CelMap; celBuffers: Record<string, CelBufferRuntime>; changed: boolean } {
  const key = makeCellKey(layerId, frameId)
  const ref = cels[key]
  if (!ref || ref.kind === 'empty') {
    return { cels, celBuffers: { ...celBuffers }, changed: false }
  }
  const refCounts = getCelReferenceCountMap(cels)
  if ((refCounts.get(ref.celId) ?? 0) <= 1) {
    return { cels, celBuffers: { ...celBuffers }, changed: false }
  }
  const src = celBuffers[ref.celId]
  if (!src) {
    return { cels, celBuffers: { ...celBuffers }, changed: false }
  }
  const newCelId = generateId('cel')
  const nextBuffers: Record<string, CelBufferRuntime> = {
    ...celBuffers,
    [newCelId]: {
      id: newCelId,
      offsetX: src.offsetX,
      offsetY: src.offsetY,
      dataWidth: src.dataWidth,
      dataHeight: src.dataHeight,
      data: new Uint8Array(src.data),
    },
  }
  const nextCels: CelMap = {
    ...cels,
    [key]: { kind: 'cel', celId: newCelId },
  }
  return { cels: nextCels, celBuffers: nextBuffers, changed: true }
}

export function linkCellToSourceCell(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  layerId: string,
  sourceFrameId: string,
  targetFrameId: string
): { cels: CelMap; celBuffers: Record<string, CelBufferRuntime>; changed: boolean } {
  return linkCellToAnySourceCell(
    cels,
    celBuffers,
    layerId,
    sourceFrameId,
    layerId,
    targetFrameId
  )
}

export function linkCellToAnySourceCell(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  sourceLayerId: string,
  sourceFrameId: string,
  targetLayerId: string,
  targetFrameId: string
): { cels: CelMap; celBuffers: Record<string, CelBufferRuntime>; changed: boolean } {
  if (sourceLayerId === targetLayerId && sourceFrameId === targetFrameId) {
    return { cels, celBuffers: { ...celBuffers }, changed: false }
  }
  const srcKey = makeCellKey(sourceLayerId, sourceFrameId)
  const dstKey = makeCellKey(targetLayerId, targetFrameId)
  const srcRef = cels[srcKey]
  const dstRef = cels[dstKey]

  if (!srcRef || srcRef.kind === 'empty' || !celBuffers[srcRef.celId]) {
    if (!dstRef || dstRef.kind === 'empty') {
      return { cels, celBuffers: { ...celBuffers }, changed: false }
    }
    const nextCels: CelMap = { ...cels, [dstKey]: { kind: 'empty' } }
    return {
      cels: nextCels,
      celBuffers: pruneUnreferencedCelBuffers(nextCels, celBuffers),
      changed: true,
    }
  }

  if (dstRef?.kind === 'cel' && dstRef.celId === srcRef.celId) {
    return { cels, celBuffers: { ...celBuffers }, changed: false }
  }

  const nextCels: CelMap = {
    ...cels,
    [dstKey]: { kind: 'cel', celId: srcRef.celId },
  }
  return {
    cels: nextCels,
    celBuffers: pruneUnreferencedCelBuffers(nextCels, celBuffers),
    changed: true,
  }
}

export function willLinkingOverwriteDistinctPixels(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  sourceLayerId: string,
  sourceFrameId: string,
  targetLayerId: string,
  targetFrameId: string
): boolean {
  const dstRef = cels[makeCellKey(targetLayerId, targetFrameId)]
  if (!dstRef || dstRef.kind === 'empty') return false
  const dstBuf = celBuffers[dstRef.celId]
  if (!dstBuf || !hasAnyOpaquePixel(dstBuf.data)) return false

  const srcRef = cels[makeCellKey(sourceLayerId, sourceFrameId)]
  if (!srcRef || srcRef.kind === 'empty') return true
  if (srcRef.celId === dstRef.celId) return false
  const srcBuf = celBuffers[srcRef.celId]
  if (!srcBuf) return true

  if (
    srcBuf.offsetX !== dstBuf.offsetX ||
    srcBuf.offsetY !== dstBuf.offsetY ||
    srcBuf.dataWidth !== dstBuf.dataWidth ||
    srcBuf.dataHeight !== dstBuf.dataHeight ||
    srcBuf.data.length !== dstBuf.data.length
  ) {
    return true
  }

  for (let i = 0; i < dstBuf.data.length; i++) {
    if (dstBuf.data[i] !== srcBuf.data[i]) return true
  }
  return false
}

export function getCellsSharingCelId(
  cels: CelMap,
  celId: string
): Array<{ cellKey: string; layerId: string; frameId: string }> {
  const out: Array<{ cellKey: string; layerId: string; frameId: string }> = []
  for (const [ck, ref] of Object.entries(cels)) {
    if (ref?.kind === 'cel' && ref.celId === celId) {
      const sep = ck.lastIndexOf(':')
      if (sep >= 0) {
        out.push({
          cellKey: ck,
          layerId: ck.slice(0, sep),
          frameId: ck.slice(sep + 1),
        })
      }
    }
  }
  return out
}

export function copyCellAsIndependent(
  cels: CelMap,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>,
  layerId: string,
  sourceFrameId: string,
  targetFrameId: string
): { cels: CelMap; celBuffers: Record<string, CelBufferRuntime>; changed: boolean } {
  if (sourceFrameId === targetFrameId) {
    return { cels, celBuffers: { ...celBuffers }, changed: false }
  }
  const srcKey = makeCellKey(layerId, sourceFrameId)
  const dstKey = makeCellKey(layerId, targetFrameId)
  const srcRef = cels[srcKey]

  if (!srcRef || srcRef.kind === 'empty' || !celBuffers[srcRef.celId]) {
    const nextCels: CelMap = { ...cels, [dstKey]: { kind: 'empty' } }
    return {
      cels: nextCels,
      celBuffers: pruneUnreferencedCelBuffers(nextCels, celBuffers),
      changed: true,
    }
  }

  const src = celBuffers[srcRef.celId]!
  const newCelId = generateId('cel')
  const nextBuffers: Record<string, CelBufferRuntime> = {
    ...celBuffers,
    [newCelId]: {
      id: newCelId,
      offsetX: src.offsetX,
      offsetY: src.offsetY,
      dataWidth: src.dataWidth,
      dataHeight: src.dataHeight,
      data: new Uint8Array(src.data),
    },
  }
  const nextCels: CelMap = {
    ...cels,
    [dstKey]: { kind: 'cel', celId: newCelId },
  }
  return {
    cels: nextCels,
    celBuffers: pruneUnreferencedCelBuffers(nextCels, nextBuffers),
    changed: true,
  }
}

export function insertNewFrame(
  timeline: TimelineState,
  layerMetas: readonly LayerMeta[],
  mode: 'empty' | 'duplicate-independent' | 'duplicate-linked',
  afterFrameId?: string
): TimelineState {
  const newFrameId = generateId('frame')
  const refFrameId = afterFrameId ?? timeline.activeFrameId
  const refIdx = timeline.frames.findIndex((f) => f.id === refFrameId)
  const insertAt = refIdx >= 0 ? refIdx + 1 : timeline.frames.length
  const srcFrame = refIdx >= 0 ? timeline.frames[refIdx] : timeline.frames[0]

  const durationMs =
    mode === 'empty'
      ? clampFrameDurationMs(timeline.defaultFrameDurationMs)
      : clampFrameDurationMs(
          srcFrame?.durationMs ?? timeline.defaultFrameDurationMs
        )

  const nextFrames = [
    ...timeline.frames.slice(0, insertAt),
    { id: newFrameId, durationMs },
    ...timeline.frames.slice(insertAt),
  ]

  const nextCels: CelMap = { ...timeline.cels }
  const nextBuffers: Record<string, CelBufferRuntime> = { ...timeline.celBuffers }

  for (const layer of layerMetas) {
    const dstKey = makeCellKey(layer.id, newFrameId)
    if (mode === 'empty' || !srcFrame) {
      nextCels[dstKey] = { kind: 'empty' }
      continue
    }

    const srcRef: CelRef | undefined =
      timeline.cels[makeCellKey(layer.id, srcFrame.id)]
    if (!srcRef || srcRef.kind === 'empty' || !nextBuffers[srcRef.celId]) {
      nextCels[dstKey] = { kind: 'empty' }
    } else if (mode === 'duplicate-linked') {
      nextCels[dstKey] = { kind: 'cel', celId: srcRef.celId }
    } else {
      const srcBuf = nextBuffers[srcRef.celId]!
      const copyId = generateId('cel')
      nextBuffers[copyId] = {
        id: copyId,
        offsetX: srcBuf.offsetX,
        offsetY: srcBuf.offsetY,
        dataWidth: srcBuf.dataWidth,
        dataHeight: srcBuf.dataHeight,
        data: new Uint8Array(srcBuf.data),
      }
      nextCels[dstKey] = { kind: 'cel', celId: copyId }
    }
  }

  return {
    ...timeline,
    frames: nextFrames,
    cels: nextCels,
    celBuffers: nextBuffers,
    activeFrameId: newFrameId,
  }
}

export function deleteFrameFromTimeline(
  timeline: TimelineState,
  frameId: string
): TimelineState | null {
  if (timeline.frames.length <= 1) return null
  const idx = timeline.frames.findIndex((f) => f.id === frameId)
  if (idx < 0) return null

  const nextFrames = timeline.frames.filter((f) => f.id !== frameId)
  const nextCels: CelMap = {}
  for (const [k, v] of Object.entries(timeline.cels)) {
    const sep = k.lastIndexOf(':')
    const fId = sep >= 0 ? k.slice(sep + 1) : ''
    if (fId !== frameId) {
      nextCels[k] = v
    }
  }
  const nextActiveFrameId =
    timeline.activeFrameId === frameId
      ? nextFrames[Math.max(0, idx - 1)]!.id
      : timeline.activeFrameId

  return {
    ...timeline,
    frames: nextFrames,
    cels: nextCels,
    celBuffers: pruneUnreferencedCelBuffers(nextCels, timeline.celBuffers),
    activeFrameId: nextActiveFrameId,
  }
}

export function reorderTimelineFrames(
  timeline: TimelineState,
  orderedFrameIds: readonly string[]
): TimelineState {
  const map = new Map(timeline.frames.map((f) => [f.id, f]))
  const nextFrames: FrameMeta[] = []
  for (const id of orderedFrameIds) {
    const f = map.get(id)
    if (f) nextFrames.push(f)
  }
  if (nextFrames.length !== timeline.frames.length) return timeline
  return { ...timeline, frames: nextFrames }
}

export function computePlaybackFrameIndices(
  frameCount: number,
  direction: PlaybackDirection,
  forSingleShotCycle = false
): number[] {
  const n = Math.max(0, Math.trunc(frameCount))
  if (n <= 0) return []
  if (n === 1) return [0]

  if (direction === 'forward') {
    return Array.from({ length: n }, (_, i) => i)
  }
  if (direction === 'reverse') {
    return Array.from({ length: n }, (_, i) => n - 1 - i)
  }

  if (n === 2) {
    return forSingleShotCycle ? [0, 1, 0] : [0, 1]
  }
  const seq: number[] = []
  for (let i = 0; i < n; i++) seq.push(i)
  for (let i = n - 2; i >= 1; i--) seq.push(i)
  if (forSingleShotCycle) {
    seq.push(0)
  }
  return seq
}

export function resolveBatchDurationTargetFrameIds(
  frames: readonly FrameMeta[],
  scope:
    | { mode: 'selected'; selectedFrameIds: readonly string[] }
    | { mode: 'range'; fromFrameNumber: number; toFrameNumber: number }
    | { mode: 'all' }
): string[] {
  if (scope.mode === 'all') {
    return frames.map((f) => f.id)
  }
  if (scope.mode === 'selected') {
    const set = new Set(scope.selectedFrameIds)
    return frames.filter((f) => set.has(f.id)).map((f) => f.id)
  }
  const a = Math.max(1, Math.min(frames.length, Math.round(scope.fromFrameNumber)))
  const b = Math.max(1, Math.min(frames.length, Math.round(scope.toFrameNumber)))
  const lo = Math.min(a, b) - 1
  const hi = Math.max(a, b) - 1
  return frames.slice(lo, hi + 1).map((f) => f.id)
}

export function applyBatchFrameDuration(
  frames: readonly FrameMeta[],
  targetFrameIds: readonly string[],
  durationMs: number
): FrameMeta[] {
  const clamped = clampFrameDurationMs(durationMs)
  const set = new Set(targetFrameIds)
  return frames.map((f) => (set.has(f.id) ? { ...f, durationMs: clamped } : f))
}
