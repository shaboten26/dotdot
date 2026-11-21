import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { BrushShape, FloatingShapeState, Point, ToolId, ToolSettings } from '../../types'
import type { MultiStepPhase } from '../../state/useEditorController'
import { getBrushOffsets } from '../../engine/brush'
import { getPixel } from '../../engine/pixelBuffer'
import { rgbaToHex } from '../../engine/color'
import { rasterizeTransformedShape } from '../../engine/transform'
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

interface InteractiveViewportProps {
  width: number
  height: number
  compositedBuffer: Uint8ClampedArray | null
  tool: ToolId
  toolSettings: ToolSettings
  cursor: Point
  stepPhase: MultiStepPhase
  floatingShape: FloatingShapeState | null
  selectionMask: Uint8Array | null
  showGrid: boolean
  checkerboardDark: boolean
  activeHexColor: string
  fitTrigger: number
  onMoveCursor: (pt: Point) => void
  onBeginDrawAt: (pt?: Point) => void
  onEndDraw: () => void
  onMoveFloatingShape: (dx: number, dy: number) => void
}

interface ActivePointerInfo {
  x: number
  y: number
  pointerType: string
}

/**
 * Draw a crisp pixel-art square control handle (no smooth anti-aliased circles).
 */
function drawPixelHandle(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  fillHex: string,
  label?: string
) {
  const rx = Math.round(sx)
  const ry = Math.round(sy)
  ctx.save()
  ctx.fillStyle = '#181521'
  ctx.fillRect(rx - 5, ry - 5, 10, 10)
  ctx.fillStyle = '#f8f6f2'
  ctx.fillRect(rx - 4, ry - 4, 8, 8)
  ctx.fillStyle = fillHex
  ctx.fillRect(rx - 2, ry - 2, 4, 4)

  if (label) {
    ctx.font = '11px "Silkscreen", "DotGothic16", monospace'
    const tw = Math.ceil(ctx.measureText(label).width)
    ctx.fillStyle = '#181521'
    ctx.fillRect(rx + 6, ry - 11, tw + 6, 13)
    ctx.fillStyle = '#f8f6f2'
    ctx.fillText(label, rx + 9, ry - 1)
  }
  ctx.restore()
}

/**
 * Draw crisp pixel L-corner brackets around a rectangle [x, y, w, h].
 */
function drawPixelCornerBrackets(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  armLen: number,
  innerColor: string
) {
  const rx = Math.round(x)
  const ry = Math.round(y)
  const rw = Math.max(2, Math.round(w))
  const rh = Math.max(2, Math.round(h))
  const L = Math.max(3, Math.min(armLen, Math.floor(Math.min(rw, rh) / 2) + 2))

  const drawPass = (color: string, expand: number, thickness: number) => {
    ctx.fillStyle = color
    const x0 = rx - expand
    const y0 = ry - expand
    const x1 = rx + rw + expand
    const y1 = ry + rh + expand

    // Top-left
    ctx.fillRect(x0, y0, L, thickness)
    ctx.fillRect(x0, y0, thickness, L)
    // Top-right
    ctx.fillRect(x1 - L, y0, L, thickness)
    ctx.fillRect(x1 - thickness, y0, thickness, L)
    // Bottom-left
    ctx.fillRect(x0, y1 - thickness, L, thickness)
    ctx.fillRect(x0, y1 - L, thickness, L)
    // Bottom-right
    ctx.fillRect(x1 - L, y1 - thickness, L, thickness)
    ctx.fillRect(x1 - thickness, y1 - L, thickness, L)
  }

  drawPass('#181521', 2, 3)
  drawPass(innerColor, 1, 1)
}

