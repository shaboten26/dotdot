import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  TRANSPARENT_COLOR_INDEX,
  type ActiveMoveSession,
  type BlendMode,
  type CelBufferRuntime,
  type CelMap,
  type ClipboardBuffer,
  type FloatingShapeState,
  type LayerOffsetTransition,
  type LayerRuntime,
  type PlaybackDirection,
  type Point,
  type ProjectPalette,
  type ProjectRecord,
  type ResizeAnchor,
  type RGBA,
  type ToolId,
  type ToolSettings,
  type WorldSelectionMask,
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
  canvasMaskToWorldSelection,
  cloneSelectionMask,
  cloneWorldSelectionMask,
  copyWorldSelectionFromLayer,
  cutWorldSelectionFromLayer,
  extractWorldSelectionFromLayer,
  flipWorldSelectionOnLayer,
  hasAnySelectedPixel,
  hasAnySelectedWorldPixel,
  invertSelectionMask,
  mergeWorldSelectionMasks,
  moveWorldSelectionOnLayer,
  projectWorldSelectionToCanvasMask,
  selectSameColor,
  selectWorldEllipseMask,
  selectWorldRectangleMask,
  shiftWorldSelectionMask,
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
import {
  applyBatchFrameDuration,
  clampFrameDurationMs,
  computePlaybackFrameIndices,
  copyCellAsIndependent,
  createSingleFrameTimelineFromLayers,
  DEFAULT_FRAME_DURATION_MS,
  deleteFrameFromTimeline,
  insertNewFrame,
  linkCellToAnySourceCell,
  linkCellToSourceCell,
  makeCellKey,
  projectFrameLayers,
  pruneUnreferencedCelBuffers,
  reorderTimelineFrames,
  resolveBatchDurationTargetFrameIds,
  setCellToEmpty,
  unlinkCellToIndependent,
  type TimelineState,
} from '../engine/animation'
import { estimateProjectLoad } from '../engine/loadEstimator'
import { clampCanvasPoint } from '../utils/coordinates'
import { playUiTick } from '../utils/sound'

export interface OnionSkinConfig {
  enabled: boolean
  showPrev: boolean
  showNext: boolean
  prevCount: number // 1..3
  nextCount: number // 1..3
  opacity: number // 10..80 (%)
}

