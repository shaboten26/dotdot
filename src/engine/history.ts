import type {
  CanvasSnapshot,
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  HistoryEntry,
  LayerRuntime,
  PixelPatch,
  ProjectPalette,
  SerializedHistoryEntry,
  TimelineSnapshot,
  WorldSelectionMask,
} from '../types'
import { normalizeProjectPalette } from './indexedPalette'
import { createPixelBuffer, normalizeLayerGeometry } from './pixelBuffer'
import { projectFrameLayers, pruneUnreferencedCelBuffers } from './animation'
import {
  canvasMaskToWorldSelection,
  cloneWorldSelectionMask,
  projectWorldSelectionToCanvasMask,
} from './selection'

function clonePaletteSnapshot(p?: ProjectPalette): ProjectPalette | undefined {
  if (!p) return undefined
  const norm = normalizeProjectPalette(p)
  return {
    ...norm,
    colors: [...norm.colors],
    colorTable: norm.colorTable ? [...norm.colorTable] : undefined,
    displayOrder: norm.displayOrder ? [...norm.displayOrder] : undefined,
    originalDisplayOrder: norm.originalDisplayOrder
      ? [...norm.originalDisplayOrder]
      : undefined,
  }
}

/**
 * Compute a compact sparse 1-byte-per-pixel `PixelPatch` recording ONLY the pixels that changed
 * between `beforeLayer` and `afterLayer`, including backing geometry transitions.
 */
export function createLayerPixelPatch(
  beforeLayer: Pick<
    LayerRuntime,
    'id' | 'offsetX' | 'offsetY' | 'dataWidth' | 'dataHeight' | 'data'
  >,
  afterLayer: Pick<
    LayerRuntime,
    'id' | 'offsetX' | 'offsetY' | 'dataWidth' | 'dataHeight' | 'data'
  >,
  celId?: string
): PixelPatch | null {
  const bOx = beforeLayer.offsetX ?? 0
  const bOy = beforeLayer.offsetY ?? 0
  const bW = beforeLayer.dataWidth ?? 1
  const bH = beforeLayer.dataHeight ?? 1

  const aOx = afterLayer.offsetX ?? 0
  const aOy = afterLayer.offsetY ?? 0
  const aW = afterLayer.dataWidth ?? 1
  const aH = afterLayer.dataHeight ?? 1

  const sameGeometry = bOx === aOx && bOy === aOy && bW === aW && aH === bH

  if (sameGeometry && beforeLayer.data.length === afterLayer.data.length) {
    const base = createPixelPatch(beforeLayer.id, beforeLayer.data, afterLayer.data)
    if (!base) return null
    return {
      ...base,
      ...(celId ? { celId } : {}),
      beforeGeometry: { offsetX: bOx, offsetY: bOy, dataWidth: bW, dataHeight: bH },
      afterGeometry: { offsetX: aOx, offsetY: aOy, dataWidth: aW, dataHeight: aH },
    }
  }

  const uMinX = Math.min(bOx, aOx)
  const uMinY = Math.min(bOy, aOy)
  const uMaxX = Math.max(bOx + bW, aOx + aW)
  const uMaxY = Math.max(bOy + bH, aOy + aH)
  const uW = Math.max(1, uMaxX - uMinX)
  const uH = Math.max(1, uMaxY - uMinY)

  const alignedBefore = createPixelBuffer(uW, uH)
  for (let ly = 0; ly < bH; ly++) {
    const ny = bOy + ly - uMinY
    const nx = bOx - uMinX
    const sOff = ly * bW
    const dOff = ny * uW + nx
    alignedBefore.set(beforeLayer.data.subarray(sOff, sOff + bW), dOff)
  }

  const alignedAfter = createPixelBuffer(uW, uH)
  for (let ly = 0; ly < aH; ly++) {
    const ny = aOy + ly - uMinY
    const nx = aOx - uMinX
    const sOff = ly * aW
    const dOff = ny * uW + nx
    alignedAfter.set(afterLayer.data.subarray(sOff, sOff + aW), dOff)
  }

  const diff = createPixelPatch(beforeLayer.id, alignedBefore, alignedAfter)
  if (!diff && sameGeometry) return null

  return {
    layerId: beforeLayer.id,
    ...(celId ? { celId } : {}),
    indices: diff ? diff.indices : new Uint32Array(0),
    before: diff ? diff.before : new Uint8Array(0),
    after: diff ? diff.after : new Uint8Array(0),
    beforeGeometry: { offsetX: bOx, offsetY: bOy, dataWidth: bW, dataHeight: bH },
    afterGeometry: { offsetX: aOx, offsetY: aOy, dataWidth: aW, dataHeight: aH },
  }
}

