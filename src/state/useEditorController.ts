import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BlendMode,
  ClipboardBuffer,
  FloatingShapeState,
  LayerRuntime,
  Point,
  ProjectPalette,
  ProjectRecord,
  ToolId,
  ToolSettings,
} from '../types'
import {
  db,
  generateId,
  loadProjectFull,
  saveProjectFull,
} from '../db/database'
import { hexToRgba, rgbaToHex } from '../engine/color'
import {
  clearBuffer,
  createPixelBuffer,
  flipBufferHorizontal,
  flipBufferVertical,
  getPixel,
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  resizePixelBuffer,
  translateBuffer,
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
  cutSelection,
  flipSelectionContent,
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
  createPixelPatch,
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

const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  penSize: 1,
  penShape: 'square',
  penDither: 1,
  pixelPerfect: true, // Section 4-1: Pixel-perfect ON by default

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

export interface UseEditorOptions {
  projectId: string | null
  historyLimit: number | 'unlimited'
  soundEnabled: boolean
  onSaved?: () => void
  onQuotaTrimmed?: () => void
  onSaveError?: () => void
  onToast?: (msgKey: string) => void
}

export function useEditorController(options: UseEditorOptions) {
  const {
    projectId,
    historyLimit,
    soundEnabled,
    onSaved,
    onQuotaTrimmed,
    onSaveError,
  } = options

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [layers, setLayers] = useState<LayerRuntime[]>([])
  const [activeLayerId, setActiveLayerId] = useState<string>('')
  const [palette, setPalette] = useState<ProjectPalette>({
    name: 'Standard',
    colors: ['#000000', '#FFFFFF'],
  })
  const [selectedColorIndex, setSelectedColorIndex] = useState<number>(0)

  const [tool, setTool] = useState<ToolId>('pen')
  const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS)

  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const [stepPhase, setStepPhase] = useState<MultiStepPhase>({ kind: 'idle' })
  const [floatingShape, setFloatingShape] = useState<FloatingShapeState | null>(null)
  const [selectionMask, setSelectionMask] = useState<Uint8Array | null>(null)
  const [clipboard, setClipboard] = useState<ClipboardBuffer | null>(null)

  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)

  // Continuous stroke state (for Pen / Eraser while Draw or mouse button is held)
  const [isContinuousDrawing, setIsContinuousDrawing] = useState(false)
  const strokeRef = useRef<{
    active: boolean
    tool: 'pen' | 'eraser'
    layerId: string
    baseBuffer: Uint8ClampedArray
    rawPoints: Point[]
    latestPreview: Uint8ClampedArray
  } | null>(null)

  const [liveStrokeBuffer, setLiveStrokeBuffer] = useState<{
    layerId: string
    data: Uint8ClampedArray
  } | null>(null)

  const historyRef = useRef<HistoryManager>(new HistoryManager(historyLimit))
  const saveTimerRef = useRef<number | null>(null)

  // Keep HistoryManager limit synced with settings
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
      setProject(loaded.project)
      setLayers(loaded.layers)
      setActiveLayerId(loaded.project.activeLayerId || loaded.layers[0]?.id || '')
      setPalette({
        name: loaded.project.palette.name,
        colors: [...loaded.project.palette.colors],
        sourcePaletteId: loaded.project.palette.sourcePaletteId,
      })
      setSelectedColorIndex(
        Math.min(
          Math.max(0, loaded.project.selectedColorIndex),
          Math.max(0, loaded.project.palette.colors.length - 1)
        )
      )
      setCursor({
        x: Math.floor(loaded.project.width / 2),
        y: Math.floor(loaded.project.height / 2),
      })
      setStepPhase({ kind: 'idle' })
      setFloatingShape(null)
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
  }, [projectId]) // intentionally load only when projectId changes

  const activeHexColor = useMemo(() => {
    return palette.colors[selectedColorIndex] ?? palette.colors[0] ?? '#000000'
  }, [palette.colors, selectedColorIndex])

  const activeRgba = useMemo(() => hexToRgba(activeHexColor, 255), [activeHexColor])

  const activeLayer = useMemo(
    () => layers.find((l) => l.id === activeLayerId) ?? layers[0] ?? null,
    [layers, activeLayerId]
  )

  const syncHistoryCounts = useCallback(() => {
    setUndoCount(historyRef.current.getUndoCount())
    setRedoCount(historyRef.current.getRedoCount())
  }, [])

  /**
   * Schedule debounced atomic persistence of committed state (never saves uncommitted preview data).
   */
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

  /**
   * Compute live preview layer override so canvas shows exact final rasterized output BEFORE committing.
   */
  const previewLayerOverride = useMemo((): {
    layerId: string
    data: Uint8ClampedArray
  } | null => {
    if (!project || !activeLayer) return null
    const w = project.width
    const h = project.height

    // 1. Active continuous pen/eraser stroke
    if (liveStrokeBuffer) {
      return liveStrokeBuffer
    }

    // 2. Active floating shape transform (non-destructive preview)
    if (floatingShape) {
      return {
        layerId: activeLayer.id,
        data: compositeFloatingShapeOntoLayer(
          activeLayer.data,
          w,
          h,
          floatingShape,
          effectiveSelectionMask
        ),
      }
    }

    // 3. Multi-step previews (Gradient fill, Line, Bezier, Shape placement)
    if (stepPhase.kind === 'gradient-end') {
      const buf = new Uint8ClampedArray(activeLayer.data)
      applyGradientFloodFill(buf, {
        width: w,
        height: h,
        startX: stepPhase.start.x,
        startY: stepPhase.start.y,
        endX: cursor.x,
        endY: cursor.y,
        color: activeRgba,
        connectivity: toolSettings.fillConnectivity,
        steps: toolSettings.gradientSteps,
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    if (stepPhase.kind === 'line-end') {
      const buf = new Uint8ClampedArray(activeLayer.data)
      drawLine(buf, stepPhase.start, cursor, {
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

    if (stepPhase.kind === 'bezier-p3') {
      const buf = new Uint8ClampedArray(activeLayer.data)
      drawLine(buf, stepPhase.p0, cursor, {
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

    if (stepPhase.kind === 'bezier-p1') {
      const buf = new Uint8ClampedArray(activeLayer.data)
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
      const buf = new Uint8ClampedArray(activeLayer.data)
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
      const buf = new Uint8ClampedArray(activeLayer.data)
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

    // 4. Hover brush footprint preview for Pen / Eraser when idle
    if (stepPhase.kind === 'idle' && (tool === 'pen' || tool === 'eraser')) {
      const buf = new Uint8ClampedArray(activeLayer.data)
      stampPoints(buf, [cursor], {
        width: w,
        height: h,
        size: tool === 'pen' ? toolSettings.penSize : toolSettings.eraserSize,
        shape: tool === 'pen' ? toolSettings.penShape : toolSettings.eraserShape,
        color: activeRgba,
        dither: tool === 'pen' ? toolSettings.penDither : 1,
        erase: tool === 'eraser',
        selectionMask: effectiveSelectionMask,
      })
      return { layerId: activeLayer.id, data: buf }
    }

    return null
  }, [
    project,
    activeLayer,
    liveStrokeBuffer,
    floatingShape,
    stepPhase,
    cursor,
    activeRgba,
    toolSettings,
    effectiveSelectionMask,
    tool,
  ])

  /**
   * Selection preview mask while dragging/stepping a Rect or Ellipse selection.
   */
  const previewSelectionMask = useMemo((): Uint8Array | null => {
    if (!project || stepPhase.kind !== 'select-end') return selectionMask
    const newPart =
      toolSettings.selectType === 'ellipse'
        ? selectEllipseMask(project.width, project.height, stepPhase.start, cursor)
        : selectRectangleMask(project.width, project.height, stepPhase.start, cursor)
    return mergeSelectionMasks(selectionMask, newPart)
  }, [project, stepPhase, toolSettings.selectType, cursor, selectionMask])

  /**
   * Composited RGBA pixel buffer for display (uses identical compositor as PNG export).
   */
  const compositedBuffer = useMemo(() => {
    if (!project || layers.length === 0) return null
    return compositeLayers(layers, project.width, project.height, {
      previewLayerOverride,
    })
  }, [project, layers, previewLayerOverride])

  /**
   * Commit a single layer pixel buffer modification with sparse diff undo entry & auto-save.
   */
  const commitLayerBufferChange = useCallback(
    (
      layerId: string,
      beforeBuf: Uint8ClampedArray,
      afterBuf: Uint8ClampedArray,
      label: string,
      selectionTransition?: {
        before: Uint8Array | null
        after: Uint8Array | null
      }
    ) => {
      if (!project) return
      const patch = createPixelPatch(layerId, beforeBuf, afterBuf)
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

      const nextLayers = layers.map((l) =>
        l.id === layerId ? { ...l, data: afterBuf } : l
      )
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

  /**
   * Commit floating shape onto active layer (Section 6-3).
   */
  const commitFloatingShape = useCallback(() => {
    if (!floatingShape || !project || !activeLayer) return
    const afterBuf = compositeFloatingShapeOntoLayer(
      activeLayer.data,
      project.width,
      project.height,
      floatingShape,
      effectiveSelectionMask
    )
    setFloatingShape(null)
    playUiTick('draw', soundEnabled)
    commitLayerBufferChange(activeLayer.id, activeLayer.data, afterBuf, 'Shape')
  }, [
    floatingShape,
    project,
    activeLayer,
    effectiveSelectionMask,
    soundEnabled,
    commitLayerBufferChange,
  ])

  const discardFloatingShape = useCallback(() => {
    setFloatingShape(null)
  }, [])

  /**
   * Switch active tool safely (auto-commits any pending floating shape and resets multi-step phase).
   */
  const selectTool = useCallback(
    (nextTool: ToolId) => {
      if (floatingShape) {
        commitFloatingShape()
      }
      setStepPhase({ kind: 'idle' })
      setTool(nextTool)
    },
    [floatingShape, commitFloatingShape]
  )

  const cancelMultiStep = useCallback(() => {
    setStepPhase({ kind: 'idle' })
    if (floatingShape) {
      setFloatingShape(null)
    }
  }, [floatingShape])

  /**
   * Re-evaluate active continuous Pen / Eraser stroke from its base buffer so Pixel-Perfect & Dithering stay 100% exact.
   */
  const recomputeContinuousStroke = useCallback(
    (rawPoints: readonly Point[], baseBuffer: Uint8ClampedArray, mode: 'pen' | 'eraser') => {
      if (!project) return baseBuffer
      const nextBuf = new Uint8ClampedArray(baseBuffer)
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
   * Move cursor to pixel coordinate `(x, y)` (clamped to canvas bounds).
   * If Draw button (or PC mouse button) is currently held in Pen/Eraser mode, extends the continuous stroke!
   */
  const moveCursorTo = useCallback(
    (pt: Point) => {
      if (!project) return
      const clamped = clampCanvasPoint(pt, project.width, project.height)
      setCursor((prev) =>
        prev.x === clamped.x && prev.y === clamped.y ? prev : clamped
      )

      const st = strokeRef.current
      if (st && st.active) {
        const last = st.rawPoints[st.rawPoints.length - 1]
        if (!last || last.x !== clamped.x || last.y !== clamped.y) {
          st.rawPoints.push(clamped)
          const updated = recomputeContinuousStroke(
            st.rawPoints,
            st.baseBuffer,
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
   * Begin Draw action at `targetPoint` (defaults to current `cursor`).
   * Used both by the bottom Draw button on smartphones AND direct canvas click on PC!
   */
  const beginDrawAction = useCallback(
    (targetPoint?: Point) => {
      if (!project || !activeLayer) return
      if (floatingShape) {
        // Pressing Draw while floating shape is active commits it
        commitFloatingShape()
        return
      }

      const pt = targetPoint
        ? clampCanvasPoint(targetPoint, project.width, project.height)
        : cursor
      if (targetPoint) {
        setCursor(pt)
      }

      const w = project.width
      const h = project.height

      // Pen & Eraser: start continuous holdable stroke
      if (tool === 'pen' || tool === 'eraser') {
        if (!activeLayer.visible) return
        const baseCopy = new Uint8ClampedArray(activeLayer.data)
        const initialPreview = recomputeContinuousStroke([pt], baseCopy, tool)
        strokeRef.current = {
          active: true,
          tool,
          layerId: activeLayer.id,
          baseBuffer: baseCopy,
          rawPoints: [pt],
          latestPreview: initialPreview,
        }
        setIsContinuousDrawing(true)
        setLiveStrokeBuffer({ layerId: activeLayer.id, data: initialPreview })
        playUiTick('draw', soundEnabled)
        return
      }

      // Eyedropper: pick visible composited color at `pt`
      if (tool === 'eyedropper') {
        const comp = compositeLayers(layers, w, h)
        const picked = getPixel(comp, w, h, pt.x, pt.y)
        if (picked.a > 0) {
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
          } else {
            const nextColors = [...palette.colors]
            nextColors[selectedColorIndex] = hex
            setPalette({ ...palette, colors: nextColors })
          }
          playUiTick('step', soundEnabled)
        }
        setTool('pen')
        return
      }

      // Flood Fill (Normal vs Density Gradient)
      if (tool === 'fill') {
        if (!activeLayer.visible) return
        if (toolSettings.fillMode === 'normal') {
          const after = new Uint8ClampedArray(activeLayer.data)
          applyFloodFill(after, {
            width: w,
            height: h,
            seedX: pt.x,
            seedY: pt.y,
            color: activeRgba,
            connectivity: toolSettings.fillConnectivity,
            dither: toolSettings.fillDither,
            selectionMask: effectiveSelectionMask,
          })
          playUiTick('draw', soundEnabled)
          commitLayerBufferChange(activeLayer.id, activeLayer.data, after, 'Fill')
        } else {
          if (stepPhase.kind !== 'gradient-end') {
            setStepPhase({ kind: 'gradient-end', start: pt })
            playUiTick('step', soundEnabled)
          } else {
            const after = new Uint8ClampedArray(activeLayer.data)
            applyGradientFloodFill(after, {
              width: w,
              height: h,
              startX: stepPhase.start.x,
              startY: stepPhase.start.y,
              endX: pt.x,
              endY: pt.y,
              color: activeRgba,
              connectivity: toolSettings.fillConnectivity,
              steps: toolSettings.gradientSteps,
              selectionMask: effectiveSelectionMask,
            })
            setStepPhase({ kind: 'idle' })
            playUiTick('draw', soundEnabled)
            commitLayerBufferChange(
              activeLayer.id,
              activeLayer.data,
              after,
              'Gradient Fill'
            )
          }
        }
        return
      }

      // Straight Line & Cubic Bezier (Section 5-1 & 5-2)
      if (tool === 'line') {
        if (!activeLayer.visible) return
        if (toolSettings.lineType === 'line') {
          if (stepPhase.kind !== 'line-end') {
            setStepPhase({ kind: 'line-end', start: pt })
            playUiTick('step', soundEnabled)
          } else {
            const after = new Uint8ClampedArray(activeLayer.data)
            drawLine(after, stepPhase.start, pt, {
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
            commitLayerBufferChange(activeLayer.id, activeLayer.data, after, 'Line')
          }
        } else {
          // 4-point Cubic Bezier state machine: P0 -> P3 -> P1 -> P2
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
            const after = new Uint8ClampedArray(activeLayer.data)
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
            commitLayerBufferChange(
              activeLayer.id,
              activeLayer.data,
              after,
              'Bezier Curve'
            )
          } else {
            setStepPhase({ kind: 'bezier-p3', p0: pt })
          }
        }
        return
      }

      // Shape (Rectangle / Ellipse -> transitions into non-destructive Transform state on 2nd Draw! Section 6-3)
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
          // Rasterize into local isolated buffer so rotation/movement never touches underlying pixels until committed!
          // Note: Use canvas-space dither coordinates for initial rasterization so pattern aligns seamlessly
          const tempCanvasBuf = createPixelBuffer(w, h)
          const shapeOpts = {
            width: w,
            height: h,
            filled: toolSettings.shapeFilled,
            strokeSize: toolSettings.shapeSize,
            dither: toolSettings.shapeDither,
            color: activeRgba,
            selectionMask: null,
          }
          if (toolSettings.shapeType === 'rect') {
            rasterizeRectangle(tempCanvasBuf, bounds, shapeOpts)
          } else {
            rasterizeEllipse(tempCanvasBuf, bounds, shapeOpts)
          }

          // Extract local bounding box into sourceBuffer
          const sw = Math.max(1, bounds.width)
          const sh = Math.max(1, bounds.height)
          const localBuf = createPixelBuffer(sw, sh)
          for (let ly = 0; ly < sh; ly++) {
            const cy = bounds.minY + ly
            if (cy < 0 || cy >= h) continue
            for (let lx = 0; lx < sw; lx++) {
              const cx = bounds.minX + lx
              if (cx < 0 || cx >= w) continue
              const sIdx = (cy * w + cx) * 4
              const dIdx = (ly * sw + lx) * 4
              localBuf[dIdx] = tempCanvasBuf[sIdx]
              localBuf[dIdx + 1] = tempCanvasBuf[sIdx + 1]
              localBuf[dIdx + 2] = tempCanvasBuf[sIdx + 2]
              localBuf[dIdx + 3] = tempCanvasBuf[sIdx + 3]
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

      // Selection Tool (Magic Wand / Rectangle / Ellipse with union support, Section 7)
      if (tool === 'select') {
        const beforeSel = cloneSelectionMask(selectionMask)
        if (toolSettings.selectType === 'wand') {
          const wandMask = selectSameColor(
            activeLayer.data,
            w,
            h,
            pt.x,
            pt.y,
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
      floatingShape,
      commitFloatingShape,
      cursor,
      tool,
      recomputeContinuousStroke,
      soundEnabled,
      layers,
      palette,
      selectedColorIndex,
      toolSettings,
      activeRgba,
      effectiveSelectionMask,
      commitLayerBufferChange,
      stepPhase,
      selectionMask,
      syncHistoryCounts,
    ]
  )

  /**
   * Finish continuous Draw action (when Draw button or PC mouse button is released).
   */
  const endDrawAction = useCallback(() => {
    const st = strokeRef.current
    if (!st || !st.active) return
    st.active = false
    strokeRef.current = null
    setIsContinuousDrawing(false)
    setLiveStrokeBuffer(null)

    commitLayerBufferChange(
      st.layerId,
      st.baseBuffer,
      st.latestPreview,
      st.tool === 'pen' ? 'Pen' : 'Eraser'
    )
  }, [commitLayerBufferChange])

  // Floating shape controls (Section 6-3)
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

  // Selection operations (Section 7-4)
  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      if (!project || !activeLayer || !effectiveSelectionMask) return
      const beforeMask = cloneSelectionMask(effectiveSelectionMask)
      const { nextBuffer, nextMask } = moveSelectionContent(
        activeLayer.data,
        effectiveSelectionMask,
        project.width,
        project.height,
        dx,
        dy
      )
      commitLayerBufferChange(activeLayer.id, activeLayer.data, nextBuffer, 'Move Selection', {
        before: beforeMask,
        after: nextMask,
      })
    },
    [project, activeLayer, effectiveSelectionMask, commitLayerBufferChange]
  )

  const outlineSelection = useCallback(() => {
    if (!project || !activeLayer || !effectiveSelectionMask) return
    const outlineRgba = hexToRgba(toolSettings.outlineColor, 255)
    const nextBuffer = applySelectionOutline(
      activeLayer.data,
      effectiveSelectionMask,
      project.width,
      project.height,
      toolSettings.outlineMode,
      toolSettings.outlineSize,
      outlineRgba
    )
    commitLayerBufferChange(
      activeLayer.id,
      activeLayer.data,
      nextBuffer,
      'Selection Outline'
    )
  }, [project, activeLayer, effectiveSelectionMask, toolSettings, commitLayerBufferChange])

  const copySelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !effectiveSelectionMask) return false
    const clip = copySelection(
      activeLayer.data,
      effectiveSelectionMask,
      project.width,
      project.height
    )
    if (!clip) return false
    setClipboard(clip)
    return true
  }, [project, activeLayer, effectiveSelectionMask])

  const cutSelectedPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !effectiveSelectionMask) return false
    const { clipboard: clip, nextBuffer } = cutSelection(
      activeLayer.data,
      effectiveSelectionMask,
      project.width,
      project.height
    )
    if (!clip) return false
    setClipboard(clip)
    commitLayerBufferChange(activeLayer.id, activeLayer.data, nextBuffer, 'Cut Selection')
    return true
  }, [project, activeLayer, effectiveSelectionMask, commitLayerBufferChange])

  const pasteClipboardPixels = useCallback((): boolean => {
    if (!project || !activeLayer || !clipboard) return false
    const beforeMask = cloneSelectionMask(selectionMask)
    const { nextBuffer, nextMask } = pasteClipboard(
      activeLayer.data,
      clipboard,
      project.width,
      project.height
    )
    commitLayerBufferChange(activeLayer.id, activeLayer.data, nextBuffer, 'Paste', {
      before: beforeMask,
      after: nextMask,
    })
    return true
  }, [project, activeLayer, clipboard, selectionMask, commitLayerBufferChange])

  const flipSelectedPixels = useCallback(
    (direction: 'horizontal' | 'vertical') => {
      if (!project || !activeLayer || !effectiveSelectionMask) return
      const beforeMask = cloneSelectionMask(effectiveSelectionMask)
      const { nextBuffer, nextMask } = flipSelectionContent(
        activeLayer.data,
        effectiveSelectionMask,
        project.width,
        project.height,
        direction
      )
      commitLayerBufferChange(activeLayer.id, activeLayer.data, nextBuffer, 'Flip Selection', {
        before: beforeMask,
        after: nextMask,
      })
    },
    [project, activeLayer, effectiveSelectionMask, commitLayerBufferChange]
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
  }, [selectionMask, syncHistoryCounts])

  // Structural helper (used for Layer management & Canvas resize so everything is Undo/Redo-able)
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

  // Layer operations (Section 8: up to 50 layers, all 15 operations)
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
        // Ensure bottom-most layer cannot remain clipped to nothing
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
        if (idx <= 0) return null // bottom layer has nothing below
        const lower = curr[idx - 1]
        const upper = curr[idx]
        const mergedData = mergeTwoLayers(lower, upper, w, h)
        const mergedLayer: LayerRuntime = {
          ...lower,
          opacity: 100,
          visible: true,
          data: mergedData,
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

  const updateLayerProps = useCallback(
    (
      layerId: string,
      patch: Partial<Pick<LayerRuntime, 'name' | 'visible' | 'opacity' | 'blendMode' | 'clipping'>>
    ) => {
      executeStructuralChange('Update Layer', (curr, currActive, w, h) => {
        const idx = curr.findIndex((l) => l.id === layerId)
        if (idx < 0) return null
        // Bottom-most layer (idx === 0) cannot have clipping=true
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
      const target = layers.find((l) => l.id === layerId)
      if (!target) return
      const nextBuf = new Uint8ClampedArray(target.data)
      clearBuffer(nextBuf)
      commitLayerBufferChange(layerId, target.data, nextBuf, 'Clear Layer')
    },
    [layers, commitLayerBufferChange]
  )

  const copyLayerToClipboard = useCallback(
    (layerId: string): boolean => {
      if (!project) return false
      const target = layers.find((l) => l.id === layerId)
      if (!target) return false
      setClipboard({
        width: project.width,
        height: project.height,
        offsetX: 0,
        offsetY: 0,
        data: new Uint8ClampedArray(target.data),
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
      const nextBuf =
        dir === 'horizontal'
          ? flipBufferHorizontal(target.data, project.width, project.height)
          : flipBufferVertical(target.data, project.width, project.height)
      commitLayerBufferChange(layerId, target.data, nextBuf, 'Flip Layer')
    },
    [project, layers, commitLayerBufferChange]
  )

  const translateLayer = useCallback(
    (layerId: string, dx: number, dy: number) => {
      if (!project) return
      const target = layers.find((l) => l.id === layerId)
      if (!target) return
      const nextBuf = translateBuffer(
        target.data,
        project.width,
        project.height,
        dx,
        dy
      )
      commitLayerBufferChange(layerId, target.data, nextBuf, 'Move Layer')
    },
    [project, layers, commitLayerBufferChange]
  )

  // Canvas resize (Section 9: 1..256px, top-left (0,0) anchored)
  const resizeCanvas = useCallback(
    (newWidthRaw: number, newHeightRaw: number) => {
      const nw = Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(newWidthRaw)))
      const nh = Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(newHeightRaw)))
      executeStructuralChange('Resize Canvas', (curr, currActive, w, h) => {
        if (nw === w && nh === h) return null
        const resizedLayers = curr.map((l) => ({
          ...l,
          data: resizePixelBuffer(l.data, w, h, nw, nh),
        }))
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

  // Project Palette operations (Undo/Redo supported, independent copy per project: Section 10)
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
          ? Math.max(0, Math.min(safeColors.length - 1, nextColorIdx))
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

  // Undo & Redo
  const undo = useCallback(() => {
    if (!project) return
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
    const safeIdx = Math.min(
      selectedColorIndex,
      Math.max(0, prev.palette.colors.length - 1)
    )
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
    const safeIdx = Math.min(
      selectedColorIndex,
      Math.max(0, next.palette.colors.length - 1)
    )
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
    palette,
    selectedColorIndex,
    setSelectedColorIndex,
    activeHexColor,
    tool,
    selectTool,
    toolSettings,
    setToolSettings,
    cursor,
    moveCursorTo,
    stepPhase,
    cancelMultiStep,
    floatingShape,
    rotateFloatingShape,
    moveFloatingShape,
    commitFloatingShape,
    discardFloatingShape,
    selectionMask: previewSelectionMask,
    hasSelection: hasAnySelectedPixel(selectionMask),
    clipboard,
    nudgeSelection,
    outlineSelection,
    copySelectedPixels,
    cutSelectedPixels,
    pasteClipboardPixels,
    flipSelectedPixels,
    invertCurrentSelection,
    clearCurrentSelection,
    compositedBuffer,
    isContinuousDrawing,
    beginDrawAction,
    endDrawAction,
    undo,
    redo,
    canUndo: undoCount > 0 || floatingShape !== null || stepPhase.kind !== 'idle',
    canRedo: redoCount > 0,
    undoCount,
    redoCount,
    // Layer & Project operations
    addNewLayer,
    duplicateLayer,
    deleteLayer,
    mergeLayerDown,
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

export type EditorController = ReturnType<typeof useEditorController>

export const ALL_BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'add',
  'difference',
]
