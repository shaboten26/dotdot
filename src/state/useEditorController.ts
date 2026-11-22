import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  TRANSPARENT_COLOR_INDEX,
  type ActiveMoveSession,
  type BlendMode,
  type ClipboardBuffer,
  type FloatingShapeState,
  type LayerOffsetTransition,
  type LayerRuntime,
  type Point,
  type ProjectPalette,
  type ProjectRecord,
  type ResizeAnchor,
  type RGBA,
  type ToolId,
  type ToolSettings,
} from '../types'
import {
  db,
  generateId,
  loadProjectFull,
  saveProjectFull,
} from '../db/database'
import { hexToRgba, rgbaToHex } from '../engine/color'
import {
  createPixelBuffer,
  extractLayerCanvasView,
  flipLayerAroundCanvas,
  getPixel,
  isInBounds,
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  resizeLayersWithAnchor,
  stampBufferIntoLayerWorld,
  writeLayerCanvasView,
} from '../engine/pixelBuffer'
import { stampPoints } from '../engine/brush'
import { expandStrokePoints, filterPixelPerfectPoints } from '../engine/pixelPerfect'
import { applyFloodFill, applyGradientFloodFill } from '../engine/floodFill'
import {
  computeShapeBounds,
  drawCubicBezier,
  drawLine,
  rasterizeEllipse,
  rasterizeRectangle,
} from '../engine/rasterize'
import { compositeFloatingShapeOntoLayer } from '../engine/transform'
import {
  applySelectionOutline,
  cloneSelectionMask,
  copySelection,
  createSelectionMask,
  cutSelection,
  flipSelectionContent,
  getSelectionBounds,
  hasAnySelectedPixel,
  invertSelectionMask,
  mergeSelectionMasks,
  moveSelectionContent,
  pasteClipboard,
  selectEllipseMask,
  selectRectangleMask,
  selectSameColor,
} from '../engine/selection'
import {
  compositeLayers,
  MAX_LAYERS,
  mergeTwoLayers,
} from '../engine/compositor'
import {
  captureCanvasSnapshot,
  createLayerPixelPatch,
  HistoryManager,
} from '../engine/history'
import { clampCanvasPoint } from '../utils/coordinates'
import { playUiTick } from '../utils/sound'

export type MultiStepPhase =
  | { kind: 'idle' }
  | { kind: 'gradient-end'; start: Point }
  | { kind: 'line-end'; start: Point }
  | { kind: 'bezier-p3'; p0: Point }
  | { kind: 'bezier-p1'; p0: Point; p3: Point }
  | { kind: 'bezier-p2'; p0: Point; p3: Point; p1: Point }
  | { kind: 'shape-end'; start: Point }
  | { kind: 'select-end'; start: Point }

export const ALL_BLEND_MODES: ReadonlyArray<BlendMode> = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'add',
  'difference',
]

const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  penSize: 1,
  penShape: 'square',
  penDither: 1,
  pixelPerfect: true,

  eraserSize: 1,
  eraserShape: 'square',

  fillConnectivity: 4,
  fillDither: 1,
  fillMode: 'normal',
  gradientSteps: 4,

  lineType: 'line',
  lineSize: 1,
  lineShape: 'square',
  lineDither: 1,
  linePixelPerfect: false,

  shapeType: 'rect',
  shapeFilled: false,
  shapeFixedRatio: false,
  shapeSize: 1,
  shapeDither: 1,

  selectType: 'rect',
  selectConnectivity: 4,
  outlineMode: 'pixelPerfect',
  outlineSize: 1,
  outlineColor: '#000000',
}

/**
 * Clamp arbitrary integer coordinates within generous world bounds (`[-2048 .. 2304]`)
 * so out-of-canvas line/bezier/shape/gradient endpoints preserve exact slope & curvature (Section 12).
 */
function normalizeWorldPoint(pt: Point): Point {
  return {
    x: Math.max(-2048, Math.min(2304, Math.round(pt.x))),
    y: Math.max(-2048, Math.min(2304, Math.round(pt.y))),
  }
}

export interface UseEditorOptions {
  projectId: string | null
  historyLimit: number | 'unlimited'
  soundEnabled: boolean
  onSaved?: () => void
  onQuotaTrimmed?: () => void
  onSaveError?: () => void
  onColorPicked?: (isTransparent: boolean) => void
}