/**
 * Compute a compact sparse 1-byte `PixelPatch` between two equal-length Indexed Color buffers.
 */
export function createPixelPatch(
  layerId: string,
  beforeBuf: Uint8Array,
  afterBuf: Uint8Array
): PixelPatch | null {
  if (beforeBuf.length !== afterBuf.length) {
    throw new Error('Buffer length mismatch when creating PixelPatch')
  }

  const pixelCount = beforeBuf.length
  const changedIndices: number[] = []

  for (let p = 0; p < pixelCount; p++) {
    if (beforeBuf[p] !== afterBuf[p]) {
      changedIndices.push(p)
    }
  }

  if (changedIndices.length === 0) return null

  const n = changedIndices.length
  const indices = new Uint32Array(n)
  const before = new Uint8Array(n)
  const after = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    const p = changedIndices[i]!
    indices[i] = p
    before[i] = beforeBuf[p]!
    after[i] = afterBuf[p]!
  }

  return { layerId, indices, before, after }
}

export function applyPixelPatch(
  buffer: Uint8Array,
  patch: PixelPatch,
  direction: 'undo' | 'redo'
): Uint8Array {
  const next = new Uint8Array(buffer)
  const values = direction === 'undo' ? patch.before : patch.after
  const n = patch.indices.length

  for (let i = 0; i < n; i++) {
    const p = patch.indices[i]!
    if (p < next.length && i < values.length) {
      next[p] = values[i]!
    }
  }

  return next
}

export function applyPatchToGeometryBuffer<
  T extends {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
    data: Uint8Array
  },
>(target: T, patch: PixelPatch, direction: 'undo' | 'redo'): T {
  const bGeo = patch.beforeGeometry
  const aGeo = patch.afterGeometry

  if (
    !bGeo ||
    !aGeo ||
    (bGeo.offsetX === aGeo.offsetX &&
      bGeo.offsetY === aGeo.offsetY &&
      bGeo.dataWidth === aGeo.dataWidth &&
      bGeo.dataHeight === aGeo.dataHeight)
  ) {
    return {
      ...target,
      data: applyPixelPatch(target.data, patch, direction),
    }
  }

  const uMinX = Math.min(bGeo.offsetX, aGeo.offsetX)
  const uMinY = Math.min(bGeo.offsetY, aGeo.offsetY)
  const uMaxX = Math.max(bGeo.offsetX + bGeo.dataWidth, aGeo.offsetX + aGeo.dataWidth)
  const uMaxY = Math.max(bGeo.offsetY + bGeo.dataHeight, aGeo.offsetY + aGeo.dataHeight)
  const uW = Math.max(1, uMaxX - uMinX)
  const uH = Math.max(1, uMaxY - uMinY)

  const srcGeo = direction === 'undo' ? aGeo : bGeo
  const dstGeo = direction === 'undo' ? bGeo : aGeo

  const unionBuf = createPixelBuffer(uW, uH)
  for (let ly = 0; ly < target.dataHeight; ly++) {
    const ny = (target.offsetY ?? srcGeo.offsetY) + ly - uMinY
    const nx = (target.offsetX ?? srcGeo.offsetX) - uMinX
    if (ny < 0 || ny >= uH) continue
    const sOff = ly * target.dataWidth
    const dOff = ny * uW + nx
    const copyLen = Math.min(target.dataWidth, uW - nx)
    if (nx >= 0 && copyLen > 0) {
      unionBuf.set(target.data.subarray(sOff, sOff + copyLen), dOff)
    }
  }

  const patchedUnion = applyPixelPatch(unionBuf, patch, direction)

  const targetBuf = createPixelBuffer(dstGeo.dataWidth, dstGeo.dataHeight)
  for (let ly = 0; ly < dstGeo.dataHeight; ly++) {
    const ny = dstGeo.offsetY + ly - uMinY
    const nx = dstGeo.offsetX - uMinX
    const sOff = ny * uW + nx
    const dOff = ly * dstGeo.dataWidth
    targetBuf.set(patchedUnion.subarray(sOff, sOff + dstGeo.dataWidth), dOff)
  }

  return {
    ...target,
    offsetX: dstGeo.offsetX,
    offsetY: dstGeo.offsetY,
    dataWidth: dstGeo.dataWidth,
    dataHeight: dstGeo.dataHeight,
    data: targetBuf,
  }
}

