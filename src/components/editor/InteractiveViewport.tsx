import React, { ViewTransition, useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActiveMoveSession,
  BrushShape,
  FloatingShapeState,
  Point,
  ToolId,
  ToolSettings,
  WorldSelectionMask,
} from '../../types'
import type { MultiStepPhase } from '../../state/useEditorController'
import { getBrushOffsets } from '../../engine/brush'
import { rasterizeTransformedShape } from '../../engine/transform'
import { resolveToolIconName } from '../../utils/toolIcon'
import { PixelIcon, type PixelIconName } from '../common/PixelIcon'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import {
  clampCanvasPoint,
  clampViewportTransform,
  computeFitViewport,
  screenToCanvasPixel,
  zoomAroundPoint,
  type ViewportTransform,
} from '../../utils/coordinates'
import {
  detectInitialInputModality,
  modalityFromPointerType,
  type InputModality,
} from '../../utils/inputDetect'

/** Section 9-2: Double-tap detection threshold in ms (default ~300ms) */
export const DOUBLE_TAP_EYEDROPPER_WINDOW_MS = 300

/** Section 4-2: Minimum touch slide distance in CSS px before moving the virtual cursor (taps NEVER move cursor) */
export const TOUCH_SLIDE_DEADZONE_PX = 6

/** Maximum screen distance (CSS px) between two stationary touch taps to count as an intentional double-tap gesture */
export const TOUCH_DOUBLE_TAP_MAX_SEPARATION_PX = 44

interface InteractiveViewportProps {
  projectId: string
  width: number
  height: number
  compositedBuffer: Uint8ClampedArray | null
  onionPrevBuffer?: Uint8ClampedArray | null
  onionNextBuffer?: Uint8ClampedArray | null
  onionOpacity?: number
  isPlaying?: boolean
  tool: ToolId
  toolSettings: ToolSettings
  cursor: Point
  stepPhase: MultiStepPhase
  floatingShape: FloatingShapeState | null
  moveSession: ActiveMoveSession | null
  hasSelection: boolean
  selectionMask: Uint8Array | null
  worldSelection?: WorldSelectionMask | null
  showGrid: boolean
  checkerboardDark: boolean
  activeHexColor: string
  isTransparentColor: boolean
  eyedropperDoubleTap: boolean
  fitTrigger: number
  onModalityChange?: (modality: InputModality) => void
  onMoveCursor: (pt: Point, allowOutOfBounds?: boolean) => void
  onBeginDrawAt: (pt?: Point, allowOutOfBounds?: boolean) => void
  onEndDraw: () => void
  onAbortStroke: () => void
  /** Invoked on double-tap eyedropper gesture; ALWAYS samples from current in-app cursor (NEVER from tap coordinates) */
  onDoubleTapEyedropper: () => void
  onMoveFloatingShape: (dx: number, dy: number) => void
  onUpdateMoveOffset: (dx: number, dy: number) => void
}

interface ActivePointerInfo {
  x: number
  y: number
  pointerType: string
}

function drawPixelHandle(
  ctx: CanvasRenderingContext2D,
  devX: number,
  devY: number,
  fillHex: string,
  dpr: number
) {
  const s = Math.max(1, Math.round(dpr))
  const rx = Math.round(devX)
  const ry = Math.round(devY)
  ctx.save()
  ctx.fillStyle = '#181521'
  ctx.fillRect(rx - 5 * s, ry - 5 * s, 10 * s, 10 * s)
  ctx.fillStyle = '#f8f6f2'
  ctx.fillRect(rx - 4 * s, ry - 4 * s, 8 * s, 8 * s)
  ctx.fillStyle = fillHex
  ctx.fillRect(rx - 2 * s, ry - 2 * s, 4 * s, 4 * s)
  ctx.restore()
}

function drawPixelCornerBrackets(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  armLen: number,
  innerColor: string,
  dpr: number
) {
  const s = Math.max(1, Math.round(dpr))
  const rx = Math.round(x)
  const ry = Math.round(y)
  const rw = Math.max(2 * s, Math.round(w))
  const rh = Math.max(2 * s, Math.round(h))
  const L = Math.max(
    3 * s,
    Math.min(armLen * s, Math.floor(Math.min(rw, rh) / 2) + 2 * s)
  )

  const drawPass = (color: string, expand: number, thickness: number) => {
    ctx.fillStyle = color
    const x0 = rx - expand * s
    const y0 = ry - expand * s
    const x1 = rx + rw + expand * s
    const y1 = ry + rh + expand * s
    const th = thickness * s

    ctx.fillRect(x0, y0, L, th)
    ctx.fillRect(x0, y0, th, L)
    ctx.fillRect(x1 - L, y0, L, th)
    ctx.fillRect(x1 - th, y0, th, L)
    ctx.fillRect(x0, y1 - th, L, th)
    ctx.fillRect(x0, y1 - L, th, L)
    ctx.fillRect(x1 - L, y1 - th, L, th)
    ctx.fillRect(x1 - th, y1 - L, th, L)
  }

  drawPass('#181521', 2, 3)
  drawPass(innerColor, 1, 1)
}

