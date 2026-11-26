import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_OPAQUE_PALETTE_COLORS,
  TRANSPARENT_COLOR_INDEX,
  TRANSPARENT_INDEX,
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
  type SeamlessWrapMode,
  type SymmetryMode,
  type TilePreviewGrid,
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
import { hexToRgba, normalizeHex, rgbaToHex } from '../engine/color'
import {
  addColorToIndexedPalette,
  convertRgbaBuffersToIndexed,
  displaySlotToPixelIndex,
  extractUsedColorMap,
  findExactFixedIndex,
  findNearestFixedIndex,
  getHexForPixelIndex,
  normalizeProjectPalette,
  pixelIndexToDisplaySlot,
  remapClipboardToTargetPalette,
  updateIndexedPaletteSlotColor,
} from '../engine/indexedPalette'
import {
  createPixelBuffer,
  extractLayerCanvasView,
  flipLayerAroundCanvas,
  getPixelIndex,
  isInBounds,
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  resizeLayersWithAnchor,
  stampBufferIntoLayerWorld,
  writeLayerCanvasView,
} from '../engine/pixelBuffer'
import { shouldDrawWithDither, stampPoints } from '../engine/brush'
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
  type PixelPatch,
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
import { resolveCanvasPoint } from '../engine/symmetry'
import {
  countFixedIndexUsageAcrossProject,
  deletePaletteSlotWithReplacement,
  replaceColorAcrossTimeline,
} from '../engine/paletteTools'
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
  data: Uint8Array
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
  defaultSymmetryMode?: SymmetryMode
  defaultTilePreviewGrid?: TilePreviewGrid
  defaultSeamlessWrapMode?: SeamlessWrapMode
  sharedClipboard?: ClipboardBuffer | null
  onUpdateSharedClipboard?: (clip: ClipboardBuffer | null) => void
  onSaved?: () => void
  onQuotaTrimmed?: () => void
  onSaveError?: () => void
  onColorPicked?: (isTransparent: boolean) => void
  onPaletteLimitReached?: () => void
}