export function applyPatchToLayerRuntime(
  layer: LayerRuntime,
  patch: PixelPatch,
  direction: 'undo' | 'redo'
): LayerRuntime {
  return applyPatchToGeometryBuffer(layer, patch, direction)
}

export function captureTimelineSnapshot(
  frames: readonly FrameMeta[],
  cels: CelMap,
  activeFrameId: string,
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
): TimelineSnapshot {
  return {
    frames: frames.map((f) => ({ ...f })),
    cels: Object.fromEntries(
      Object.entries(cels).map(([k, v]) => [k, v.kind === 'cel' ? { ...v } : { kind: 'empty' }])
    ),
    activeFrameId,
    celBuffers: Object.values(celBuffers).map((cb) => ({
      id: cb.id,
      offsetX: cb.offsetX,
      offsetY: cb.offsetY,
      dataWidth: cb.dataWidth,
      dataHeight: cb.dataHeight,
      data: new Uint8Array(cb.data),
    })),
  }
}

export function restoreTimelineSnapshot(
  snap: TimelineSnapshot,
  canvasWidth: number,
  canvasHeight: number
): {
  frames: FrameMeta[]
  cels: CelMap
  activeFrameId: string
  celBuffers: Record<string, CelBufferRuntime>
} {
  const celBuffers: Record<string, CelBufferRuntime> = {}
  for (const cb of snap.celBuffers) {
    const raw = new Uint8Array(cb.data)
    const geo = normalizeLayerGeometry(
      {
        offsetX: cb.offsetX,
        offsetY: cb.offsetY,
        dataWidth: cb.dataWidth,
        dataHeight: cb.dataHeight,
        data: raw,
      },
      canvasWidth,
      canvasHeight
    )
    const expectedLen = geo.dataWidth * geo.dataHeight
    let data: Uint8Array
    if (raw.byteLength === expectedLen) {
      data = raw
    } else {
      data = createPixelBuffer(geo.dataWidth, geo.dataHeight)
      data.set(raw.subarray(0, Math.min(raw.length, expectedLen)))
    }
    celBuffers[cb.id] = {
      id: cb.id,
      offsetX: geo.offsetX,
      offsetY: geo.offsetY,
      dataWidth: geo.dataWidth,
      dataHeight: geo.dataHeight,
      data,
    }
  }
  return {
    frames: snap.frames.map((f) => ({ ...f })),
    cels: Object.fromEntries(
      Object.entries(snap.cels).map(([k, v]) => [
        k,
        v.kind === 'cel' ? { ...v } : { kind: 'empty' },
      ])
    ),
    activeFrameId: snap.activeFrameId,
    celBuffers,
  }
}

export function captureCanvasSnapshot(
  width: number,
  height: number,
  layers: readonly LayerRuntime[],
  activeLayerId: string,
  timeline?: {
    frames: readonly FrameMeta[]
    cels: CelMap
    activeFrameId: string
    celBuffers: Readonly<Record<string, CelBufferRuntime>>
  }
): CanvasSnapshot {
  return {
    width,
    height,
    activeLayerId,
    layers: layers.map((l) => ({
      meta: {
        id: l.id,
        name: l.name,
        visible: l.visible,
        locked: Boolean(l.locked),
        opacity: l.opacity,
        blendMode: l.blendMode,
        clipping: l.clipping,
        offsetX: l.offsetX ?? 0,
        offsetY: l.offsetY ?? 0,
        dataWidth: l.dataWidth ?? width,
        dataHeight: l.dataHeight ?? height,
      },
      data: new Uint8Array(l.data),
    })),
    timeline: timeline
      ? captureTimelineSnapshot(
          timeline.frames,
          timeline.cels,
          timeline.activeFrameId,
          timeline.celBuffers
        )
      : undefined,
  }
}