export function InteractiveViewport({
  projectId,
  width,
  height,
  compositedBuffer,
  onionPrevBuffer = null,
  onionNextBuffer = null,
  onionOpacity = 35,
  isPlaying = false,
  tool,
  toolSettings,
  cursor,
  stepPhase,
  floatingShape,
  moveSession,
  hasSelection,
  selectionMask,
  worldSelection = null,
  showGrid,
  checkerboardDark,
  activeHexColor,
  isTransparentColor,
  eyedropperDoubleTap,
  fitTrigger,
  onModalityChange,
  onMoveCursor,
  onBeginDrawAt,
  onEndDraw,
  onAbortStroke,
  onDoubleTapEyedropper,
  onMoveFloatingShape,
  onUpdateMoveOffset,
}: InteractiveViewportProps) {
  const { reducedMotion } = useApp()
  const { t } = useI18n()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const onionCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({
    w: 360,
    h: 360,
  })
  const [transform, setTransform] = useState<ViewportTransform>({
    scale: 8,
    panX: 24,
    panY: 24,
  })
  const [modality, setModalityState] = useState<InputModality>(() =>
    detectInitialInputModality()
  )
  const setModality = useCallback(
    (next: InputModality) => {
      setModalityState((prev) => (prev === next ? prev : next))
      onModalityChange?.(next)
    },
    [onModalityChange]
  )

  useEffect(() => {
    onModalityChange?.(modality)
  }, [modality, onModalityChange])
  const [spacePressed, setSpacePressed] = useState(false)
  const [antsOffset, setAntsOffset] = useState(0)

  const allowsOutOfBoundsPoint =
    tool === 'line' ||
    tool === 'shape' ||
    (tool === 'fill' && toolSettings.fillMode === 'gradient' && stepPhase.kind === 'gradient-end') ||
    (tool === 'select' && toolSettings.selectType !== 'wand')

  useEffect(() => {
    if (!hasSelection || reducedMotion) {
      setAntsOffset(0)
      return
    }
    const id = window.setInterval(() => {
      setAntsOffset((prev) => (prev + 1) % 8)
    }, 110)
    return () => window.clearInterval(id)
  }, [hasSelection, reducedMotion])

  const subPixelCursorRef = useRef<{ x: number; y: number }>({
    x: cursor.x,
    y: cursor.y,
  })
  useEffect(() => {
    if (
      Math.abs(subPixelCursorRef.current.x - cursor.x) >= 1 ||
      Math.abs(subPixelCursorRef.current.y - cursor.y) >= 1
    ) {
      subPixelCursorRef.current = { x: cursor.x, y: cursor.y }
    }
  }, [cursor.x, cursor.y])

  const activePointersRef = useRef<Map<number, ActivePointerInfo>>(new Map())
  const pinchStateRef = useRef<{
    prevDist: number
    prevMidX: number
    prevMidY: number
  } | null>(null)

  const singleGestureRef = useRef<{
    pointerId: number
    mode:
      | 'touch-cursor'
      | 'mouse-draw'
      | 'mouse-deferred-tap'
      | 'pan'
      | 'floating-drag'
      | 'move-session-drag'
    startVx: number
    startVy: number
    lastVx: number
    lastVy: number
    startCanvasPt: Point
    moved: boolean
    hadMultiTouch: boolean
    accumFloatX: number
    accumFloatY: number
  } | null>(null)

  /**
   * Section 3: Touch double-tap gesture state (strictly decoupled from cursor sample coordinates!)
   * & Mouse double-tap state so the 1st mouse click does not leave an unintended dot.
   */
  const lastTouchTapRef = useRef<{
    vx: number
    vy: number
    time: number
  } | null>(null)
  const lastTapRef = useRef<{
    canvasX: number
    canvasY: number
    time: number
  } | null>(null)
  const pendingSingleTapTimerRef = useRef<number | null>(null)
  const pendingSingleTapPointRef = useRef<{
    pt: Point
    allowOutOfBounds: boolean
  } | null>(null)

  const cancelPendingSingleTap = useCallback(() => {
    if (pendingSingleTapTimerRef.current !== null) {
      window.clearTimeout(pendingSingleTapTimerRef.current)
      pendingSingleTapTimerRef.current = null
    }
    pendingSingleTapPointRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      cancelPendingSingleTap()
    }
  }, [cancelPendingSingleTap])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)
      ) {
        setSpacePressed(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const updateSize = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize({ w: rect.width, h: rect.height })
      }
    }
    updateSize()

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => updateSize())
      ro.observe(el)
      return () => ro.disconnect()
    }
  }, [])

  useEffect(() => {
    if (viewportSize.w <= 0 || viewportSize.h <= 0) return
    setTransform(computeFitViewport(width, height, viewportSize.w, viewportSize.h, 0.86))
  }, [width, height, fitTrigger, viewportSize.w, viewportSize.h])

  useEffect(() => {
    const canvas = displayCanvasRef.current
    if (!canvas || viewportSize.w <= 0 || viewportSize.h <= 0) return

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3))
    const devViewportW = Math.max(1, Math.round(viewportSize.w * dpr))
    const devViewportH = Math.max(1, Math.round(viewportSize.h * dpr))

    if (canvas.width !== devViewportW || canvas.height !== devViewportH) {
      canvas.width = devViewportW
      canvas.height = devViewportH
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, devViewportW, devViewportH)

    const { scale, panX, panY } = transform
    const devLeft = Math.round(panX * dpr)
    const devTop = Math.round(panY * dpr)
    const devW = Math.max(1, Math.round(width * scale * dpr))
    const devH = Math.max(1, Math.round(height * scale * dpr))

    const colDevX = (cx: number) => devLeft + Math.round((cx * devW) / width)
    const rowDevY = (cy: number) => devTop + Math.round((cy * devH) / height)

    // 1. Transparency Checkerboard + Artwork strictly clipped to `[devLeft, devTop, devW, devH]`
    ctx.save()
    ctx.beginPath()
    ctx.rect(devLeft, devTop, devW, devH)
    ctx.clip()

    const checkCell = Math.max(
      Math.round(4 * dpr),
      Math.min(Math.round(16 * dpr), scale >= 2 ? Math.round(scale * dpr) : Math.round(8 * dpr))
    )
    const cLight = checkerboardDark ? '#272334' : '#ede9df'
    const cDark = checkerboardDark ? '#1d1a27' : '#dbd5c7'
    ctx.fillStyle = cLight
    ctx.fillRect(devLeft, devTop, devW, devH)
    ctx.fillStyle = cDark

    const cols = Math.ceil(devW / checkCell)
    const rows = Math.ceil(devH / checkCell)
    for (let r = 0; r < rows; r++) {
      const y0 = devTop + r * checkCell
      const hCell = Math.min(checkCell, devTop + devH - y0)
      if (hCell <= 0) continue
      for (let c = r % 2; c < cols; c += 2) {
        const x0 = devLeft + c * checkCell
        const wCell = Math.min(checkCell, devLeft + devW - x0)
        if (wCell <= 0) continue
        ctx.fillRect(x0, y0, wCell, hCell)
      }
    }

    // 1b. Optional Onion Skin Underlays (Prev frame tinted warm rose, Next frame tinted cool teal) when not playing
    const drawOnionBuffer = (
      buf: Uint8ClampedArray | null,
      tint: [number, number, number],
      alpha: number
    ) => {
      if (isPlaying || !buf || buf.length !== width * height * 4) return
      if (!onionCanvasRef.current) {
        onionCanvasRef.current = document.createElement('canvas')
      }
      const oc = onionCanvasRef.current
      if (oc.width !== width || oc.height !== height) {
        oc.width = width
        oc.height = height
      }
      const octx = oc.getContext('2d')
      if (!octx) return
      const tinted = new Uint8ClampedArray(buf.length)
      for (let i = 0; i < buf.length; i += 4) {
        const a = buf[i + 3]!
        if (a === 0) continue
        tinted[i] = Math.round(buf[i]! * 0.45 + tint[0] * 0.55)
        tinted[i + 1] = Math.round(buf[i + 1]! * 0.45 + tint[1] * 0.55)
        tinted[i + 2] = Math.round(buf[i + 2]! * 0.45 + tint[2] * 0.55)
        tinted[i + 3] = Math.round(a * alpha)
      }
      octx.putImageData(new ImageData(tinted, width, height), 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(oc, 0, 0, width, height, devLeft, devTop, devW, devH)
    }
    const baseOnionAlpha = Math.max(0.05, Math.min(0.85, onionOpacity / 100))
    drawOnionBuffer(onionPrevBuffer, [216, 108, 130], baseOnionAlpha)
    drawOnionBuffer(onionNextBuffer, [87, 175, 162], baseOnionAlpha * 0.9)

    if (compositedBuffer && compositedBuffer.length === width * height * 4) {
      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas')
      }
      const off = offscreenCanvasRef.current
      if (off.width !== width || off.height !== height) {
        off.width = width
        off.height = height
      }
      const offCtx = off.getContext('2d')
      if (offCtx) {
        const imgData = new ImageData(
          new Uint8ClampedArray(compositedBuffer),
          width,
          height
        )
        offCtx.putImageData(imgData, 0, 0)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(off, 0, 0, width, height, devLeft, devTop, devW, devH)
      }
    }

    // 2. Adaptive Interior Pixel Grid (`1..width-1`, `1..height-1`)
    const cellDevSize = devW / width
    if (showGrid && scale >= 3 && cellDevSize >= 4) {
      const zoomFactor = Math.min(1, (scale - 3) / 10)
      const darkAlpha = 0.14 + zoomFactor * 0.24
      const lightAlpha = 0.10 + zoomFactor * 0.18
      const majorInterval = 8

      for (let x = 1; x < width; x++) {
        const gx = colDevX(x)
        const isMajor = scale >= 6 && x % majorInterval === 0
        ctx.fillStyle = `rgba(24, 21, 33, ${isMajor ? Math.min(0.52, darkAlpha + 0.12) : darkAlpha})`
        ctx.fillRect(gx, devTop, 1, devH)
        if (cellDevSize >= 10) {
          ctx.fillStyle = `rgba(248, 246, 242, ${isMajor ? lightAlpha + 0.08 : lightAlpha})`
          ctx.fillRect(gx - 1, devTop, 1, devH)
        }
      }
      for (let y = 1; y < height; y++) {
        const gy = rowDevY(y)
        const isMajor = scale >= 6 && y % majorInterval === 0
        ctx.fillStyle = `rgba(24, 21, 33, ${isMajor ? Math.min(0.52, darkAlpha + 0.12) : darkAlpha})`
        ctx.fillRect(devLeft, gy, devW, 1)
        if (cellDevSize >= 10) {
          ctx.fillStyle = `rgba(248, 246, 242, ${isMajor ? lightAlpha + 0.08 : lightAlpha})`
          ctx.fillRect(devLeft, gy - 1, devW, 1)
        }
      }
    }

    ctx.restore()

    // 3. Crisp Symmetric 4-Sided Outer Pixel Frame
    const borderPx = Math.max(2, Math.round(2 * dpr))
    ctx.fillStyle = checkerboardDark ? '#696082' : '#4a4358'
    ctx.fillRect(devLeft - borderPx, devTop - borderPx, devW + borderPx * 2, borderPx)
    ctx.fillRect(devLeft - borderPx, devTop + devH, devW + borderPx * 2, borderPx)
    ctx.fillRect(devLeft - borderPx, devTop, borderPx, devH)
    ctx.fillRect(devLeft + devW, devTop, borderPx, devH)

    // 4. Animated Marching Ants Selection Boundary (renders in full world space so off-canvas selections remain visible in viewport!)
    if (worldSelection && worldSelection.width > 0 && worldSelection.height > 0) {
      ctx.save()
      ctx.beginPath()
      const { originX, originY, width: sw, height: sh, mask: sm } = worldSelection
      for (let ly = 0; ly < sh; ly++) {
        const wy = originY + ly
        const py0 = rowDevY(wy)
        const py1 = rowDevY(wy + 1)
        if (py1 < -4 || py0 > devViewportH + 4) continue
        for (let lx = 0; lx < sw; lx++) {
          if (sm[ly * sw + lx] === 0) continue
          const wx = originX + lx
          const px0 = colDevX(wx)
          const px1 = colDevX(wx + 1)
          if (px1 < -4 || px0 > devViewportW + 4) continue

          if (ly === 0 || sm[(ly - 1) * sw + lx] === 0) {
            ctx.moveTo(px0, py0)
            ctx.lineTo(px1, py0)
          }
          if (ly === sh - 1 || sm[(ly + 1) * sw + lx] === 0) {
            ctx.moveTo(px0, py1)
            ctx.lineTo(px1, py1)
          }
          if (lx === 0 || sm[ly * sw + (lx - 1)] === 0) {
            ctx.moveTo(px0, py0)
            ctx.lineTo(px0, py1)
          }
          if (lx === sw - 1 || sm[ly * sw + (lx + 1)] === 0) {
            ctx.moveTo(px1, py0)
            ctx.lineTo(px1, py1)
          }
        }
      }
      const dashLen = Math.max(4, Math.round(4 * dpr))
      ctx.lineWidth = Math.max(2, Math.round(2 * dpr))
      ctx.strokeStyle = '#181521'
      ctx.setLineDash([])
      ctx.stroke()

      ctx.strokeStyle = '#f8f6f2'
      ctx.setLineDash([dashLen, dashLen])
      ctx.lineDashOffset = -Math.round((antsOffset / 8) * dashLen * 2)
      ctx.stroke()
      ctx.restore()
    } else if (selectionMask && selectionMask.length === width * height) {
      ctx.save()
      ctx.beginPath()
      for (let y = 0; y < height; y++) {
        const py0 = rowDevY(y)
        const py1 = rowDevY(y + 1)
        for (let x = 0; x < width; x++) {
          if (selectionMask[y * width + x] === 0) continue
          const px0 = colDevX(x)
          const px1 = colDevX(x + 1)

          if (y === 0 || selectionMask[(y - 1) * width + x] === 0) {
            ctx.moveTo(px0, py0)
            ctx.lineTo(px1, py0)
          }
          if (y === height - 1 || selectionMask[(y + 1) * width + x] === 0) {
            ctx.moveTo(px0, py1)
            ctx.lineTo(px1, py1)
          }
          if (x === 0 || selectionMask[y * width + (x - 1)] === 0) {
            ctx.moveTo(px0, py0)
            ctx.lineTo(px0, py1)
          }
          if (x === width - 1 || selectionMask[y * width + (x + 1)] === 0) {
            ctx.moveTo(px1, py0)
            ctx.lineTo(px1, py1)
          }
        }
      }
      const dashLen = Math.max(4, Math.round(4 * dpr))
      ctx.lineWidth = Math.max(2, Math.round(2 * dpr))
      ctx.strokeStyle = '#181521'
      ctx.setLineDash([])
      ctx.stroke()

      ctx.strokeStyle = '#f8f6f2'
      ctx.setLineDash([dashLen, dashLen])
      ctx.lineDashOffset = -Math.round((antsOffset / 8) * dashLen * 2)
      ctx.stroke()
      ctx.restore()
    }

    // 5. Active Layer / Multi-Layer Move Frame
    if (
      moveSession &&
      (moveSession.mode === 'layer' || moveSession.mode === 'multi-layer')
    ) {
      const lx = moveSession.initialLayerOffsetX + moveSession.dx
      const ly = moveSession.initialLayerOffsetY + moveSession.dy
      const bx0 = colDevX(lx)
      const by0 = rowDevY(ly)
      const bx1 = colDevX(lx + moveSession.extractedWidth)
      const by1 = rowDevY(ly + moveSession.extractedHeight)
      const bw = bx1 - bx0
      const bh = by1 - by0
      ctx.save()
      const dashLen = Math.max(4, Math.round(4 * dpr))
      ctx.lineWidth = Math.max(2, Math.round(2 * dpr))
      ctx.strokeStyle = '#181521'
      ctx.strokeRect(bx0, by0, bw, bh)
      ctx.setLineDash([dashLen, dashLen])
      ctx.lineDashOffset = -Math.round((antsOffset / 8) * dashLen * 2)
      ctx.strokeStyle = '#579b91'
      ctx.strokeRect(bx0, by0, bw, bh)
      ctx.restore()
    }

    // 6. Floating Shape Transform Pixel Frame & Square Handles
    if (floatingShape) {
      const tf = rasterizeTransformedShape(floatingShape)
      const bx = colDevX(tf.left)
      const by = rowDevY(tf.top)
      const bw = colDevX(tf.left + tf.width) - bx
      const bh = rowDevY(tf.top + tf.height) - by

      ctx.save()
      ctx.strokeStyle = '#181521'
      ctx.lineWidth = Math.max(2, Math.round(2.5 * dpr))
      ctx.strokeRect(bx, by, bw, bh)
      ctx.setLineDash([Math.round(4 * dpr), Math.round(3 * dpr)])
      ctx.strokeStyle = '#8476c4'
      ctx.lineWidth = Math.max(1.5, Math.round(1.5 * dpr))
      ctx.strokeRect(bx, by, bw, bh)
      ctx.restore()

      drawPixelHandle(ctx, bx, by, '#8476c4', dpr)
      drawPixelHandle(ctx, bx + bw, by, '#8476c4', dpr)
      drawPixelHandle(ctx, bx, by + bh, '#8476c4', dpr)
      drawPixelHandle(ctx, bx + bw, by + bh, '#8476c4', dpr)
    }

    // 7. Multi-step Control Handles & Guide Lines (also visible outside canvas bounds!)
    const pixelCenter = (p: Point) => ({
      sx: (colDevX(p.x) + colDevX(p.x + 1)) / 2,
      sy: (rowDevY(p.y) + rowDevY(p.y + 1)) / 2,
    })

    const drawDashedGuide = (a: Point, b: Point, color: string) => {
      const pA = pixelCenter(a)
      const pB = pixelCenter(b)
      ctx.save()
      ctx.strokeStyle = '#181521'
      ctx.lineWidth = Math.max(2, Math.round(2.5 * dpr))
      ctx.setLineDash([Math.round(4 * dpr), Math.round(4 * dpr)])
      ctx.beginPath()
      ctx.moveTo(pA.sx, pA.sy)
      ctx.lineTo(pB.sx, pB.sy)
      ctx.stroke()
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr))
      ctx.stroke()
      ctx.restore()
    }

    if (stepPhase.kind === 'gradient-end') {
      drawDashedGuide(stepPhase.start, cursor, '#579b91')
      const s0 = pixelCenter(stepPhase.start)
      const s1 = pixelCenter(cursor)
      if (toolSettings.gradientType === 'radial') {
        const rxPx = toolSettings.gradientFixedRatio
          ? Math.hypot(s1.sx - s0.sx, s1.sy - s0.sy)
          : Math.abs(s1.sx - s0.sx)
        const ryPx = toolSettings.gradientFixedRatio
          ? Math.hypot(s1.sx - s0.sx, s1.sy - s0.sy)
          : Math.abs(s1.sy - s0.sy)
        if (rxPx > 1 || ryPx > 1) {
          ctx.save()
          ctx.setLineDash([Math.round(4 * dpr), Math.round(4 * dpr)])
          ctx.lineWidth = Math.max(1.5, Math.round(1.5 * dpr))
          ctx.strokeStyle = '#579b91'
          ctx.beginPath()
          if (typeof ctx.ellipse === 'function') {
            ctx.ellipse(s0.sx, s0.sy, Math.max(1, rxPx), Math.max(1, ryPx), 0, 0, Math.PI * 2)
          } else {
            ctx.rect(s0.sx - rxPx, s0.sy - ryPx, rxPx * 2, ryPx * 2)
          }
          ctx.stroke()
          ctx.restore()
        }
      }
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', dpr)
      drawPixelHandle(ctx, s1.sx, s1.sy, '#c47388', dpr)
    } else if (stepPhase.kind === 'line-end' || stepPhase.kind === 'shape-end') {
      const s0 = pixelCenter(stepPhase.start)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', dpr)
    } else if (stepPhase.kind === 'select-end') {
      const s0 = pixelCenter(stepPhase.start)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', dpr)
      const minX = Math.min(stepPhase.start.x, cursor.x)
      const maxX = Math.max(stepPhase.start.x, cursor.x)
      const minY = Math.min(stepPhase.start.y, cursor.y)
      const maxY = Math.max(stepPhase.start.y, cursor.y)
      ctx.save()
      ctx.setLineDash([Math.round(4 * dpr), Math.round(4 * dpr)])
      ctx.lineWidth = Math.max(1.5, Math.round(1.5 * dpr))
      ctx.strokeStyle = '#579b91'
      ctx.strokeRect(
        colDevX(minX),
        rowDevY(minY),
        colDevX(maxX + 1) - colDevX(minX),
        rowDevY(maxY + 1) - rowDevY(minY)
      )
      ctx.restore()
    } else if (stepPhase.kind === 'bezier-p3') {
      const s0 = pixelCenter(stepPhase.p0)
      const s3 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', dpr)
      drawPixelHandle(ctx, s3.sx, s3.sy, '#8476c4', dpr)
    } else if (stepPhase.kind === 'bezier-p1') {
      drawDashedGuide(stepPhase.p0, cursor, '#c47388')
      const s0 = pixelCenter(stepPhase.p0)
      const s3 = pixelCenter(stepPhase.p3)
      const s1 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', dpr)
      drawPixelHandle(ctx, s3.sx, s3.sy, '#8476c4', dpr)
      drawPixelHandle(ctx, s1.sx, s1.sy, '#c47388', dpr)
    } else if (stepPhase.kind === 'bezier-p2') {
      drawDashedGuide(stepPhase.p0, stepPhase.p1, '#c47388')
      drawDashedGuide(stepPhase.p3, cursor, '#c47388')
      const s0 = pixelCenter(stepPhase.p0)
      const s3 = pixelCenter(stepPhase.p3)
      const s1 = pixelCenter(stepPhase.p1)
      const s2 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', dpr)
      drawPixelHandle(ctx, s3.sx, s3.sy, '#8476c4', dpr)
      drawPixelHandle(ctx, s1.sx, s1.sy, '#c47388', dpr)
      drawPixelHandle(ctx, s2.sx, s2.sy, '#d99b52', dpr)
    }

    // 8. Tool-Specific Virtual Pixel Cursor
    // Section 3-1: On PC (`modality === 'mouse'`), hide the app's custom virtual cursor and draw with OS mouse cursor!
    if (!floatingShape && !moveSession && !isPlaying && modality !== 'mouse') {
      const cellX0 = colDevX(cursor.x)
      const cellY0 = rowDevY(cursor.y)
      const cellW = Math.max(Math.round(2 * dpr), colDevX(cursor.x + 1) - cellX0)
      const cellH = Math.max(Math.round(2 * dpr), rowDevY(cursor.y + 1) - cellY0)

      const drawBrushBoundary = (
        size: number,
        shape: BrushShape,
        accentHex: string,
        dashedErase = false
      ) => {
        const offsets = getBrushOffsets(size, shape)
        let minDx = 0
        let maxDx = 0
        let minDy = 0
        let maxDy = 0
        const set = new Set<string>()
        for (const o of offsets) {
          if (o.x < minDx) minDx = o.x
          if (o.x > maxDx) maxDx = o.x
          if (o.y < minDy) minDy = o.y
          if (o.y > maxDy) maxDy = o.y
          set.add(`${o.x},${o.y}`)
        }

        ctx.save()
        ctx.beginPath()
        for (const o of offsets) {
          const px0 = colDevX(cursor.x + o.x)
          const px1 = colDevX(cursor.x + o.x + 1)
          const py0 = rowDevY(cursor.y + o.y)
          const py1 = rowDevY(cursor.y + o.y + 1)
          if (!set.has(`${o.x},${o.y - 1}`)) {
            ctx.moveTo(px0, py0)
            ctx.lineTo(px1, py0)
          }
          if (!set.has(`${o.x},${o.y + 1}`)) {
            ctx.moveTo(px0, py1)
            ctx.lineTo(px1, py1)
          }
          if (!set.has(`${o.x - 1},${o.y}`)) {
            ctx.moveTo(px0, py0)
            ctx.lineTo(px0, py1)
          }
          if (!set.has(`${o.x + 1},${o.y}`)) {
            ctx.moveTo(px1, py0)
            ctx.lineTo(px1, py1)
          }
        }
        ctx.strokeStyle = '#181521'
        ctx.lineWidth = Math.max(2, Math.round(2 * dpr))
        ctx.stroke()
        if (dashedErase) {
          ctx.setLineDash([Math.round(3 * dpr), Math.round(3 * dpr)])
        }
        ctx.strokeStyle = accentHex
        ctx.lineWidth = Math.max(1, Math.round(dpr))
        ctx.stroke()
        ctx.restore()

        if (modality === 'touch') {
          const bx0 = colDevX(cursor.x + minDx) - Math.round(3 * dpr)
          const by0 = rowDevY(cursor.y + minDy) - Math.round(3 * dpr)
          const bw =
            colDevX(cursor.x + maxDx + 1) -
            colDevX(cursor.x + minDx) +
            Math.round(6 * dpr)
          const bh =
            rowDevY(cursor.y + maxDy + 1) -
            rowDevY(cursor.y + minDy) +
            Math.round(6 * dpr)
          drawPixelCornerBrackets(ctx, bx0, by0, bw, bh, 5, accentHex, dpr)
        }
      }

      if (tool === 'pen') {
        drawBrushBoundary(
          toolSettings.penSize,
          toolSettings.penShape,
          isTransparentColor ? '#c47388' : '#f8f6f2',
          isTransparentColor
        )
      } else if (tool === 'eraser') {
        drawBrushBoundary(
          toolSettings.eraserSize,
          toolSettings.eraserShape,
          '#c47388',
          true
        )
      } else if (tool === 'line') {
        // Section 2: Line & Bezier cursor reflects exact `lineSize` & `lineShape` immediately!
        drawBrushBoundary(
          toolSettings.lineSize,
          toolSettings.lineShape,
          isTransparentColor ? '#c47388' : '#8476c4',
          isTransparentColor
        )
      } else if (tool === 'fill') {
        drawPixelCornerBrackets(ctx, cellX0, cellY0, cellW, cellH, 5, '#579b91', dpr)
      } else if (tool === 'eyedropper') {
        drawPixelCornerBrackets(
          ctx,
          cellX0 - dpr,
          cellY0 - dpr,
          cellW + 2 * dpr,
          cellH + 2 * dpr,
          5,
          '#f8f6f2',
          dpr
        )
      } else if (tool === 'select') {
        drawPixelCornerBrackets(
          ctx,
          cellX0 - dpr,
          cellY0 - dpr,
          cellW + 2 * dpr,
          cellH + 2 * dpr,
          5,
          '#579b91',
          dpr
        )
      } else {
        drawPixelCornerBrackets(ctx, cellX0, cellY0, cellW, cellH, 5, '#8476c4', dpr)
      }
    }

    ctx.restore()
  }, [
    viewportSize,
    transform,
    width,
    height,
    compositedBuffer,
    onionPrevBuffer,
    onionNextBuffer,
    onionOpacity,
    isPlaying,
    tool,
    toolSettings,
    showGrid,
    checkerboardDark,
    selectionMask,
    antsOffset,
    floatingShape,
    moveSession,
    stepPhase,
    cursor,
    modality,
    activeHexColor,
    isTransparentColor,
  ])

  const getLocalCoords = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { vx: clientX, vy: clientY }
    return {
      vx: clientX - rect.left,
      vy: clientY - rect.top,
    }
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = containerRef.current
      if (!el) return
      if (typeof el.setPointerCapture === 'function') {
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // ignore synthetic event capture errors
        }
      }

      const detected = modalityFromPointerType(e.pointerType)
      setModality(detected)

      const { vx, vy } = getLocalCoords(e.clientX, e.clientY)
      activePointersRef.current.set(e.pointerId, {
        x: vx,
        y: vy,
        pointerType: e.pointerType,
      })

      if (activePointersRef.current.size === 2) {
        cancelPendingSingleTap()
        lastTapRef.current = null
        lastTouchTapRef.current = null
        if (singleGestureRef.current) {
          singleGestureRef.current.hadMultiTouch = true
          if (singleGestureRef.current.mode === 'mouse-draw') {
            onAbortStroke()
          }
        }
        singleGestureRef.current = null
        const pts = Array.from(activePointersRef.current.values())
        const dist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y))
        const midX = (pts[0].x + pts[1].x) / 2
        const midY = (pts[0].y + pts[1].y) / 2
        pinchStateRef.current = { prevDist: dist, prevMidX: midX, prevMidY: midY }
        return
      }

      if (activePointersRef.current.size > 2) return

      if (e.button === 1 || e.button === 2 || spacePressed) {
        cancelPendingSingleTap()
        lastTapRef.current = null
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'pan',
          startVx: vx,
          startVy: vy,
          lastVx: vx,
          lastVy: vy,
          startCanvasPt: { x: 0, y: 0 },
          moved: false,
          hadMultiTouch: false,
          accumFloatX: 0,
          accumFloatY: 0,
        }
        return
      }

      if (moveSession) {
        cancelPendingSingleTap()
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'move-session-drag',
          startVx: vx,
          startVy: vy,
          lastVx: vx,
          lastVy: vy,
          startCanvasPt: { x: 0, y: 0 },
          moved: false,
          hadMultiTouch: false,
          accumFloatX: 0,
          accumFloatY: 0,
        }
        return
      }

      if (floatingShape) {
        cancelPendingSingleTap()
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'floating-drag',
          startVx: vx,
          startVy: vy,
          lastVx: vx,
          lastVy: vy,
          startCanvasPt: { x: 0, y: 0 },
          moved: false,
          hadMultiTouch: false,
          accumFloatX: 0,
          accumFloatY: 0,
        }
        return
      }

      const rawCanvasPt = screenToCanvasPixel(vx, vy, transform)

      if (detected === 'touch') {
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'touch-cursor',
          startVx: vx,
          startVy: vy,
          lastVx: vx,
          lastVy: vy,
          startCanvasPt: rawCanvasPt,
          moved: false,
          hadMultiTouch: false,
          accumFloatX: subPixelCursorRef.current.x,
          accumFloatY: subPixelCursorRef.current.y,
        }
      } else if (e.button === 0) {
        const targetPt = allowsOutOfBoundsPoint
          ? rawCanvasPt
          : clampCanvasPoint(rawCanvasPt, width, height)
        subPixelCursorRef.current = { x: targetPt.x, y: targetPt.y }
        onMoveCursor(targetPt, allowsOutOfBoundsPoint)

        const isInsideCanvas =
          rawCanvasPt.x >= 0 &&
          rawCanvasPt.x < width &&
          rawCanvasPt.y >= 0 &&
          rawCanvasPt.y < height

        // Section 9: Check if this is the 2nd tap on the SAME canvas pixel within 300ms!
        const now = performance.now()
        const prevTap = lastTapRef.current
        if (
          eyedropperDoubleTap &&
          tool !== 'eyedropper' &&
          stepPhase.kind === 'idle' &&
          isInsideCanvas &&
          prevTap &&
          prevTap.canvasX === rawCanvasPt.x &&
          prevTap.canvasY === rawCanvasPt.y &&
          now - prevTap.time <= DOUBLE_TAP_EYEDROPPER_WINDOW_MS
        ) {
          cancelPendingSingleTap()
          lastTapRef.current = null
          onAbortStroke()
          onDoubleTapEyedropper()
          return
        }

        // If double-tap eyedropper is active and user clicks inside canvas while idle,
        // defer committing a single-pixel click slightly so a 2nd tap won't leave an unwanted dot,
        // while immediately converting to responsive continuous drag (`mouse-draw`) the moment pointer moves!
        if (
          eyedropperDoubleTap &&
          tool !== 'eyedropper' &&
          stepPhase.kind === 'idle' &&
          isInsideCanvas
        ) {
          // Flush any earlier pending tap on a different pixel immediately
          if (pendingSingleTapPointRef.current) {
            const earlier = pendingSingleTapPointRef.current
            cancelPendingSingleTap()
            onBeginDrawAt(earlier.pt, earlier.allowOutOfBounds)
            onEndDraw()
          }
          singleGestureRef.current = {
            pointerId: e.pointerId,
            mode: 'mouse-deferred-tap',
            startVx: vx,
            startVy: vy,
            lastVx: vx,
            lastVy: vy,
            startCanvasPt: rawCanvasPt,
            moved: false,
            hadMultiTouch: false,
            accumFloatX: targetPt.x,
            accumFloatY: targetPt.y,
          }
          return
        }

        onBeginDrawAt(targetPt, allowsOutOfBoundsPoint)
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'mouse-draw',
          startVx: vx,
          startVy: vy,
          lastVx: vx,
          lastVy: vy,
          startCanvasPt: rawCanvasPt,
          moved: false,
          hadMultiTouch: false,
          accumFloatX: targetPt.x,
          accumFloatY: targetPt.y,
        }
      }
    },
    [
      getLocalCoords,
      cancelPendingSingleTap,
      onAbortStroke,
      spacePressed,
      moveSession,
      floatingShape,
      transform,
      allowsOutOfBoundsPoint,
      width,
      height,
      onMoveCursor,
      eyedropperDoubleTap,
      tool,
      stepPhase.kind,
      onDoubleTapEyedropper,
      onBeginDrawAt,
      onEndDraw,
    ]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const { vx, vy } = getLocalCoords(e.clientX, e.clientY)
      if (activePointersRef.current.has(e.pointerId)) {
        activePointersRef.current.set(e.pointerId, {
          x: vx,
          y: vy,
          pointerType: e.pointerType,
        })
      }

      if (activePointersRef.current.size === 2 && pinchStateRef.current) {
        const pts = Array.from(activePointersRef.current.values())
        const dist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y))
        const midX = (pts[0].x + pts[1].x) / 2
        const midY = (pts[0].y + pts[1].y) / 2

        const { prevDist, prevMidX, prevMidY } = pinchStateRef.current
        const ratio = dist / prevDist
        const panDx = midX - prevMidX
        const panDy = midY - prevMidY

        setTransform((curr) => {
          const zoomed = zoomAroundPoint(
            curr,
            curr.scale * ratio,
            midX,
            midY,
            width,
            height,
            viewportSize.w,
            viewportSize.h
          )
          return clampViewportTransform(
            {
              scale: zoomed.scale,
              panX: zoomed.panX + panDx,
              panY: zoomed.panY + panDy,
            },
            width,
            height,
            viewportSize.w,
            viewportSize.h
          )
        })

        pinchStateRef.current = { prevDist: dist, prevMidX: midX, prevMidY: midY }
        return
      }

      const g = singleGestureRef.current
      if (g && g.pointerId === e.pointerId) {
        const dxCss = vx - g.lastVx
        const dyCss = vy - g.lastVy
        const distFromStart = Math.hypot(vx - g.startVx, vy - g.startVy)
        g.lastVx = vx
        g.lastVy = vy

        const moveThreshold =
          g.mode === 'touch-cursor' ? TOUCH_SLIDE_DEADZONE_PX : 4
        if (!g.moved && distFromStart >= moveThreshold) {
          g.moved = true
        }

        if (g.mode === 'pan') {
          setTransform((curr) =>
            clampViewportTransform(
              {
                scale: curr.scale,
                panX: curr.panX + dxCss,
                panY: curr.panY + dyCss,
              },
              width,
              height,
              viewportSize.w,
              viewportSize.h
            )
          )
          return
        }

        if (g.mode === 'move-session-drag') {
          const effScale = Math.max(0.5, transform.scale)
          g.accumFloatX += dxCss / effScale
          g.accumFloatY += dyCss / effScale
          const moveX = Math.trunc(g.accumFloatX)
          const moveY = Math.trunc(g.accumFloatY)
          if (moveX !== 0 || moveY !== 0) {
            g.accumFloatX -= moveX
            g.accumFloatY -= moveY
            onUpdateMoveOffset(moveX, moveY)
          }
          return
        }

        if (g.mode === 'floating-drag') {
          const effScale = Math.max(0.5, transform.scale)
          g.accumFloatX += dxCss / effScale
          g.accumFloatY += dyCss / effScale
          const moveX = Math.trunc(g.accumFloatX)
          const moveY = Math.trunc(g.accumFloatY)
          if (moveX !== 0 || moveY !== 0) {
            g.accumFloatX -= moveX
            g.accumFloatY -= moveY
            onMoveFloatingShape(moveX, moveY)
          }
          return
        }

        if (g.mode === 'touch-cursor') {
          // Section 4-2: Touching/tapping alone MUST NOT move the cursor!
          // Only start moving the cursor AFTER the finger slides past TOUCH_SLIDE_DEADZONE_PX,
          // and move purely by relative finger delta from the existing cursor (never jump to tap point).
          if (!g.moved) {
            return
          }
          // Sliding cancels any pending double-tap gesture so slides are NEVER misrecognized as double-taps!
          lastTouchTapRef.current = null
          const effScale = Math.max(0.5, transform.scale)
          const nextFloatX = allowsOutOfBoundsPoint
            ? Math.max(-512, Math.min(width + 512, subPixelCursorRef.current.x + dxCss / effScale))
            : Math.max(0, Math.min(width - 1, subPixelCursorRef.current.x + dxCss / effScale))
          const nextFloatY = allowsOutOfBoundsPoint
            ? Math.max(-512, Math.min(height + 512, subPixelCursorRef.current.y + dyCss / effScale))
            : Math.max(0, Math.min(height - 1, subPixelCursorRef.current.y + dyCss / effScale))

          subPixelCursorRef.current = { x: nextFloatX, y: nextFloatY }

          const snappedX = Math.round(nextFloatX)
          const snappedY = Math.round(nextFloatY)
          onMoveCursor({ x: snappedX, y: snappedY }, allowsOutOfBoundsPoint)
          return
        }

        // Convert deferred tap into immediate continuous stroke once pointer moves across pixels or > 4px!
        if (g.mode === 'mouse-deferred-tap') {
          const rawPt = screenToCanvasPixel(vx, vy, transform)
          if (
            g.moved ||
            rawPt.x !== g.startCanvasPt.x ||
            rawPt.y !== g.startCanvasPt.y
          ) {
            lastTapRef.current = null
            g.mode = 'mouse-draw'
            const startTarget = allowsOutOfBoundsPoint
              ? g.startCanvasPt
              : clampCanvasPoint(g.startCanvasPt, width, height)
            onBeginDrawAt(startTarget, allowsOutOfBoundsPoint)
            const nextPt = allowsOutOfBoundsPoint
              ? rawPt
              : clampCanvasPoint(rawPt, width, height)
            subPixelCursorRef.current = { x: nextPt.x, y: nextPt.y }
            onMoveCursor(nextPt, allowsOutOfBoundsPoint)
          }
          return
        }

        if (g.mode === 'mouse-draw') {
          const rawPt = screenToCanvasPixel(vx, vy, transform)
          const targetPt = allowsOutOfBoundsPoint
            ? rawPt
            : clampCanvasPoint(rawPt, width, height)
          subPixelCursorRef.current = { x: targetPt.x, y: targetPt.y }
          onMoveCursor(targetPt, allowsOutOfBoundsPoint)
          return
        }
      }

      if (
        e.pointerType === 'mouse' &&
        activePointersRef.current.size === 0 &&
        !floatingShape &&
        !moveSession
      ) {
        const rawPt = screenToCanvasPixel(vx, vy, transform)
        if (allowsOutOfBoundsPoint && stepPhase.kind !== 'idle') {
          subPixelCursorRef.current = { x: rawPt.x, y: rawPt.y }
          onMoveCursor(rawPt, true)
        } else if (rawPt.x >= 0 && rawPt.x < width && rawPt.y >= 0 && rawPt.y < height) {
          subPixelCursorRef.current = { x: rawPt.x, y: rawPt.y }
          onMoveCursor(rawPt, false)
        }
      }
    },
    [
      getLocalCoords,
      width,
      height,
      viewportSize.w,
      viewportSize.h,
      transform,
      onUpdateMoveOffset,
      onMoveFloatingShape,
      allowsOutOfBoundsPoint,
      onMoveCursor,
      onBeginDrawAt,
      floatingShape,
      moveSession,
      stepPhase.kind,
    ]
  )

  const handlePointerUpOrCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
      activePointersRef.current.delete(e.pointerId)
      if (activePointersRef.current.size < 2) {
        pinchStateRef.current = null
      }

      const g = singleGestureRef.current
      if (g && g.pointerId === e.pointerId) {
        singleGestureRef.current = null

        if (cancelled) {
          lastTouchTapRef.current = null
          if (g.mode === 'mouse-draw') {
            onAbortStroke()
          }
          return
        }

        if (g.mode === 'mouse-draw') {
          onEndDraw()
          return
        }

        // Section 3: Touch stationary tap -> detect intentional double-tap gesture (~300ms) WITHOUT moving cursor!
        // When triggered, `onDoubleTapEyedropper()` ALWAYS samples from the current in-app cursor position (NEVER from tap coordinates)!
        if (g.mode === 'touch-cursor') {
          if (g.moved || g.hadMultiTouch) {
            lastTouchTapRef.current = null
            return
          }
          if (
            eyedropperDoubleTap &&
            tool !== 'eyedropper' &&
            stepPhase.kind === 'idle' &&
            !isPlaying
          ) {
            const now = performance.now()
            const prev = lastTouchTapRef.current
            if (
              prev &&
              now - prev.time <= DOUBLE_TAP_EYEDROPPER_WINDOW_MS &&
              Math.hypot(g.lastVx - prev.vx, g.lastVy - prev.vy) <=
                TOUCH_DOUBLE_TAP_MAX_SEPARATION_PX
            ) {
              lastTouchTapRef.current = null
              onDoubleTapEyedropper()
              return
            }
            lastTouchTapRef.current = { vx: g.lastVx, vy: g.lastVy, time: now }
          } else {
            lastTouchTapRef.current = null
          }
          // Stationary touch tap intentionally leaves cursor position untouched!
          return
        }

        // Mouse stationary single tap while double-tap eyedropper is enabled:
        // Record tap timestamp & commit single-pixel action after DOUBLE_TAP_EYEDROPPER_WINDOW_MS if no 2nd tap arrives!
        if (g.mode === 'mouse-deferred-tap') {
          const cx = g.startCanvasPt.x
          const cy = g.startCanvasPt.y
          const now = performance.now()
          lastTapRef.current = { canvasX: cx, canvasY: cy, time: now }
          const commitPt = allowsOutOfBoundsPoint
            ? { x: cx, y: cy }
            : clampCanvasPoint({ x: cx, y: cy }, width, height)
          pendingSingleTapPointRef.current = {
            pt: commitPt,
            allowOutOfBounds: allowsOutOfBoundsPoint,
          }
          pendingSingleTapTimerRef.current = window.setTimeout(() => {
            pendingSingleTapTimerRef.current = null
            const pending = pendingSingleTapPointRef.current
            pendingSingleTapPointRef.current = null
            lastTapRef.current = null
            if (pending) {
              onBeginDrawAt(pending.pt, pending.allowOutOfBounds)
              onEndDraw()
            }
          }, DOUBLE_TAP_EYEDROPPER_WINDOW_MS)
        }
      }
    },
    [
      onAbortStroke,
      onEndDraw,
      width,
      height,
      eyedropperDoubleTap,
      tool,
      stepPhase.kind,
      onDoubleTapEyedropper,
      allowsOutOfBoundsPoint,
      onMoveCursor,
      onBeginDrawAt,
    ]
  )

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault()
      const { vx, vy } = getLocalCoords(e.clientX, e.clientY)
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
      setTransform((curr) =>
        zoomAroundPoint(
          curr,
          curr.scale * factor,
          vx,
          vy,
          width,
          height,
          viewportSize.w,
          viewportSize.h
        )
      )
    },
    [getLocalCoords, width, height, viewportSize.w, viewportSize.h]
  )

  let statusIcon: PixelIconName = resolveToolIconName(tool, toolSettings)
  let statusPrimary = ''
  let statusSub = ''

  if (moveSession) {
    statusIcon = 'move'
    statusPrimary =
      moveSession.mode === 'multi-layer'
        ? t('statusMovingMultiLayers')
        : moveSession.mode === 'layer'
          ? t('statusMovingLayer')
          : t('statusMovingSelection')
    statusSub = `${moveSession.dx >= 0 ? '+' : ''}${moveSession.dx}, ${moveSession.dy >= 0 ? '+' : ''}${moveSession.dy}`
  } else if (floatingShape) {
    statusIcon = toolSettings.shapeType === 'ellipse' ? 'ellipse' : 'rect'
    statusPrimary = t('statusWaitingConfirm')
    statusSub = `${((floatingShape.rotationDeg % 360) + 360) % 360}°`
  } else {
    if (tool === 'pen') {
      statusPrimary = t('toolPen')
      statusSub = `${toolSettings.penSize}px${isTransparentColor ? ` · ${t('statusTransparentColor')}` : ''}`
    } else if (tool === 'eraser') {
      statusPrimary = t('toolEraser')
      statusSub = `${toolSettings.eraserSize}px`
    } else if (tool === 'fill') {
      statusPrimary =
        toolSettings.fillMode === 'gradient' ? t('fillGradient') : t('toolFill')
      if (stepPhase.kind === 'gradient-end') statusSub = t('statusStepEnd')
      else if (isTransparentColor) statusSub = t('statusTransparentColor')
    } else if (tool === 'line') {
      statusPrimary =
        toolSettings.lineType === 'bezier' ? t('lineBezier') : t('lineStraight')
      statusSub = `${toolSettings.lineSize}px`
      if (stepPhase.kind === 'line-end' || stepPhase.kind === 'bezier-p3') {
        statusSub = `${toolSettings.lineSize}px · ${t('statusStepEnd')}`
      } else if (stepPhase.kind === 'bezier-p1') {
        statusSub = t('statusStepP1')
      } else if (stepPhase.kind === 'bezier-p2') {
        statusSub = t('statusStepP2')
      }
    } else if (tool === 'shape') {
      statusPrimary =
        toolSettings.shapeType === 'ellipse' ? t('shapeEllipse') : t('shapeRect')
      if (stepPhase.kind === 'shape-end') statusSub = t('statusStepEnd')
    } else if (tool === 'select') {
      statusPrimary =
        toolSettings.selectType === 'wand'
          ? t('selectWand')
          : toolSettings.selectType === 'ellipse'
            ? t('selectEllipse')
            : t('selectRect')
      if (stepPhase.kind === 'select-end') statusSub = t('statusStepEnd')
      else if (hasSelection) statusSub = t('statusSelectedArea')
    } else if (tool === 'eyedropper') {
      statusPrimary = t('toolEyedropper')
    }
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => handlePointerUpOrCancel(e, false)}
      onPointerCancel={(e) => handlePointerUpOrCancel(e, true)}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none' }}
      className={`relative w-full h-full overflow-hidden bg-[var(--canvas-well)] select-none ${
        spacePressed
          ? 'cursor-grab'
          : floatingShape || moveSession
            ? 'cursor-move'
            : modality === 'mouse'
              ? 'cursor-crosshair'
              : ''
      }`}
      data-testid="canvas-viewport"
    >
      <canvas
        ref={displayCanvasRef}
        className="block w-full h-full pointer-events-none"
      />

      <ViewTransition name={`artwork-${projectId}`}>
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${Math.round(transform.panX)}px`,
            top: `${Math.round(transform.panY)}px`,
            width: `${Math.max(1, Math.round(width * transform.scale))}px`,
            height: `${Math.max(1, Math.round(height * transform.scale))}px`,
          }}
          className="pointer-events-none"
        />
      </ViewTransition>

      <div
        className="absolute top-2 right-2 pointer-events-none px-2 py-1 bg-[var(--bg-surface)] border-2 border-[var(--border-pixel)] text-[11px] font-bold text-[var(--text-primary)] flex items-center gap-1.5 max-w-[78%]"
        data-testid="top-right-status-badge"
      >
        <PixelIcon
          name={statusIcon}
          size={14}
          className="text-[var(--accent-primary)]"
        />
        <span className="truncate">{statusPrimary}</span>
        {statusSub && (
          <>
            <span className="text-[var(--text-secondary)]">·</span>
            <span className="text-[var(--accent-teal)] shrink-0">{statusSub}</span>
          </>
        )}
      </div>

      <div className="absolute bottom-1.5 left-2 pointer-events-none px-2 py-0.5 bg-[var(--bg-surface)] border border-[var(--border-pixel)] text-[10px] text-[var(--text-secondary)] flex items-center gap-1.5">
        <span>
          {cursor.x},{cursor.y}
        </span>
        <span>·</span>
        <span>×{Math.round(transform.scale * 10) / 10}</span>
      </div>
    </div>
  )
}
