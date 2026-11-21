import type {
  CanvasSnapshot,
  HistoryEntry,
  LayerRuntime,
  PixelPatch,
  ProjectPalette,
  SerializedHistoryEntry,
} from '../types'

/**
 * Compute a compact sparse PixelPatch recording ONLY the pixels that actually changed
 * between `beforeBuf` and `afterBuf`. Returns `null` if zero pixels changed.
 */
export function createPixelPatch(
  layerId: string,
  beforeBuf: Uint8ClampedArray,
  afterBuf: Uint8ClampedArray
): PixelPatch | null {
  if (beforeBuf.length !== afterBuf.length) {
    throw new Error('Buffer length mismatch when creating PixelPatch')
  }

  const pixelCount = beforeBuf.length >>> 2
  const changedIndices: number[] = []

  for (let p = 0; p < pixelCount; p++) {
    const bIdx = p * 4
    if (
      beforeBuf[bIdx] !== afterBuf[bIdx] ||
      beforeBuf[bIdx + 1] !== afterBuf[bIdx + 1] ||
      beforeBuf[bIdx + 2] !== afterBuf[bIdx + 2] ||
      beforeBuf[bIdx + 3] !== afterBuf[bIdx + 3]
    ) {
      changedIndices.push(p)
    }
  }

  if (changedIndices.length === 0) return null

  const n = changedIndices.length
  const indices = new Uint32Array(n)
  const before = new Uint8Array(n * 4)
  const after = new Uint8Array(n * 4)

  for (let i = 0; i < n; i++) {
    const p = changedIndices[i]
    indices[i] = p
    const srcOff = p * 4
    const dstOff = i * 4

    before[dstOff] = beforeBuf[srcOff]
    before[dstOff + 1] = beforeBuf[srcOff + 1]
    before[dstOff + 2] = beforeBuf[srcOff + 2]
    before[dstOff + 3] = beforeBuf[srcOff + 3]

    after[dstOff] = afterBuf[srcOff]
    after[dstOff + 1] = afterBuf[srcOff + 1]
    after[dstOff + 2] = afterBuf[srcOff + 2]
    after[dstOff + 3] = afterBuf[srcOff + 3]
  }

  return { layerId, indices, before, after }
}

/**
 * Apply a PixelPatch in reverse (`direction = 'undo'`) or forward (`direction = 'redo'`) onto target buffer.
 */
export function applyPixelPatch(
  buffer: Uint8ClampedArray,
  patch: PixelPatch,
  direction: 'undo' | 'redo'
): Uint8ClampedArray {
  const next = new Uint8ClampedArray(buffer)
  const values = direction === 'undo' ? patch.before : patch.after
  const n = patch.indices.length

  for (let i = 0; i < n; i++) {
    const p = patch.indices[i]
    const dstOff = p * 4
    const srcOff = i * 4
    next[dstOff] = values[srcOff]
    next[dstOff + 1] = values[srcOff + 1]
    next[dstOff + 2] = values[srcOff + 2]
    next[dstOff + 3] = values[srcOff + 3]
  }

  return next
}

export function captureCanvasSnapshot(
  width: number,
  height: number,
  layers: readonly LayerRuntime[],
  activeLayerId: string
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
        opacity: l.opacity,
        blendMode: l.blendMode,
        clipping: l.clipping,
      },
      data: new Uint8Array(l.data),
    })),
  }
}

export function restoreCanvasSnapshot(snapshot: CanvasSnapshot): {
  width: number
  height: number
  layers: LayerRuntime[]
  activeLayerId: string
} {
  return {
    width: snapshot.width,
    height: snapshot.height,
    activeLayerId: snapshot.activeLayerId,
    layers: snapshot.layers.map((item) => ({
      ...item.meta,
      data: new Uint8ClampedArray(item.data),
    })),
  }
}

export interface EditorRuntimeStateForHistory {
  width: number
  height: number
  layers: LayerRuntime[]
  activeLayerId: string
  selectionMask: Uint8Array | null
  palette: ProjectPalette
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
  let nextPalette = state.palette

  if (entry.kind === 'structure') {
    const snap = direction === 'undo' ? entry.beforeStructure : entry.afterStructure
    if (snap) {
      const restored = restoreCanvasSnapshot(snap)
      nextWidth = restored.width
      nextHeight = restored.height
      nextLayers = restored.layers
      nextActiveLayerId = restored.activeLayerId
    }
  } else if (entry.kind === 'pixel-diff' && entry.pixelPatches) {
    nextLayers = state.layers.map((layer) => {
      const matchingPatches = entry.pixelPatches!.filter((p) => p.layerId === layer.id)
      if (matchingPatches.length === 0) return layer
      let data = layer.data
      const ordered =
        direction === 'undo' ? [...matchingPatches].reverse() : matchingPatches
      for (const patch of ordered) {
        data = applyPixelPatch(data, patch, direction)
      }
      return { ...layer, data }
    })
  } else if (entry.kind === 'palette') {
    const pal = direction === 'undo' ? entry.beforePalette : entry.afterPalette
    if (pal) {
      nextPalette = {
        ...pal,
        colors: [...pal.colors],
      }
    }
  }

  if (entry.beforeSelection !== undefined || entry.afterSelection !== undefined) {
    const sel = direction === 'undo' ? entry.beforeSelection : entry.afterSelection
    nextSelection = sel ? new Uint8Array(sel) : null
  }

  return {
    width: nextWidth,
    height: nextHeight,
    layers: nextLayers,
    activeLayerId: nextActiveLayerId,
    selectionMask: nextSelection,
    palette: nextPalette,
  }
}

/**
 * Stateful HistoryManager per project with configurable historyLimit ('unlimited' or integer >= 1).
 */
export class HistoryManager {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private limit: number | 'unlimited'

  constructor(limit: number | 'unlimited' = 100) {
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
    const cloneEntry = (e: HistoryEntry): SerializedHistoryEntry => ({
      id: e.id,
      label: e.label,
      timestamp: e.timestamp,
      kind: e.kind,
      pixelPatches: e.pixelPatches?.map((p) => ({
        layerId: p.layerId,
        indices: new Uint32Array(p.indices),
        before: new Uint8Array(p.before),
        after: new Uint8Array(p.after),
      })),
      beforeStructure: e.beforeStructure,
      afterStructure: e.afterStructure,
      beforeSelection: e.beforeSelection ? new Uint8Array(e.beforeSelection) : e.beforeSelection,
      afterSelection: e.afterSelection ? new Uint8Array(e.afterSelection) : e.afterSelection,
      beforePalette: e.beforePalette
        ? { ...e.beforePalette, colors: [...e.beforePalette.colors] }
        : undefined,
      afterPalette: e.afterPalette
        ? { ...e.afterPalette, colors: [...e.afterPalette.colors] }
        : undefined,
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
      pixelPatches: e.pixelPatches?.map((p) => ({
        layerId: p.layerId,
        indices: new Uint32Array(p.indices),
        before: new Uint8Array(p.before),
        after: new Uint8Array(p.after),
      })),
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
      beforePalette: e.beforePalette
        ? { ...e.beforePalette, colors: [...e.beforePalette.colors] }
        : undefined,
      afterPalette: e.afterPalette
        ? { ...e.afterPalette, colors: [...e.afterPalette.colors] }
        : undefined,
    })

    this.undoStack = (data.undoStack ?? []).map(restoreEntry)
    this.redoStack = (data.redoStack ?? []).map(restoreEntry)
    this.enforceLimit()
  }
}