export function restoreCanvasSnapshot(snapshot: CanvasSnapshot): {
  width: number
  height: number
  layers: LayerRuntime[]
  activeLayerId: string
  timeline?: {
    frames: FrameMeta[]
    cels: CelMap
    activeFrameId: string
    celBuffers: Record<string, CelBufferRuntime>
  }
} {
  const restoredTimeline = snapshot.timeline
    ? restoreTimelineSnapshot(snapshot.timeline, snapshot.width, snapshot.height)
    : undefined

  const baseLayers: LayerRuntime[] = snapshot.layers.map((item) => {
    const raw = new Uint8Array(item.data)
    const geo = normalizeLayerGeometry(
      {
        offsetX: item.meta.offsetX,
        offsetY: item.meta.offsetY,
        dataWidth: item.meta.dataWidth,
        dataHeight: item.meta.dataHeight,
        data: raw,
      },
      snapshot.width,
      snapshot.height
    )
    const expectedLen = geo.dataWidth * geo.dataHeight
    let data: Uint8Array
    if (raw.byteLength === expectedLen) {
      data = raw
    } else {
      data = createPixelBuffer(geo.dataWidth, geo.dataHeight)
      data.set(raw.subarray(0, Math.min(raw.length, expectedLen)))
    }
    return {
      ...item.meta,
      locked: Boolean(item.meta.locked),
      ...geo,
      data,
    }
  })

  const projectedLayers = restoredTimeline
    ? projectFrameLayers(
        baseLayers.map((l) => ({
          id: l.id,
          name: l.name,
          visible: l.visible,
          locked: Boolean(l.locked),
          opacity: l.opacity,
          blendMode: l.blendMode,
          clipping: l.clipping,
          offsetX: l.offsetX,
          offsetY: l.offsetY,
          dataWidth: l.dataWidth,
          dataHeight: l.dataHeight,
        })),
        restoredTimeline.cels,
        restoredTimeline.celBuffers,
        restoredTimeline.activeFrameId,
        snapshot.width,
        snapshot.height
      )
    : baseLayers

  return {
    width: snapshot.width,
    height: snapshot.height,
    activeLayerId: snapshot.activeLayerId,
    layers: projectedLayers,
    timeline: restoredTimeline,
  }
}

export interface EditorRuntimeStateForHistory {
  width: number
  height: number
  layers: LayerRuntime[]
  activeLayerId: string
  selectionMask: Uint8Array | null
  worldSelection?: WorldSelectionMask | null
  palette: ProjectPalette
  frames?: FrameMeta[]
  cels?: CelMap
  celBuffers?: Record<string, CelBufferRuntime>
  activeFrameId?: string
}

