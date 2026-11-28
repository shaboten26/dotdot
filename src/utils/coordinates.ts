import type { Point } from '../types'

export interface ViewportTransform {
  /** Pixel scale factor (screen CSS pixels per 1 canvas pixel) */
  scale: number
  /** Screen CSS X coordinate of canvas top-left (0, 0) relative to viewport container */
  panX: number
  /** Screen CSS Y coordinate of canvas top-left (0, 0) relative to viewport container */
  panY: number
}

export const MIN_ZOOM_SCALE = 1
export const MAX_ZOOM_SCALE = 64

/**
 * Clamp panX/panY so the canvas can never be dragged completely off-screen and become unreachable (Section 3-3).
 * Ensures at least `marginPx` (or 25% of canvas) stays inside the viewport container.
 */
export function clampViewportTransform(
  transform: ViewportTransform,
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ViewportTransform {
  if (viewportWidth <= 0 || viewportHeight <= 0) return transform

  const minScale = Math.max(
    0.5,
    Math.min(
      MIN_ZOOM_SCALE,
      (Math.min(viewportWidth, viewportHeight) * 0.5) / Math.max(canvasWidth, canvasHeight)
    )
  )
  const scale = Math.max(minScale, Math.min(MAX_ZOOM_SCALE, transform.scale))

  const dispW = canvasWidth * scale
  const dispH = canvasHeight * scale

  const marginX = Math.min(80, Math.max(32, dispW * 0.25))
  const marginY = Math.min(80, Math.max(32, dispH * 0.25))

  const minPanX = marginX - dispW
  const maxPanX = viewportWidth - marginX
  const minPanY = marginY - dispH
  const maxPanY = viewportHeight - marginY

  return {
    scale,
    panX: Math.max(minPanX, Math.min(maxPanX, transform.panX)),
    panY: Math.max(minPanY, Math.min(maxPanY, transform.panY)),
  }
}

/**
 * Compute initial centered fit transform for a canvas inside viewport dimensions.
 */
export function computeFitViewport(
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  paddingRatio = 0.88
): ViewportTransform {
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { scale: 8, panX: 16, panY: 16 }
  }
  const availW = viewportWidth * paddingRatio
  const availH = viewportHeight * paddingRatio
  const rawScale = Math.min(availW / canvasWidth, availH / canvasHeight)
  const scale = Math.max(1, Math.min(MAX_ZOOM_SCALE, rawScale >= 2 ? Math.floor(rawScale) : rawScale))
  const panX = Math.round((viewportWidth - canvasWidth * scale) / 2)
  const panY = Math.round((viewportHeight - canvasHeight * scale) / 2)
  return { scale, panX, panY }
}

/**
 * Adjust panX/panY when the viewport container resizes (e.g., dock toggle, browser UI bar, screen rotation)
 * while strictly preserving the user's current zoom `scale` and keeping the canvas coordinate that was at the
 * center of the previous viewport centered in the new viewport (clamped so the canvas stays reachable).
 * Notice `panX` / `panY` are kept as exact floating-point coordinates (mirroring `zoomAroundPoint` & drag pan)
 * so repeated incremental resize events NEVER accumulate rounding drift!
 */
export function resizeViewportPreservingZoom(
  current: ViewportTransform,
  previousViewportWidth: number,
  previousViewportHeight: number,
  nextViewportWidth: number,
  nextViewportHeight: number,
  canvasWidth: number,
  canvasHeight: number
): ViewportTransform {
  if (
    previousViewportWidth <= 0 ||
    previousViewportHeight <= 0 ||
    nextViewportWidth <= 0 ||
    nextViewportHeight <= 0 ||
    current.scale <= 0
  ) {
    return current
  }

  const centerCanvasX =
    (previousViewportWidth / 2 - current.panX) / current.scale
  const centerCanvasY =
    (previousViewportHeight / 2 - current.panY) / current.scale
  const nextPanX = nextViewportWidth / 2 - centerCanvasX * current.scale
  const nextPanY = nextViewportHeight / 2 - centerCanvasY * current.scale

  return clampViewportTransform(
    {
      scale: current.scale,
      panX: nextPanX,
      panY: nextPanY,
    },
    canvasWidth,
    canvasHeight,
    nextViewportWidth,
    nextViewportHeight
  )
}

/**
 * Zoom around a specific focal point `(focusX, focusY)` in viewport CSS coordinates,
 * keeping the canvas pixel under the finger pinch center or mouse wheel cursor anchored (Section 3-3).
 */
export function zoomAroundPoint(
  current: ViewportTransform,
  nextScaleRaw: number,
  focusX: number,
  focusY: number,
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ViewportTransform {
  const minScale = Math.max(
    0.5,
    Math.min(
      MIN_ZOOM_SCALE,
      (Math.min(viewportWidth, viewportHeight) * 0.5) / Math.max(canvasWidth, canvasHeight)
    )
  )
  const nextScale = Math.max(minScale, Math.min(MAX_ZOOM_SCALE, nextScaleRaw))

  // Canvas coordinate currently under focus point
  const worldX = (focusX - current.panX) / current.scale
  const worldY = (focusY - current.panY) / current.scale

  const nextPanX = focusX - worldX * nextScale
  const nextPanY = focusY - worldY * nextScale

  return clampViewportTransform(
    { scale: nextScale, panX: nextPanX, panY: nextPanY },
    canvasWidth,
    canvasHeight,
    viewportWidth,
    viewportHeight
  )
}

/**
 * Convert viewport-relative CSS coordinate `(vx, vy)` to integer canvas pixel coordinate `(x, y)`.
 */
export function screenToCanvasPixel(
  vx: number,
  vy: number,
  transform: ViewportTransform
): Point {
  return {
    x: Math.floor((vx - transform.panX) / transform.scale),
    y: Math.floor((vy - transform.panY) / transform.scale),
  }
}

export function clampCanvasPoint(pt: Point, width: number, height: number): Point {
  return {
    x: Math.max(0, Math.min(width - 1, Math.round(pt.x))),
    y: Math.max(0, Math.min(height - 1, Math.round(pt.y))),
  }
}