export function InteractiveViewport({
  width,
  height,
  compositedBuffer,
  tool,
  toolSettings,
  cursor,
  stepPhase,
  floatingShape,
  selectionMask,
  showGrid,
  checkerboardDark,
  activeHexColor,
  fitTrigger,
  onMoveCursor,
  onBeginDrawAt,
  onEndDraw,
  onMoveFloatingShape,
}: InteractiveViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({
    w: 360,
    h: 360,
  })
  const [transform, setTransform] = useState<ViewportTransform>({
    scale: 8,
    panX: 24,
    panY: 24,
  })
  const [modality, setModality] = useState<InputModality>(() =>
    detectInitialInputModality()
  )
  const [spacePressed, setSpacePressed] = useState(false)

  // Keep fractional sub-pixel cursor accumulator synced with integer cursor (Spec v2 Section 11)
  const subPixelCursorRef = useRef<{ x: number; y: number }>({
    x: cursor.x,
    y: cursor.y,
  })
  useEffect(() => {
    // When cursor jumps externally (e.g., initial load or clamping), keep fractional tracker within 0.5px
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
    mode: 'touch-cursor' | 'mouse-draw' | 'pan' | 'floating-drag'
    lastVx: number
    lastVy: number
    accumFloatX: number
    accumFloatY: number
  } | null>(null)

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

  // Fit canvas with comfortable margin around edges (Spec v2 Section 4-2)
  useEffect(() => {
    if (viewportSize.w <= 0 || viewportSize.h <= 0) return
    setTransform(computeFitViewport(width, height, viewportSize.w, viewportSize.h, 0.86))
  }, [width, height, fitTrigger, viewportSize.w, viewportSize.h])

  // Render canvas, checkerboard, pixel grid, selection marching-pixels, guides, and tool-specific pixel cursors
  useEffect(() => {
    const canvas = displayCanvasRef.current
    if (!canvas || viewportSize.w <= 0 || viewportSize.h <= 0) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const targetW = Math.max(1, Math.round(viewportSize.w * dpr))
    const targetH = Math.max(1, Math.round(viewportSize.h * dpr))
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, viewportSize.w, viewportSize.h)

    const { scale, panX, panY } = transform
    const dispW = width * scale
    const dispH = height * scale

    // 1. Retro Pixel Offset Frame Shadow around the canvas
    ctx.fillStyle = checkerboardDark ? '#09080d' : '#b8b1a3'
    ctx.fillRect(Math.round(panX) + 4, Math.round(panY) + 4, Math.round(dispW), Math.round(dispH))

    // 2. Transparency Checkerboard + Artwork inside Canvas Bounds
    ctx.save()
    ctx.beginPath()
    ctx.rect(panX, panY, dispW, dispH)
    ctx.clip()

    const checkCell = Math.max(4, Math.min(16, scale >= 2 ? scale : 8))
    const cLight = checkerboardDark ? '#272334' : '#f3efe6'
    const cDark = checkerboardDark ? '#1d1a27' : '#dfd9cc'
    ctx.fillStyle = cLight
    ctx.fillRect(panX, panY, dispW, dispH)
    ctx.fillStyle = cDark

    const cols = Math.ceil(dispW / checkCell)
    const rows = Math.ceil(dispH / checkCell)
    for (let r = 0; r < rows; r++) {
      for (let c = r % 2; c < cols; c += 2) {
        ctx.fillRect(
          panX + c * checkCell,
          panY + r * checkCell,
          checkCell,
          checkCell
        )
      }
    }

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
        ctx.drawImage(off, panX, panY, dispW, dispH)
      }
    }

    // 3. Crisp 1px Grid when zoomed >= 5x
    if (showGrid && scale >= 5) {
      ctx.strokeStyle = checkerboardDark
        ? 'rgba(234, 230, 242, 0.11)'
        : 'rgba(43, 39, 51, 0.13)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 1; x < width; x++) {
        const sx = Math.round(panX + x * scale) + 0.5
        ctx.moveTo(sx, panY)
        ctx.lineTo(sx, panY + dispH)
      }
      for (let y = 1; y < height; y++) {
        const sy = Math.round(panY + y * scale) + 0.5
        ctx.moveTo(panX, sy)
        ctx.lineTo(panX + dispW, sy)
      }
      ctx.stroke()
    }
    ctx.restore()

    // Crisp 2px pixel frame around canvas so artwork never blends with UI
    ctx.strokeStyle = checkerboardDark ? '#696082' : '#4a4358'
    ctx.lineWidth = 2
    ctx.strokeRect(
      Math.round(panX) - 1,
      Math.round(panY) - 1,
      Math.round(dispW) + 2,
      Math.round(dispH) + 2
    )

    // 4. Pixel-stepped Selection Contour Frame (Spec v2 Section 3 & 10)
    if (selectionMask && selectionMask.length === width * height) {
      ctx.save()
      ctx.beginPath()
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (selectionMask[y * width + x] === 0) continue
          const px = panX + x * scale
          const py = panY + y * scale

          if (y === 0 || selectionMask[(y - 1) * width + x] === 0) {
            ctx.moveTo(px, py)
            ctx.lineTo(px + scale, py)
          }
          if (y === height - 1 || selectionMask[(y + 1) * width + x] === 0) {
            ctx.moveTo(px, py + scale)
            ctx.lineTo(px + scale, py + scale)
          }
          if (x === 0 || selectionMask[y * width + (x - 1)] === 0) {
            ctx.moveTo(px, py)
            ctx.lineTo(px, py + scale)
          }
          if (x === width - 1 || selectionMask[y * width + (x + 1)] === 0) {
            ctx.moveTo(px + scale, py)
            ctx.lineTo(px + scale, py + scale)
          }
        }
      }
      ctx.strokeStyle = '#181521'
      ctx.lineWidth = 2.5
      ctx.stroke()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = '#f8f6f2'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()
    }

    // 5. Floating Shape Transform Pixel Frame & Square Handles
    if (floatingShape) {
      const tf = rasterizeTransformedShape(floatingShape)
      const bx = panX + tf.left * scale
      const by = panY + tf.top * scale
      const bw = tf.width * scale
      const bh = tf.height * scale

      ctx.save()
      ctx.strokeStyle = '#181521'
      ctx.lineWidth = 3
      ctx.strokeRect(bx, by, bw, bh)
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = '#8476c4'
      ctx.lineWidth = 1.5
      ctx.strokeRect(bx, by, bw, bh)
      ctx.restore()

      drawPixelHandle(ctx, bx, by, '#8476c4')
      drawPixelHandle(ctx, bx + bw, by, '#8476c4')
      drawPixelHandle(ctx, bx, by + bh, '#8476c4')
      drawPixelHandle(ctx, bx + bw, by + bh, '#8476c4')
    }

    // 6. Multi-step Pixel Control Points & Guides (Line, Bezier P0..P3, Gradient, Shape)
    const pixelCenter = (p: Point) => ({
      sx: panX + (p.x + 0.5) * scale,
      sy: panY + (p.y + 0.5) * scale,
    })

    const drawDashedGuide = (a: Point, b: Point, color: string) => {
      const pA = pixelCenter(a)
      const pB = pixelCenter(b)
      ctx.save()
      ctx.strokeStyle = '#181521'
      ctx.lineWidth = 3
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(pA.sx, pA.sy)
      ctx.lineTo(pB.sx, pB.sy)
      ctx.stroke()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()
    }

    if (stepPhase.kind === 'gradient-end') {
      drawDashedGuide(stepPhase.start, cursor, '#579b91')
      const s0 = pixelCenter(stepPhase.start)
      const s1 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', 'S')
      drawPixelHandle(ctx, s1.sx, s1.sy, '#c47388', 'E')
    } else if (stepPhase.kind === 'line-end' || stepPhase.kind === 'shape-end') {
      const s0 = pixelCenter(stepPhase.start)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', 'S')
    } else if (stepPhase.kind === 'bezier-p3') {
      const s0 = pixelCenter(stepPhase.p0)
      const s3 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', 'P0')
      drawPixelHandle(ctx, s3.sx, s3.sy, '#8476c4', 'P3')
    } else if (stepPhase.kind === 'bezier-p1') {
      drawDashedGuide(stepPhase.p0, cursor, '#c47388')
      const s0 = pixelCenter(stepPhase.p0)
      const s3 = pixelCenter(stepPhase.p3)
      const s1 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', 'P0')
      drawPixelHandle(ctx, s3.sx, s3.sy, '#8476c4', 'P3')
      drawPixelHandle(ctx, s1.sx, s1.sy, '#c47388', 'P1')
    } else if (stepPhase.kind === 'bezier-p2') {
      drawDashedGuide(stepPhase.p0, stepPhase.p1, '#c47388')
      drawDashedGuide(stepPhase.p3, cursor, '#c47388')
      const s0 = pixelCenter(stepPhase.p0)
      const s3 = pixelCenter(stepPhase.p3)
      const s1 = pixelCenter(stepPhase.p1)
      const s2 = pixelCenter(cursor)
      drawPixelHandle(ctx, s0.sx, s0.sy, '#579b91', 'P0')
      drawPixelHandle(ctx, s3.sx, s3.sy, '#8476c4', 'P3')
      drawPixelHandle(ctx, s1.sx, s1.sy, '#c47388', 'P1')
      drawPixelHandle(ctx, s2.sx, s2.sy, '#d99b52', 'P2')
    }

    // 7. Tool-Specific Pixel-Art Cursor & Footprint Preview (Spec v2 Section 10)
    // Hidden while floatingShape transform is active
    if (!floatingShape) {
      const cellX = panX + cursor.x * scale
      const cellY = panY + cursor.y * scale
      const cellS = Math.max(2, scale)

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

        // Exact pixel footprint contour for circle/square brush
        ctx.save()
        ctx.beginPath()
        for (const o of offsets) {
          const px = panX + (cursor.x + o.x) * scale
          const py = panY + (cursor.y + o.y) * scale
          if (!set.has(`${o.x},${o.y - 1}`)) {
            ctx.moveTo(px, py)
            ctx.lineTo(px + scale, py)
          }
          if (!set.has(`${o.x},${o.y + 1}`)) {
            ctx.moveTo(px, py + scale)
            ctx.lineTo(px + scale, py + scale)
          }
          if (!set.has(`${o.x - 1},${o.y}`)) {
            ctx.moveTo(px, py)
            ctx.lineTo(px, py + scale)
          }
          if (!set.has(`${o.x + 1},${o.y}`)) {
            ctx.moveTo(px + scale, py)
            ctx.lineTo(px + scale, py + scale)
          }
        }
        ctx.strokeStyle = '#181521'
        ctx.lineWidth = 2
        ctx.stroke()
        if (dashedErase) {
          ctx.setLineDash([3, 3])
        }
        ctx.strokeStyle = accentHex
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.restore()

        // On touch devices, add non-occluding outer pixel corner brackets around brush box
        if (modality === 'touch') {
          const bx = panX + (cursor.x + minDx) * scale - 3
          const by = panY + (cursor.y + minDy) * scale - 3
          const bw = (maxDx - minDx + 1) * scale + 6
          const bh = (maxDy - minDy + 1) * scale + 6
          drawPixelCornerBrackets(ctx, bx, by, bw, bh, 6, accentHex)
        }
      }

      if (tool === 'pen') {
        drawBrushBoundary(toolSettings.penSize, toolSettings.penShape, '#f8f6f2', false)
      } else if (tool === 'eraser') {
        drawBrushBoundary(toolSettings.eraserSize, toolSettings.eraserShape, '#c47388', true)
      } else if (tool === 'fill') {
        // Fill target cursor: 4 inward pixel nibs pointing to target seed pixel + color pip
        drawPixelCornerBrackets(ctx, cellX, cellY, cellS, cellS, 5, '#579b91')
        const midX = Math.round(cellX + cellS / 2)
        ctx.fillStyle = '#181521'
        ctx.fillRect(midX - 2, Math.round(cellY) - 9, 4, 6)
        ctx.fillStyle = activeHexColor
        ctx.fillRect(midX - 1, Math.round(cellY) - 8, 2, 4)
        if (modality === 'touch') {
          ctx.fillStyle = '#181521'
          ctx.fillRect(midX - 2, Math.round(cellY + cellS) + 3, 4, 6)
          ctx.fillStyle = '#f8f6f2'
          ctx.fillRect(midX - 1, Math.round(cellY + cellS) + 4, 2, 4)
        }
      } else if (tool === 'eyedropper') {
        // Eyedropper cursor: pixel scope box + live sampled color swatch callout
        drawPixelCornerBrackets(ctx, cellX - 1, cellY - 1, cellS + 2, cellS + 2, 6, '#f8f6f2')
        let sampledHex = 'transparent'
        if (compositedBuffer) {
          const p = getPixel(compositedBuffer, width, height, cursor.x, cursor.y)
          if (p.a > 0) sampledHex = rgbaToHex(p)
        }
        const bx = Math.round(cellX + cellS + 6)
        const by = Math.round(cellY - 14)
        ctx.fillStyle = '#181521'
        ctx.fillRect(bx, by, 14, 14)
        ctx.fillStyle = '#f8f6f2'
        ctx.fillRect(bx + 1, by + 1, 12, 12)
        if (sampledHex !== 'transparent') {
          ctx.fillStyle = sampledHex
          ctx.fillRect(bx + 2, by + 2, 10, 10)
        }
      } else if (tool === 'select') {
        // Selection target cursor: dashed pixel frame with teal corners
        drawPixelCornerBrackets(ctx, cellX - 1, cellY - 1, cellS + 2, cellS + 2, 5, '#579b91')
      } else {
        // Line / Bezier / Shape precision pixel vertex cursor
        drawPixelCornerBrackets(ctx, cellX, cellY, cellS, cellS, 5, '#8476c4')
        if (modality === 'touch') {
          const midX = Math.round(cellX + cellS / 2)
          const midY = Math.round(cellY + cellS / 2)
          const off = Math.max(6, Math.round(cellS / 2) + 4)
          const drawTick = (tx: number, ty: number, tw: number, th: number) => {
            ctx.fillStyle = '#181521'
            ctx.fillRect(tx - 1, ty - 1, tw + 2, th + 2)
            ctx.fillStyle = '#f8f6f2'
            ctx.fillRect(tx, ty, tw, th)
          }
          drawTick(midX - off - 6, midY - 1, 5, 2)
          drawTick(midX + off + 1, midY - 1, 5, 2)
          drawTick(midX - 1, midY - off - 6, 2, 5)
          drawTick(midX - 1, midY + off + 1, 2, 5)
        }
      }
    }

    ctx.restore()
  }, [
    viewportSize,
    transform,
    width,
    height,
    compositedBuffer,
    tool,
    toolSettings,
    showGrid,
    checkerboardDark,
    selectionMask,
    floatingShape,
    stepPhase,
    cursor,
    modality,
    activeHexColor,
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

      // 2-finger pinch-zoom & pan
      if (activePointersRef.current.size === 2) {
        if (singleGestureRef.current?.mode === 'mouse-draw') {
          onEndDraw()
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
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'pan',
          lastVx: vx,
          lastVy: vy,
          accumFloatX: 0,
          accumFloatY: 0,
        }
        return
      }

      if (floatingShape) {
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'floating-drag',
          lastVx: vx,
          lastVy: vy,
          accumFloatX: 0,
          accumFloatY: 0,
        }
        return
      }

      if (detected === 'touch') {
        // Spec v2 Section 11:
        // Touch movement converts CSS pixel delta directly via current display `transform.scale`,
        // keeping fractional remainder in `subPixelCursorRef` and snapping final coordinates to integer pixels.
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'touch-cursor',
          lastVx: vx,
          lastVy: vy,
          accumFloatX: subPixelCursorRef.current.x,
          accumFloatY: subPixelCursorRef.current.y,
        }
      } else if (e.button === 0) {
        const rawPt = screenToCanvasPixel(vx, vy, transform)
        const clamped = clampCanvasPoint(rawPt, width, height)
        subPixelCursorRef.current = { x: clamped.x, y: clamped.y }
        onMoveCursor(clamped)
        onBeginDrawAt(clamped)
        singleGestureRef.current = {
          pointerId: e.pointerId,
          mode: 'mouse-draw',
          lastVx: vx,
          lastVy: vy,
          accumFloatX: clamped.x,
          accumFloatY: clamped.y,
        }
      }
    },
    [
      getLocalCoords,
      onEndDraw,
      spacePressed,
      floatingShape,
      transform,
      width,
      height,
      onMoveCursor,
      onBeginDrawAt,
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
        g.lastVx = vx
        g.lastVy = vy

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
          // Spec v2 Section 11:
          // Strictly convert screen CSS delta using current canvas display scale (1:1 screen motion,
          // completely independent of logical canvas size 16x16 vs 256x256, preserving fractional remainder).
          const effScale = Math.max(0.5, transform.scale)
          const nextFloatX = Math.max(
            0,
            Math.min(width - 1, subPixelCursorRef.current.x + dxCss / effScale)
          )
          const nextFloatY = Math.max(
            0,
            Math.min(height - 1, subPixelCursorRef.current.y + dyCss / effScale)
          )
          subPixelCursorRef.current = { x: nextFloatX, y: nextFloatY }

          const snappedX = Math.round(nextFloatX)
          const snappedY = Math.round(nextFloatY)
          onMoveCursor({ x: snappedX, y: snappedY })
          return
        }

        if (g.mode === 'mouse-draw') {
          const rawPt = screenToCanvasPixel(vx, vy, transform)
          const clamped = clampCanvasPoint(rawPt, width, height)
          subPixelCursorRef.current = { x: clamped.x, y: clamped.y }
          onMoveCursor(clamped)
          return
        }
      }

      if (e.pointerType === 'mouse' && activePointersRef.current.size === 0 && !floatingShape) {
        setModality('mouse')
        const rawPt = screenToCanvasPixel(vx, vy, transform)
        if (rawPt.x >= 0 && rawPt.x < width && rawPt.y >= 0 && rawPt.y < height) {
          subPixelCursorRef.current = { x: rawPt.x, y: rawPt.y }
          onMoveCursor(rawPt)
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
      onMoveFloatingShape,
      onMoveCursor,
      floatingShape,
    ]
  )

  const handlePointerUpOrCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      activePointersRef.current.delete(e.pointerId)
      if (activePointersRef.current.size < 2) {
        pinchStateRef.current = null
      }

      const g = singleGestureRef.current
      if (g && g.pointerId === e.pointerId) {
        if (g.mode === 'mouse-draw') {
          onEndDraw()
        }
        singleGestureRef.current = null
      }
    },
    [onEndDraw]
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

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none' }}
      className={`relative w-full h-full overflow-hidden bg-[var(--canvas-well)] select-none ${
        spacePressed
          ? 'cursor-grab'
          : floatingShape
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

      {/* Minimal Retro Pixel Coordinate & Scale Readout */}
      <div className="absolute bottom-1.5 left-2 pointer-events-none px-2 py-0.5 bg-[var(--bg-surface)]/90 border border-[var(--border-pixel)] text-[10px] text-[var(--text-secondary)] flex items-center gap-1.5">
        <span>
          {cursor.x},{cursor.y}
        </span>
        <span>·</span>
        <span>×{Math.round(transform.scale * 10) / 10}</span>
      </div>
    </div>
  )
}