export function useEditorController(options: UseEditorOptions) {
  const {
    projectId,
    historyLimit,
    soundEnabled,
    defaultSymmetryMode = 'none',
    defaultTilePreviewGrid = 'off',
    defaultSeamlessWrapMode = 'none',
    sharedClipboard,
    onUpdateSharedClipboard,
    onSaved,
    onQuotaTrimmed,
    onSaveError,
    onColorPicked,
    onPaletteLimitReached,
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
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([])

  const [palette, setPalette] = useState<ProjectPalette>(() =>
    normalizeProjectPalette({
      name: 'Standard',
      colors: ['#000000', '#FFFFFF'],
    })
  )
  const [selectedColorIndex, setSelectedColorIndex] = useState<number>(0)

  const [tool, setTool] = useState<ToolId>('pen')
  const toolRef = useRef<ToolId>('pen')
  toolRef.current = tool
  const prevToolBeforeEyedropperRef = useRef<ToolId>('pen')
  const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS)
  const outlineColorExplicitRef = useRef<boolean>(false)

  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const cursorRef = useRef<Point>({ x: 0, y: 0 })
  cursorRef.current = cursor
  const [stepPhase, setStepPhase] = useState<MultiStepPhase>({ kind: 'idle' })
  const [floatingShape, setFloatingShape] = useState<FloatingShapeState | null>(null)
  const [moveSession, setMoveSession] = useState<ActiveMoveSession | null>(null)
  const [symmetryMode, setSymmetryMode] = useState<SymmetryMode>(defaultSymmetryMode)
  const [tilePreviewGrid, setTilePreviewGrid] =
    useState<TilePreviewGrid>(defaultTilePreviewGrid)
  const [seamlessWrapMode, setSeamlessWrapMode] =
    useState<SeamlessWrapMode>(defaultSeamlessWrapMode)
  const [selectionMask, setSelectionMask] = useState<Uint8Array | null>(null)
  const [worldSelection, setWorldSelection] = useState<WorldSelectionMask | null>(null)
  const [localClipboard, setLocalClipboard] = useState<ClipboardBuffer | null>(null)
  const clipboard =
    sharedClipboard !== undefined ? sharedClipboard : localClipboard
  const updateClipboard = useCallback(
    (next: ClipboardBuffer | null) => {
      setLocalClipboard(next)
      onUpdateSharedClipboard?.(next)
    },
    [onUpdateSharedClipboard]
  )

  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)

  const [isContinuousDrawing, setIsContinuousDrawing] = useState(false)
  const strokeRef = useRef<{
    active: boolean
    tool: 'pen' | 'eraser'
    layerId: string
    baseCanvasView: Uint8Array
    rawPoints: Point[]
    latestPreview: Uint8Array
  } | null>(null)

  const [liveStrokeBuffer, setLiveStrokeBuffer] = useState<{
    layerId: string
    data: Uint8Array
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

  // Sync editor canvas assist modes when user updates defaults in `/settings`
  useEffect(() => {
    setSymmetryMode(defaultSymmetryMode)
  }, [defaultSymmetryMode])

  useEffect(() => {
    setTilePreviewGrid(defaultTilePreviewGrid)
  }, [defaultTilePreviewGrid])

  useEffect(() => {
    setSeamlessWrapMode(defaultSeamlessWrapMode)
  }, [defaultSeamlessWrapMode])

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
      const normalizedPal = normalizeProjectPalette(loaded.project.palette)
      const loadedColors = normalizedPal.colors
      const initialColorIdx =
        loaded.project.selectedColorIndex === TRANSPARENT_COLOR_INDEX
          ? TRANSPARENT_COLOR_INDEX
          : Math.min(
              Math.max(0, loaded.project.selectedColorIndex),
              Math.max(0, loadedColors.length - 1)
            )
      const initialOpaqueHex =
        initialColorIdx >= 0 && loadedColors[initialColorIdx]
          ? loadedColors[initialColorIdx]!
          : loadedColors[0] ?? '#000000'

      setProject(loaded.project)
      setLayers(loaded.layers)
      setTimeline(loaded.timeline)
      timelineRef.current = loaded.timeline
      setSelectedCellKeys([])
      setIsPlaying(false)
      setActiveLayerId(loaded.project.activeLayerId || loaded.layers[0]?.id || '')
      setSelectedLayerIds([])
      setPalette(normalizedPal)
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
      setSymmetryMode(defaultSymmetryMode)
      setTilePreviewGrid(defaultTilePreviewGrid)
      setSeamlessWrapMode(defaultSeamlessWrapMode)
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
   * 1-byte Fixed Pixel Index (`0..254` for registered opaque palette slots, `255` for Transparent Slot)
   */
  const activePixelIndex = useMemo((): number => {
    return displaySlotToPixelIndex(palette, selectedColorIndex)
  }, [palette, selectedColorIndex])

  // Keep Selection Outline color synced with registered palette colors
  useEffect(() => {
    if (palette.colors.length === 0) return
    const fallbackColor =
      selectedColorIndex >= 0 && palette.colors[selectedColorIndex]
        ? palette.colors[selectedColorIndex]!
        : palette.colors[0]!

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
      const normalizedPal = normalizeProjectPalette(nextPalette)
      const projToSave: ProjectRecord = {
        ...nextProj,
        pixelFormat: 'indexed-v1',
        activeLayerId: nextActiveLayerId,
        frames: tlToSave.frames,
        cels: tlToSave.cels,
        activeFrameId: tlToSave.activeFrameId,
        defaultFrameDurationMs: tlToSave.defaultFrameDurationMs,
        playbackDirection: tlToSave.playbackDirection,
        loopPlayback: tlToSave.loopPlayback,
        palette: normalizedPal,
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
      },
      paletteTransition?: {
        beforePalette: ProjectPalette
        afterPalette: ProjectPalette
      }
    ) => {
      if (!project) return
      const curTl = timelineRef.current
      const activeFrameId = curTl.activeFrameId
      const cellKey = makeCellKey(beforeLayer.id, activeFrameId)
      const existingRef = curTl.cels[cellKey]

      const baseDiff = createLayerPixelPatch(beforeLayer, afterLayer)
      if (!baseDiff && !selectionTransition && !paletteTransition) return

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
          data: new Uint8Array(afterLayer.data),
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
        kind: patch ? 'pixel-diff' : paletteTransition ? 'palette' : 'selection',
        frameId: activeFrameId,
        celAllocation,
        pixelPatches: patch ? [patch] : undefined,
        beforeSelection: selectionTransition?.before,
        afterSelection: selectionTransition?.after,
        beforeWorldSelection: selectionTransition
          ? cloneWorldSelectionMask(resolvedBeforeWorld)
          : undefined,
        afterWorldSelection: selectionTransition
          ? cloneWorldSelectionMask(resolvedAfterWorld)
          : undefined,
        ...(paletteTransition
          ? {
              beforePalette: normalizeProjectPalette(paletteTransition.beforePalette),
              afterPalette: normalizeProjectPalette(paletteTransition.afterPalette),
            }
          : {}),
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
      const effectivePalette = paletteTransition ? paletteTransition.afterPalette : palette
      if (paletteTransition) {
        setPalette(effectivePalette)
      }
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
        effectivePalette,
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
      afterCanvasView: Uint8Array,
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

  const commitFloatingShape = useCallback(() => {
    if (!floatingShape || !project || !activeLayer || !activeLayerCanvasView) return
    const afterView = compositeFloatingShapeOntoLayer(
      activeLayerCanvasView,
      project.width,
      project.height,
      floatingShape,
      effectiveSelectionMask,
      symmetryMode,
      seamlessWrapMode
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
    symmetryMode,
    seamlessWrapMode,
    soundEnabled,
    commitLayerCanvasViewChange,
  ])

  const discardFloatingShape = useCallback(() => {
    setFloatingShape(null)
  }, [])

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
        layerId: movingLayers[0]!.id,
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

  const previewLayerOverride = useMemo((): {
    layerId: string
    data: Uint8Array
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
          effectiveSelectionMask,
          symmetryMode,
          seamlessWrapMode
        ),
      }
    }

    if (stepPhase.kind === 'gradient-end') {
      const buf = new Uint8Array(activeLayerCanvasView)
      applyGradientFloodFill(buf, {
        width: w,
        height: h,
        startX: stepPhase.start.x,
        startY: stepPhase.start.y,
        endX: cursor.x,
        endY: cursor.y,
        colorIndex: activePixelIndex,
        connectivity: toolSettings.fillConnectivity,
        gradientType: toolSettings.gradientType,
        fixedRatio: toolSettings.gradientFixedRatio,
        steps: toolSettings.gradientSteps,
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'line-end') {
      const buf = new Uint8Array(activeLayerCanvasView)
      drawLine(buf, stepPhase.start, cursor, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        pixelPerfect: toolSettings.linePixelPerfect,
        colorIndex: activePixelIndex,
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'bezier-p3') {
      const buf = new Uint8Array(activeLayerCanvasView)
      drawLine(buf, stepPhase.p0, cursor, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        pixelPerfect: toolSettings.linePixelPerfect,
        colorIndex: activePixelIndex,
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'bezier-p1') {
      const buf = new Uint8Array(activeLayerCanvasView)
      drawCubicBezier(buf, stepPhase.p0, cursor, stepPhase.p3, stepPhase.p3, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        colorIndex: activePixelIndex,
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'bezier-p2') {
      const buf = new Uint8Array(activeLayerCanvasView)
      drawCubicBezier(buf, stepPhase.p0, stepPhase.p1, cursor, stepPhase.p3, {
        width: w,
        height: h,
        size: toolSettings.lineSize,
        shape: toolSettings.lineShape,
        dither: toolSettings.lineDither,
        colorIndex: activePixelIndex,
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'shape-end') {
      const buf = new Uint8Array(activeLayerCanvasView)
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
        colorIndex: activePixelIndex,
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      }
      if (toolSettings.shapeType === 'rect') {
        rasterizeRectangle(buf, bounds, shapeOpts)
      } else {
        rasterizeEllipse(buf, bounds, shapeOpts)
      }
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'idle' && (tool === 'pen' || tool === 'eraser' || tool === 'line')) {
      const buf = new Uint8Array(activeLayerCanvasView)
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
        colorIndex: activePixelIndex,
        dither: brushDither,
        erase: tool === 'eraser',
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
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
    activePixelIndex,
    toolSettings,
    tool,
    symmetryMode,
    seamlessWrapMode,
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
      return compositeLayers(previewLayers, project.width, project.height, {
        palette,
      })
    }
    return compositeLayers(layers, project.width, project.height, {
      palette,
      previewLayerOverride,
    })
  }, [project, layers, moveSession, palette, previewLayerOverride])

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
      baseCanvasView: Uint8Array,
      mode: 'pen' | 'eraser'
    ) => {
      if (!project) return baseCanvasView
      const nextBuf = new Uint8Array(baseCanvasView)
      const pts =
        mode === 'pen' && toolSettings.pixelPerfect
          ? filterPixelPerfectPoints(rawPoints)
          : expandStrokePoints(rawPoints)

      stampPoints(nextBuf, pts, {
        width: project.width,
        height: project.height,
        size: mode === 'pen' ? toolSettings.penSize : toolSettings.eraserSize,
        shape: mode === 'pen' ? toolSettings.penShape : toolSettings.eraserShape,
        colorIndex: activePixelIndex,
        dither: mode === 'pen' ? toolSettings.penDither : 1,
        erase: mode === 'eraser',
        selectionMask: effectiveSelectionMask,
        symmetry: symmetryMode,
        seamlessWrap: seamlessWrapMode,
      })
      return nextBuf
    },
    [
      project,
      toolSettings,
      activePixelIndex,
      effectiveSelectionMask,
      symmetryMode,
      seamlessWrapMode,
    ]
  )

  const moveCursorTo = useCallback(
    (pt: Point, allowOutOfBounds = false) => {
      if (!project) return
      const seamlessActive = seamlessWrapMode !== 'none'
      const wrappedForCursor = seamlessActive
        ? resolveCanvasPoint(
            pt.x,
            pt.y,
            project.width,
            project.height,
            seamlessWrapMode
          ) ?? clampCanvasPoint(pt, project.width, project.height)
        : clampCanvasPoint(pt, project.width, project.height)

      const nextPt =
        allowOutOfBounds && !seamlessActive
          ? normalizeWorldPoint(pt)
          : allowOutOfBounds &&
              seamlessActive &&
              (tool === 'line' || tool === 'shape' || tool === 'select')
            ? normalizeWorldPoint(pt)
            : wrappedForCursor

      cursorRef.current = nextPt
      setCursor((prev) =>
        prev.x === nextPt.x && prev.y === nextPt.y ? prev : nextPt
      )

      const st = strokeRef.current
      if (st && st.active) {
        const strokePt = seamlessActive
          ? normalizeWorldPoint(pt)
          : clampCanvasPoint(pt, project.width, project.height)
        const last = st.rawPoints[st.rawPoints.length - 1]
        if (!last || last.x !== strokePt.x || last.y !== strokePt.y) {
          st.rawPoints.push(strokePt)
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
    [project, seamlessWrapMode, tool, recomputeContinuousStroke]
  )

  /**
   * Section 7-5: Indexed Color Eyedropper
   * - Never mutates pixel data.
   * - If composited pixel is transparent (`a === 0`), selects Transparent Slot (`-1`).
   * - If active layer is normal 100% opaque and has a fixed index at `(pt.x, pt.y)` with no upper visible layer covering it,
   *   directly selects that fixed index's display slot!
   * - Otherwise resolves the composited RGB to an exact palette match, or registers it if `< 255` opaque colors,
   *   or selects the nearest registered palette color and triggers `onPaletteLimitReached` when at the 255-color cap.
   */
  const pickColorAtCanvasPoint = useCallback(
    (pt: Point, opts?: { restorePreviousTool?: boolean }): boolean => {
      if (!project) return false
      const w = project.width
      const h = project.height
      if (!isInBounds(pt.x, pt.y, w, h)) return false

      const comp = compositeLayers(layers, w, h, { palette })
      const off = (pt.y * w + pt.x) * 4
      const r = comp[off]!
      const g = comp[off + 1]!
      const b = comp[off + 2]!
      const a = comp[off + 3]!

      if (a === 0) {
        setSelectedColorIndex(TRANSPARENT_COLOR_INDEX)
        playUiTick('step', soundEnabled)
        onColorPicked?.(true)
      } else {
        // Check topmost visible normal 100%-opacity unclipped layer for direct fixed-index hit
        let directFixedHit: number | null = null
        for (let li = layers.length - 1; li >= 0; li--) {
          const l = layers[li]!
          if (!l.visible || l.opacity <= 0) continue
          const view = extractLayerCanvasView(l, w, h)
          const pxIdx = getPixelIndex(view, w, h, pt.x, pt.y)
          if (pxIdx === TRANSPARENT_INDEX) continue
          if (l.opacity === 100 && l.blendMode === 'normal' && !l.clipping) {
            directFixedHit = pxIdx
          }
          break
        }

        if (directFixedHit !== null) {
          const dispSlot = pixelIndexToDisplaySlot(palette, directFixedHit)
          if (dispSlot >= 0) {
            setSelectedColorIndex(dispSlot)
          }
        } else {
          const hex = rgbaToHex({ r, g, b }).toUpperCase()
          const exactFixed = findExactFixedIndex(palette, hex)
          if (exactFixed >= 0) {
            const dispSlot = pixelIndexToDisplaySlot(palette, exactFixed)
            setSelectedColorIndex(Math.max(0, dispSlot))
          } else if (palette.colors.length < MAX_OPAQUE_PALETTE_COLORS) {
            const added = addColorToIndexedPalette(palette, hex)
            if (added.added && added.displayIndex >= 0) {
              setPalette(added.palette)
              setSelectedColorIndex(added.displayIndex)
              persistCommittedState(
                project,
                layers,
                added.palette,
                added.displayIndex,
                activeLayerId
              )
            }
          } else {
            // Palette has reached 255 opaque colors: never overwrite a fixed slot (which would corrupt pixels!);
            // select the closest registered color and notify the user!
            const nearFixed = findNearestFixedIndex(palette, r, g, b)
            const dispSlot = pixelIndexToDisplaySlot(palette, nearFixed)
            setSelectedColorIndex(Math.max(0, dispSlot))
            onPaletteLimitReached?.()
          }
        }
        playUiTick('step', soundEnabled)
        onColorPicked?.(false)
      }

      if (opts?.restorePreviousTool) {
        if (toolRef.current === 'eyedropper') {
          const prev = prevToolBeforeEyedropperRef.current
          setTool(prev === 'eyedropper' ? 'pen' : prev)
        }
      }
      return true
    },
    [
      project,
      layers,
      palette,
      soundEnabled,
      onColorPicked,
      persistCommittedState,
      activeLayerId,
      onPaletteLimitReached,
    ]
  )

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
        seamlessWrapMode !== 'none' ||
        tool === 'line' ||
        tool === 'shape' ||
        (tool === 'fill' &&
          toolSettings.fillMode === 'gradient' &&
          stepPhase.kind === 'gradient-end') ||
        (tool === 'select' && toolSettings.selectType !== 'wand')

      const pt = targetPoint
        ? allowOutOfBounds || supportsOutOfCanvasEndpoint
          ? normalizeWorldPoint(targetPoint)
          : clampCanvasPoint(targetPoint, project.width, project.height)
        : supportsOutOfCanvasEndpoint
          ? normalizeWorldPoint(cursor)
          : clampCanvasPoint(cursor, project.width, project.height)

      if (targetPoint) {
        const displayCursor =
          seamlessWrapMode !== 'none' &&
          tool !== 'line' &&
          tool !== 'shape' &&
          tool !== 'select'
            ? resolveCanvasPoint(
                pt.x,
                pt.y,
                project.width,
                project.height,
                seamlessWrapMode
              ) ?? clampCanvasPoint(pt, project.width, project.height)
            : pt
        setCursor(displayCursor)
      }

      const w = project.width
      const h = project.height

      if (tool === 'pen' || tool === 'eraser') {
        if (!activeLayer.visible) return
        const startStrokePt =
          seamlessWrapMode !== 'none' ? pt : clampCanvasPoint(pt, w, h)
        const baseCopy = new Uint8Array(activeLayerCanvasView)
        const initialPreview = recomputeContinuousStroke([startStrokePt], baseCopy, tool)
        strokeRef.current = {
          active: true,
          tool,
          layerId: activeLayer.id,
          baseCanvasView: baseCopy,
          rawPoints: [startStrokePt],
          latestPreview: initialPreview,
        }
        setIsContinuousDrawing(true)
        setLiveStrokeBuffer({ layerId: activeLayer.id, data: initialPreview })
        playUiTick('draw', soundEnabled)
        return
      }

      if (tool === 'eyedropper') {
        const clampedPt =
          seamlessWrapMode !== 'none'
            ? resolveCanvasPoint(pt.x, pt.y, w, h, seamlessWrapMode) ??
              clampCanvasPoint(pt, w, h)
            : clampCanvasPoint(pt, w, h)
        pickColorAtCanvasPoint(clampedPt, { restorePreviousTool: true })
        return
      }

      if (tool === 'fill') {
        if (!activeLayer.visible) return
        if (toolSettings.fillMode === 'normal') {
          const seedPt =
            seamlessWrapMode !== 'none'
              ? resolveCanvasPoint(pt.x, pt.y, w, h, seamlessWrapMode) ??
                clampCanvasPoint(pt, w, h)
              : clampCanvasPoint(pt, w, h)
          const after = new Uint8Array(activeLayerCanvasView)
          applyFloodFill(after, {
            width: w,
            height: h,
            seedX: seedPt.x,
            seedY: seedPt.y,
            colorIndex: activePixelIndex,
            connectivity: toolSettings.fillConnectivity,
            dither: toolSettings.fillDither,
            selectionMask: effectiveSelectionMask,
            symmetry: symmetryMode,
            seamlessWrap: seamlessWrapMode,
          })
          playUiTick('draw', soundEnabled)
          commitLayerCanvasViewChange(activeLayer.id, after, 'Fill')
        } else {
          if (stepPhase.kind !== 'gradient-end') {
            const clampedStart =
              seamlessWrapMode !== 'none'
                ? resolveCanvasPoint(pt.x, pt.y, w, h, seamlessWrapMode) ??
                  clampCanvasPoint(pt, w, h)
                : clampCanvasPoint(pt, w, h)
            setStepPhase({ kind: 'gradient-end', start: clampedStart })
            playUiTick('step', soundEnabled)
          } else {
            const after = new Uint8Array(activeLayerCanvasView)
            applyGradientFloodFill(after, {
              width: w,
              height: h,
              startX: stepPhase.start.x,
              startY: stepPhase.start.y,
              endX: pt.x,
              endY: pt.y,
              colorIndex: activePixelIndex,
              connectivity: toolSettings.fillConnectivity,
              gradientType: toolSettings.gradientType,
              fixedRatio: toolSettings.gradientFixedRatio,
              steps: toolSettings.gradientSteps,
              selectionMask: effectiveSelectionMask,
              symmetry: symmetryMode,
              seamlessWrap: seamlessWrapMode,
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
            const after = new Uint8Array(activeLayerCanvasView)
            drawLine(after, stepPhase.start, pt, {
              width: w,
              height: h,
              size: toolSettings.lineSize,
              shape: toolSettings.lineShape,
              dither: toolSettings.lineDither,
              pixelPerfect: toolSettings.linePixelPerfect,
              colorIndex: activePixelIndex,
              selectionMask: effectiveSelectionMask,
              symmetry: symmetryMode,
              seamlessWrap: seamlessWrapMode,
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
            const after = new Uint8Array(activeLayerCanvasView)
            drawCubicBezier(after, stepPhase.p0, stepPhase.p1, pt, stepPhase.p3, {
              width: w,
              height: h,
              size: toolSettings.lineSize,
              shape: toolSettings.lineShape,
              dither: toolSettings.lineDither,
              colorIndex: activePixelIndex,
              selectionMask: effectiveSelectionMask,
              symmetry: symmetryMode,
              seamlessWrap: seamlessWrapMode,
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

          // When Transparent Slot (`TRANSPARENT_INDEX`) is selected, apply transparent shape directly to active layer
          if (activePixelIndex === TRANSPARENT_INDEX) {
            const after = new Uint8Array(activeLayerCanvasView)
            const shapeOpts = {
              width: w,
              height: h,
              filled: toolSettings.shapeFilled,
              strokeSize: toolSettings.shapeSize,
              dither: toolSettings.shapeDither,
              colorIndex: TRANSPARENT_INDEX,
              selectionMask: effectiveSelectionMask,
              symmetry: symmetryMode,
              seamlessWrap: seamlessWrapMode,
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

          const sw = Math.max(1, Math.min(1024, bounds.width))
          const sh = Math.max(1, Math.min(1024, bounds.height))
          const localBuf = createPixelBuffer(sw, sh)

          const solidLocalOpts = {
            width: sw,
            height: sh,
            filled: toolSettings.shapeFilled,
            strokeSize: toolSettings.shapeSize,
            dither: 1 as const,
            colorIndex: activePixelIndex,
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
            for (let ly = 0; ly < sh; ly++) {
              const worldY = bounds.minY + ly
              for (let lx = 0; lx < sw; lx++) {
                const idx = ly * sw + lx
                if (localBuf[idx] === TRANSPARENT_INDEX) continue
                const worldX = bounds.minX + lx
                if (!shouldDrawWithDither(toolSettings.shapeDither, worldX, worldY)) {
                  localBuf[idx] = TRANSPARENT_INDEX
                }
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
      isPlaying,
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
      activePixelIndex,
      effectiveSelectionMask,
      effectiveWorldSelection,
      symmetryMode,
      seamlessWrapMode,
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
    const validHex =
      palette.colors.find(
        (c) => c.toUpperCase() === toolSettings.outlineColor.toUpperCase()
      ) ??
      (selectedColorIndex >= 0 && palette.colors[selectedColorIndex]
        ? palette.colors[selectedColorIndex]!
        : palette.colors[0] ?? '#000000')
    const fixedIdx = findExactFixedIndex(palette, validHex)
    const outlineColorIdx =
      fixedIdx >= 0
        ? fixedIdx
        : displaySlotToPixelIndex(palette, selectedColorIndex >= 0 ? selectedColorIndex : 0)

    const nextBuffer = applySelectionOutline(
      activeLayerCanvasView,
      effectiveSelectionMask,
      project.width,
      project.height,
      toolSettings.outlineMode,
      toolSettings.outlineSize,
      outlineColorIdx
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
    palette,
    toolSettings,
    selectedColorIndex,
    commitLayerCanvasViewChange,
  ])

  const copySelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !effectiveWorldSelection) return false
    const clip = copyWorldSelectionFromLayer(
      activeLayer,
      effectiveWorldSelection,
      palette
    )
    if (!clip) return false
    updateClipboard(clip)
    return true
  }, [project, activeLayer, effectiveWorldSelection, palette, updateClipboard])

  const cutSelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !effectiveWorldSelection) {
      return false
    }
    const { clipboard: clip, nextLayer } = cutWorldSelectionFromLayer(
      activeLayer,
      effectiveWorldSelection,
      palette
    )
    if (!clip) return false
    updateClipboard(clip)
    commitUpdatedLayer(activeLayer, nextLayer, 'Cut Selection')
    return true
  }, [
    project,
    activeLayer,
    effectiveWorldSelection,
    palette,
    updateClipboard,
    commitUpdatedLayer,
  ])

  const pasteClipboardPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !activeLayerCanvasView || !clipboard) return false
    const beforeMask = cloneSelectionMask(selectionMask)
    const beforeWorld = cloneWorldSelectionMask(effectiveWorldSelection)

    const remapped = remapClipboardToTargetPalette(clipboard, palette)

    const intersectsCanvas =
      clipboard.offsetX < project.width &&
      clipboard.offsetX + clipboard.width > 0 &&
      clipboard.offsetY < project.height &&
      clipboard.offsetY + clipboard.height > 0
    const targetOffsetX = intersectsCanvas
      ? clipboard.offsetX
      : Math.max(0, Math.min(project.width - clipboard.width, clipboard.offsetX))
    const targetOffsetY = intersectsCanvas
      ? clipboard.offsetY
      : Math.max(0, Math.min(project.height - clipboard.height, clipboard.offsetY))

    const afterLayer = stampBufferIntoLayerWorld(
      activeLayer,
      remapped.data,
      clipboard.width,
      clipboard.height,
      targetOffsetX,
      targetOffsetY
    )
    const pastedMask = new Uint8Array(clipboard.width * clipboard.height)
    let anyNonTransparent = false
    for (let i = 0; i < clipboard.width * clipboard.height; i++) {
      if (remapped.data[i] !== TRANSPARENT_INDEX) {
        pastedMask[i] = 1
        anyNonTransparent = true
      }
    }
    const afterWorld: WorldSelectionMask | null = anyNonTransparent
      ? {
          originX: targetOffsetX,
          originY: targetOffsetY,
          width: clipboard.width,
          height: clipboard.height,
          mask: pastedMask,
        }
      : {
          originX: targetOffsetX,
          originY: targetOffsetY,
          width: clipboard.width,
          height: clipboard.height,
          mask: new Uint8Array(clipboard.width * clipboard.height).fill(1),
        }
    const afterCanvasMask = projectWorldSelectionToCanvasMask(
      afterWorld,
      project.width,
      project.height
    )
    commitUpdatedLayer(
      activeLayer,
      afterLayer,
      'Paste',
      {
        before: beforeMask,
        after: afterCanvasMask,
        beforeWorld,
        afterWorld,
      },
      remapped.paletteChanged
        ? { beforePalette: palette, afterPalette: remapped.palette }
        : undefined
    )
    return true
  }, [
    project,
    activeLayer,
    activeLayerCanvasView,
    clipboard,
    palette,
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
        currentTimeline: TimelineState,
        currentPalette: ProjectPalette
      ) => {
        width: number
        height: number
        layers: LayerRuntime[]
        activeLayerId: string
        timeline?: TimelineState
        palette?: ProjectPalette
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
        curTl,
        palette
      )
      if (!mutated) return false

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

        for (const [k, v] of Object.entries(curTl.cels)) {
          const sep = k.indexOf(':')
          if (sep < 0) continue
          const lId = k.slice(0, sep)
          if (survivingLayerIds.has(lId)) {
            nextCels[k] = v
          }
        }

        for (const nl of mutated.layers) {
          const existedBefore = prevLayerMap.has(nl.id)
          const activeKey = makeCellKey(nl.id, curTl.activeFrameId)

          if (!existedBefore) {
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
                  data: new Uint8Array(nl.data),
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
                  data: new Uint8Array(nl.data),
                }
              } else {
                const cid = generateId('cel')
                nextCelBuffers[cid] = {
                  id: cid,
                  offsetX: nl.offsetX,
                  offsetY: nl.offsetY,
                  dataWidth: nl.dataWidth,
                  dataHeight: nl.dataHeight,
                  data: new Uint8Array(nl.data),
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
      const resolvedPalette = mutated.palette
        ? normalizeProjectPalette(mutated.palette)
        : palette

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
        ...(mutated.palette
          ? {
              beforePalette: normalizeProjectPalette(palette),
              afterPalette: resolvedPalette,
            }
          : {}),
      })
      syncHistoryCounts()

      const updatedProject: ProjectRecord = {
        ...project,
        pixelFormat: 'indexed-v1',
        width: mutated.width,
        height: mutated.height,
        activeLayerId: mutated.activeLayerId,
        frames: resolvedTl.frames,
        cels: resolvedTl.cels,
        activeFrameId: resolvedTl.activeFrameId,
        defaultFrameDurationMs: resolvedTl.defaultFrameDurationMs,
        playbackDirection: resolvedTl.playbackDirection,
        loopPlayback: resolvedTl.loopPlayback,
        palette: resolvedPalette,
      }
      timelineRef.current = resolvedTl
      setTimeline(resolvedTl)
      setProject(updatedProject)
      setLayers(projectedLayers)
      setActiveLayerId(mutated.activeLayerId)
      if (mutated.palette) {
        setPalette(resolvedPalette)
      }
      if (mutated.clearSelection) {
        setSelectionMask(null)
        setWorldSelection(null)
      }
      setCursor((prev) => clampCanvasPoint(prev, mutated.width, mutated.height))

      persistCommittedState(
        updatedProject,
        projectedLayers,
        resolvedPalette,
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
            data: new Uint8Array(src.data),
          }
          const next = [...curr.slice(0, idx + 1), copy, ...curr.slice(idx + 1)]

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
                  data: new Uint8Array(sb.data),
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
        if (next.length > 0 && next[0]!.clipping) {
          next[0] = { ...next[0]!, clipping: false }
        }
        const nextActive =
          currActive === layerId
            ? next[Math.max(0, idx - 1)]!.id
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
        (curr, _currActive, w, h, curTl, curPal) => {
          const idx = curr.findIndex((l) => l.id === layerId)
          if (idx <= 0) return null
          const lower = curr[idx - 1]!
          const upper = curr[idx]!

          let workingPalette = normalizeProjectPalette(curPal)
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

            const m = mergeTwoLayers(
              projectedPair[0]!,
              projectedPair[1]!,
              w,
              h,
              workingPalette
            )
            workingPalette = m.palette
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
              data: new Uint8Array(m.data),
            }
            nextCels[makeCellKey(lower.id, f.id)] = { kind: 'cel', celId: cid }
          }

          const merged =
            activeMergedGeo ?? mergeTwoLayers(lower, upper, w, h, workingPalette)
          workingPalette = merged.palette
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
            palette: workingPalette,
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
              data: new Uint8Array(l.data),
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
      (curr, currActive, w, h, _curTl, curPal) => {
        const selectedInOrder = curr.filter((l) => selectedSet.has(l.id))
        if (selectedInOrder.length < 2) return null

        let workingPalette = normalizeProjectPalette(curPal)
        let acc: LayerRuntime = {
          ...selectedInOrder[0]!,
          data: new Uint8Array(selectedInOrder[0]!.data),
        }
        for (let i = 1; i < selectedInOrder.length; i++) {
          const upper = selectedInOrder[i]!
          const m = mergeTwoLayers(acc, upper, w, h, workingPalette)
          workingPalette = m.palette
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
          } else if (!selectedSet.has(curr[i]!.id)) {
            next.push(curr[i]!)
          }
        }
        if (next[0]?.clipping) {
          next[0] = { ...next[0], clipping: false }
        }
        const nextActive = selectedSet.has(currActive) ? acc.id : currActive
        return {
          width: w,
          height: h,
          layers: next,
          activeLayerId: nextActive,
          palette: workingPalette,
        }
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
        if (next[0]!.clipping) {
          next[0] = { ...next[0]!, clipping: false }
        }
        const nextActive = next.some((l) => l.id === currActive)
          ? currActive
          : next[next.length - 1]!.id
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
      updateClipboard({
        width: project.width,
        height: project.height,
        offsetX: 0,
        offsetY: 0,
        data: view,
        sourceColorMap: extractUsedColorMap(view, palette),
      })
      return true
    },
    [project, layers, palette, updateClipboard]
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

  /**
   * Smart Indexed Palette Updater (Section 7-3 & 7-5):
   * 1. If `nextPalette` already includes `colorTable` and `displayOrder` (e.g. from `sortProjectPalette`,
   *    `restorePaletteOriginalOrder`, `addColorToIndexedPalette`, `updateIndexedPaletteSlotColor`),
   *    it preserves fixed indices verbatim so display-order sorting NEVER changes pixel colors!
   * 2. If `nextPalette` was passed with `{ ...palette, colors: nextColors }`:
   *    - Pure permutation of `palette.colors`: updates `displayOrder` ONLY (zero pixel color changes!).
   *    - Single-slot color edit (`length` equal, 1 index changed): updates that slot's `colorTable[fixedIdx]`!
   *    - Appended color (`length === prev.length + 1`): allocates a free fixed slot via `addColorToIndexedPalette`!
   *    - Preset load / full palette replacement: builds a fresh fixed table AND remaps any existing cel pixels
   *      to the exact or nearest color in the new preset (undoable in 1 step!).
   */
  const updateProjectPalette = useCallback(
    (nextPaletteInput: ProjectPalette, nextColorIdx?: number) => {
      if (!project) return
      const curPal = normalizeProjectPalette(palette)
      const safeInputColors = (
        nextPaletteInput.colors.length > 0 ? nextPaletteInput.colors : ['#000000']
      ).slice(0, MAX_OPAQUE_PALETTE_COLORS)

      let resolvedPalette: ProjectPalette | null = null
      let remapPixelsToNewTable = false

      const hasExplicitIndexedTable =
        Array.isArray(nextPaletteInput.colorTable) &&
        Array.isArray(nextPaletteInput.displayOrder) &&
        nextPaletteInput.displayOrder.length === safeInputColors.length &&
        nextPaletteInput.displayOrder.every(
          (slotIdx, dispIdx) =>
            typeof nextPaletteInput.colorTable![slotIdx] === 'string' &&
            nextPaletteInput.colorTable![slotIdx]!.toUpperCase() ===
              (normalizeHex(safeInputColors[dispIdx] ?? '') ?? '').toUpperCase()
        )

      if (hasExplicitIndexedTable) {
        resolvedPalette = normalizeProjectPalette({
          ...nextPaletteInput,
          colors: safeInputColors,
        })
      } else if (safeInputColors.length === curPal.colors.length) {
        // Check if pure permutation of existing display slots
        const usedPrevPositions = new Set<number>()
        const mappedDisplayOrder: number[] = []
        let isPurePermutation = true
        for (const hex of safeInputColors) {
          const norm = normalizeHex(hex)
          if (!norm) {
            isPurePermutation = false
            break
          }
          const foundPos = curPal.colors.findIndex(
            (c, pos) => !usedPrevPositions.has(pos) && c.toUpperCase() === norm
          )
          if (foundPos < 0) {
            isPurePermutation = false
            break
          }
          usedPrevPositions.add(foundPos)
          mappedDisplayOrder.push(curPal.displayOrder![foundPos]!)
        }

        if (isPurePermutation) {
          resolvedPalette = normalizeProjectPalette({
            ...curPal,
            ...nextPaletteInput,
            colorTable: [...curPal.colorTable!],
            displayOrder: mappedDisplayOrder,
            colors: safeInputColors,
          })
        } else {
          // Check if single-slot or in-place slot edit (same displayOrder, updated colorTable entries)
          let diffCount = 0
          let diffDispIdx = -1
          for (let i = 0; i < safeInputColors.length; i++) {
            const norm = normalizeHex(safeInputColors[i]!)
            if (!norm || norm !== curPal.colors[i]!.toUpperCase()) {
              diffCount++
              diffDispIdx = i
            }
          }
          if (
            diffCount === 1 &&
            nextPaletteInput.sourcePaletteId === curPal.sourcePaletteId
          ) {
            resolvedPalette = updateIndexedPaletteSlotColor(
              { ...curPal, name: nextPaletteInput.name || curPal.name },
              diffDispIdx,
              safeInputColors[diffDispIdx]!
            )
          } else if (diffCount === 0) {
            resolvedPalette = normalizeProjectPalette({
              ...curPal,
              name: nextPaletteInput.name.trim() || curPal.name,
              sourcePaletteId: nextPaletteInput.sourcePaletteId,
              author: nextPaletteInput.author,
              sourceUrl: nextPaletteInput.sourceUrl,
            })
          }
        }
      } else if (
        safeInputColors.length === curPal.colors.length + 1 &&
        curPal.colors.every(
          (c, idx) =>
            (normalizeHex(safeInputColors[idx] ?? '') ?? '') === c.toUpperCase()
        )
      ) {
        const added = addColorToIndexedPalette(
          { ...curPal, name: nextPaletteInput.name || curPal.name },
          safeInputColors[safeInputColors.length - 1]!,
          { allowDuplicate: true }
        )
        resolvedPalette = added.palette
      }

      if (!resolvedPalette) {
        // Full palette replacement (e.g. loading a library/Lospec palette):
        // Build clean fixed table AND remap any existing pixels across timeline cels so art never corrupts!
        resolvedPalette = normalizeProjectPalette({
          name: nextPaletteInput.name.trim() || 'Palette',
          colors: safeInputColors,
          sourcePaletteId: nextPaletteInput.sourcePaletteId,
          author: nextPaletteInput.author,
          sourceUrl: nextPaletteInput.sourceUrl,
        })
        remapPixelsToNewTable = true
      }

      const targetIdx =
        nextColorIdx !== undefined
          ? nextColorIdx === TRANSPARENT_COLOR_INDEX
            ? TRANSPARENT_COLOR_INDEX
            : Math.max(0, Math.min(resolvedPalette.colors.length - 1, nextColorIdx))
          : selectedColorIndex === TRANSPARENT_COLOR_INDEX
            ? TRANSPARENT_COLOR_INDEX
            : Math.min(selectedColorIndex, resolvedPalette.colors.length - 1)

      if (remapPixelsToNewTable) {
        const curTl = timelineRef.current
        const slotRemap = new Uint8Array(256)
        slotRemap.fill(TRANSPARENT_INDEX)
        for (let oldFixed = 0; oldFixed < MAX_OPAQUE_PALETTE_COLORS; oldFixed++) {
          const oldHex = curPal.colorTable![oldFixed]
          if (!oldHex) continue
          const exact = findExactFixedIndex(resolvedPalette, oldHex)
          if (exact >= 0) {
            slotRemap[oldFixed] = exact
          } else {
            const c = hexToRgba(oldHex)
            slotRemap[oldFixed] = findNearestFixedIndex(
              resolvedPalette,
              c.r,
              c.g,
              c.b
            )
          }
        }

        const patches: PixelPatch[] = []
        const nextCelBuffers: Record<string, CelBufferRuntime> = {
          ...curTl.celBuffers,
        }
        const celToLayerId = new Map<string, string>()
        for (const [ck, ref] of Object.entries(curTl.cels)) {
          if (ref.kind === 'cel' && !celToLayerId.has(ref.celId)) {
            const sep = ck.indexOf(':')
            if (sep > 0) celToLayerId.set(ref.celId, ck.slice(0, sep))
          }
        }

        for (const [celId, cb] of Object.entries(curTl.celBuffers)) {
          const changedIndices: number[] = []
          const beforeBytes: number[] = []
          const afterBytes: number[] = []
          const nextData = new Uint8Array(cb.data)

          for (let p = 0; p < nextData.length; p++) {
            const oldVal = nextData[p]!
            if (oldVal === TRANSPARENT_INDEX) continue
            const newVal = slotRemap[oldVal]!
            if (newVal !== oldVal) {
              nextData[p] = newVal
              changedIndices.push(p)
              beforeBytes.push(oldVal)
              afterBytes.push(newVal)
            }
          }

          if (changedIndices.length > 0) {
            nextCelBuffers[celId] = { ...cb, data: nextData }
            patches.push({
              layerId: celToLayerId.get(celId) ?? layers[0]?.id ?? '',
              celId,
              indices: new Uint32Array(changedIndices),
              before: new Uint8Array(beforeBytes),
              after: new Uint8Array(afterBytes),
            })
          }
        }

        const nextTl: TimelineState = {
          ...curTl,
          celBuffers: nextCelBuffers,
        }
        const nextActiveLayers = projectFrameLayers(
          layers,
          nextTl.cels,
          nextTl.celBuffers,
          nextTl.activeFrameId,
          project.width,
          project.height
        )

        historyRef.current.push({
          id: generateId('hist'),
          label: 'Switch Palette',
          timestamp: Date.now(),
          kind: patches.length > 0 ? 'pixel-diff' : 'palette',
          frameId: curTl.activeFrameId,
          ...(patches.length > 0 ? { pixelPatches: patches } : {}),
          beforePalette: curPal,
          afterPalette: resolvedPalette,
        })
        syncHistoryCounts()
        timelineRef.current = nextTl
        setTimeline(nextTl)
        setLayers(nextActiveLayers)
        setPalette(resolvedPalette)
        setSelectedColorIndex(targetIdx)
        persistCommittedState(
          project,
          nextActiveLayers,
          resolvedPalette,
          targetIdx,
          activeLayerId,
          nextTl
        )
        return
      }

      historyRef.current.push({
        id: generateId('hist'),
        label: 'Edit Palette',
        timestamp: Date.now(),
        kind: 'palette',
        beforePalette: curPal,
        afterPalette: resolvedPalette,
      })
      syncHistoryCounts()

      setPalette(resolvedPalette)
      setSelectedColorIndex(targetIdx)
      persistCommittedState(project, layers, resolvedPalette, targetIdx, activeLayerId)
    },
    [
      project,
      palette,
      selectedColorIndex,
      layers,
      syncHistoryCounts,
      persistCommittedState,
      activeLayerId,
    ]
  )

  /**
   * Section 7-6: Count how many pixels across the entire artwork reference `displaySlotIndex`'s fixed color index.
   */
  const countPaletteSlotUsage = useCallback(
    (displaySlotIndex: number): number => {
      if (displaySlotIndex < 0 || displaySlotIndex >= palette.colors.length) {
        return 0
      }
      const fixedIdx = displaySlotToPixelIndex(palette, displaySlotIndex)
      if (fixedIdx === TRANSPARENT_INDEX) return 0
      const curTl = timelineRef.current
      return countFixedIndexUsageAcrossProject({
        fixedIndex: fixedIdx,
        cels: curTl.cels,
        celBuffers: curTl.celBuffers,
        fallbackLayers: layers,
      })
    },
    [palette, layers]
  )

  /**
   * Section 7-6: Delete a palette color slot safely!
   * - If unused (`usage === 0`), removes the slot cleanly without touching pixels.
   * - If in use, replaces all referencing pixels across all frames/cels with either another palette slot
   *   or `TRANSPARENT_INDEX` (`255`), and pushes a single atomic Undo entry restoring both pixels & palette!
   */
  const deletePaletteColorSlot = useCallback(
    (
      displaySlotIndex: number,
      replacementTarget: { kind: 'slot'; displayIndex: number } | { kind: 'transparent' } = {
        kind: 'transparent',
      }
    ): boolean => {
      if (!project || palette.colors.length <= 1) return false
      if (displaySlotIndex < 0 || displaySlotIndex >= palette.colors.length) {
        return false
      }

      const curPal = normalizeProjectPalette(palette)
      const curTl = timelineRef.current
      const replacementFixedIdx =
        replacementTarget.kind === 'transparent'
          ? 'transparent'
          : displaySlotToPixelIndex(curPal, replacementTarget.displayIndex)

      const res = deletePaletteSlotWithReplacement({
        palette: curPal,
        deleteDisplaySlot: displaySlotIndex,
        replacementTarget: replacementFixedIdx,
        selectedColorIndex,
        layerMetas: layers,
        frames: curTl.frames,
        cels: curTl.cels,
        celBuffers: curTl.celBuffers,
        activeFrameId: curTl.activeFrameId,
        canvasWidth: project.width,
        canvasHeight: project.height,
      })

      if (res.nextPalette === curPal) return false

      historyRef.current.push({
        id: generateId('hist'),
        label: 'Delete Palette Color',
        timestamp: Date.now(),
        kind: res.pixelPatches.length > 0 ? 'pixel-diff' : 'palette',
        frameId: curTl.activeFrameId,
        ...(res.pixelPatches.length > 0 ? { pixelPatches: res.pixelPatches } : {}),
        beforePalette: curPal,
        afterPalette: res.nextPalette,
      })
      syncHistoryCounts()

      const nextTl: TimelineState = {
        ...curTl,
        celBuffers: res.nextCelBuffers,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)
      setLayers(res.nextActiveLayers)
      setPalette(res.nextPalette)
      setSelectedColorIndex(res.nextSelectedIndex)
      playUiTick('step', soundEnabled)
      persistCommittedState(
        project,
        res.nextActiveLayers,
        res.nextPalette,
        res.nextSelectedIndex,
        activeLayerId,
        nextTl
      )
      return true
    },
    [
      project,
      palette,
      selectedColorIndex,
      layers,
      syncHistoryCounts,
      soundEnabled,
      persistCommittedState,
      activeLayerId,
    ]
  )

  const replaceProjectColor = useCallback(
    (params: {
      sourceHex: string
      targetHexOrTransparent: string | 'transparent'
      layerScope?: 'all' | 'active-layer'
      frameScope?: 'all-frames' | 'active-frame'
      updatePaletteSwatch?: boolean
    }): number => {
      if (!project) return 0
      const curTl = timelineRef.current
      const curPal = normalizeProjectPalette(palette)

      // Ensure targetHex exists in `workingPal` if replacing pixels with a color not yet in palette
      let workingPal = curPal
      if (params.targetHexOrTransparent !== 'transparent') {
        const normDst = normalizeHex(params.targetHexOrTransparent)
        if (normDst && findExactFixedIndex(workingPal, normDst) < 0) {
          if (workingPal.colors.length < MAX_OPAQUE_PALETTE_COLORS) {
            const added = addColorToIndexedPalette(workingPal, normDst)
            workingPal = added.palette
          }
        }
      }

      const res = replaceColorAcrossTimeline({
        palette: workingPal,
        sourceHex: params.sourceHex,
        targetHexOrTransparent: params.targetHexOrTransparent,
        layerMetas: layers,
        frames: curTl.frames,
        cels: curTl.cels,
        celBuffers: curTl.celBuffers,
        activeFrameId: curTl.activeFrameId,
        canvasWidth: project.width,
        canvasHeight: project.height,
        layerScope: params.layerScope ?? 'all',
        targetLayerId: activeLayerId,
        frameScope: params.frameScope ?? 'all-frames',
      })

      let nextPal = res.nextPalette
      if (
        params.updatePaletteSwatch &&
        params.targetHexOrTransparent !== 'transparent'
      ) {
        const srcFixed = findExactFixedIndex(nextPal, params.sourceHex)
        const normDst = normalizeHex(params.targetHexOrTransparent)
        if (srcFixed >= 0 && normDst) {
          const dispSlot = pixelIndexToDisplaySlot(nextPal, srcFixed)
          if (dispSlot >= 0) {
            nextPal = updateIndexedPaletteSlotColor(nextPal, dispSlot, normDst)
          }
        }
      }

      const paletteChanged =
        nextPal.colors.length !== curPal.colors.length ||
        nextPal.colors.some((c, i) => c !== curPal.colors[i])
      if (res.pixelPatches.length === 0 && !paletteChanged) {
        return 0
      }

      historyRef.current.push({
        id: generateId('hist'),
        label: 'Replace Color',
        timestamp: Date.now(),
        kind: res.pixelPatches.length > 0 ? 'pixel-diff' : 'palette',
        frameId: curTl.activeFrameId,
        pixelPatches: res.pixelPatches.length > 0 ? res.pixelPatches : undefined,
        ...(paletteChanged
          ? {
              beforePalette: curPal,
              afterPalette: nextPal,
            }
          : {}),
      })
      syncHistoryCounts()

      const nextTl: TimelineState = {
        ...curTl,
        celBuffers: res.nextCelBuffers,
      }
      timelineRef.current = nextTl
      setTimeline(nextTl)
      setLayers(res.nextActiveLayers)
      if (paletteChanged) {
        setPalette(nextPal)
      }
      playUiTick('draw', soundEnabled)
      persistCommittedState(
        project,
        res.nextActiveLayers,
        nextPal,
        selectedColorIndex,
        activeLayerId,
        nextTl
      )
      return res.replacedPixelCount
    },
    [
      project,
      palette,
      layers,
      activeLayerId,
      syncHistoryCounts,
      soundEnabled,
      persistCommittedState,
      selectedColorIndex,
    ]
  )

  /**
   * Import external pixel buffer (either 1-byte Indexed OR 4-byte RGBA) into the current project as a new layer,
   * automatically registering/remapping colors into the project's 255-color indexed palette!
   */
  const importBufferAsNewLayer = useCallback(
    (params: {
      name: string
      width: number
      height: number
      data: Uint8Array | Uint8ClampedArray
    }): boolean => {
      if (!project || layers.length >= MAX_LAYERS) return false
      const imgW = Math.max(1, Math.round(params.width))
      const imgH = Math.max(1, Math.round(params.height))

      return executeStructuralChange(
        'Import Image Layer',
        (curr, currActive, w, h, curTl, curPal) => {
          if (curr.length >= MAX_LAYERS) return null

          let indexedLayerData: Uint8Array
          let nextPalette = normalizeProjectPalette(curPal)

          if (params.data.byteLength === imgW * imgH) {
            indexedLayerData = new Uint8Array(params.data)
          } else {
            // Convert 4-byte RGBA into 1-byte Indexed Color while preserving all existing `curPal` fixed slots!
            const expectedRgba = imgW * imgH * 4
            const cleanRgba = new Uint8Array(expectedRgba)
            cleanRgba.set(
              params.data.subarray(0, Math.min(expectedRgba, params.data.length))
            )

            // Collect existing cel colors so we never drop colors already used on canvas if quantization occurs
            const usedFixed = new Set<number>()
            for (const cb of Object.values(curTl.celBuffers)) {
              for (let i = 0; i < cb.data.length; i++) {
                const v = cb.data[i]!
                if (v !== TRANSPARENT_INDEX) usedFixed.add(v)
              }
            }

            // First try adding exact opaque colors into free slots of `nextPalette`
            const convertedTmp = convertRgbaBuffersToIndexed(
              [{ id: 'imp', width: imgW, height: imgH, rgba: cleanRgba }],
              nextPalette
            )
            // Remap `convertedTmp` onto `nextPalette` preserving existing fixed slots!
            const colorMap: Record<number, string> = {}
            const tmpTable = convertedTmp.palette.colorTable!
            for (let s = 0; s < MAX_OPAQUE_PALETTE_COLORS; s++) {
              if (tmpTable[s]) colorMap[s] = tmpTable[s]!
            }
            const remapped = remapClipboardToTargetPalette(
              {
                width: imgW,
                height: imgH,
                offsetX: 0,
                offsetY: 0,
                data: convertedTmp.buffers.get('imp')!,
                sourceColorMap: colorMap,
              },
              nextPalette
            )
            indexedLayerData = remapped.data
            nextPalette = remapped.palette
            void usedFixed
          }

          const newLayerId = generateId('layer')
          const ox = Math.floor((w - imgW) / 2)
          const oy = Math.floor((h - imgH) / 2)
          const newLayer: LayerRuntime = {
            id: newLayerId,
            name: params.name.trim().slice(0, 40) || `Import ${curr.length + 1}`,
            visible: true,
            locked: false,
            opacity: 100,
            blendMode: 'normal',
            clipping: false,
            offsetX: ox,
            offsetY: oy,
            dataWidth: imgW,
            dataHeight: imgH,
            data: indexedLayerData,
          }
          const idx = curr.findIndex((l) => l.id === currActive)
          const insertAt = idx >= 0 ? idx + 1 : curr.length
          const nextLayers = [
            ...curr.slice(0, insertAt),
            newLayer,
            ...curr.slice(insertAt),
          ]

          const nextCels: CelMap = { ...curTl.cels }
          const nextCelBuffers: Record<string, CelBufferRuntime> = {
            ...curTl.celBuffers,
          }
          const cid = generateId('cel')
          nextCelBuffers[cid] = {
            id: cid,
            offsetX: ox,
            offsetY: oy,
            dataWidth: imgW,
            dataHeight: imgH,
            data: new Uint8Array(indexedLayerData),
          }
          for (const f of curTl.frames) {
            nextCels[makeCellKey(newLayerId, f.id)] =
              f.id === curTl.activeFrameId
                ? { kind: 'cel', celId: cid }
                : { kind: 'empty' }
          }

          return {
            width: w,
            height: h,
            layers: nextLayers,
            activeLayerId: newLayerId,
            palette: nextPalette,
            timeline: {
              ...curTl,
              cels: nextCels,
              celBuffers: nextCelBuffers,
            },
          }
        }
      )
    },
    [project, layers.length, executeStructuralChange]
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

    const normPal = normalizeProjectPalette(prev.palette)
    const updatedProj: ProjectRecord = {
      ...project,
      width: prev.width,
      height: prev.height,
      activeLayerId: prev.activeLayerId,
      frames: nextTl.frames,
      cels: nextTl.cels,
      activeFrameId: nextTl.activeFrameId,
      palette: normPal,
    }
    const safeIdx =
      selectedColorIndex === TRANSPARENT_COLOR_INDEX
        ? TRANSPARENT_COLOR_INDEX
        : Math.min(selectedColorIndex, Math.max(0, normPal.colors.length - 1))
    setProject(updatedProj)
    setLayers(prev.layers)
    setActiveLayerId(prev.activeLayerId)
    setSelectionMask(prev.selectionMask)
    setWorldSelection(
      prev.worldSelection !== undefined
        ? prev.worldSelection
        : canvasMaskToWorldSelection(prev.selectionMask, prev.width, prev.height)
    )
    setPalette(normPal)
    setSelectedColorIndex(safeIdx)
    persistCommittedState(
      updatedProj,
      prev.layers,
      normPal,
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

    const normPal = normalizeProjectPalette(next.palette)
    const updatedProj: ProjectRecord = {
      ...project,
      width: next.width,
      height: next.height,
      activeLayerId: next.activeLayerId,
      frames: nextTl.frames,
      cels: nextTl.cels,
      activeFrameId: nextTl.activeFrameId,
      palette: normPal,
    }
    const safeIdx =
      selectedColorIndex === TRANSPARENT_COLOR_INDEX
        ? TRANSPARENT_COLOR_INDEX
        : Math.min(selectedColorIndex, Math.max(0, normPal.colors.length - 1))
    setProject(updatedProj)
    setLayers(next.layers)
    setActiveLayerId(next.activeLayerId)
    setSelectionMask(next.selectionMask)
    setWorldSelection(
      next.worldSelection !== undefined
        ? next.worldSelection
        : canvasMaskToWorldSelection(next.selectionMask, next.width, next.height)
    )
    setPalette(normPal)
    setSelectedColorIndex(safeIdx)
    persistCommittedState(
      updatedProj,
      next.layers,
      normPal,
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
        const nextCels = { ...curTl.cels }
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
          const srcFrameId =
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
        data: new Uint8Array(0),
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
      data: new Uint8Array(sb.data),
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
              data: new Uint8Array(celClipboard.data),
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
    playStepCursorRef.current = 0
    const curTl = timelineRef.current
    if (curTl.frames.length >= 2) {
      const targetFrame =
        curTl.playbackDirection === 'reverse'
          ? curTl.frames[curTl.frames.length - 1]
          : curTl.frames[0]
      if (targetFrame && targetFrame.id !== curTl.activeFrameId) {
        selectFrame(targetFrame.id)
      }
    }
  }, [selectFrame])

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

  // Onion-skin composited RGBA buffers (multi-step weighted composite for Prev & Next frames)
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
      const acc = new Uint8ClampedArray(w * h * 4)
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
        const comp = compositeLayers(fLayers, w, h, { palette })
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
    palette,
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

  // Unused-import guard for `getHexForPixelIndex`
  void getHexForPixelIndex

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
    activePixelIndex,
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
    symmetryMode,
    setSymmetryMode,
    tilePreviewGrid,
    setTilePreviewGrid,
    seamlessWrapMode,
    setSeamlessWrapMode,
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
    countPaletteSlotUsage,
    deletePaletteColorSlot,
    replaceProjectColor,
    importBufferAsNewLayer,
    renameProject,
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