export function applyHistoryEntry(
  state: EditorRuntimeStateForHistory,
  entry: HistoryEntry,
  direction: 'undo' | 'redo'
): EditorRuntimeStateForHistory {
  let nextLayers = state.layers
  let nextWidth = state.width
  let nextHeight = state.height
  let nextActiveLayerId = state.activeLayerId
  let nextSelection = state.selectionMask
  let nextWorldSelection = state.worldSelection
  let nextPalette = state.palette
  let nextFrames = state.frames
  let nextCels = state.cels
  let nextCelBuffers = state.celBuffers
  let nextActiveFrameId = state.activeFrameId

  if (entry.kind === 'structure') {
    const snap = direction === 'undo' ? entry.beforeStructure : entry.afterStructure
    if (snap) {
      const restored = restoreCanvasSnapshot(snap)
      nextWidth = restored.width
      nextHeight = restored.height
      nextLayers = restored.layers
      nextActiveLayerId = restored.activeLayerId
      if (restored.timeline) {
        nextFrames = restored.timeline.frames
        nextCels = restored.timeline.cels
        nextCelBuffers = restored.timeline.celBuffers
        nextActiveFrameId = restored.timeline.activeFrameId
      }
    }
  } else if (
    entry.kind === 'layer-offset' &&
    (entry.layerOffsetChanges || entry.layerOffsetChange)
  ) {
    const changes =
      entry.layerOffsetChanges ??
      (entry.layerOffsetChange ? [entry.layerOffsetChange] : [])
    const mapByLayer = new Map(changes.map((c) => [c.layerId, c]))

    if (nextCelBuffers && nextCels) {
      const updatedBuffers = { ...nextCelBuffers }
      for (const ch of changes) {
        if (ch.celId && updatedBuffers[ch.celId]) {
          const targetOx = direction === 'undo' ? ch.beforeOffsetX : ch.afterOffsetX
          const targetOy = direction === 'undo' ? ch.beforeOffsetY : ch.afterOffsetY
          updatedBuffers[ch.celId] = {
            ...updatedBuffers[ch.celId]!,
            offsetX: targetOx,
            offsetY: targetOy,
          }
        }
      }
      nextCelBuffers = updatedBuffers
      if (entry.frameId && nextFrames?.some((f) => f.id === entry.frameId)) {
        nextActiveFrameId = entry.frameId
      }
      if (nextActiveFrameId) {
        nextLayers = projectFrameLayers(
          state.layers,
          nextCels,
          nextCelBuffers,
          nextActiveFrameId,
          nextWidth,
          nextHeight
        )
      }
    } else {
      nextLayers = state.layers.map((layer) => {
        const ch = mapByLayer.get(layer.id)
        if (!ch) return layer
        const targetOx = direction === 'undo' ? ch.beforeOffsetX : ch.afterOffsetX
        const targetOy = direction === 'undo' ? ch.beforeOffsetY : ch.afterOffsetY
        return { ...layer, offsetX: targetOx, offsetY: targetOy }
      })
    }
  } else if (entry.kind === 'pixel-diff' && entry.pixelPatches) {
    const hasCelMode = Boolean(
      nextCelBuffers && nextCels && entry.pixelPatches.some((p) => Boolean(p.celId))
    )

    if (hasCelMode && nextCelBuffers && nextCels) {
      const updatedCels: CelMap = { ...nextCels }
      let updatedBuffers: Record<string, CelBufferRuntime> = { ...nextCelBuffers }

      if (entry.celAllocation && direction === 'redo') {
        const { cellKey, allocatedCelId } = entry.celAllocation
        updatedCels[cellKey] = { kind: 'cel', celId: allocatedCelId }
        if (!updatedBuffers[allocatedCelId]) {
          updatedBuffers[allocatedCelId] = {
            id: allocatedCelId,
            offsetX: 0,
            offsetY: 0,
            dataWidth: nextWidth,
            dataHeight: nextHeight,
            data: createPixelBuffer(nextWidth, nextHeight),
          }
        }
      }

      const ordered =
        direction === 'undo' ? [...entry.pixelPatches].reverse() : entry.pixelPatches
      for (const patch of ordered) {
        if (patch.celId && updatedBuffers[patch.celId]) {
          updatedBuffers[patch.celId] = applyPatchToGeometryBuffer(
            updatedBuffers[patch.celId]!,
            patch,
            direction
          )
        }
      }

      if (entry.celAllocation && direction === 'undo') {
        updatedCels[entry.celAllocation.cellKey] = { kind: 'empty' }
        updatedBuffers = pruneUnreferencedCelBuffers(updatedCels, updatedBuffers)
      }

      nextCels = updatedCels
      nextCelBuffers = updatedBuffers
      if (entry.frameId && nextFrames?.some((f) => f.id === entry.frameId)) {
        nextActiveFrameId = entry.frameId
      }
      if (nextActiveFrameId) {
        nextLayers = projectFrameLayers(
          state.layers,
          nextCels,
          nextCelBuffers,
          nextActiveFrameId,
          nextWidth,
          nextHeight
        )
      }
    } else {
      nextLayers = state.layers.map((layer) => {
        const matchingPatches = entry.pixelPatches!.filter((p) => p.layerId === layer.id)
        if (matchingPatches.length === 0) return layer
        let updatedLayer = layer
        const ordered =
          direction === 'undo' ? [...matchingPatches].reverse() : matchingPatches
        for (const patch of ordered) {
          updatedLayer = applyPatchToLayerRuntime(updatedLayer, patch, direction)
        }
        return updatedLayer
      })
    }
  }

  // Apply palette transition if recorded (supports pure `'palette'` entries AND combined `'pixel-diff' + palette` entries!)
  if (entry.beforePalette !== undefined || entry.afterPalette !== undefined) {
    const pal = direction === 'undo' ? entry.beforePalette : entry.afterPalette
    if (pal) {
      nextPalette = clonePaletteSnapshot(pal)!
    }
  }

  if (
    entry.beforeWorldSelection !== undefined ||
    entry.afterWorldSelection !== undefined
  ) {
    const ws =
      direction === 'undo' ? entry.beforeWorldSelection : entry.afterWorldSelection
    nextWorldSelection = cloneWorldSelectionMask(ws)
    nextSelection = projectWorldSelectionToCanvasMask(
      nextWorldSelection,
      nextWidth,
      nextHeight
    )
  } else if (
    entry.beforeSelection !== undefined ||
    entry.afterSelection !== undefined
  ) {
    const sel = direction === 'undo' ? entry.beforeSelection : entry.afterSelection
    nextSelection = sel ? new Uint8Array(sel) : null
    nextWorldSelection = canvasMaskToWorldSelection(
      nextSelection,
      nextWidth,
      nextHeight
    )
  }

  return {
    width: nextWidth,
    height: nextHeight,
    layers: nextLayers,
    activeLayerId: nextActiveLayerId,
    selectionMask: nextSelection,
    ...(nextWorldSelection !== undefined
      ? { worldSelection: nextWorldSelection }
      : {}),
    palette: nextPalette,
    ...(nextFrames !== undefined ? { frames: nextFrames } : {}),
    ...(nextCels !== undefined ? { cels: nextCels } : {}),
    ...(nextCelBuffers !== undefined ? { celBuffers: nextCelBuffers } : {}),
    ...(nextActiveFrameId !== undefined ? { activeFrameId: nextActiveFrameId } : {}),
  }
}