export interface CelClipboardItem {
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
  data: Uint8ClampedArray
  isEmpty: boolean
  sourceLayerId: string
  sourceFrameId: string
}

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
  gradientType: 'linear',
  gradientFixedRatio: false,
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
  const [timeline, setTimeline] = useState<TimelineState>(() => ({
    frames: [{ id: 'frame-1', durationMs: DEFAULT_FRAME_DURATION_MS }],
    cels: {},
    celBuffers: {},
    activeFrameId: 'frame-1',
    defaultFrameDurationMs: DEFAULT_FRAME_DURATION_MS,
    playbackDirection: 'forward',
    loopPlayback: true,
  }))
  const timelineRef = useRef<TimelineState>(timeline)
  timelineRef.current = timeline

  const [selectedCellKeys, setSelectedCellKeys] = useState<string[]>([])
  const [celClipboard, setCelClipboard] = useState<CelClipboardItem | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1)
  const [onionSkin, setOnionSkin] = useState<OnionSkinConfig>({
    enabled: false,
    showPrev: true,
    showNext: true,
    prevCount: 1,
    nextCount: 1,
    opacity: 35,
  })

  const [activeLayerId, setActiveLayerId] = useState<string>('')
  /** Section 8: Multi-layer checkbox selection IDs (independent of `activeLayerId`) */
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([])

  const [palette, setPalette] = useState<ProjectPalette>({
    name: 'Standard',
    colors: ['#000000', '#FFFFFF'],
  })
  const [selectedColorIndex, setSelectedColorIndex] = useState<number>(0)

  const [tool, setTool] = useState<ToolId>('pen')
  const toolRef = useRef<ToolId>('pen')
  toolRef.current = tool
  /** Remember previous drawing tool before manual eyedropper selection so picking returns to it */
  const prevToolBeforeEyedropperRef = useRef<ToolId>('pen')
  const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS)
  /** Track whether the user has explicitly picked an outline palette color yet */
  const outlineColorExplicitRef = useRef<boolean>(false)

  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  /** Always-fresh cursor ref so double-tap eyedropper NEVER reads a stale React closure coordinate! */
  const cursorRef = useRef<Point>({ x: 0, y: 0 })
  cursorRef.current = cursor
  const [stepPhase, setStepPhase] = useState<MultiStepPhase>({ kind: 'idle' })
  const [floatingShape, setFloatingShape] = useState<FloatingShapeState | null>(null)
  const [moveSession, setMoveSession] = useState<ActiveMoveSession | null>(null)
  const [selectionMask, setSelectionMask] = useState<Uint8Array | null>(null)
  const [worldSelection, setWorldSelection] = useState<WorldSelectionMask | null>(null)
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
  const pendingSaveFnRef = useRef<(() => Promise<void>) | null>(null)
  const mountedRef = useRef<boolean>(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (pendingSaveFnRef.current) {
        const flush = pendingSaveFnRef.current
        pendingSaveFnRef.current = null
        void flush()
      }
    }
  }, [])

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
      setTimeline(loaded.timeline)
      timelineRef.current = loaded.timeline
      setSelectedCellKeys([])
      setIsPlaying(false)
      setActiveLayerId(loaded.project.activeLayerId || loaded.layers[0]?.id || '')
      setSelectedLayerIds([])
      setPalette({
        name: loaded.project.palette.name,
        colors: loadedColors,
        sourcePaletteId: loaded.project.palette.sourcePaletteId,
        author: loaded.project.palette.author,
        sourceUrl: loaded.project.palette.sourceUrl,
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
      setWorldSelection(null)
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
      nextActiveLayerId: string,
      explicitTimeline?: TimelineState
    ) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
      const tlToSave = explicitTimeline ?? timelineRef.current
      const projToSave: ProjectRecord = {
        ...nextProj,
        activeLayerId: nextActiveLayerId,
        frames: tlToSave.frames,
        cels: tlToSave.cels,
        activeFrameId: tlToSave.activeFrameId,
        defaultFrameDurationMs: tlToSave.defaultFrameDurationMs,
        playbackDirection: tlToSave.playbackDirection,
        loopPlayback: tlToSave.loopPlayback,
        palette: {
          name: nextPalette.name,
          colors: [...nextPalette.colors],
          sourcePaletteId: nextPalette.sourcePaletteId,
          author: nextPalette.author,
          sourceUrl: nextPalette.sourceUrl,
        },
        selectedColorIndex: nextSelectedColorIdx,
      }
      const layersSnapshot = [...nextLayers]
      const historySnapshot = historyRef.current.serialize()

      const executeSave = async () => {
        try {
          const res = await saveProjectFull(
            {
              project: projToSave,
              layers: layersSnapshot,
              timeline: tlToSave,
              history: historySnapshot,
            },
            db
          )
          if (mountedRef.current) {
            setProject(projToSave)
            setSaving(false)
            if (res.quotaTrimmed) {
              onQuotaTrimmed?.()
            }
          }
          onSaved?.()
        } catch {
          if (mountedRef.current) {
            setSaving(false)
            onSaveError?.()
          }
        }
      }

      pendingSaveFnRef.current = executeSave
      setSaving(true)
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null
        pendingSaveFnRef.current = null
        void executeSave()
      }, 120)
    },
    [onQuotaTrimmed, onSaveError, onSaved]
  )

  const effectiveWorldSelection = useMemo((): WorldSelectionMask | null => {
    if (hasAnySelectedWorldPixel(worldSelection)) {
      return worldSelection
    }
    if (project && hasAnySelectedPixel(selectionMask)) {
      return canvasMaskToWorldSelection(selectionMask, project.width, project.height)
    }
    return null
  }, [worldSelection, selectionMask, project])

  const effectiveSelectionMask = useMemo(() => {
    if (!project) {
      return hasAnySelectedPixel(selectionMask) ? selectionMask : null
    }
    if (effectiveWorldSelection) {
      return projectWorldSelectionToCanvasMask(
        effectiveWorldSelection,
        project.width,
        project.height
      )
    }
    return hasAnySelectedPixel(selectionMask) ? selectionMask : null
  }, [project, effectiveWorldSelection, selectionMask])

  /**
   * World-space selection mask including any live Selection Move `(dx, dy)` offset,
   * so marching ants render cleanly in world coordinates (both inside and outside canvas!).
   */
  const displayWorldSelection = useMemo((): WorldSelectionMask | null => {
    if (
      moveSession &&
      moveSession.mode === 'selection' &&
      moveSession.initialWorldSelection
    ) {
      return shiftWorldSelectionMask(
        moveSession.initialWorldSelection,
        moveSession.dx,
        moveSession.dy
      )
    }
    return effectiveWorldSelection
  }, [moveSession, effectiveWorldSelection])

  const displaySelectionMask = useMemo((): Uint8Array | null => {
    if (!project) return effectiveSelectionMask
    if (displayWorldSelection) {
      return projectWorldSelectionToCanvasMask(
        displayWorldSelection,
        project.width,
        project.height
      )
    }
    return effectiveSelectionMask
  }, [project, effectiveSelectionMask, displayWorldSelection])

  const commitUpdatedLayer = useCallback(
    (
      beforeLayer: LayerRuntime,
      afterLayer: LayerRuntime,
      label: string,
      selectionTransition?: {
        before: Uint8Array | null
        after: Uint8Array | null
        beforeWorld?: WorldSelectionMask | null
        afterWorld?: WorldSelectionMask | null
      }
    ) => {
      if (!project) return
      const curTl = timelineRef.current
      const activeFrameId = curTl.activeFrameId
      const cellKey = makeCellKey(beforeLayer.id, activeFrameId)
      const existingRef = curTl.cels[cellKey]

      const baseDiff = createLayerPixelPatch(beforeLayer, afterLayer)
      if (!baseDiff && !selectionTransition) return

      let targetCelId: string | undefined
      let celAllocation:
        | { cellKey: string; allocatedCelId: string }
        | undefined
      let nextCels = curTl.cels
      let nextCelBuffers = curTl.celBuffers

      if (baseDiff) {
        nextCels = { ...curTl.cels }
        nextCelBuffers = { ...curTl.celBuffers }
        if (existingRef?.kind === 'cel' && nextCelBuffers[existingRef.celId]) {
          targetCelId = existingRef.celId
        } else {
          targetCelId = generateId('cel')
          celAllocation = { cellKey, allocatedCelId: targetCelId }
          nextCels[cellKey] = { kind: 'cel', celId: targetCelId }
        }
        nextCelBuffers[targetCelId] = {
          id: targetCelId,
          offsetX: afterLayer.offsetX,
          offsetY: afterLayer.offsetY,
          dataWidth: afterLayer.dataWidth,
          dataHeight: afterLayer.dataHeight,
          data: new Uint8ClampedArray(afterLayer.data),
        }
      }

      const patch = baseDiff
        ? { ...baseDiff, ...(targetCelId ? { celId: targetCelId } : {}) }
        : null

      const resolvedBeforeWorld =
        selectionTransition?.beforeWorld !== undefined
          ? selectionTransition.beforeWorld
          : selectionTransition?.before !== undefined
            ? canvasMaskToWorldSelection(
                selectionTransition.before,
                project.width,
                project.height
              )
            : undefined
      const resolvedAfterWorld =
        selectionTransition?.afterWorld !== undefined
          ? selectionTransition.afterWorld
          : selectionTransition?.after !== undefined
            ? canvasMaskToWorldSelection(
                selectionTransition.after,
                project.width,
                project.height
              )
            : undefined

      historyRef.current.push({
        id: generateId('hist'),
        label,
        timestamp: Date.now(),
        kind: patch ? 'pixel-diff' : 'selection',
        frameId: activeFrameId,
        celAllocation,
        pixelPatches: patch ? [patch] : undefined,
        beforeSelection: selectionTransition?.before,
        afterSelection: selectionTransition?.after,
        beforeWorldSelection: cloneWorldSelectionMask(resolvedBeforeWorld),
        afterWorldSelection: cloneWorldSelectionMask(resolvedAfterWorld),
      })
      syncHistoryCounts()

      const nextTl: TimelineState = patch
        ? {
            ...curTl,
            cels: nextCels,
            celBuffers: nextCelBuffers,
          }
        : curTl
      if (patch) {
        timelineRef.current = nextTl
        setTimeline(nextTl)
      }

      const nextLayers = layers.map((l) => (l.id === beforeLayer.id ? afterLayer : l))
      setLayers(nextLayers)
      if (selectionTransition) {
        if (resolvedAfterWorld !== undefined) {
          setWorldSelection(cloneWorldSelectionMask(resolvedAfterWorld))
          setSelectionMask(
            projectWorldSelectionToCanvasMask(
              resolvedAfterWorld,
              project.width,
              project.height
            )
          )
        } else {
          setSelectionMask(selectionTransition.after)
          setWorldSelection(
            canvasMaskToWorldSelection(
              selectionTransition.after,
              project.width,
              project.height
            )
          )
        }
      }
      persistCommittedState(
        project,
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
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
        beforeWorld?: WorldSelectionMask | null
        afterWorld?: WorldSelectionMask | null
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
   * Start interactive Selection Move mode (Section 7 + Off-Canvas World Preservation)
   * Works seamlessly even when the selection is already partially or completely outside `[0..width-1, 0..height-1]`!
   */
  const startSelectionMove = useCallback((): boolean => {
    if (!project || !activeLayer || activeLayer.locked || !effectiveWorldSelection) {
      return false
    }
    const { extractedBuffer, clearedLayer } = extractWorldSelectionFromLayer(
      activeLayer,
      effectiveWorldSelection
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
      initialMask: cloneSelectionMask(
        projectWorldSelectionToCanvasMask(
          effectiveWorldSelection,
          project.width,
          project.height
        )
      ),
      initialWorldSelection: cloneWorldSelectionMask(effectiveWorldSelection),
      clearedLayer,
      extractedBuffer,
      extractedWidth: effectiveWorldSelection.width,
      extractedHeight: effectiveWorldSelection.height,
      extractedOriginX: effectiveWorldSelection.originX,
      extractedOriginY: effectiveWorldSelection.originY,
      initialLayerOffsetX: activeLayer.offsetX,
      initialLayerOffsetY: activeLayer.offsetY,
    })
    playUiTick('step', soundEnabled)
    return true
  }, [project, activeLayer, effectiveWorldSelection, soundEnabled])

  /**
   * Start interactive Single-Layer Move on canvas
   */
  const startLayerMove = useCallback(
    (targetLayerId?: string): boolean => {
      if (!project) return false
      const target =
        layers.find((l) => l.id === (targetLayerId ?? activeLayerId)) ?? activeLayer
      if (!target || target.locked) return false
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
      const curTl = timelineRef.current
      const nextCelBuffers = { ...curTl.celBuffers }

      const nextLayers = layers.map((l) => {
        if (!targetSet.has(l.id)) return l
        const init = moveSession.initialLayerOffsets[l.id] ?? {
          offsetX: l.offsetX,
          offsetY: l.offsetY,
        }
        const afterOx = init.offsetX + moveSession.dx
        const afterOy = init.offsetY + moveSession.dy
        const ref = curTl.cels[makeCellKey(l.id, curTl.activeFrameId)]
        const celId = ref?.kind === 'cel' ? ref.celId : undefined
        if (celId && nextCelBuffers[celId]) {
          nextCelBuffers[celId] = {
            ...nextCelBuffers[celId]!,
            offsetX: afterOx,
            offsetY: afterOy,
          }
        }
        offsetTransitions.push({
          layerId: l.id,
          ...(celId ? { celId } : {}),
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
        frameId: curTl.activeFrameId,
        layerOffsetChange: offsetTransitions[0],
        layerOffsetChanges: offsetTransitions,
      })
      syncHistoryCounts()

      const nextTl: TimelineState = {
        ...curTl,
        celBuffers: nextCelBuffers,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)
      setMoveSession(null)
      setLayers(nextLayers)
      playUiTick('draw', soundEnabled)
      persistCommittedState(
        project,
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
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
      moveSession.initialWorldSelection
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
      // Preserve FULL world-space selection even if moved partially or completely outside `[0..w-1, 0..h-1]`!
      const afterWorld = shiftWorldSelectionMask(
        moveSession.initialWorldSelection,
        moveSession.dx,
        moveSession.dy
      )
      const afterCanvasMask = projectWorldSelectionToCanvasMask(afterWorld, w, h)

      setMoveSession(null)
      playUiTick('draw', soundEnabled)
      commitUpdatedLayer(target, afterLayer, 'Move Selection', {
        before: moveSession.initialMask,
        after: afterCanvasMask,
        beforeWorld: moveSession.initialWorldSelection,
        afterWorld,
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
        connectivity: toolSettings.fillConnectivity,
        gradientType: toolSettings.gradientType,
        fixedRatio: toolSettings.gradientFixedRatio,
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

      cursorRef.current = nextPt
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
        if (toolRef.current === 'eyedropper') {
          const prev = prevToolBeforeEyedropperRef.current
          setTool(prev === 'eyedropper' ? 'pen' : prev)
        }
        // When invoked via double-tap while using another tool (e.g. pen, line, fill, shape),
        // `toolRef.current` is ALREADY that active tool, so we preserve it without clobbering!
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

  /**
   * Section 3: Sample color at the CURRENT in-app cursor (`cursorRef.current`).
   * Used by double-tap eyedropper so the sample coordinate is ALWAYS the cursor's pixel, NEVER the finger tap location!
   */
  const pickColorAtCurrentCursor = useCallback((): boolean => {
    const pt = cursorRef.current
    return pickColorAtCanvasPoint(pt, { restorePreviousTool: true })
  }, [pickColorAtCanvasPoint])

  const beginDrawAction = useCallback(
    (targetPoint?: Point, allowOutOfBounds = false) => {
      if (!project || !activeLayer || !activeLayerCanvasView) return
      if (isPlaying) {
        setIsPlaying(false)
      }
      if (moveSession) {
        commitActiveMove()
        return
      }
      if (floatingShape) {
        commitFloatingShape()
        return
      }
      if (activeLayer.locked && tool !== 'eyedropper' && tool !== 'select') {
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
              connectivity: toolSettings.fillConnectivity,
              gradientType: toolSettings.gradientType,
              fixedRatio: toolSettings.gradientFixedRatio,
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
        const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)
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
          const wandWorld = canvasMaskToWorldSelection(wandMask, w, h)
          const nextWorld = mergeWorldSelectionMasks(effectiveWorldSelection, wandWorld)
          const nextSel = projectWorldSelectionToCanvasMask(nextWorld, w, h)
          historyRef.current.push({
            id: generateId('hist'),
            label: 'Magic Wand Select',
            timestamp: Date.now(),
            kind: 'selection',
            beforeSelection: beforeSel,
            afterSelection: cloneSelectionMask(nextSel),
            beforeWorldSelection: beforeWorld,
            afterWorldSelection: cloneWorldSelectionMask(nextWorld),
          })
          syncHistoryCounts()
          setWorldSelection(nextWorld)
          setSelectionMask(nextSel)
          playUiTick('draw', soundEnabled)
        } else {
          if (stepPhase.kind !== 'select-end') {
            setStepPhase({ kind: 'select-end', start: pt })
            playUiTick('step', soundEnabled)
          } else {
            // Preserve true world-space rectangle/ellipse coordinates even if partially or wholly outside canvas!
            const partWorld =
              toolSettings.selectType === 'ellipse'
                ? selectWorldEllipseMask(stepPhase.start, pt)
                : selectWorldRectangleMask(stepPhase.start, pt)
            const nextWorld = mergeWorldSelectionMasks(
              effectiveWorldSelection,
              partWorld
            )
            const nextSel = projectWorldSelectionToCanvasMask(nextWorld, w, h)
            setStepPhase({ kind: 'idle' })
            historyRef.current.push({
              id: generateId('hist'),
              label: 'Area Select',
              timestamp: Date.now(),
              kind: 'selection',
              beforeSelection: beforeSel,
              afterSelection: cloneSelectionMask(nextSel),
              beforeWorldSelection: beforeWorld,
              afterWorldSelection: cloneWorldSelectionMask(nextWorld),
            })
            syncHistoryCounts()
            setWorldSelection(nextWorld)
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
      if (!project || !activeLayer || !effectiveWorldSelection) {
        return
      }
      const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)
      const beforeMask = cloneSelectionMask(
        projectWorldSelectionToCanvasMask(
          effectiveWorldSelection,
          project.width,
          project.height
        )
      )
      const { nextLayer, nextWorldSelection } = moveWorldSelectionOnLayer(
        activeLayer,
        effectiveWorldSelection,
        dx,
        dy
      )
      const afterMask = projectWorldSelectionToCanvasMask(
        nextWorldSelection,
        project.width,
        project.height
      )
      commitUpdatedLayer(activeLayer, nextLayer, 'Move Selection', {
        before: beforeMask,
        after: afterMask,
        beforeWorld,
        afterWorld: nextWorldSelection,
      })
    },
    [
      moveSession,
      updateActiveMoveOffset,
      project,
      activeLayer,
      effectiveWorldSelection,
      commitUpdatedLayer,
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
    if (!project || !activeLayer || !effectiveWorldSelection) return false
    const clip = copyWorldSelectionFromLayer(activeLayer, effectiveWorldSelection)
    if (!clip) return false
    setClipboard(clip)
    return true
  }, [project, activeLayer, effectiveWorldSelection])

  const cutSelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !effectiveWorldSelection) {
      return false
    }
    const { clipboard: clip, nextLayer } = cutWorldSelectionFromLayer(
      activeLayer,
      effectiveWorldSelection
    )
    if (!clip) return false
    setClipboard(clip)
    commitUpdatedLayer(activeLayer, nextLayer, 'Cut Selection')
    return true
  }, [project, activeLayer, effectiveWorldSelection, commitUpdatedLayer])

  const pasteClipboardPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !activeLayerCanvasView || !clipboard) return false
    const beforeMask = cloneSelectionMask(selectionMask)
    const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)

    // Stamp clipboard into world layer at (clipboard.offsetX, clipboard.offsetY) so even off-canvas clipboard coordinates preserve pixels!
    const afterLayer = stampBufferIntoLayerWorld(
      activeLayer,
      clipboard.data,
      clipboard.width,
      clipboard.height,
      clipboard.offsetX,
      clipboard.offsetY
    )
    const pastedMask = new Uint8Array(clipboard.width * clipboard.height)
    let anyNonTransparent = false
    for (let i = 0; i < clipboard.width * clipboard.height; i++) {
      if (clipboard.data[i * 4 + 3]! > 0) {
        pastedMask[i] = 1
        anyNonTransparent = true
      }
    }
    const afterWorld: WorldSelectionMask | null = anyNonTransparent
      ? {
          originX: clipboard.offsetX,
          originY: clipboard.offsetY,
          width: clipboard.width,
          height: clipboard.height,
          mask: pastedMask,
        }
      : {
          originX: clipboard.offsetX,
          originY: clipboard.offsetY,
          width: clipboard.width,
          height: clipboard.height,
          mask: new Uint8Array(clipboard.width * clipboard.height).fill(1),
        }
    const afterCanvasMask = projectWorldSelectionToCanvasMask(
      afterWorld,
      project.width,
      project.height
    )
    commitUpdatedLayer(activeLayer, afterLayer, 'Paste', {
      before: beforeMask,
      after: afterCanvasMask,
      beforeWorld,
      afterWorld,
    })
    return true
  }, [
    project,
    activeLayer,
    activeLayerCanvasView,
    clipboard,
    selectionMask,
    effectiveWorldSelection,
    commitUpdatedLayer,
  ])

  const flipSelectedPixels = useCallback(
    (direction: 'horizontal' | 'vertical') => {
      if (!project || !activeLayer || !effectiveWorldSelection) {
        return
      }
      const beforeMask = cloneSelectionMask(selectionMask)
      const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)
      const { nextLayer, nextWorldSelection } = flipWorldSelectionOnLayer(
        activeLayer,
        effectiveWorldSelection,
        direction
      )
      const afterMask = projectWorldSelectionToCanvasMask(
        nextWorldSelection,
        project.width,
        project.height
      )
      commitUpdatedLayer(activeLayer, nextLayer, 'Flip Selection', {
        before: beforeMask,
        after: afterMask,
        beforeWorld,
        afterWorld: nextWorldSelection,
      })
    },
    [
      project,
      activeLayer,
      selectionMask,
      effectiveWorldSelection,
      commitUpdatedLayer,
    ]
  )

  const invertCurrentSelection = useCallback(() => {
    if (!project) return
    const before = cloneSelectionMask(selectionMask)
    const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)
    const after = invertSelectionMask(
      effectiveSelectionMask,
      project.width,
      project.height
    )
    const afterWorld = canvasMaskToWorldSelection(after, project.width, project.height)
    historyRef.current.push({
      id: generateId('hist'),
      label: 'Invert Selection',
      timestamp: Date.now(),
      kind: 'selection',
      beforeSelection: before,
      afterSelection: cloneSelectionMask(after),
      beforeWorldSelection: beforeWorld,
      afterWorldSelection: cloneWorldSelectionMask(afterWorld),
    })
    syncHistoryCounts()
    setSelectionMask(after)
    setWorldSelection(afterWorld)
  }, [
    project,
    selectionMask,
    effectiveWorldSelection,
    effectiveSelectionMask,
    syncHistoryCounts,
  ])

  const clearCurrentSelection = useCallback(() => {
    if (moveSession?.mode === 'selection') {
      setMoveSession(null)
    }
    if (
      !hasAnySelectedPixel(selectionMask) &&
      !hasAnySelectedWorldPixel(effectiveWorldSelection)
    ) {
      setSelectionMask(null)
      setWorldSelection(null)
      setStepPhase({ kind: 'idle' })
      return
    }
    const before = cloneSelectionMask(selectionMask)
    const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)
    historyRef.current.push({
      id: generateId('hist'),
      label: 'Deselect',
      timestamp: Date.now(),
      kind: 'selection',
      beforeSelection: before,
      afterSelection: null,
      beforeWorldSelection: beforeWorld,
      afterWorldSelection: null,
    })
    syncHistoryCounts()
    setSelectionMask(null)
    setWorldSelection(null)
    setStepPhase({ kind: 'idle' })
  }, [moveSession, selectionMask, effectiveWorldSelection, syncHistoryCounts])

  const executeStructuralChange = useCallback(
    (
      label: string,
      mutator: (
        currentLayers: LayerRuntime[],
        currentActiveId: string,
        w: number,
        h: number,
        currentTimeline: TimelineState
      ) => {
        width: number
        height: number
        layers: LayerRuntime[]
        activeLayerId: string
        timeline?: TimelineState
        clearSelection?: boolean
      } | null
    ) => {
      if (!project) return false
      const curTl = timelineRef.current
      const beforeSnap = captureCanvasSnapshot(
        project.width,
        project.height,
        layers,
        activeLayerId,
        curTl
      )
      const beforeSel = cloneSelectionMask(selectionMask)
      const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)

      const mutated = mutator(
        layers,
        activeLayerId,
        project.width,
        project.height,
        curTl
      )
      if (!mutated) return false

      // Reconcile timeline automatically if mutator didn't construct an explicit TimelineState
      let resolvedTl: TimelineState
      if (mutated.timeline) {
        resolvedTl = {
          ...mutated.timeline,
          celBuffers: pruneUnreferencedCelBuffers(
            mutated.timeline.cels,
            mutated.timeline.celBuffers
          ),
        }
      } else {
        const nextCels: CelMap = {}
        const nextCelBuffers: Record<string, CelBufferRuntime> = {
          ...curTl.celBuffers,
        }
        const survivingLayerIds = new Set(mutated.layers.map((l) => l.id))
        const prevLayerMap = new Map(layers.map((l) => [l.id, l]))

        // Copy surviving cel mappings first
        for (const [k, v] of Object.entries(curTl.cels)) {
          const sep = k.indexOf(':')
          if (sep < 0) continue
          const lId = k.slice(0, sep)
          if (survivingLayerIds.has(lId)) {
            nextCels[k] = v
          }
        }

        // Sync active frame buffers & populate newly added layers across frames
        for (const nl of mutated.layers) {
          const existedBefore = prevLayerMap.has(nl.id)
          const activeKey = makeCellKey(nl.id, curTl.activeFrameId)

          if (!existedBefore) {
            // Newly created or duplicated layer
            for (const f of curTl.frames) {
              const fk = makeCellKey(nl.id, f.id)
              if (f.id === curTl.activeFrameId || curTl.frames.length === 1) {
                const cid = generateId('cel')
                nextCelBuffers[cid] = {
                  id: cid,
                  offsetX: nl.offsetX,
                  offsetY: nl.offsetY,
                  dataWidth: nl.dataWidth,
                  dataHeight: nl.dataHeight,
                  data: new Uint8ClampedArray(nl.data),
                }
                nextCels[fk] = { kind: 'cel', celId: cid }
              } else {
                nextCels[fk] = { kind: 'empty' }
              }
            }
          } else {
            const prevL = prevLayerMap.get(nl.id)!
            const changedGeometryOrPixels =
              prevL.data !== nl.data ||
              prevL.offsetX !== nl.offsetX ||
              prevL.offsetY !== nl.offsetY ||
              prevL.dataWidth !== nl.dataWidth ||
              prevL.dataHeight !== nl.dataHeight
            if (changedGeometryOrPixels) {
              const existingRef = nextCels[activeKey]
              if (existingRef?.kind === 'cel' && nextCelBuffers[existingRef.celId]) {
                nextCelBuffers[existingRef.celId] = {
                  id: existingRef.celId,
                  offsetX: nl.offsetX,
                  offsetY: nl.offsetY,
                  dataWidth: nl.dataWidth,
                  dataHeight: nl.dataHeight,
                  data: new Uint8ClampedArray(nl.data),
                }
              } else {
                const cid = generateId('cel')
                nextCelBuffers[cid] = {
                  id: cid,
                  offsetX: nl.offsetX,
                  offsetY: nl.offsetY,
                  dataWidth: nl.dataWidth,
                  dataHeight: nl.dataHeight,
                  data: new Uint8ClampedArray(nl.data),
                }
                nextCels[activeKey] = { kind: 'cel', celId: cid }
              }
            }
          }
        }

        resolvedTl = {
          ...curTl,
          cels: nextCels,
          celBuffers: pruneUnreferencedCelBuffers(nextCels, nextCelBuffers),
        }
      }

      const projectedLayers = projectFrameLayers(
        mutated.layers,
        resolvedTl.cels,
        resolvedTl.celBuffers,
        resolvedTl.activeFrameId,
        mutated.width,
        mutated.height
      )

      const afterSnap = captureCanvasSnapshot(
        mutated.width,
        mutated.height,
        projectedLayers,
        mutated.activeLayerId,
        resolvedTl
      )
      const afterSel = mutated.clearSelection ? null : beforeSel
      const afterWorld = mutated.clearSelection ? null : beforeWorld

      historyRef.current.push({
        id: generateId('hist'),
        label,
        timestamp: Date.now(),
        kind: 'structure',
        beforeStructure: beforeSnap,
        afterStructure: afterSnap,
        beforeSelection: beforeSel,
        afterSelection: afterSel,
        beforeWorldSelection: beforeWorld,
        afterWorldSelection: afterWorld,
      })
      syncHistoryCounts()

      const updatedProject: ProjectRecord = {
        ...project,
        width: mutated.width,
        height: mutated.height,
        activeLayerId: mutated.activeLayerId,
        frames: resolvedTl.frames,
        cels: resolvedTl.cels,
        activeFrameId: resolvedTl.activeFrameId,
        defaultFrameDurationMs: resolvedTl.defaultFrameDurationMs,
        playbackDirection: resolvedTl.playbackDirection,
        loopPlayback: resolvedTl.loopPlayback,
      }
      timelineRef.current = resolvedTl
      setTimeline(resolvedTl)
      setProject(updatedProject)
      setLayers(projectedLayers)
      setActiveLayerId(mutated.activeLayerId)
      if (mutated.clearSelection) {
        setSelectionMask(null)
        setWorldSelection(null)
      }
      setCursor((prev) => clampCanvasPoint(prev, mutated.width, mutated.height))

      persistCommittedState(
        updatedProject,
        projectedLayers,
        palette,
        selectedColorIndex,
        mutated.activeLayerId,
        resolvedTl
      )
      return true
    },
    [
      project,
      layers,
      activeLayerId,
      selectionMask,
      effectiveWorldSelection,
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
      return executeStructuralChange(
        'Duplicate Layer',
        (curr, _currActive, w, h, curTl) => {
          const idx = curr.findIndex((l) => l.id === layerId)
          if (idx < 0) return null
          const src = curr[idx]!
          const newId = generateId('layer')
          const copy: LayerRuntime = {
            ...src,
            id: newId,
            name: `${src.name} Copy`,
            data: new Uint8ClampedArray(src.data),
          }
          const next = [...curr.slice(0, idx + 1), copy, ...curr.slice(idx + 1)]

          // Clone cel structure across ALL frames (preserving linked-cel groupings within the new layer!)
          const nextCels: CelMap = { ...curTl.cels }
          const nextCelBuffers: Record<string, CelBufferRuntime> = {
            ...curTl.celBuffers,
          }
          const clonedCelIdMap = new Map<string, string>()
          for (const f of curTl.frames) {
            const srcRef = curTl.cels[makeCellKey(layerId, f.id)]
            const dstKey = makeCellKey(newId, f.id)
            if (!srcRef || srcRef.kind === 'empty' || !nextCelBuffers[srcRef.celId]) {
              nextCels[dstKey] = { kind: 'empty' }
            } else {
              let mappedId = clonedCelIdMap.get(srcRef.celId)
              if (!mappedId) {
                mappedId = generateId('cel')
                clonedCelIdMap.set(srcRef.celId, mappedId)
                const sb = nextCelBuffers[srcRef.celId]!
                nextCelBuffers[mappedId] = {
                  id: mappedId,
                  offsetX: sb.offsetX,
                  offsetY: sb.offsetY,
                  dataWidth: sb.dataWidth,
                  dataHeight: sb.dataHeight,
                  data: new Uint8ClampedArray(sb.data),
                }
              }
              nextCels[dstKey] = { kind: 'cel', celId: mappedId }
            }
          }

          return {
            width: w,
            height: h,
            layers: next,
            activeLayerId: newId,
            timeline: {
              ...curTl,
              cels: nextCels,
              celBuffers: nextCelBuffers,
            },
          }
        }
      )
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
      return executeStructuralChange(
        'Merge Down',
        (curr, _currActive, w, h, curTl) => {
          const idx = curr.findIndex((l) => l.id === layerId)
          if (idx <= 0) return null
          const lower = curr[idx - 1]!
          const upper = curr[idx]!

          const nextCels: CelMap = {}
          const nextCelBuffers: Record<string, CelBufferRuntime> = {
            ...curTl.celBuffers,
          }
          for (const [k, v] of Object.entries(curTl.cels)) {
            const sep = k.indexOf(':')
            const lId = sep >= 0 ? k.slice(0, sep) : ''
            if (lId !== upper.id && lId !== lower.id) {
              nextCels[k] = v
            }
          }

          let activeMergedGeo: ReturnType<typeof mergeTwoLayers> | null = null
          for (const f of curTl.frames) {
            const projectedPair = projectFrameLayers(
              [lower, upper],
              curTl.cels,
              curTl.celBuffers,
              f.id,
              w,
              h
            )
            const lowerRef = curTl.cels[makeCellKey(lower.id, f.id)]
            const upperRef = curTl.cels[makeCellKey(upper.id, f.id)]
            const bothEmpty =
              (!lowerRef || lowerRef.kind === 'empty') &&
              (!upperRef || upperRef.kind === 'empty')

            if (bothEmpty && curTl.frames.length > 1) {
              nextCels[makeCellKey(lower.id, f.id)] = { kind: 'empty' }
              continue
            }

            const m = mergeTwoLayers(projectedPair[0]!, projectedPair[1]!, w, h)
            if (f.id === curTl.activeFrameId) {
              activeMergedGeo = m
            }
            const cid = generateId('cel')
            nextCelBuffers[cid] = {
              id: cid,
              offsetX: m.offsetX,
              offsetY: m.offsetY,
              dataWidth: m.dataWidth,
              dataHeight: m.dataHeight,
              data: new Uint8ClampedArray(m.data),
            }
            nextCels[makeCellKey(lower.id, f.id)] = { kind: 'cel', celId: cid }
          }

          const merged = activeMergedGeo ?? mergeTwoLayers(lower, upper, w, h)
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
          return {
            width: w,
            height: h,
            layers: next,
            activeLayerId: mergedLayer.id,
            timeline: {
              ...curTl,
              cels: nextCels,
              celBuffers: pruneUnreferencedCelBuffers(nextCels, nextCelBuffers),
            },
          }
        }
      )
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
        Pick<
          LayerRuntime,
          'name' | 'visible' | 'locked' | 'opacity' | 'blendMode' | 'clipping'
        >
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

      const curTl = timelineRef.current
      const ref = curTl.cels[makeCellKey(layerId, curTl.activeFrameId)]
      const celId = ref?.kind === 'cel' ? ref.celId : undefined
      const nextCelBuffers = { ...curTl.celBuffers }
      if (celId && nextCelBuffers[celId]) {
        nextCelBuffers[celId] = {
          ...nextCelBuffers[celId]!,
          offsetX: afterOx,
          offsetY: afterOy,
        }
      }

      historyRef.current.push({
        id: generateId('hist'),
        label: 'Move Layer',
        timestamp: Date.now(),
        kind: 'layer-offset',
        frameId: curTl.activeFrameId,
        layerOffsetChange: {
          layerId,
          ...(celId ? { celId } : {}),
          beforeOffsetX: beforeOx,
          beforeOffsetY: beforeOy,
          afterOffsetX: afterOx,
          afterOffsetY: afterOy,
        },
      })
      syncHistoryCounts()

      const nextTl: TimelineState = {
        ...curTl,
        celBuffers: nextCelBuffers,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)

      const nextLayers = layers.map((l) =>
        l.id === layerId ? { ...l, offsetX: afterOx, offsetY: afterOy } : l
      )
      setLayers(nextLayers)
      persistCommittedState(
        project,
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
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
      executeStructuralChange('Resize Canvas', (curr, currActive, w, h, curTl) => {
        if (nw === w && nh === h) return null
        const {
          layers: resizedLayers,
          shiftX,
          shiftY,
        } = resizeLayersWithAnchor(curr, w, h, nw, nh, anchor)
        const shiftedCelBuffers: Record<string, CelBufferRuntime> = {}
        for (const [cid, cb] of Object.entries(curTl.celBuffers)) {
          shiftedCelBuffers[cid] = {
            ...cb,
            offsetX: cb.offsetX + shiftX,
            offsetY: cb.offsetY + shiftY,
          }
        }
        return {
          width: nw,
          height: nh,
          layers: resizedLayers,
          activeLayerId: currActive,
          timeline: {
            ...curTl,
            celBuffers: shiftedCelBuffers,
          },
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
        author: nextPalette.author,
        sourceUrl: nextPalette.sourceUrl,
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

    const curTl = timelineRef.current
    const prev = historyRef.current.undo({
      width: project.width,
      height: project.height,
      layers,
      activeLayerId,
      selectionMask,
      worldSelection: effectiveWorldSelection,
      palette,
      frames: curTl.frames,
      cels: curTl.cels,
      celBuffers: curTl.celBuffers,
      activeFrameId: curTl.activeFrameId,
    })
    if (!prev) return

    playUiTick('undo', soundEnabled)
    syncHistoryCounts()

    const nextTl: TimelineState =
      prev.frames && prev.cels && prev.celBuffers && prev.activeFrameId
        ? {
            ...curTl,
            frames: prev.frames,
            cels: prev.cels,
            celBuffers: prev.celBuffers,
            activeFrameId: prev.activeFrameId,
          }
        : createSingleFrameTimelineFromLayers(prev.layers, {
            frameId: curTl.activeFrameId,
            defaultFrameDurationMs: curTl.defaultFrameDurationMs,
            playbackDirection: curTl.playbackDirection,
            loopPlayback: curTl.loopPlayback,
          })

    timelineRef.current = nextTl
    setTimeline(nextTl)

    const updatedProj: ProjectRecord = {
      ...project,
      width: prev.width,
      height: prev.height,
      activeLayerId: prev.activeLayerId,
      frames: nextTl.frames,
      cels: nextTl.cels,
      activeFrameId: nextTl.activeFrameId,
    }
    const safeIdx =
      selectedColorIndex === TRANSPARENT_COLOR_INDEX
        ? TRANSPARENT_COLOR_INDEX
        : Math.min(selectedColorIndex, Math.max(0, prev.palette.colors.length - 1))
    setProject(updatedProj)
    setLayers(prev.layers)
    setActiveLayerId(prev.activeLayerId)
    setSelectionMask(prev.selectionMask)
    setWorldSelection(
      prev.worldSelection !== undefined
        ? prev.worldSelection
        : canvasMaskToWorldSelection(prev.selectionMask, prev.width, prev.height)
    )
    setPalette(prev.palette)
    setSelectedColorIndex(safeIdx)
    persistCommittedState(
      updatedProj,
      prev.layers,
      prev.palette,
      safeIdx,
      prev.activeLayerId,
      nextTl
    )
  }, [
    project,
    moveSession,
    floatingShape,
    stepPhase.kind,
    layers,
    activeLayerId,
    selectionMask,
    effectiveWorldSelection,
    palette,
    soundEnabled,
    syncHistoryCounts,
    selectedColorIndex,
    persistCommittedState,
  ])

  const redo = useCallback(() => {
    if (!project) return
    const curTl = timelineRef.current
    const next = historyRef.current.redo({
      width: project.width,
      height: project.height,
      layers,
      activeLayerId,
      selectionMask,
      worldSelection: effectiveWorldSelection,
      palette,
      frames: curTl.frames,
      cels: curTl.cels,
      celBuffers: curTl.celBuffers,
      activeFrameId: curTl.activeFrameId,
    })
    if (!next) return

    playUiTick('step', soundEnabled)
    syncHistoryCounts()

    const nextTl: TimelineState =
      next.frames && next.cels && next.celBuffers && next.activeFrameId
        ? {
            ...curTl,
            frames: next.frames,
            cels: next.cels,
            celBuffers: next.celBuffers,
            activeFrameId: next.activeFrameId,
          }
        : createSingleFrameTimelineFromLayers(next.layers, {
            frameId: curTl.activeFrameId,
            defaultFrameDurationMs: curTl.defaultFrameDurationMs,
            playbackDirection: curTl.playbackDirection,
            loopPlayback: curTl.loopPlayback,
          })

    timelineRef.current = nextTl
    setTimeline(nextTl)

    const updatedProj: ProjectRecord = {
      ...project,
      width: next.width,
      height: next.height,
      activeLayerId: next.activeLayerId,
      frames: nextTl.frames,
      cels: nextTl.cels,
      activeFrameId: nextTl.activeFrameId,
    }
    const safeIdx =
      selectedColorIndex === TRANSPARENT_COLOR_INDEX
        ? TRANSPARENT_COLOR_INDEX
        : Math.min(selectedColorIndex, Math.max(0, next.palette.colors.length - 1))
    setProject(updatedProj)
    setLayers(next.layers)
    setActiveLayerId(next.activeLayerId)
    setSelectionMask(next.selectionMask)
    setWorldSelection(
      next.worldSelection !== undefined
        ? next.worldSelection
        : canvasMaskToWorldSelection(next.selectionMask, next.width, next.height)
    )
    setPalette(next.palette)
    setSelectedColorIndex(safeIdx)
      persistCommittedState(
        updatedProj,
        next.layers,
        next.palette,
        safeIdx,
        next.activeLayerId,
        nextTl
      )
    }, [
      project,
      layers,
      activeLayerId,
      selectionMask,
      effectiveWorldSelection,
      palette,
      soundEnabled,
      syncHistoryCounts,
      selectedColorIndex,
      persistCommittedState,
    ])

  // ---------------------------------------------------------------------------
  // Unified Frame / Cel / Playback / Onion-Skin / Load Estimator Operations
  // ---------------------------------------------------------------------------

  const selectFrame = useCallback(
    (frameId: string) => {
      if (!project) return
      const curTl = timelineRef.current
      if (curTl.activeFrameId === frameId) return
      if (!curTl.frames.some((f) => f.id === frameId)) return

      if (moveSession) {
        setMoveSession(null)
      }
      if (floatingShape) {
        setFloatingShape(null)
      }
      if (stepPhase.kind !== 'idle') {
        setStepPhase({ kind: 'idle' })
      }

      const nextTl: TimelineState = {
        ...curTl,
        activeFrameId: frameId,
      }
      const nextLayers = projectFrameLayers(
        layers,
        nextTl.cels,
        nextTl.celBuffers,
        frameId,
        project.width,
        project.height
      )
      timelineRef.current = nextTl
      setTimeline(nextTl)
      setLayers(nextLayers)
      persistCommittedState(
        { ...project, activeFrameId: frameId },
        nextLayers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
      )
    },
    [
      project,
      moveSession,
      floatingShape,
      stepPhase.kind,
      layers,
      persistCommittedState,
      palette,
      selectedColorIndex,
      activeLayerId,
    ]
  )

  const stepFrame = useCallback(
    (delta: -1 | 1) => {
      const curTl = timelineRef.current
      if (curTl.frames.length <= 1) return
      const idx = curTl.frames.findIndex((f) => f.id === curTl.activeFrameId)
      if (idx < 0) return
      const nextIdx = (idx + delta + curTl.frames.length) % curTl.frames.length
      selectFrame(curTl.frames[nextIdx]!.id)
    },
    [selectFrame]
  )

  const addEmptyFrame = useCallback(
    (afterFrameId?: string): boolean => {
      setIsPlaying(false)
      return executeStructuralChange(
        'Add Empty Frame',
        (curr, currActive, w, h, curTl) => {
          const nextTl = insertNewFrame(curTl, curr, 'empty', afterFrameId)
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: nextTl,
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const duplicateFrame = useCallback(
    (mode: 'independent' | 'linked' = 'independent', frameId?: string): boolean => {
      setIsPlaying(false)
      return executeStructuralChange(
        mode === 'linked' ? 'Duplicate Linked Frame' : 'Duplicate Frame',
        (curr, currActive, w, h, curTl) => {
          const nextTl = insertNewFrame(
            curTl,
            curr,
            mode === 'linked' ? 'duplicate-linked' : 'duplicate-independent',
            frameId ?? curTl.activeFrameId
          )
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: nextTl,
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const deleteFrame = useCallback(
    (frameId?: string): boolean => {
      setIsPlaying(false)
      const targetId = frameId ?? timelineRef.current.activeFrameId
      if (timelineRef.current.frames.length <= 1) return false
      return executeStructuralChange(
        'Delete Frame',
        (curr, currActive, w, h, curTl) => {
          const nextTl = deleteFrameFromTimeline(curTl, targetId)
          if (!nextTl) return null
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: nextTl,
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const reorderFrames = useCallback(
    (orderedFrameIds: readonly string[]) => {
      executeStructuralChange(
        'Reorder Frames',
        (curr, currActive, w, h, curTl) => {
          const nextTl = reorderTimelineFrames(curTl, orderedFrameIds)
          if (nextTl === curTl) return null
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: nextTl,
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const setFrameDuration = useCallback(
    (frameId: string, durationMs: number) => {
      const clamped = clampFrameDurationMs(durationMs)
      executeStructuralChange(
        'Set Frame Duration',
        (curr, currActive, w, h, curTl) => {
          const target = curTl.frames.find((f) => f.id === frameId)
          if (!target || target.durationMs === clamped) return null
          const nextFrames = curTl.frames.map((f) =>
            f.id === frameId ? { ...f, durationMs: clamped } : f
          )
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, frames: nextFrames },
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const applyBatchDuration = useCallback(
    (
      scope:
        | { mode: 'selected'; selectedFrameIds: readonly string[] }
        | { mode: 'range'; fromFrameNumber: number; toFrameNumber: number }
        | { mode: 'all' },
      durationMs: number
    ): boolean => {
      return executeStructuralChange(
        'Batch Frame Duration',
        (curr, currActive, w, h, curTl) => {
          const ids = resolveBatchDurationTargetFrameIds(curTl.frames, scope)
          if (ids.length === 0) return null
          const nextFrames = applyBatchFrameDuration(curTl.frames, ids, durationMs)
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, frames: nextFrames },
          }
        }
      )
    },
    [executeStructuralChange]
  )

  // Cell-level operations
  const clearCell = useCallback(
    (layerId?: string, frameId?: string): boolean => {
      const lId = layerId ?? activeLayerId
      const fId = frameId ?? timelineRef.current.activeFrameId
      return executeStructuralChange(
        'Clear Cel to Empty',
        (curr, currActive, w, h, curTl) => {
          const res = setCellToEmpty(curTl.cels, curTl.celBuffers, lId, fId)
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, cels: res.cels, celBuffers: res.celBuffers },
          }
        }
      )
    },
    [activeLayerId, executeStructuralChange]
  )

  const unlinkCell = useCallback(
    (layerId?: string, frameId?: string): boolean => {
      const lId = layerId ?? activeLayerId
      const fId = frameId ?? timelineRef.current.activeFrameId
      return executeStructuralChange(
        'Unlink Cel',
        (curr, currActive, w, h, curTl) => {
          const res = unlinkCellToIndependent(
            curTl.cels,
            curTl.celBuffers,
            lId,
            fId
          )
          if (!res.changed) return null
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, cels: res.cels, celBuffers: res.celBuffers },
          }
        }
      )
    },
    [activeLayerId, executeStructuralChange]
  )

  const linkCellTo = useCallback(
    (layerId: string, sourceFrameId: string, targetFrameId: string): boolean => {
      return executeStructuralChange(
        'Link Cels',
        (curr, currActive, w, h, curTl) => {
          const res = linkCellToSourceCell(
            curTl.cels,
            curTl.celBuffers,
            layerId,
            sourceFrameId,
            targetFrameId
          )
          if (!res.changed) return null
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, cels: res.cels, celBuffers: res.celBuffers },
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const linkCellToAny = useCallback(
    (
      sourceLayerId: string,
      sourceFrameId: string,
      targetLayerId: string,
      targetFrameId: string
    ): boolean => {
      return executeStructuralChange(
        'Change to Linked Cel',
        (curr, currActive, w, h, curTl) => {
          const res = linkCellToAnySourceCell(
            curTl.cels,
            curTl.celBuffers,
            sourceLayerId,
            sourceFrameId,
            targetLayerId,
            targetFrameId
          )
          if (!res.changed) return null
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, cels: res.cels, celBuffers: res.celBuffers },
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const copyCellTo = useCallback(
    (layerId: string, sourceFrameId: string, targetFrameId: string): boolean => {
      return executeStructuralChange(
        'Copy Cel',
        (curr, currActive, w, h, curTl) => {
          const res = copyCellAsIndependent(
            curTl.cels,
            curTl.celBuffers,
            layerId,
            sourceFrameId,
            targetFrameId
          )
          if (!res.changed) return null
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: { ...curTl, cels: res.cels, celBuffers: res.celBuffers },
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const moveCellTo = useCallback(
    (layerId: string, sourceFrameId: string, targetFrameId: string): boolean => {
      if (sourceFrameId === targetFrameId) return false
      return executeStructuralChange(
        'Move Cel',
        (curr, currActive, w, h, curTl) => {
          const srcKey = makeCellKey(layerId, sourceFrameId)
          const dstKey = makeCellKey(layerId, targetFrameId)
          const srcRef = curTl.cels[srcKey] ?? { kind: 'empty' as const }
          const dstRef = curTl.cels[dstKey] ?? { kind: 'empty' as const }
          const nextCels: CelMap = {
            ...curTl.cels,
            [srcKey]: dstRef,
            [dstKey]: srcRef,
          }
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: {
              ...curTl,
              cels: nextCels,
              activeFrameId: targetFrameId,
            },
          }
        }
      )
    },
    [executeStructuralChange]
  )

  const toggleCellSelected = useCallback((cellKey: string) => {
    setSelectedCellKeys((prev) =>
      prev.includes(cellKey) ? prev.filter((k) => k !== cellKey) : [...prev, cellKey]
    )
  }, [])

  const clearCellSelection = useCallback(() => {
    setSelectedCellKeys([])
  }, [])

  const batchClearSelectedCells = useCallback((): boolean => {
    if (selectedCellKeys.length === 0) return false
    const ok = executeStructuralChange(
      'Clear Selected Cels',
      (curr, currActive, w, h, curTl) => {
        let nextCels = { ...curTl.cels }
        for (const ck of selectedCellKeys) {
          nextCels[ck] = { kind: 'empty' }
        }
        return {
          width: w,
          height: h,
          layers: curr,
          activeLayerId: currActive,
          timeline: {
            ...curTl,
            cels: nextCels,
            celBuffers: pruneUnreferencedCelBuffers(nextCels, curTl.celBuffers),
          },
        }
      }
    )
    if (ok) setSelectedCellKeys([])
    return ok
  }, [selectedCellKeys, executeStructuralChange])

  const batchUnlinkSelectedCells = useCallback((): boolean => {
    if (selectedCellKeys.length === 0) return false
    return executeStructuralChange(
      'Unlink Selected Cels',
      (curr, currActive, w, h, curTl) => {
        let nextCels = curTl.cels
        let nextBuffers = curTl.celBuffers
        let anyChanged = false
        for (const ck of selectedCellKeys) {
          const sep = ck.indexOf(':')
          if (sep < 0) continue
          const res = unlinkCellToIndependent(
            nextCels,
            nextBuffers,
            ck.slice(0, sep),
            ck.slice(sep + 1)
          )
          if (res.changed) {
            nextCels = res.cels
            nextBuffers = res.celBuffers
            anyChanged = true
          }
        }
        if (!anyChanged) return null
        return {
          width: w,
          height: h,
          layers: curr,
          activeLayerId: currActive,
          timeline: { ...curTl, cels: nextCels, celBuffers: nextBuffers },
        }
      }
    )
  }, [selectedCellKeys, executeStructuralChange])

  const batchLinkSelectedCells = useCallback((): boolean => {
    if (selectedCellKeys.length < 2) return false
    return executeStructuralChange(
      'Link Selected Cels',
      (curr, currActive, w, h, curTl) => {
        // Group selected cells by layerId; link within each layer to the earliest frame in timeline order
        const byLayer = new Map<string, string[]>()
        for (const ck of selectedCellKeys) {
          const sep = ck.indexOf(':')
          if (sep < 0) continue
          const lId = ck.slice(0, sep)
          const fId = ck.slice(sep + 1)
          const arr = byLayer.get(lId) ?? []
          arr.push(fId)
          byLayer.set(lId, arr)
        }
        const frameOrder = new Map(curTl.frames.map((f, idx) => [f.id, idx]))
        let nextCels = { ...curTl.cels }
        let nextBuffers = { ...curTl.celBuffers }
        let anyChanged = false

        for (const [lId, fIds] of byLayer.entries()) {
          if (fIds.length < 2) continue
          fIds.sort((a, b) => (frameOrder.get(a) ?? 0) - (frameOrder.get(b) ?? 0))
          // Pick first non-empty frame if available, else allocate a blank shared cel
          let srcFrameId =
            fIds.find((fid) => nextCels[makeCellKey(lId, fid)]?.kind === 'cel') ??
            fIds[0]!
          const srcKey = makeCellKey(lId, srcFrameId)
          if (nextCels[srcKey]?.kind !== 'cel') {
            const newCid = generateId('cel')
            nextBuffers[newCid] = {
              id: newCid,
              offsetX: 0,
              offsetY: 0,
              dataWidth: w,
              dataHeight: h,
              data: createPixelBuffer(w, h),
            }
            nextCels[srcKey] = { kind: 'cel', celId: newCid }
          }
          for (const dstFrameId of fIds) {
            if (dstFrameId === srcFrameId) continue
            const res = linkCellToSourceCell(
              nextCels,
              nextBuffers,
              lId,
              srcFrameId,
              dstFrameId
            )
            if (res.changed) {
              nextCels = res.cels
              nextBuffers = res.celBuffers
              anyChanged = true
            }
          }
        }
        if (!anyChanged) return null
        return {
          width: w,
          height: h,
          layers: curr,
          activeLayerId: currActive,
          timeline: { ...curTl, cels: nextCels, celBuffers: nextBuffers },
        }
      }
    )
  }, [selectedCellKeys, executeStructuralChange])

  const copyActiveCell = useCallback((): boolean => {
    const curTl = timelineRef.current
    const ref = curTl.cels[makeCellKey(activeLayerId, curTl.activeFrameId)]
    if (!ref || ref.kind === 'empty' || !curTl.celBuffers[ref.celId]) {
      setCelClipboard({
        offsetX: 0,
        offsetY: 0,
        dataWidth: project?.width ?? 1,
        dataHeight: project?.height ?? 1,
        data: new Uint8ClampedArray(0),
        isEmpty: true,
        sourceLayerId: activeLayerId,
        sourceFrameId: curTl.activeFrameId,
      })
      return true
    }
    const sb = curTl.celBuffers[ref.celId]!
    setCelClipboard({
      offsetX: sb.offsetX,
      offsetY: sb.offsetY,
      dataWidth: sb.dataWidth,
      dataHeight: sb.dataHeight,
      data: new Uint8ClampedArray(sb.data),
      isEmpty: false,
      sourceLayerId: activeLayerId,
      sourceFrameId: curTl.activeFrameId,
    })
    return true
  }, [activeLayerId, project])

  const pasteToActiveCell = useCallback(
    (asLinked = false): boolean => {
      if (!celClipboard) return false
      const targetLayerId = activeLayerId
      const targetFrameId = timelineRef.current.activeFrameId
      if (
        asLinked &&
        celClipboard.sourceLayerId === targetLayerId &&
        celClipboard.sourceFrameId !== targetFrameId
      ) {
        return linkCellTo(
          targetLayerId,
          celClipboard.sourceFrameId,
          targetFrameId
        )
      }
      return executeStructuralChange(
        'Paste Cel',
        (curr, currActive, w, h, curTl) => {
          const dstKey = makeCellKey(targetLayerId, targetFrameId)
          if (celClipboard.isEmpty) {
            const res = setCellToEmpty(
              curTl.cels,
              curTl.celBuffers,
              targetLayerId,
              targetFrameId
            )
            return {
              width: w,
              height: h,
              layers: curr,
              activeLayerId: currActive,
              timeline: { ...curTl, cels: res.cels, celBuffers: res.celBuffers },
            }
          }
          const cid = generateId('cel')
          const nextBuffers = {
            ...curTl.celBuffers,
            [cid]: {
              id: cid,
              offsetX: celClipboard.offsetX,
              offsetY: celClipboard.offsetY,
              dataWidth: celClipboard.dataWidth,
              dataHeight: celClipboard.dataHeight,
              data: new Uint8ClampedArray(celClipboard.data),
            },
          }
          const nextCels: CelMap = {
            ...curTl.cels,
            [dstKey]: { kind: 'cel', celId: cid },
          }
          return {
            width: w,
            height: h,
            layers: curr,
            activeLayerId: currActive,
            timeline: {
              ...curTl,
              cels: nextCels,
              celBuffers: pruneUnreferencedCelBuffers(nextCels, nextBuffers),
            },
          }
        }
      )
    },
    [celClipboard, activeLayerId, linkCellTo, executeStructuralChange]
  )

  const setDefaultFrameDuration = useCallback(
    (durationMs: number) => {
      if (!project) return
      const clamped = clampFrameDurationMs(durationMs)
      const nextTl: TimelineState = {
        ...timelineRef.current,
        defaultFrameDurationMs: clamped,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)
      persistCommittedState(
        { ...project, defaultFrameDurationMs: clamped },
        layers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
      )
    },
    [project, persistCommittedState, layers, palette, selectedColorIndex, activeLayerId]
  )

  // Playback Controls & Timer Loop
  const setPlaybackDirection = useCallback(
    (dir: PlaybackDirection) => {
      if (!project) return
      const nextTl: TimelineState = {
        ...timelineRef.current,
        playbackDirection: dir,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)
      persistCommittedState(
        { ...project, playbackDirection: dir },
        layers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
      )
    },
    [project, persistCommittedState, layers, palette, selectedColorIndex, activeLayerId]
  )

  const setLoopPlayback = useCallback(
    (loop: boolean) => {
      if (!project) return
      const nextTl: TimelineState = {
        ...timelineRef.current,
        loopPlayback: loop,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)
      persistCommittedState(
        { ...project, loopPlayback: loop },
        layers,
        palette,
        selectedColorIndex,
        activeLayerId,
        nextTl
      )
    },
    [project, persistCommittedState, layers, palette, selectedColorIndex, activeLayerId]
  )

  const togglePlay = useCallback(() => {
    if (timelineRef.current.frames.length <= 1) return
    setIsPlaying((prev) => !prev)
  }, [])

  const stopPlay = useCallback(() => {
    setIsPlaying(false)
  }, [])

  const playStepCursorRef = useRef<number>(0)
  useEffect(() => {
    if (!isPlaying || !project || timeline.frames.length <= 1) {
      if (isPlaying && timeline.frames.length <= 1) {
        setIsPlaying(false)
      }
      return
    }

    const seq = computePlaybackFrameIndices(
      timeline.frames.length,
      timeline.playbackDirection,
      !timeline.loopPlayback
    )
    if (seq.length === 0) return

    // Align initial step cursor to current activeFrameId if needed
    const curFrameIdx = timeline.frames.findIndex(
      (f) => f.id === timeline.activeFrameId
    )
    let seqPos = playStepCursorRef.current
    if (seqPos < 0 || seqPos >= seq.length || seq[seqPos] !== curFrameIdx) {
      const found = seq.indexOf(Math.max(0, curFrameIdx))
      seqPos = found >= 0 ? found : 0
      playStepCursorRef.current = seqPos
    }

    const activeFrameMeta = timeline.frames[seq[seqPos]!] ?? timeline.frames[0]!
    const effectiveDelay = Math.max(
      10,
      Math.round(activeFrameMeta.durationMs / Math.max(0.1, playbackSpeed))
    )

    const timer = window.setTimeout(() => {
      const nextPos = seqPos + 1
      if (nextPos >= seq.length) {
        if (!timeline.loopPlayback) {
          setIsPlaying(false)
          playStepCursorRef.current = 0
          return
        }
        playStepCursorRef.current = 0
      } else {
        playStepCursorRef.current = nextPos
      }

      const targetFrame =
        timelineRef.current.frames[seq[playStepCursorRef.current]!]
      if (!targetFrame) return
      const nextTl: TimelineState = {
        ...timelineRef.current,
        activeFrameId: targetFrame.id,
      }
      const nextLayers = projectFrameLayers(
        layers,
        nextTl.cels,
        nextTl.celBuffers,
        targetFrame.id,
        project.width,
        project.height
      )
      timelineRef.current = nextTl
      setTimeline(nextTl)
      setLayers(nextLayers)
    }, effectiveDelay)

    return () => window.clearTimeout(timer)
  }, [
    isPlaying,
    project,
    timeline.frames,
    timeline.activeFrameId,
    timeline.playbackDirection,
    timeline.loopPlayback,
    playbackSpeed,
    layers,
  ])

  const updateOnionSkin = useCallback((patch: Partial<OnionSkinConfig>) => {
    setOnionSkin((prev) => ({ ...prev, ...patch }))
  }, [])

  // Onion-skin composited buffers (multi-step weighted composite for Prev & Next frames)
  const { onionPrevBuffer, onionNextBuffer } = useMemo((): {
    onionPrevBuffer: Uint8ClampedArray | null
    onionNextBuffer: Uint8ClampedArray | null
  } => {
    if (
      !project ||
      !onionSkin.enabled ||
      isPlaying ||
      timeline.frames.length <= 1
    ) {
      return { onionPrevBuffer: null, onionNextBuffer: null }
    }
    const w = project.width
    const h = project.height
    const curIdx = timeline.frames.findIndex(
      (f) => f.id === timeline.activeFrameId
    )
    if (curIdx < 0) return { onionPrevBuffer: null, onionNextBuffer: null }

    const buildDirectionalBuffer = (
      dir: -1 | 1,
      count: number
    ): Uint8ClampedArray | null => {
      const acc = createPixelBuffer(w, h)
      let anyDrawn = false
      for (let step = count; step >= 1; step--) {
        let idx = curIdx + dir * step
        if (timeline.loopPlayback) {
          idx = (idx + timeline.frames.length * 4) % timeline.frames.length
          if (idx === curIdx) continue
        } else if (idx < 0 || idx >= timeline.frames.length) {
          continue
        }
        const f = timeline.frames[idx]
        if (!f) continue
        const fLayers = projectFrameLayers(
          layers,
          timeline.cels,
          timeline.celBuffers,
          f.id,
          w,
          h
        )
        const comp = compositeLayers(fLayers, w, h)
        const falloff = 1 / step
        for (let i = 0; i < comp.length; i += 4) {
          const sa = comp[i + 3]!
          if (sa === 0) continue
          anyDrawn = true
          const effA = Math.round(sa * falloff)
          if (effA >= acc[i + 3]!) {
            acc[i] = comp[i]!
            acc[i + 1] = comp[i + 1]!
            acc[i + 2] = comp[i + 2]!
            acc[i + 3] = effA
          }
        }
      }
      return anyDrawn ? acc : null
    }

    return {
      onionPrevBuffer: onionSkin.showPrev
        ? buildDirectionalBuffer(-1, Math.max(1, Math.min(3, onionSkin.prevCount)))
        : null,
      onionNextBuffer: onionSkin.showNext
        ? buildDirectionalBuffer(1, Math.max(1, Math.min(3, onionSkin.nextCount)))
        : null,
    }
  }, [
    project,
    onionSkin,
    isPlaying,
    timeline.frames,
    timeline.activeFrameId,
    timeline.loopPlayback,
    timeline.cels,
    timeline.celBuffers,
    layers,
  ])

  const loadEstimate = useMemo(() => {
    if (!project) return null
    return estimateProjectLoad({
      canvasWidth: project.width,
      canvasHeight: project.height,
      layers,
      frames: timeline.frames,
      cels: timeline.cels,
      celBuffers: timeline.celBuffers,
    })
  }, [project, layers, timeline.frames, timeline.cels, timeline.celBuffers])

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
    worldSelection: displayWorldSelection,
    hasSelection: effectiveWorldSelection !== null || effectiveSelectionMask !== null,
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
    pickColorAtCurrentCursor,
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
    // Timeline, Cels, Playback, Onion Skin & Load Estimate
    timeline,
    selectFrame,
    stepFrame,
    addEmptyFrame,
    duplicateFrame,
    deleteFrame,
    reorderFrames,
    setFrameDuration,
    setDefaultFrameDuration,
    applyBatchDuration,
    clearCell,
    unlinkCell,
    linkCellTo,
    linkCellToAny,
    copyCellTo,
    moveCellTo,
    selectedCellKeys,
    toggleCellSelected,
    clearCellSelection,
    batchClearSelectedCells,
    batchUnlinkSelectedCells,
    batchLinkSelectedCells,
    celClipboard,
    copyActiveCell,
    pasteToActiveCell,
    isPlaying,
    togglePlay,
    stopPlay,
    playbackSpeed,
    setPlaybackSpeed,
    setPlaybackDirection,
    setLoopPlayback,
    onionSkin,
    updateOnionSkin,
    onionPrevBuffer,
    onionNextBuffer,
    loadEstimate,
  }
}