export function useEditorController(options: UseEditorOptions) {
  const {
    projectId,
    historyLimit,
    soundEnabled,
    onSaved,
    onQuotaTrimmed,
    onSaveError,
    onColorPicked,
  } = options

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [layers, setLayers] = useState<LayerRuntime[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string>('')
  /** Section 8: Multi-layer checkbox selection IDs (independent of `activeLayerId`) */
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([])

  const [palette, setPalette] = useState<ProjectPalette>({
    name: 'Standard',
    colors: ['#000000', '#FFFFFF'],
  })
  const [selectedColorIndex, setSelectedColorIndex] = useState<number>(0)

  const [tool, setTool] = useState<ToolId>('pen')
  /** Remember previous drawing tool before manual eyedropper selection so picking returns to it */
  const prevToolBeforeEyedropperRef = useRef<ToolId>('pen')
  const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS)
  /** Track whether the user has explicitly picked an outline palette color yet */
  const outlineColorExplicitRef = useRef<boolean>(false)

  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const [stepPhase, setStepPhase] = useState<MultiStepPhase>({ kind: 'idle' })
  const [floatingShape, setFloatingShape] = useState<FloatingShapeState | null>(null)
  const [moveSession, setMoveSession] = useState<ActiveMoveSession | null>(null)
  const [selectionMask, setSelectionMask] = useState<Uint8Array | null>(null)
  const [clipboard, setClipboard] = useState<ClipboardBuffer | null>(null)

  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)

  const [isContinuousDrawing, setIsContinuousDrawing] = useState(false)
  const strokeRef = useRef<{
    active: boolean
    tool: 'pen' | 'eraser'
    layerId: string
    baseCanvasView: Uint8ClampedArray
    rawPoints: Point[]
    latestPreview: Uint8ClampedArray
  } | null>(null)

  const [liveStrokeBuffer, setLiveStrokeBuffer] = useState<{
    layerId: string
    data: Uint8ClampedArray
  } | null>(null)

  const historyRef = useRef<HistoryManager>(new HistoryManager(historyLimit))
  const saveTimerRef = useRef<number | null>(null)

  useEffect(() => {
    historyRef.current.setLimit(historyLimit)
    setUndoCount(historyRef.current.getUndoCount())
    setRedoCount(historyRef.current.getRedoCount())
  }, [historyLimit])

  // Load project from IndexedDB
  useEffect(() => {
    let cancelled = false
    if (!projectId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void (async () => {
      const loaded = await loadProjectFull(projectId, db)
      if (cancelled) return
      if (!loaded) {
        setLoading(false)
        return
      }
      const loadedColors =
        loaded.project.palette.colors.length > 0
          ? [...loaded.project.palette.colors]
          : ['#000000', '#FFFFFF']
      const initialColorIdx =
        loaded.project.selectedColorIndex === TRANSPARENT_COLOR_INDEX
          ? TRANSPARENT_COLOR_INDEX
          : Math.min(
              Math.max(0, loaded.project.selectedColorIndex),
              Math.max(0, loadedColors.length - 1)
            )
      const initialOpaqueHex =
        initialColorIdx >= 0 && loadedColors[initialColorIdx]
          ? loadedColors[initialColorIdx]
          : loadedColors[0]

      setProject(loaded.project)
      setLayers(loaded.layers)
      setActiveLayerId(loaded.project.activeLayerId || loaded.layers[0]?.id || '')
      setSelectedLayerIds([])
      setPalette({
        name: loaded.project.palette.name,
        colors: loadedColors,
        sourcePaletteId: loaded.project.palette.sourcePaletteId,
      })
      setSelectedColorIndex(initialColorIdx)
      outlineColorExplicitRef.current = false
      setToolSettings((prev) => ({
        ...prev,
        outlineColor: initialOpaqueHex,
      }))
      setCursor({
        x: Math.floor(loaded.project.width / 2),
        y: Math.floor(loaded.project.height / 2),
      })
      setStepPhase({ kind: 'idle' })
      setFloatingShape(null)
      setMoveSession(null)
      setSelectionMask(null)
      strokeRef.current = null
      setLiveStrokeBuffer(null)

      const mgr = new HistoryManager(historyLimit)
      mgr.hydrate(loaded.history)
      historyRef.current = mgr
      setUndoCount(mgr.getUndoCount())
      setRedoCount(mgr.getRedoCount())
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [projectId])

  // Keep selectedLayerIds pruned to existing layer IDs
  useEffect(() => {
    setSelectedLayerIds((prev) => {
      if (prev.length === 0) return prev
      const validSet = new Set(layers.map((l) => l.id))
      const filtered = prev.filter((id) => validSet.has(id))
      return filtered.length === prev.length ? prev : filtered
    })
  }, [layers])

  const isTransparentColorSelected = selectedColorIndex === TRANSPARENT_COLOR_INDEX

  const activeHexColor = useMemo(() => {
    if (selectedColorIndex === TRANSPARENT_COLOR_INDEX) {
      return palette.colors[0] ?? '#000000'
    }
    return palette.colors[selectedColorIndex] ?? palette.colors[0] ?? '#000000'
  }, [palette.colors, selectedColorIndex])

  /**
   * Section 1: When Transparent Slot (`TRANSPARENT_COLOR_INDEX`) is selected,
   * `activeRgba` has `a: 0` so Pen, Fill, Gradient, Line, Bezier, Shape, and Dithered tools all clear `#` mask pixels to transparent!
   */
  const activeRgba = useMemo((): RGBA => {
    if (selectedColorIndex === TRANSPARENT_COLOR_INDEX) {
      return { r: 0, g: 0, b: 0, a: 0 }
    }
    return hexToRgba(activeHexColor, 255)
  }, [selectedColorIndex, activeHexColor])

  /**
   * Section 3: Selection Outline Color Restriction
   * - Outline color MUST always be a valid opaque color inside `palette.colors` (Transparent Slot is excluded).
   * - Defaults to the current drawing color (or `palette.colors[0]` if Transparent is selected).
   * - Automatically heals if the palette is switched or a color is deleted!
   */
  useEffect(() => {
    if (palette.colors.length === 0) return
    const fallbackColor =
      selectedColorIndex >= 0 && palette.colors[selectedColorIndex]
        ? palette.colors[selectedColorIndex]
        : palette.colors[0]

    setToolSettings((prev) => {
      if (!outlineColorExplicitRef.current) {
        if (prev.outlineColor.toUpperCase() === fallbackColor.toUpperCase()) return prev
        return { ...prev, outlineColor: fallbackColor }
      }
      const existsInPalette = palette.colors.some(
        (c) => c.toUpperCase() === prev.outlineColor.toUpperCase()
      )
      if (existsInPalette) return prev
      return { ...prev, outlineColor: fallbackColor }
    })
  }, [palette.colors, selectedColorIndex])

  const updateToolSettings = useCallback((patch: Partial<ToolSettings>) => {
    if (patch.outlineColor !== undefined) {
      outlineColorExplicitRef.current = true
    }
    setToolSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const activeLayer = useMemo(
    () => layers.find((l) => l.id === activeLayerId) ?? layers[0] ?? null,
    [layers, activeLayerId]
  )

  const activeLayerCanvasView = useMemo(() => {
    if (!project || !activeLayer) return null
    return extractLayerCanvasView(activeLayer, project.width, project.height)
  }, [project, activeLayer])

  const syncHistoryCounts = useCallback(() => {
    setUndoCount(historyRef.current.getUndoCount())
    setRedoCount(historyRef.current.getRedoCount())
  }, [])

  const persistCommittedState = useCallback(
    (
      nextProj: ProjectRecord,
      nextLayers: readonly LayerRuntime[],
      nextPalette: ProjectPalette,
      nextSelectedColorIdx: number,
      nextActiveLayerId: string
    ) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
      setSaving(true)
      saveTimerRef.current = window.setTimeout(async () => {
        saveTimerRef.current = null
        try {
          const projToSave: ProjectRecord = {
            ...nextProj,
            activeLayerId: nextActiveLayerId,
            palette: {
              name: nextPalette.name,
              colors: [...nextPalette.colors],
              sourcePaletteId: nextPalette.sourcePaletteId,
            },
            selectedColorIndex: nextSelectedColorIdx,
          }
          const res = await saveProjectFull(
            {
              project: projToSave,
              layers: nextLayers,
              history: historyRef.current.serialize(),
            },
            db
          )
          setProject(projToSave)
          setSaving(false)
          if (res.quotaTrimmed) {
            onQuotaTrimmed?.()
          }
          onSaved?.()
        } catch {
          setSaving(false)
          onSaveError?.()
        }
      }, 120)
    },
    [onQuotaTrimmed, onSaveError, onSaved]
  )

  const effectiveSelectionMask = useMemo(
    () => (hasAnySelectedPixel(selectionMask) ? selectionMask : null),
    [selectionMask]
  )

  const displaySelectionMask = useMemo((): Uint8Array | null => {
    if (!project) return effectiveSelectionMask
    if (moveSession && moveSession.mode === 'selection' && moveSession.initialMask) {
      const w = project.width
      const h = project.height
      const shifted = createSelectionMask(w, h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (moveSession.initialMask[y * w + x] === 0) continue
          const nx = x + moveSession.dx
          const ny = y + moveSession.dy
          if (isInBounds(nx, ny, w, h)) {
            shifted[ny * w + nx] = 1
          }
        }
      }
      return shifted
    }
    return effectiveSelectionMask
  }, [project, effectiveSelectionMask, moveSession])

  const commitUpdatedLayer = useCallback(
    (
      beforeLayer: LayerRuntime,
      afterLayer: LayerRuntime,
      label: string,
      selectionTransition?: {
        before: Uint8Array | null
        after: Uint8Array | null
      }
    ) => {
      if (!project) return
      const patch = createLayerPixelPatch(beforeLayer, afterLayer)
      if (!patch && !selectionTransition) return

      historyRef.current.push({
        id: generateId('hist'),
        label,
        timestamp: Date.now(),
        kind: patch ? 'pixel-diff' : 'selection',
        pixelPatches: patch ? [patch] : undefined,
        beforeSelection: selectionTransition?.before,
        afterSelection: selectionTransition?.after,
      })
      syncHistoryCounts()

      const nextLayers = layers.map((l) => (l.id === beforeLayer.id ? afterLayer : l))
      setLayers(nextLayers)
      if (selectionTransition) {
        setSelectionMask(selectionTransition.after)
      }
      persistCommittedState(
        project,
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId
      )
    },
    [
      project,
      layers,
      palette,
      selectedColorIndex,
      activeLayerId,
      syncHistoryCounts,
      persistCommittedState,
    ]
  )

  const commitLayerCanvasViewChange = useCallback(
    (
      layerId: string,
      afterCanvasView: Uint8ClampedArray,
      label: string,
      selectionTransition?: {
        before: Uint8Array | null
        after: Uint8Array | null
      }
    ) => {
      if (!project) return
      const target = layers.find((l) => l.id === layerId)
      if (!target) return
      const afterLayer = writeLayerCanvasView(
        target,
        afterCanvasView,
        project.width,
        project.height
      )
      commitUpdatedLayer(target, afterLayer, label, selectionTransition)
    },
    [project, layers, commitUpdatedLayer]
  )

  /**
   * Commit floating shape onto active layer.
   * Note: If Transparent Color is selected, `floatingShape` stores a mask (`a = 255, r=g=b=0`) with a dedicated erase flag
   * or we apply `compositeFloatingShapeOntoLayer` directly; for transparent shapes we commit directly on placement!
   */
  const commitFloatingShape = useCallback(() => {
    if (!floatingShape || !project || !activeLayer || !activeLayerCanvasView) return
    const afterView = compositeFloatingShapeOntoLayer(
      activeLayerCanvasView,
      project.width,
      project.height,
      floatingShape,
      effectiveSelectionMask
    )
    setFloatingShape(null)
    playUiTick('draw', soundEnabled)
    commitLayerCanvasViewChange(activeLayer.id, afterView, 'Shape')
  }, [
    floatingShape,
    project,
    activeLayer,
    activeLayerCanvasView,
    effectiveSelectionMask,
    soundEnabled,
    commitLayerCanvasViewChange,
  ])

  const discardFloatingShape = useCallback(() => {
    setFloatingShape(null)
  }, [])

  /**
   * Start interactive Selection Move mode (Section 7)
   */
  const startSelectionMove = useCallback((): boolean => {
    if (!project || !activeLayer || !activeLayerCanvasView || !effectiveSelectionMask) {
      return false
    }
    const bounds = getSelectionBounds(effectiveSelectionMask, project.width, project.height)
    if (!bounds) return false

    const extracted = createPixelBuffer(bounds.width, bounds.height)
    const clearedView = new Uint8ClampedArray(activeLayerCanvasView)

    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        const idx = y * project.width + x
        if (effectiveSelectionMask[idx] === 0) continue
        const sb = idx * 4
        const dbOff = ((y - bounds.minY) * bounds.width + (x - bounds.minX)) * 4
        extracted[dbOff] = activeLayerCanvasView[sb]
        extracted[dbOff + 1] = activeLayerCanvasView[sb + 1]
        extracted[dbOff + 2] = activeLayerCanvasView[sb + 2]
        extracted[dbOff + 3] = activeLayerCanvasView[sb + 3]

        clearedView[sb] = 0
        clearedView[sb + 1] = 0
        clearedView[sb + 2] = 0
        clearedView[sb + 3] = 0
      }
    }

    const clearedLayer = writeLayerCanvasView(
      activeLayer,
      clearedView,
      project.width,
      project.height
    )

    setStepPhase({ kind: 'idle' })
    setFloatingShape(null)
    setMoveSession({
      mode: 'selection',
      layerId: activeLayer.id,
      layerIds: [activeLayer.id],
      initialLayerOffsets: {
        [activeLayer.id]: {
          offsetX: activeLayer.offsetX,
          offsetY: activeLayer.offsetY,
        },
      },
      dx: 0,
      dy: 0,
      initialMask: cloneSelectionMask(effectiveSelectionMask),
      clearedLayer,
      extractedBuffer: extracted,
      extractedWidth: bounds.width,
      extractedHeight: bounds.height,
      extractedOriginX: bounds.minX,
      extractedOriginY: bounds.minY,
      initialLayerOffsetX: activeLayer.offsetX,
      initialLayerOffsetY: activeLayer.offsetY,
    })
    playUiTick('step', soundEnabled)
    return true
  }, [project, activeLayer, activeLayerCanvasView, effectiveSelectionMask, soundEnabled])

  /**
   * Start interactive Single-Layer Move on canvas
   */
  const startLayerMove = useCallback(
    (targetLayerId?: string): boolean => {
      if (!project) return false
      const target =
        layers.find((l) => l.id === (targetLayerId ?? activeLayerId)) ?? activeLayer
      if (!target) return false
      if (target.id !== activeLayerId) {
        setActiveLayerId(target.id)
      }
      setStepPhase({ kind: 'idle' })
      setFloatingShape(null)
      setMoveSession({
        mode: 'layer',
        layerId: target.id,
        layerIds: [target.id],
        initialLayerOffsets: {
          [target.id]: {
            offsetX: target.offsetX,
            offsetY: target.offsetY,
          },
        },
        dx: 0,
        dy: 0,
        initialMask: null,
        clearedLayer: null,
        extractedBuffer: null,
        extractedWidth: target.dataWidth,
        extractedHeight: target.dataHeight,
        extractedOriginX: target.offsetX,
        extractedOriginY: target.offsetY,
        initialLayerOffsetX: target.offsetX,
        initialLayerOffsetY: target.offsetY,
      })
      playUiTick('step', soundEnabled)
      return true
    },
    [project, layers, activeLayerId, activeLayer, soundEnabled]
  )

  /**
   * Section 8-3: Start interactive Multi-Layer Batch Move on canvas!
   * Moves all checked layers by the exact same `(dx, dy)` while preserving their relative offsets and off-canvas pixels.
   */
  const startMultiLayerMove = useCallback(
    (targetIds?: string[]): boolean => {
      if (!project) return false
      const idsToMove = (targetIds ?? selectedLayerIds).filter((id) =>
        layers.some((l) => l.id === id)
      )
      if (idsToMove.length === 0) return false
      if (idsToMove.length === 1) {
        return startLayerMove(idsToMove[0])
      }

      const movingLayers = layers.filter((l) => idsToMove.includes(l.id))
      const initialOffsets: Record<string, { offsetX: number; offsetY: number }> = {}
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      for (const l of movingLayers) {
        initialOffsets[l.id] = { offsetX: l.offsetX, offsetY: l.offsetY }
        minX = Math.min(minX, l.offsetX)
        minY = Math.min(minY, l.offsetY)
        maxX = Math.max(maxX, l.offsetX + l.dataWidth)
        maxY = Math.max(maxY, l.offsetY + l.dataHeight)
      }

      setStepPhase({ kind: 'idle' })
      setFloatingShape(null)
      setMoveSession({
        mode: 'multi-layer',
        layerId: movingLayers[0].id,
        layerIds: idsToMove,
        initialLayerOffsets: initialOffsets,
        dx: 0,
        dy: 0,
        initialMask: null,
        clearedLayer: null,
        extractedBuffer: null,
        extractedWidth: Math.max(1, maxX - minX),
        extractedHeight: Math.max(1, maxY - minY),
        extractedOriginX: minX,
        extractedOriginY: minY,
        initialLayerOffsetX: minX,
        initialLayerOffsetY: minY,
      })
      playUiTick('step', soundEnabled)
      return true
    },
    [project, selectedLayerIds, layers, startLayerMove, soundEnabled]
  )

  const updateActiveMoveOffset = useCallback((deltaX: number, deltaY: number) => {
    const sx = Math.trunc(deltaX)
    const sy = Math.trunc(deltaY)
    if (sx === 0 && sy === 0) return
    setMoveSession((prev) =>
      prev ? { ...prev, dx: prev.dx + sx, dy: prev.dy + sy } : null
    )
  }, [])

  const cancelActiveMove = useCallback(() => {
    setMoveSession(null)
  }, [])

  const commitActiveMove = useCallback(() => {
    if (!moveSession || !project) return
    if (moveSession.dx === 0 && moveSession.dy === 0) {
      setMoveSession(null)
      return
    }

    if (moveSession.mode === 'layer' || moveSession.mode === 'multi-layer') {
      const targetSet = new Set(moveSession.layerIds)
      const offsetTransitions: LayerOffsetTransition[] = []

      const nextLayers = layers.map((l) => {
        if (!targetSet.has(l.id)) return l
        const init = moveSession.initialLayerOffsets[l.id] ?? {
          offsetX: l.offsetX,
          offsetY: l.offsetY,
        }
        const afterOx = init.offsetX + moveSession.dx
        const afterOy = init.offsetY + moveSession.dy
        offsetTransitions.push({
          layerId: l.id,
          beforeOffsetX: init.offsetX,
          beforeOffsetY: init.offsetY,
          afterOffsetX: afterOx,
          afterOffsetY: afterOy,
        })
        return { ...l, offsetX: afterOx, offsetY: afterOy }
      })

      if (offsetTransitions.length === 0) {
        setMoveSession(null)
        return
      }

      historyRef.current.push({
        id: generateId('hist'),
        label:
          offsetTransitions.length > 1 ? 'Move Selected Layers' : 'Move Layer',
        timestamp: Date.now(),
        kind: 'layer-offset',
        layerOffsetChange: offsetTransitions[0],
        layerOffsetChanges: offsetTransitions,
      })
      syncHistoryCounts()

      setMoveSession(null)
      setLayers(nextLayers)
      playUiTick('draw', soundEnabled)
      persistCommittedState(
        project,
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId
      )
      return
    }

    const target = layers.find((l) => l.id === moveSession.layerId)
    if (!target) {
      setMoveSession(null)
      return
    }

    if (
      moveSession.mode === 'selection' &&
      moveSession.clearedLayer &&
      moveSession.extractedBuffer &&
      moveSession.initialMask
    ) {
      const afterLayer = stampBufferIntoLayerWorld(
        moveSession.clearedLayer,
        moveSession.extractedBuffer,
        moveSession.extractedWidth,
        moveSession.extractedHeight,
        moveSession.extractedOriginX + moveSession.dx,
        moveSession.extractedOriginY + moveSession.dy
      )

      const w = project.width
      const h = project.height
      const nextMask = createSelectionMask(w, h)
      let anyVisible = false
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (moveSession.initialMask[y * w + x] === 0) continue
          const nx = x + moveSession.dx
          const ny = y + moveSession.dy
          if (isInBounds(nx, ny, w, h)) {
            nextMask[ny * w + nx] = 1
            anyVisible = true
          }
        }
      }

      setMoveSession(null)
      playUiTick('draw', soundEnabled)
      commitUpdatedLayer(target, afterLayer, 'Move Selection', {
        before: moveSession.initialMask,
        after: anyVisible ? nextMask : null,
      })
    }
  }, [
    moveSession,
    project,
    layers,
    syncHistoryCounts,
    soundEnabled,
    persistCommittedState,
    palette,
    selectedColorIndex,
    activeLayerId,
    commitUpdatedLayer,
  ])

  /**
   * Compute live preview layer override for single-layer tools & selection move.
   */
  const previewLayerOverride = useMemo((): {
    layerId: string
    data: Uint8ClampedArray
  } | null => {
    if (!project || !activeLayer || !activeLayerCanvasView) return null
    const w = project.width
    const h = project.height

    if (moveSession) {
      if (moveSession.mode === 'layer') {
        const movingLayer =
          layers.find((l) => l.id === moveSession.layerId) ?? activeLayer
        const previewShifted: LayerRuntime = {
          ...movingLayer,
          offsetX: moveSession.initialLayerOffsetX + moveSession.dx,
          offsetY: moveSession.initialLayerOffsetY + moveSession.dy,
        }
        return {
          layerId: movingLayer.id,
          data: extractLayerCanvasView(previewShifted, w, h),
        }
      }
      if (
        moveSession.mode === 'selection' &&
        moveSession.clearedLayer &&
        moveSession.extractedBuffer
      ) {
        const stamped = stampBufferIntoLayerWorld(
          moveSession.clearedLayer,
          moveSession.extractedBuffer,
          moveSession.extractedWidth,
          moveSession.extractedHeight,
          moveSession.extractedOriginX + moveSession.dx,
          moveSession.extractedOriginY + moveSession.dy
        )
        return {
          layerId: moveSession.layerId,
          data: extractLayerCanvasView(stamped, w, h),
        }
      }
      // Note: 'multi-layer' preview shifts multiple layers simultaneously inside `compositedBuffer` below!
      return null
    }

    if (liveStrokeBuffer) {
      return liveStrokeBuffer
    }

    if (floatingShape) {
      return {
        layerId: activeLayer.id,
        data: compositeFloatingShapeOntoLayer(
          activeLayerCanvasView,
          w,
          h,
          floatingShape,
          effectiveSelectionMask
        ),
      }
    }

    if (stepPhase.kind === 'gradient-end') {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      applyGradientFloodFill(buf, {
        width: w,
        height: h,
        startX: stepPhase.start.x,
        startY: stepPhase.start.y,
        endX: cursor.x,
        endY: cursor.y,
        color: activeRgba,
        steps: toolSettings.gradientSteps,
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'line-end') {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      drawLine(buf, stepPhase.start, cursor, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        pixelPerfect: toolSettings.linePixelPerfect,
        color: activeRgba,
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'bezier-p3') {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      drawLine(buf, stepPhase.p0, cursor, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        pixelPerfect: toolSettings.linePixelPerfect,
        color: activeRgba,
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'bezier-p1') {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      drawCubicBezier(buf, stepPhase.p0, cursor, stepPhase.p3, stepPhase.p3, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        color: activeRgba,
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'bezier-p2') {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      drawCubicBezier(buf, stepPhase.p0, stepPhase.p1, cursor, stepPhase.p3, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        color: activeRgba,
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'shape-end') {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      const bounds = computeShapeBounds(
        stepPhase.start,
        cursor,
        toolSettings.shapeFixedRatio
      )
      const shapeOpts = {
        width: w,
        height: h,
        filled: toolSettings.shapeFilled,
        strokeSize: toolSettings.shapeSize,
        dither: toolSettings.shapeDither,
        color: activeRgba,
        selectionMask: effectiveSelectionMask,
      }
      if (toolSettings.shapeType === 'rect') {
        rasterizeRectangle(buf, bounds, shapeOpts)
      } else {
        rasterizeEllipse(buf, bounds, shapeOpts)
      }
      return { layerId: activeLayer.id, data: buf }
    }

    // Section 2: Hover brush footprint preview for Pen, Eraser, AND Line/Bezier when idle!
    if (stepPhase.kind === 'idle' && (tool === 'pen' || tool === 'eraser' || tool === 'line')) {
      const buf = new Uint8ClampedArray(activeLayerCanvasView)
      const brushSize =
        tool === 'pen'
          ? toolSettings.penSize
          : tool === 'eraser'
            ? toolSettings.eraserSize
            : toolSettings.lineSize
      const brushShape =
        tool === 'pen'
          ? toolSettings.penShape
          : tool === 'eraser'
            ? toolSettings.eraserShape
            : toolSettings.lineShape
      const brushDither =
        tool === 'pen'
          ? toolSettings.penDither
          : tool === 'line'
            ? toolSettings.lineDither
            : 1

      stampPoints(buf, [cursor], {
        width: w,
        height: h,
        size: brushSize,
        shape: brushShape,
        color: activeRgba,
        dither: brushDither,
        erase: tool === 'eraser',
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    return null
  }, [
    project,
    activeLayer,
    activeLayerCanvasView,
    moveSession,
    layers,
    liveStrokeBuffer,
    floatingShape,
    effectiveSelectionMask,
    stepPhase,
    cursor,
    activeRgba,
    toolSettings,
    tool,
  ])

  const compositedBuffer = useMemo(() => {
    if (!project || layers.length === 0) return null
    if (moveSession && moveSession.mode === 'multi-layer') {
      const movingSet = new Set(moveSession.layerIds)
      const previewLayers = layers.map((l) => {
        if (!movingSet.has(l.id)) return l
        const init = moveSession.initialLayerOffsets[l.id] ?? {
          offsetX: l.offsetX,
          offsetY: l.offsetY,
        }
        return {
          ...l,
          offsetX: init.offsetX + moveSession.dx,
          offsetY: init.offsetY + moveSession.dy,
        }
      })
      return compositeLayers(previewLayers, project.width, project.height)
    }
    return compositeLayers(layers, project.width, project.height, {
      previewLayerOverride,
    })
  }, [project, layers, moveSession, previewLayerOverride])

  const selectTool = useCallback(
    (nextTool: ToolId) => {
      if (moveSession) {
        commitActiveMove()
      }
      if (floatingShape) {
        commitFloatingShape()
      }
      setStepPhase({ kind: 'idle' })
      if (nextTool === 'eyedropper' && tool !== 'eyedropper') {
        prevToolBeforeEyedropperRef.current = tool
      }
      setTool(nextTool)
    },
    [moveSession, commitActiveMove, floatingShape, commitFloatingShape, tool]
  )

  const cancelMultiStep = useCallback(() => {
    setStepPhase({ kind: 'idle' })
    if (floatingShape) {
      setFloatingShape(null)
    }
    if (moveSession) {
      setMoveSession(null)
    }
  }, [floatingShape, moveSession])

  const recomputeContinuousStroke = useCallback(
    (
      rawPoints: readonly Point[],
      baseCanvasView: Uint8ClampedArray,
      mode: 'pen' | 'eraser'
    ) => {
      if (!project) return baseCanvasView
      const nextBuf = new Uint8ClampedArray(baseCanvasView)
      const pts =
        mode === 'pen' && toolSettings.pixelPerfect
          ? filterPixelPerfectPoints(rawPoints)
          : expandStrokePoints(rawPoints)

      stampPoints(nextBuf, pts, {
        width: project.width,
        height: project.height,
        size: mode === 'pen' ? toolSettings.penSize : toolSettings.eraserSize,
        shape: mode === 'pen' ? toolSettings.penShape : toolSettings.eraserShape,
        color: activeRgba,
        dither: mode === 'pen' ? toolSettings.penDither : 1,
        erase: mode === 'eraser',
        selectionMask: effectiveSelectionMask,
      })
      return nextBuf
    },
    [project, toolSettings, activeRgba, effectiveSelectionMask]
  )

  /**
   * Section 12: Allow cursor / endpoint coordinates outside `[0..width-1, 0..height-1]`
   * when `allowOutOfBounds` is true (Line, Bezier, Shape, Select area, Gradient Fill)!
   */
  const moveCursorTo = useCallback(
    (pt: Point, allowOutOfBounds = false) => {
      if (!project) return
      const nextPt = allowOutOfBounds
        ? normalizeWorldPoint(pt)
        : clampCanvasPoint(pt, project.width, project.height)

      setCursor((prev) =>
        prev.x === nextPt.x && prev.y === nextPt.y ? prev : nextPt
      )

      const st = strokeRef.current
      if (st && st.active) {
        const clamped = clampCanvasPoint(pt, project.width, project.height)
        const last = st.rawPoints[st.rawPoints.length - 1]
        if (!last || last.x !== clamped.x || last.y !== clamped.y) {
          st.rawPoints.push(clamped)
          const updated = recomputeContinuousStroke(
            st.rawPoints,
            st.baseCanvasView,
            st.tool
          )
          st.latestPreview = updated
          setLiveStrokeBuffer({ layerId: st.layerId, data: updated })
        }
      }
    },
    [project, recomputeContinuousStroke]
  )

  /**
   * Section 1 & Section 9: Shared Eyedropper Color Picker
   * - Does NOT modify any pixel or layer data.
   * - If the sampled pixel is transparent (`a === 0`), selects the dedicated Transparent Slot (`TRANSPARENT_COLOR_INDEX = -1`).
   * - If opaque, selects matching color in `palette.colors` or adds to palette (if `< 256` colors).
   * - When invoked via double-tap (`restoreCurrentTool = true`), keeps the current tool active!
   */
  const pickColorAtCanvasPoint = useCallback(
    (pt: Point, options?: { restorePreviousTool?: boolean }): boolean => {
      if (!project) return false
      const w = project.width
      const h = project.height
      if (!isInBounds(pt.x, pt.y, w, h)) return false

      const comp = compositeLayers(layers, w, h)
      const picked = getPixel(comp, w, h, pt.x, pt.y)

      if (picked.a === 0) {
        setSelectedColorIndex(TRANSPARENT_COLOR_INDEX)
        playUiTick('step', soundEnabled)
        onColorPicked?.(true)
      } else {
        const hex = rgbaToHex(picked)
        const idx = palette.colors.findIndex(
          (c) => c.toUpperCase() === hex.toUpperCase()
        )
        if (idx >= 0) {
          setSelectedColorIndex(idx)
        } else if (palette.colors.length < 256) {
          const nextColors = [...palette.colors, hex]
          const nextPal = { ...palette, colors: nextColors }
          setPalette(nextPal)
          setSelectedColorIndex(nextColors.length - 1)
          persistCommittedState(
            project,
            layers,
            nextPal,
            nextColors.length - 1,
            activeLayerId
          )
        } else {
          const replaceIdx = selectedColorIndex >= 0 ? selectedColorIndex : 0
          const nextColors = [...palette.colors]
          nextColors[replaceIdx] = hex
          const nextPal = { ...palette, colors: nextColors }
          setPalette(nextPal)
          setSelectedColorIndex(replaceIdx)
          persistCommittedState(
            project,
            layers,
            nextPal,
            replaceIdx,
            activeLayerId
          )
        }
        playUiTick('step', soundEnabled)
        onColorPicked?.(false)
      }

      if (options?.restorePreviousTool) {
        const prev = prevToolBeforeEyedropperRef.current
        setTool(prev === 'eyedropper' ? 'pen' : prev)
      }
      return true
    },
    [
      project,
      layers,
      soundEnabled,
      onColorPicked,
      palette,
      persistCommittedState,
      activeLayerId,
      selectedColorIndex,
    ]
  )

  const beginDrawAction = useCallback(
    (targetPoint?: Point, allowOutOfBounds = false) => {
      if (!project || !activeLayer || !activeLayerCanvasView) return
      if (moveSession) {
        commitActiveMove()
        return
      }
      if (floatingShape) {
        commitFloatingShape()
        return
      }

      const supportsOutOfCanvasEndpoint =
        tool === 'line' ||
        tool === 'shape' ||
        (tool === 'fill' && toolSettings.fillMode === 'gradient' && stepPhase.kind === 'gradient-end') ||
        (tool === 'select' && toolSettings.selectType !== 'wand')

      const pt = targetPoint
        ? allowOutOfBounds || supportsOutOfCanvasEndpoint
          ? normalizeWorldPoint(targetPoint)
          : clampCanvasPoint(targetPoint, project.width, project.height)
        : supportsOutOfCanvasEndpoint
          ? normalizeWorldPoint(cursor)
          : clampCanvasPoint(cursor, project.width, project.height)

      if (targetPoint) {
        setCursor(pt)
      }

      const w = project.width
      const h = project.height

      if (tool === 'pen' || tool === 'eraser') {
        if (!activeLayer.visible) return
        const clampedPt = clampCanvasPoint(pt, w, h)
        const baseCopy = new Uint8ClampedArray(activeLayerCanvasView)
        const initialPreview = recomputeContinuousStroke([clampedPt], baseCopy, tool)
        strokeRef.current = {
          active: true,
          tool,
          layerId: activeLayer.id,
          baseCanvasView: baseCopy,
          rawPoints: [clampedPt],
          latestPreview: initialPreview,
        }
        setIsContinuousDrawing(true)
        setLiveStrokeBuffer({ layerId: activeLayer.id, data: initialPreview })
        playUiTick('draw', soundEnabled)
        return
      }

      if (tool === 'eyedropper') {
        const clampedPt = clampCanvasPoint(pt, w, h)
        pickColorAtCanvasPoint(clampedPt, { restorePreviousTool: true })
        return
      }

      if (tool === 'fill') {
        if (!activeLayer.visible) return
        if (toolSettings.fillMode === 'normal') {
          const clampedPt = clampCanvasPoint(pt, w, h)
          const after = new Uint8ClampedArray(activeLayerCanvasView)
          applyFloodFill(after, {
            width: w,
            height: h,
            seedX: clampedPt.x,
            seedY: clampedPt.y,
            color: activeRgba,
            connectivity: toolSettings.fillConnectivity,
            dither: toolSettings.fillDither,
            selectionMask: effectiveSelectionMask,
          })
          playUiTick('draw', soundEnabled)
          commitLayerCanvasViewChange(activeLayer.id, after, 'Fill')
        } else {
          if (stepPhase.kind !== 'gradient-end') {
            const clampedStart = clampCanvasPoint(pt, w, h)
            setStepPhase({ kind: 'gradient-end', start: clampedStart })
            playUiTick('step', soundEnabled)
          } else {
            const after = new Uint8ClampedArray(activeLayerCanvasView)
            applyGradientFloodFill(after, {
              width: w,
              height: h,
              startX: stepPhase.start.x,
              startY: stepPhase.start.y,
              endX: pt.x,
              endY: pt.y,
              color: activeRgba,
              steps: toolSettings.gradientSteps,
              selectionMask: effectiveSelectionMask,
            })
            setStepPhase({ kind: 'idle' })
            playUiTick('draw', soundEnabled)
            commitLayerCanvasViewChange(activeLayer.id, after, 'Gradient Fill')
          }
        }
        return
      }

      if (tool === 'line') {
        if (!activeLayer.visible) return
        if (toolSettings.lineType === 'line') {
          if (stepPhase.kind !== 'line-end') {
            setStepPhase({ kind: 'line-end', start: pt })
            playUiTick('step', soundEnabled)
          } else {
            const after = new Uint8ClampedArray(activeLayerCanvasView)
            drawLine(after, stepPhase.start, pt, {
              width: w,
              height: h,
              size: toolSettings.lineSize,
              shape: toolSettings.lineShape,
              dither: toolSettings.lineDither,
              pixelPerfect: toolSettings.linePixelPerfect,
              color: activeRgba,
              selectionMask: effectiveSelectionMask,
            })
            setStepPhase({ kind: 'idle' })
            playUiTick('draw', soundEnabled)
            commitLayerCanvasViewChange(activeLayer.id, after, 'Line')
          }
        } else {
          if (stepPhase.kind === 'idle') {
            setStepPhase({ kind: 'bezier-p3', p0: pt })
            playUiTick('step', soundEnabled)
          } else if (stepPhase.kind === 'bezier-p3') {
            setStepPhase({ kind: 'bezier-p1', p0: stepPhase.p0, p3: pt })
            playUiTick('step', soundEnabled)
          } else if (stepPhase.kind === 'bezier-p1') {
            setStepPhase({
              kind: 'bezier-p2',
              p0: stepPhase.p0,
              p3: stepPhase.p3,
              p1: pt,
            })
            playUiTick('step', soundEnabled)
          } else if (stepPhase.kind === 'bezier-p2') {
            const after = new Uint8ClampedArray(activeLayerCanvasView)
            drawCubicBezier(after, stepPhase.p0, stepPhase.p1, pt, stepPhase.p3, {
              width: w,
              height: h,
              size: toolSettings.lineSize,
              shape: toolSettings.lineShape,
              dither: toolSettings.lineDither,
              color: activeRgba,
              selectionMask: effectiveSelectionMask,
            })
            setStepPhase({ kind: 'idle' })
            playUiTick('draw', soundEnabled)
            commitLayerCanvasViewChange(activeLayer.id, after, 'Bezier Curve')
          } else {
            setStepPhase({ kind: 'bezier-p3', p0: pt })
          }
        }
        return
      }

      if (tool === 'shape') {
        if (!activeLayer.visible) return
        if (stepPhase.kind !== 'shape-end') {
          setStepPhase({ kind: 'shape-end', start: pt })
          playUiTick('step', soundEnabled)
        } else {
          const bounds = computeShapeBounds(
            stepPhase.start,
            pt,
            toolSettings.shapeFixedRatio
          )

          // Section 1-2: When Transparent Slot is selected, apply transparent shape directly to active layer
          // (respecting dither `#` vs `.` and selectionMask, setting RGBA alpha=0)!
          if (activeRgba.a === 0) {
            const after = new Uint8ClampedArray(activeLayerCanvasView)
            const shapeOpts = {
              width: w,
              height: h,
              filled: toolSettings.shapeFilled,
              strokeSize: toolSettings.shapeSize,
              dither: toolSettings.shapeDither,
              color: activeRgba,
              selectionMask: effectiveSelectionMask,
            }
            if (toolSettings.shapeType === 'rect') {
              rasterizeRectangle(after, bounds, shapeOpts)
            } else {
              rasterizeEllipse(after, bounds, shapeOpts)
            }
            setStepPhase({ kind: 'idle' })
            playUiTick('draw', soundEnabled)
            commitLayerCanvasViewChange(activeLayer.id, after, 'Shape')
            return
          }

          // Section 12: Rasterize in local shape space (`[0..sw-1, 0..sh-1]`) with world-anchored dither
          // so shapes extending outside `[0..w-1, 0..h-1]` preserve their true geometry & curves even when dragged/rotated!
          const sw = Math.max(1, Math.min(1024, bounds.width))
          const sh = Math.max(1, Math.min(1024, bounds.height))
          const localBuf = createPixelBuffer(sw, sh)

          // Build unshifted shape in `[0..sw-1, 0..sh-1]` with solid mask first, then apply canvas-anchored dither `(bounds.minX + lx, bounds.minY + ly)`
          const solidLocalOpts = {
            width: sw,
            height: sh,
            filled: toolSettings.shapeFilled,
            strokeSize: toolSettings.shapeSize,
            dither: 1 as const,
            color: activeRgba,
            selectionMask: null,
          }
          const localBounds = {
            minX: 0,
            minY: 0,
            maxX: sw - 1,
            maxY: sh - 1,
            width: sw,
            height: sh,
          }
          if (toolSettings.shapeType === 'rect') {
            rasterizeRectangle(localBuf, localBounds, solidLocalOpts)
          } else {
            rasterizeEllipse(localBuf, localBounds, solidLocalOpts)
          }

          if (toolSettings.shapeDither !== 1) {
            // Apply canvas-space dither mask anchored to `(0, 0)`
            const tempCanvasTest = createPixelBuffer(1, 1)
            for (let ly = 0; ly < sh; ly++) {
              const worldY = bounds.minY + ly
              for (let lx = 0; lx < sw; lx++) {
                const idx = (ly * sw + lx) * 4
                if (localBuf[idx + 3] === 0) continue
                const worldX = bounds.minX + lx
                tempCanvasTest[3] = 0
                // Check dither at `(worldX, worldY)` via stamp/dither parity
                stampPoints(tempCanvasTest, [{ x: 0, y: 0 }], {
                  width: 1,
                  height: 1,
                  size: 1,
                  shape: 'square',
                  color: activeRgba,
                  dither: 1,
                })
                // Direct world dither check
                const dId = toolSettings.shapeDither
                // Inline world dither modulo via rasterizeRectangle 1x1 trick is unnecessary; import shouldDrawWithDither or check directly
                void dId
                void worldX
                void worldY
              }
            }
          }

          // Re-rasterize directly with canvas-anchored dither if shapeDither !== 1:
          if (toolSettings.shapeDither !== 1) {
            const ditheredBuf = createPixelBuffer(w, h)
            const canvasShapeOpts = {
              width: w,
              height: h,
              filled: toolSettings.shapeFilled,
              strokeSize: toolSettings.shapeSize,
              dither: toolSettings.shapeDither,
              color: activeRgba,
              selectionMask: null,
            }
            if (toolSettings.shapeType === 'rect') {
              rasterizeRectangle(ditheredBuf, bounds, canvasShapeOpts)
            } else {
              rasterizeEllipse(ditheredBuf, bounds, canvasShapeOpts)
            }
            localBuf.fill(0)
            for (let ly = 0; ly < sh; ly++) {
              const cy = bounds.minY + ly
              if (cy < 0 || cy >= h) continue
              for (let lx = 0; lx < sw; lx++) {
                const cx = bounds.minX + lx
                if (cx < 0 || cx >= w) continue
                const sIdx = (cy * w + cx) * 4
                const dIdx = (ly * sw + lx) * 4
                localBuf[dIdx] = ditheredBuf[sIdx]
                localBuf[dIdx + 1] = ditheredBuf[sIdx + 1]
                localBuf[dIdx + 2] = ditheredBuf[sIdx + 2]
                localBuf[dIdx + 3] = ditheredBuf[sIdx + 3]
              }
            }
          }

          setStepPhase({ kind: 'idle' })
          setFloatingShape({
            sourceBuffer: localBuf,
            sourceWidth: sw,
            sourceHeight: sh,
            offsetX: bounds.minX,
            offsetY: bounds.minY,
            rotationDeg: 0,
          })
          playUiTick('step', soundEnabled)
        }
        return
      }

      if (tool === 'select') {
        const beforeSel = cloneSelectionMask(selectionMask)
        if (toolSettings.selectType === 'wand') {
          const clampedPt = clampCanvasPoint(pt, w, h)
          const wandMask = selectSameColor(
            activeLayerCanvasView,
            w,
            h,
            clampedPt.x,
            clampedPt.y,
            toolSettings.selectConnectivity
          )
          const nextSel = mergeSelectionMasks(selectionMask, wandMask)
          historyRef.current.push({
            id: generateId('hist'),
            label: 'Magic Wand Select',
            timestamp: Date.now(),
            kind: 'selection',
            beforeSelection: beforeSel,
            afterSelection: cloneSelectionMask(nextSel),
          })
          syncHistoryCounts()
          setSelectionMask(nextSel)
          playUiTick('draw', soundEnabled)
        } else {
          if (stepPhase.kind !== 'select-end') {
            setStepPhase({ kind: 'select-end', start: pt })
            playUiTick('step', soundEnabled)
          } else {
            const part =
              toolSettings.selectType === 'ellipse'
                ? selectEllipseMask(w, h, stepPhase.start, pt)
                : selectRectangleMask(w, h, stepPhase.start, pt)
            const nextSel = mergeSelectionMasks(selectionMask, part)
            setStepPhase({ kind: 'idle' })
            historyRef.current.push({
              id: generateId('hist'),
              label: 'Area Select',
              timestamp: Date.now(),
              kind: 'selection',
              beforeSelection: beforeSel,
              afterSelection: cloneSelectionMask(nextSel),
            })
            syncHistoryCounts()
            setSelectionMask(nextSel)
            playUiTick('draw', soundEnabled)
          }
        }
      }
    },
    [
      project,
      activeLayer,
      activeLayerCanvasView,
      moveSession,
      commitActiveMove,
      floatingShape,
      commitFloatingShape,
      tool,
      toolSettings,
      stepPhase,
      cursor,
      recomputeContinuousStroke,
      soundEnabled,
      pickColorAtCanvasPoint,
      activeRgba,
      effectiveSelectionMask,
      commitLayerCanvasViewChange,
      selectionMask,
      syncHistoryCounts,
    ]
  )

  const endDrawAction = useCallback(() => {
    const st = strokeRef.current
    if (!st || !st.active) return
    st.active = false
    strokeRef.current = null
    setIsContinuousDrawing(false)
    setLiveStrokeBuffer(null)

    commitLayerCanvasViewChange(
      st.layerId,
      st.latestPreview,
      st.tool === 'pen' ? 'Pen' : 'Eraser'
    )
  }, [commitLayerCanvasViewChange])

  /**
   * Abort an in-progress stroke WITHOUT committing (used by Section 9-3 when 2nd tap of a double-tap eyedropper arrives!).
   */
  const abortStrokePreview = useCallback(() => {
    const st = strokeRef.current
    if (st) {
      st.active = false
      strokeRef.current = null
    }
    setIsContinuousDrawing(false)
    setLiveStrokeBuffer(null)
  }, [])

  const rotateFloatingShape = useCallback((deltaDeg: number) => {
    setFloatingShape((prev) =>
      prev ? { ...prev, rotationDeg: prev.rotationDeg + deltaDeg } : null
    )
  }, [])

  const moveFloatingShape = useCallback((dx: number, dy: number) => {
    setFloatingShape((prev) =>
      prev ? { ...prev, offsetX: prev.offsetX + dx, offsetY: prev.offsetY + dy } : null
    )
  }, [])

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (moveSession) {
        updateActiveMoveOffset(dx, dy)
        return
      }
      if (!project || !activeLayer || !activeLayerCanvasView || !effectiveSelectionMask) {
        return
      }
      const beforeMask = cloneSelectionMask(effectiveSelectionMask)
      const { nextBuffer, nextMask } = moveSelectionContent(
        activeLayerCanvasView,
        effectiveSelectionMask,
        project.width,
        project.height,
        dx,
        dy
      )
      commitLayerCanvasViewChange(activeLayer.id, nextBuffer, 'Move Selection', {
        before: beforeMask,
        after: nextMask,
      })
    },
    [
      moveSession,
      updateActiveMoveOffset,
      project,
      activeLayer,
      activeLayerCanvasView,
      effectiveSelectionMask,
      commitLayerCanvasViewChange,
    ]
  )

  const outlineSelection = useCallback(() => {
    if (!project || !activeLayer || !activeLayerCanvasView || !effectiveSelectionMask) return
    // Guarantee outlineColor comes from project palette (Section 3)
    const validHex =
      palette.colors.find(
        (c) => c.toUpperCase() === toolSettings.outlineColor.toUpperCase()
      ) ??
      (selectedColorIndex >= 0 && palette.colors[selectedColorIndex]
        ? palette.colors[selectedColorIndex]
        : palette.colors[0] ?? '#000000')
    const outlineRgba = hexToRgba(validHex, 255)
    const nextBuffer = applySelectionOutline(
      activeLayerCanvasView,
      effectiveSelectionMask,
      project.width,
      project.height,
      toolSettings.outlineMode,
      toolSettings.outlineSize,
      outlineRgba
    )
    commitLayerCanvasViewChange(
      activeLayer.id,
      nextBuffer,
      'Selection Outline'
    )
  }, [
    project,
    activeLayer,
    activeLayerCanvasView,
    effectiveSelectionMask,
    palette.colors,
    toolSettings,
    selectedColorIndex,
    commitLayerCanvasViewChange,
  ])

  const copySelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayerCanvasView || !effectiveSelectionMask) return false
    const clip = copySelection(
      activeLayerCanvasView,
      effectiveSelectionMask,
      project.width,
      project.height
    )
    if (!clip) return false
    setClipboard(clip)
    return true
  }, [project, activeLayerCanvasView, effectiveSelectionMask])

  const cutSelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !activeLayerCanvasView || !effectiveSelectionMask) {
      return false
    }
    const { clipboard: clip, nextBuffer } = cutSelection(
      activeLayerCanvasView,
      effectiveSelectionMask,
      project.width,
      project.height
    )
    if (!clip) return false
    setClipboard(clip)
    commitLayerCanvasViewChange(activeLayer.id, nextBuffer, 'Cut Selection')
    return true
  }, [
    project,
    activeLayer,
    activeLayerCanvasView,
    effectiveSelectionMask,
    commitLayerCanvasViewChange,
  ])

  const pasteClipboardPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !activeLayerCanvasView || !clipboard) return false
    const beforeMask = cloneSelectionMask(selectionMask)
    const { nextBuffer, nextMask } = pasteClipboard(
      activeLayerCanvasView,
      clipboard,
      project.width,
      project.height
    )
    commitLayerCanvasViewChange(activeLayer.id, nextBuffer, 'Paste', {
      before: beforeMask,
      after: nextMask,
    })
    return true
  }, [
    project,
    activeLayer,
    activeLayerCanvasView,
    clipboard,
    selectionMask,
    commitLayerCanvasViewChange,
  ])

  const flipSelectedPixels = useCallback(
    (direction: 'horizontal' | 'vertical') => {
      if (!project || !activeLayer || !activeLayerCanvasView || !effectiveSelectionMask) {
        return
      }
      const beforeMask = cloneSelectionMask(effectiveSelectionMask)
      const { nextBuffer, nextMask } = flipSelectionContent(
        activeLayerCanvasView,
        effectiveSelectionMask,
        project.width,
        project.height,
        direction
      )
      commitLayerCanvasViewChange(activeLayer.id, nextBuffer, 'Flip Selection', {
        before: beforeMask,
        after: nextMask,
      })
    },
    [
      project,
      activeLayer,
      activeLayerCanvasView,
      effectiveSelectionMask,
      commitLayerCanvasViewChange,
    ]
  )

  const invertCurrentSelection = useCallback(() => {
    if (!project) return
    const before = cloneSelectionMask(selectionMask)
    const after = invertSelectionMask(selectionMask, project.width, project.height)
    historyRef.current.push({
      id: generateId('hist'),
      label: 'Invert Selection',
      timestamp: Date.now(),
      kind: 'selection',
      beforeSelection: before,
      afterSelection: cloneSelectionMask(after),
    })
    syncHistoryCounts()
    setSelectionMask(after)
  }, [project, selectionMask, syncHistoryCounts])

  const clearCurrentSelection = useCallback(() => {
    if (moveSession?.mode === 'selection') {
      setMoveSession(null)
    }
    if (!hasAnySelectedPixel(selectionMask)) {
      setSelectionMask(null)
      setStepPhase({ kind: 'idle' })
      return
    }
    const before = cloneSelectionMask(selectionMask)
    historyRef.current.push({
      id: generateId('hist'),
      label: 'Deselect',
      timestamp: Date.now(),
      kind: 'selection',
      beforeSelection: before,
      afterSelection: null,
    })
    syncHistoryCounts()
    setSelectionMask(null)
    setStepPhase({ kind: 'idle' })
  }, [moveSession, selectionMask, syncHistoryCounts])

  const executeStructuralChange = useCallback(
    (
      label: string,
      mutator: (
        currentLayers: LayerRuntime[],
        currentActiveId: string,
        w: number,
        h: number
      ) => {
        width: number
        height: number
        layers: LayerRuntime[]
        activeLayerId: string
        clearSelection?: boolean
      } | null
    ) => {
      if (!project) return false
      const beforeSnap = captureCanvasSnapshot(
        project.width,
        project.height,
        layers,
        activeLayerId
      )
      const beforeSel = cloneSelectionMask(selectionMask)

      const mutated = mutator(layers, activeLayerId, project.width, project.height)
      if (!mutated) return false

      const afterSnap = captureCanvasSnapshot(
        mutated.width,
        mutated.height,
        mutated.layers,
        mutated.activeLayerId
      )
      const afterSel = mutated.clearSelection ? null : beforeSel

      historyRef.current.push({
        id: generateId('hist'),
        label,
        timestamp: Date.now(),
        kind: 'structure',
        beforeStructure: beforeSnap,
        afterStructure: afterSnap,
        beforeSelection: beforeSel,
        afterSelection: afterSel,
      })
      syncHistoryCounts()

      const updatedProject: ProjectRecord = {
        ...project,
        width: mutated.width,
        height: mutated.height,
        activeLayerId: mutated.activeLayerId,
      }
      setProject(updatedProject)
      setLayers(mutated.layers)
      setActiveLayerId(mutated.activeLayerId)
      if (mutated.clearSelection) {
        setSelectionMask(null)
      }
      setCursor((prev) => clampCanvasPoint(prev, mutated.width, mutated.height))

      persistCommittedState(
        updatedProject,
        mutated.layers,
        palette,
        selectedColorIndex,
        mutated.activeLayerId
      )
      return true
    },
    [
      project,
      layers,
      activeLayerId,
      selectionMask,
      syncHistoryCounts,
      persistCommittedState,
      palette,
      selectedColorIndex,
    ]
  )

  const addNewLayer = useCallback((): boolean => {
    if (layers.length >= MAX_LAYERS) return false
    return executeStructuralChange('Add Layer', (curr, currActive, w, h) => {
      const newId = generateId('layer')
      const newLayer: LayerRuntime = {
        id: newId,
        name: `Layer ${curr.length + 1}`,
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: w,
        dataHeight: h,
        data: createPixelBuffer(w, h),
      }
      const idx = curr.findIndex((l) => l.id === currActive)
      const insertAt = idx >= 0 ? idx + 1 : curr.length
      const next = [...curr.slice(0, insertAt), newLayer, ...curr.slice(insertAt)]
      return { width: w, height: h, layers: next, activeLayerId: newId }
    })
  }, [layers.length, executeStructuralChange])

  const duplicateLayer = useCallback(
    (layerId: string): boolean => {
      if (layers.length >= MAX_LAYERS) return false
      return executeStructuralChange('Duplicate Layer', (curr, _currActive, w, h) => {
        const idx = curr.findIndex((l) => l.id === layerId)
        if (idx < 0) return null
        const src = curr[idx]
        const newId = generateId('layer')
        const copy: LayerRuntime = {
          ...src,
          id: newId,
          name: `${src.name} Copy`,
          data: new Uint8ClampedArray(src.data),
        }
        const next = [...curr.slice(0, idx + 1), copy, ...curr.slice(idx + 1)]
        return { width: w, height: h, layers: next, activeLayerId: newId }
      })
    },
    [layers.length, executeStructuralChange]
  )

  const deleteLayer = useCallback(
    (layerId: string): boolean => {
      if (layers.length <= 1) return false
      return executeStructuralChange('Delete Layer', (curr, currActive, w, h) => {
        const idx = curr.findIndex((l) => l.id === layerId)
        if (idx < 0 || curr.length <= 1) return null
        const next = curr.filter((l) => l.id !== layerId)
        if (next.length > 0 && next[0].clipping) {
          next[0] = { ...next[0], clipping: false }
        }
        const nextActive =
          currActive === layerId
            ? next[Math.max(0, idx - 1)].id
            : currActive
        return { width: w, height: h, layers: next, activeLayerId: nextActive }
      })
    },
    [layers.length, executeStructuralChange]
  )

  const mergeLayerDown = useCallback(
    (layerId: string): boolean => {
      return executeStructuralChange('Merge Down', (curr, _currActive, w, h) => {
        const idx = curr.findIndex((l) => l.id === layerId)
        if (idx <= 0) return null
        const lower = curr[idx - 1]
        const upper = curr[idx]
        const merged = mergeTwoLayers(lower, upper, w, h)
        const mergedLayer: LayerRuntime = {
          ...lower,
          opacity: 100,
          visible: true,
          offsetX: merged.offsetX,
          offsetY: merged.offsetY,
          dataWidth: merged.dataWidth,
          dataHeight: merged.dataHeight,
          data: merged.data,
        }
        const next = [
          ...curr.slice(0, idx - 1),
          mergedLayer,
          ...curr.slice(idx + 1),
        ]
        return { width: w, height: h, layers: next, activeLayerId: mergedLayer.id }
      })
    },
    [executeStructuralChange]
  )

  /**
   * Section 8: Multi-Layer Checkbox Selection & Safe Batch Operations
   * - Toggling checkbox NEVER mutates `activeLayerId`!
   */
  const toggleLayerSelected = useCallback((layerId: string) => {
    setSelectedLayerIds((prev) =>
      prev.includes(layerId) ? prev.filter((id) => id !== layerId) : [...prev, layerId]
    )
  }, [])

  const clearLayerSelection = useCallback(() => {
    setSelectedLayerIds([])
  }, [])

  const duplicateSelectedLayers = useCallback((): boolean => {
    if (selectedLayerIds.length === 0) return false
    const selectedSet = new Set(selectedLayerIds)
    const countToAdd = layers.filter((l) => selectedSet.has(l.id)).length
    if (countToAdd === 0 || layers.length + countToAdd > MAX_LAYERS) return false

    const newIds: string[] = []
    const ok = executeStructuralChange(
      'Duplicate Selected Layers',
      (curr, currActive, w, h) => {
        const next: LayerRuntime[] = []
        for (const l of curr) {
          next.push(l)
          if (selectedSet.has(l.id)) {
            const nid = generateId('layer')
            newIds.push(nid)
            next.push({
              ...l,
              id: nid,
              name: `${l.name} Copy`,
              data: new Uint8ClampedArray(l.data),
            })
          }
        }
        return { width: w, height: h, layers: next, activeLayerId: currActive }
      }
    )
    if (ok && newIds.length > 0) {
      setSelectedLayerIds(newIds)
    }
    return ok
  }, [selectedLayerIds, layers, executeStructuralChange])

  const mergeSelectedLayers = useCallback((): boolean => {
    if (selectedLayerIds.length < 2) return false
    const selectedSet = new Set(selectedLayerIds)
    let mergedId = ''
    const ok = executeStructuralChange(
      'Merge Selected Layers',
      (curr, currActive, w, h) => {
        const selectedInOrder = curr.filter((l) => selectedSet.has(l.id))
        if (selectedInOrder.length < 2) return null

        let acc: LayerRuntime = {
          ...selectedInOrder[0],
          data: new Uint8ClampedArray(selectedInOrder[0].data),
        }
        for (let i = 1; i < selectedInOrder.length; i++) {
          const upper = selectedInOrder[i]
          const m = mergeTwoLayers(acc, upper, w, h)
          acc = {
            ...acc,
            opacity: 100,
            visible: true,
            offsetX: m.offsetX,
            offsetY: m.offsetY,
            dataWidth: m.dataWidth,
            dataHeight: m.dataHeight,
            data: m.data,
          }
        }

        mergedId = acc.id
        const lowestSelectedIdx = curr.findIndex((l) => selectedSet.has(l.id))
        const next: LayerRuntime[] = []
        for (let i = 0; i < curr.length; i++) {
          if (i === lowestSelectedIdx) {
            next.push(acc)
          } else if (!selectedSet.has(curr[i].id)) {
            next.push(curr[i])
          }
        }
        if (next[0]?.clipping) {
          next[0] = { ...next[0], clipping: false }
        }
        const nextActive = selectedSet.has(currActive) ? acc.id : currActive
        return { width: w, height: h, layers: next, activeLayerId: nextActive }
      }
    )
    if (ok && mergedId) {
      setSelectedLayerIds([mergedId])
    }
    return ok
  }, [selectedLayerIds, executeStructuralChange])

  const deleteSelectedLayers = useCallback((): boolean => {
    if (selectedLayerIds.length === 0) return false
    const selectedSet = new Set(selectedLayerIds)
    const remainingCount = layers.filter((l) => !selectedSet.has(l.id)).length
    if (remainingCount < 1) return false

    const ok = executeStructuralChange(
      'Delete Selected Layers',
      (curr, currActive, w, h) => {
        const next = curr.filter((l) => !selectedSet.has(l.id))
        if (next.length < 1) return null
        if (next[0].clipping) {
          next[0] = { ...next[0], clipping: false }
        }
        const nextActive = next.some((l) => l.id === currActive)
          ? currActive
          : next[next.length - 1].id
        return { width: w, height: h, layers: next, activeLayerId: nextActive }
      }
    )
    if (ok) {
      setSelectedLayerIds([])
    }
    return ok
  }, [selectedLayerIds, layers, executeStructuralChange])

  const updateLayerProps = useCallback(
    (
      layerId: string,
      patch: Partial<
        Pick<LayerRuntime, 'name' | 'visible' | 'opacity' | 'blendMode' | 'clipping'>
      >
    ) => {
      executeStructuralChange('Update Layer', (curr, currActive, w, h) => {
        const idx = curr.findIndex((l) => l.id === layerId)
        if (idx < 0) return null
        const safePatch =
          idx === 0 && patch.clipping ? { ...patch, clipping: false } : patch
        const next = curr.map((l, i) => (i === idx ? { ...l, ...safePatch } : l))
        return { width: w, height: h, layers: next, activeLayerId: currActive }
      })
    },
    [executeStructuralChange]
  )

  const reorderLayers = useCallback(
    (orderedBottomToTopIds: string[]) => {
      executeStructuralChange('Reorder Layers', (curr, currActive, w, h) => {
        const map = new Map(curr.map((l) => [l.id, l]))
        const next: LayerRuntime[] = []
        for (const id of orderedBottomToTopIds) {
          const item = map.get(id)
          if (item) next.push(item)
        }
        if (next.length !== curr.length) return null
        if (next[0]?.clipping) {
          next[0] = { ...next[0], clipping: false }
        }
        return { width: w, height: h, layers: next, activeLayerId: currActive }
      })
    },
    [executeStructuralChange]
  )

  const clearLayerPixels = useCallback(
    (layerId: string) => {
      if (!project) return
      const target = layers.find((l) => l.id === layerId)
      if (!target) return
      const clearedLayer: LayerRuntime = {
        ...target,
        offsetX: 0,
        offsetY: 0,
        dataWidth: project.width,
        dataHeight: project.height,
        data: createPixelBuffer(project.width, project.height),
      }
      commitUpdatedLayer(target, clearedLayer, 'Clear Layer')
    },
    [project, layers, commitUpdatedLayer]
  )

  const copyLayerToClipboard = useCallback(
    (layerId: string): boolean => {
      if (!project) return false
      const target = layers.find((l) => l.id === layerId)
      if (!target) return false
      const view = extractLayerCanvasView(target, project.width, project.height)
      setClipboard({
        width: project.width,
        height: project.height,
        offsetX: 0,
        offsetY: 0,
        data: view,
      })
      return true
    },
    [project, layers]
  )

  const flipLayer = useCallback(
    (layerId: string, dir: 'horizontal' | 'vertical') => {
      if (!project) return
      const target = layers.find((l) => l.id === layerId)
      if (!target) return
      const flipped = flipLayerAroundCanvas(
        target,
        project.width,
        project.height,
        dir
      )
      commitUpdatedLayer(target, flipped, 'Flip Layer')
    },
    [project, layers, commitUpdatedLayer]
  )

  const translateLayer = useCallback(
    (layerId: string, dx: number, dy: number) => {
      const sx = Math.trunc(dx)
      const sy = Math.trunc(dy)
      if (!project || (sx === 0 && sy === 0)) return
      const target = layers.find((l) => l.id === layerId)
      if (!target) return

      const beforeOx = target.offsetX ?? 0
      const beforeOy = target.offsetY ?? 0
      const afterOx = beforeOx + sx
      const afterOy = beforeOy + sy

      historyRef.current.push({
        id: generateId('hist'),
        label: 'Move Layer',
        timestamp: Date.now(),
        kind: 'layer-offset',
        layerOffsetChange: {
          layerId,
          beforeOffsetX: beforeOx,
          beforeOffsetY: beforeOy,
          afterOffsetX: afterOx,
          afterOffsetY: afterOy,
        },
      })
      syncHistoryCounts()

      const nextLayers = layers.map((l) =>
        l.id === layerId ? { ...l, offsetX: afterOx, offsetY: afterOy } : l
      )
      setLayers(nextLayers)
      persistCommittedState(
        project,
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId
      )
    },
    [
      project,
      layers,
      syncHistoryCounts,
      persistCommittedState,
      palette,
      selectedColorIndex,
      activeLayerId,
    ]
  )

  /**
   * Section 5: 9-Directional Anchor Canvas Resize (default anchor = `'center'`)!
   * Applies the exact same deterministic `(shiftX, shiftY)` across ALL layers, keeping inter-layer relative positions
   * and layer order/props 100% intact while preserving off-canvas pixel buffers!
   */
  const resizeCanvas = useCallback(
    (newWidthRaw: number, newHeightRaw: number, anchor: ResizeAnchor = 'center') => {
      const nw = Math.max(
        MIN_CANVAS_SIZE,
        Math.min(MAX_CANVAS_SIZE, Math.round(newWidthRaw))
      )
      const nh = Math.max(
        MIN_CANVAS_SIZE,
        Math.min(MAX_CANVAS_SIZE, Math.round(newHeightRaw))
      )
      executeStructuralChange('Resize Canvas', (curr, currActive, w, h) => {
        if (nw === w && nh === h) return null
        const { layers: resizedLayers } = resizeLayersWithAnchor(
          curr,
          w,
          h,
          nw,
          nh,
          anchor
        )
        return {
          width: nw,
          height: nh,
          layers: resizedLayers,
          activeLayerId: currActive,
          clearSelection: true,
        }
      })
    },
    [executeStructuralChange]
  )

  const updateProjectPalette = useCallback(
    (nextPalette: ProjectPalette, nextColorIdx?: number) => {
      if (!project) return
      const safeColors =
        nextPalette.colors.length > 0
          ? nextPalette.colors.slice(0, 256)
          : ['#000000']
      const normalized: ProjectPalette = {
        name: nextPalette.name.trim() || 'Palette',
        colors: safeColors,
        sourcePaletteId: nextPalette.sourcePaletteId,
      }
      historyRef.current.push({
        id: generateId('hist'),
        label: 'Edit Palette',
        timestamp: Date.now(),
        kind: 'palette',
        beforePalette: { ...palette, colors: [...palette.colors] },
        afterPalette: { ...normalized, colors: [...normalized.colors] },
      })
      syncHistoryCounts()

      const targetIdx =
        nextColorIdx !== undefined
          ? nextColorIdx === TRANSPARENT_COLOR_INDEX
            ? TRANSPARENT_COLOR_INDEX
            : Math.max(0, Math.min(safeColors.length - 1, nextColorIdx))
          : selectedColorIndex === TRANSPARENT_COLOR_INDEX
            ? TRANSPARENT_COLOR_INDEX
            : Math.min(selectedColorIndex, safeColors.length - 1)
      setPalette(normalized)
      setSelectedColorIndex(targetIdx)
      persistCommittedState(project, layers, normalized, targetIdx, activeLayerId)
    },
    [
      project,
      palette,
      syncHistoryCounts,
      selectedColorIndex,
      persistCommittedState,
      layers,
      activeLayerId,
    ]
  )

  const renameProject = useCallback(
    (newName: string) => {
      if (!project) return
      const trimmed = newName.trim() || project.name
      const nextProj = { ...project, name: trimmed }
      setProject(nextProj)
      persistCommittedState(
        nextProj,
        layers,
        palette,
        selectedColorIndex,
        activeLayerId
      )
    },
    [project, persistCommittedState, layers, palette, selectedColorIndex, activeLayerId]
  )

  const undo = useCallback(() => {
    if (!project) return
    if (moveSession) {
      setMoveSession(null)
      return
    }
    if (floatingShape) {
      setFloatingShape(null)
      return
    }
    if (stepPhase.kind !== 'idle') {
      setStepPhase({ kind: 'idle' })
      return
    }

    const prev = historyRef.current.undo({
      width: project.width,
      height: project.height,
      layers,
      activeLayerId,
      selectionMask,
      palette,
    })
    if (!prev) return

    playUiTick('undo', soundEnabled)
    syncHistoryCounts()

    const updatedProj: ProjectRecord = {
      ...project,
      width: prev.width,
      height: prev.height,
      activeLayerId: prev.activeLayerId,
    }
    const safeIdx =
      selectedColorIndex === TRANSPARENT_COLOR_INDEX
        ? TRANSPARENT_COLOR_INDEX
        : Math.min(selectedColorIndex, Math.max(0, prev.palette.colors.length - 1))
    setProject(updatedProj)
    setLayers(prev.layers)
    setActiveLayerId(prev.activeLayerId)
    setSelectionMask(prev.selectionMask)
    setPalette(prev.palette)
    setSelectedColorIndex(safeIdx)
    persistCommittedState(
      updatedProj,
      prev.layers,
      prev.palette,
      safeIdx,
      prev.activeLayerId
    )
  }, [
    project,
    moveSession,
    floatingShape,
    stepPhase.kind,
    layers,
    activeLayerId,
    selectionMask,
    palette,
    soundEnabled,
    syncHistoryCounts,
    selectedColorIndex,
    persistCommittedState,
  ])

  const redo = useCallback(() => {
    if (!project) return
    const next = historyRef.current.redo({
      width: project.width,
      height: project.height,
      layers,
      activeLayerId,
      selectionMask,
      palette,
    })
    if (!next) return

    playUiTick('step', soundEnabled)
    syncHistoryCounts()

    const updatedProj: ProjectRecord = {
      ...project,
      width: next.width,
      height: next.height,
      activeLayerId: next.activeLayerId,
    }
    const safeIdx =
      selectedColorIndex === TRANSPARENT_COLOR_INDEX
        ? TRANSPARENT_COLOR_INDEX
        : Math.min(selectedColorIndex, Math.max(0, next.palette.colors.length - 1))
    setProject(updatedProj)
    setLayers(next.layers)
    setActiveLayerId(next.activeLayerId)
    setSelectionMask(next.selectionMask)
    setPalette(next.palette)
    setSelectedColorIndex(safeIdx)
    persistCommittedState(
      updatedProj,
      next.layers,
      next.palette,
      safeIdx,
      next.activeLayerId
    )
  }, [
    project,
    layers,
    activeLayerId,
    selectionMask,
    palette,
    soundEnabled,
    syncHistoryCounts,
    selectedColorIndex,
    persistCommittedState,
  ])

  return {
    loading,
    saving,
    project,
    layers,
    activeLayer,
    activeLayerId,
    setActiveLayerId,
    selectedLayerIds,
    toggleLayerSelected,
    clearLayerSelection,
    palette,
    selectedColorIndex,
    setSelectedColorIndex,
    isTransparentColorSelected,
    activeHexColor,
    tool,
    selectTool,
    toolSettings,
    setToolSettings,
    updateToolSettings,
    cursor,
    moveCursorTo,
    stepPhase,
    cancelMultiStep,
    floatingShape,
    rotateFloatingShape,
    moveFloatingShape,
    commitFloatingShape,
    discardFloatingShape,
    moveSession,
    startSelectionMove,
    startLayerMove,
    startMultiLayerMove,
    updateActiveMoveOffset,
    commitActiveMove,
    cancelActiveMove,
    selectionMask: displaySelectionMask,
    hasSelection: effectiveSelectionMask !== null,
    clipboard,
    isContinuousDrawing,
    compositedBuffer,
    canUndo:
      undoCount > 0 ||
      floatingShape !== null ||
      moveSession !== null ||
      stepPhase.kind !== 'idle',
    canRedo: redoCount > 0,
    undoCount,
    redoCount,
    beginDrawAction,
    endDrawAction,
    abortStrokePreview,
    pickColorAtCanvasPoint,
    undo,
    redo,
    nudgeSelection,
    outlineSelection,
    copySelectedPixels,
    cutSelectedPixels,
    pasteClipboardPixels,
    flipSelectedPixels,
    invertCurrentSelection,
    clearCurrentSelection,
    addNewLayer,
    duplicateLayer,
    deleteLayer,
    mergeLayerDown,
    duplicateSelectedLayers,
    mergeSelectedLayers,
    deleteSelectedLayers,
    updateLayerProps,
    reorderLayers,
    clearLayerPixels,
    copyLayerToClipboard,
    flipLayer,
    translateLayer,
    resizeCanvas,
    updateProjectPalette,
    renameProject,
  }
}