export class HistoryManager {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private limit: number | 'unlimited'

  constructor(limit: number | 'unlimited' = 'unlimited') {
    this.limit = limit
  }

  setLimit(limit: number | 'unlimited'): void {
    this.limit = limit
    this.enforceLimit()
  }

  getLimit(): number | 'unlimited' {
    return this.limit
  }

  private enforceLimit(): void {
    if (this.limit === 'unlimited') return
    const cap = Math.max(1, Math.trunc(this.limit))
    if (this.undoStack.length > cap) {
      this.undoStack.splice(0, this.undoStack.length - cap)
    }
  }

  push(entry: HistoryEntry): void {
    this.undoStack.push(entry)
    this.redoStack = []
    this.enforceLimit()
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  getUndoCount(): number {
    return this.undoStack.length
  }

  getRedoCount(): number {
    return this.redoStack.length
  }

  undo(state: EditorRuntimeStateForHistory): EditorRuntimeStateForHistory | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push(entry)
    return applyHistoryEntry(state, entry, 'undo')
  }

  redo(state: EditorRuntimeStateForHistory): EditorRuntimeStateForHistory | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push(entry)
    this.enforceLimit()
    return applyHistoryEntry(state, entry, 'redo')
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  serialize(): { undoStack: SerializedHistoryEntry[]; redoStack: SerializedHistoryEntry[] } {
    const cloneSnapshot = (s?: CanvasSnapshot): CanvasSnapshot | undefined => {
      if (!s) return undefined
      return {
        width: s.width,
        height: s.height,
        activeLayerId: s.activeLayerId,
        layers: s.layers.map((l) => ({
          meta: { ...l.meta },
          data: new Uint8Array(l.data),
        })),
        timeline: s.timeline
          ? {
              frames: s.timeline.frames.map((f) => ({ ...f })),
              cels: Object.fromEntries(
                Object.entries(s.timeline.cels).map(([k, v]) => [
                  k,
                  v.kind === 'cel' ? { ...v } : { kind: 'empty' },
                ])
              ),
              activeFrameId: s.timeline.activeFrameId,
              celBuffers: s.timeline.celBuffers.map((cb) => ({
                ...cb,
                data: new Uint8Array(cb.data),
              })),
            }
          : undefined,
      }
    }

    const cloneEntry = (e: HistoryEntry): SerializedHistoryEntry => ({
      id: e.id,
      label: e.label,
      timestamp: e.timestamp,
      kind: e.kind,
      frameId: e.frameId,
      celAllocation: e.celAllocation ? { ...e.celAllocation } : undefined,
      pixelPatches: e.pixelPatches?.map((p) => ({
        layerId: p.layerId,
        celId: p.celId,
        indices: new Uint32Array(p.indices),
        before: new Uint8Array(p.before),
        after: new Uint8Array(p.after),
        beforeGeometry: p.beforeGeometry ? { ...p.beforeGeometry } : undefined,
        afterGeometry: p.afterGeometry ? { ...p.afterGeometry } : undefined,
      })),
      layerOffsetChange: e.layerOffsetChange ? { ...e.layerOffsetChange } : undefined,
      layerOffsetChanges: e.layerOffsetChanges
        ? e.layerOffsetChanges.map((c) => ({ ...c }))
        : undefined,
      beforeStructure: cloneSnapshot(e.beforeStructure),
      afterStructure: cloneSnapshot(e.afterStructure),
      beforeSelection: e.beforeSelection ? new Uint8Array(e.beforeSelection) : e.beforeSelection,
      afterSelection: e.afterSelection ? new Uint8Array(e.afterSelection) : e.afterSelection,
      beforeWorldSelection:
        e.beforeWorldSelection === undefined
          ? undefined
          : cloneWorldSelectionMask(e.beforeWorldSelection),
      afterWorldSelection:
        e.afterWorldSelection === undefined
          ? undefined
          : cloneWorldSelectionMask(e.afterWorldSelection),
      beforePalette: clonePaletteSnapshot(e.beforePalette),
      afterPalette: clonePaletteSnapshot(e.afterPalette),
    })

    return {
      undoStack: this.undoStack.map(cloneEntry),
      redoStack: this.redoStack.map(cloneEntry),
    }
  }

  hydrate(data: {
    undoStack: SerializedHistoryEntry[]
    redoStack: SerializedHistoryEntry[]
  }): void {
    const restoreEntry = (e: SerializedHistoryEntry): HistoryEntry => ({
      id: e.id,
      label: e.label,
      timestamp: e.timestamp,
      kind: e.kind,
      frameId: e.frameId,
      celAllocation: e.celAllocation ? { ...e.celAllocation } : undefined,
      pixelPatches: e.pixelPatches?.map((p) => ({
        layerId: p.layerId,
        celId: p.celId,
        indices: new Uint32Array(p.indices),
        before: new Uint8Array(p.before),
        after: new Uint8Array(p.after),
        beforeGeometry: p.beforeGeometry ? { ...p.beforeGeometry } : undefined,
        afterGeometry: p.afterGeometry ? { ...p.afterGeometry } : undefined,
      })),
      layerOffsetChange: e.layerOffsetChange ? { ...e.layerOffsetChange } : undefined,
      layerOffsetChanges: e.layerOffsetChanges
        ? e.layerOffsetChanges.map((c) => ({ ...c }))
        : undefined,
      beforeStructure: e.beforeStructure,
      afterStructure: e.afterStructure,
      beforeSelection:
        e.beforeSelection === undefined
          ? undefined
          : e.beforeSelection
            ? new Uint8Array(e.beforeSelection)
            : null,
      afterSelection:
        e.afterSelection === undefined
          ? undefined
          : e.afterSelection
            ? new Uint8Array(e.afterSelection)
            : null,
      beforeWorldSelection:
        e.beforeWorldSelection === undefined
          ? undefined
          : cloneWorldSelectionMask(e.beforeWorldSelection),
      afterWorldSelection:
        e.afterWorldSelection === undefined
          ? undefined
          : cloneWorldSelectionMask(e.afterWorldSelection),
      beforePalette: clonePaletteSnapshot(e.beforePalette),
      afterPalette: clonePaletteSnapshot(e.afterPalette),
    })

    this.undoStack = (data.undoStack ?? []).map(restoreEntry)
    this.redoStack = (data.redoStack ?? []).map(restoreEntry)
    this.enforceLimit()
  }
}
