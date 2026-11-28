import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { hsvToRgb } from '../../engine/color'

/**
 * Pixel-Art Stepped Color Wheel & SV Grid Geometry
 * - Low-res 52x52 logical dot grid upscaled via nearest-neighbor (`image-rendering: pixelated`)
 *   so every ring edge, SV gradient cell, and cursor crosshair retains authentic crisp pixel-art steps!
 */
export const PIXEL_WHEEL_GRID_SIZE = 52
const WHEEL_CENTER = PIXEL_WHEEL_GRID_SIZE / 2
const RING_OUTER_RADIUS = 25
const RING_INNER_RADIUS = 18.2
const RING_OUTLINE_OUTER = 26
const RING_OUTLINE_INNER = 17.2
const SV_BOX_MIN = 14
const SV_BOX_MAX = 37 // inclusive -> 24x24 discrete pixel steps!

export type PixelWheelHitRegion = 'ring' | 'sv' | 'outside'

export function classifyWheelPoint(
  normX: number,
  normY: number
): PixelWheelHitRegion {
  const gx = normX * PIXEL_WHEEL_GRID_SIZE
  const gy = normY * PIXEL_WHEEL_GRID_SIZE

  if (
    gx >= SV_BOX_MIN - 0.75 &&
    gx <= SV_BOX_MAX + 1.75 &&
    gy >= SV_BOX_MIN - 0.75 &&
    gy <= SV_BOX_MAX + 1.75
  ) {
    return 'sv'
  }

  const dist = Math.hypot(gx - WHEEL_CENTER, gy - WHEEL_CENTER)
  if (dist >= RING_INNER_RADIUS - 2.2 && dist <= RING_OUTER_RADIUS + 2.8) {
    return 'ring'
  }
  return 'outside'
}

export function wheelPointToHue(normX: number, normY: number): number {
  const gx = normX * PIXEL_WHEEL_GRID_SIZE
  const gy = normY * PIXEL_WHEEL_GRID_SIZE
  const angleRad = Math.atan2(gy - WHEEL_CENTER, gx - WHEEL_CENTER)
  const deg = (angleRad * 180) / Math.PI
  return Math.round(((deg % 360) + 360) % 360) % 360
}

export function wheelPointToSv(
  normX: number,
  normY: number
): { s: number; v: number } {
  const gx = normX * PIXEL_WHEEL_GRID_SIZE
  const gy = normY * PIXEL_WHEEL_GRID_SIZE
  const span = SV_BOX_MAX - SV_BOX_MIN
  const sRatio = Math.max(0, Math.min(1, (gx - SV_BOX_MIN) / span))
  const vRatio = Math.max(0, Math.min(1, 1 - (gy - SV_BOX_MIN) / span))
  return {
    s: Math.round(sRatio * 100),
    v: Math.round(vRatio * 100),
  }
}

interface PixelColorWheelProps {
  hue: number
  saturation: number
  value: number
  onChange: (nextH: number, nextS: number, nextV: number) => void
  hintText?: string
  testId?: string
}

export function PixelColorWheel({
  hue,
  saturation,
  value,
  onChange,
  hintText,
  testId = 'pixel-color-wheel',
}: PixelColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeDragRef = useRef<{
    pointerId: number
    mode: 'ring' | 'sv'
  } | null>(null)

  const clampedH = ((Math.round(hue) % 360) + 360) % 360
  const clampedS = Math.max(0, Math.min(100, Math.round(saturation)))
  const clampedV = Math.max(0, Math.min(100, Math.round(value)))

  // Precompute the static 52x52 outer stepped hue ring + crisp pixel outline once
  const staticRingRgba = useMemo(() => {
    const N = PIXEL_WHEEL_GRID_SIZE
    const buf = new Uint8ClampedArray(N * N * 4)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - WHEEL_CENTER
        const dy = y + 0.5 - WHEEL_CENTER
        const d = Math.hypot(dx, dy)
        const off = (y * N + x) * 4

        if (d >= RING_INNER_RADIUS && d <= RING_OUTER_RADIUS) {
          const rawDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
          // Quantize hue ring into 36 crisp retro pixel sectors (10 deg steps) for unmistakable pixel-art feel
          const steppedHue = (Math.round(rawDeg / 10) * 10) % 360
          const { r, g, b } = hsvToRgb(steppedHue, 100, 100)
          buf[off] = r
          buf[off + 1] = g
          buf[off + 2] = b
          buf[off + 3] = 255
        } else if (
          (d >= RING_OUTER_RADIUS && d <= RING_OUTLINE_OUTER) ||
          (d >= RING_OUTLINE_INNER && d < RING_INNER_RADIUS)
        ) {
          buf[off] = 24
          buf[off + 1] = 21
          buf[off + 2] = 33
          buf[off + 3] = 255
        }
      }
    }
    return buf
  }, [])

  // Render low-res 52x52 pixel buffer whenever (H, S, V) changes
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const N = PIXEL_WHEEL_GRID_SIZE
    if (el.width !== N || el.height !== N) {
      el.width = N
      el.height = N
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false

    const frame = new Uint8ClampedArray(staticRingRgba)
    const setPx = (px: number, py: number, r: number, g: number, b: number) => {
      if (px < 0 || py < 0 || px >= N || py >= N) return
      const o = (py * N + px) * 4
      frame[o] = r
      frame[o + 1] = g
      frame[o + 2] = b
      frame[o + 3] = 255
    }

    // 1. Crisp 1-dot dark frame around inner SV pixel matrix
    for (let x = SV_BOX_MIN - 1; x <= SV_BOX_MAX + 1; x++) {
      setPx(x, SV_BOX_MIN - 1, 24, 21, 33)
      setPx(x, SV_BOX_MAX + 1, 24, 21, 33)
    }
    for (let y = SV_BOX_MIN - 1; y <= SV_BOX_MAX + 1; y++) {
      setPx(SV_BOX_MIN - 1, y, 24, 21, 33)
      setPx(SV_BOX_MAX + 1, y, 24, 21, 33)
    }

    // 2. Inner 24x24 stepped pixel-art SV grid
    const span = SV_BOX_MAX - SV_BOX_MIN
    for (let y = SV_BOX_MIN; y <= SV_BOX_MAX; y++) {
      const vCell = Math.round(((SV_BOX_MAX - y) / span) * 100)
      for (let x = SV_BOX_MIN; x <= SV_BOX_MAX; x++) {
        const sCell = Math.round(((x - SV_BOX_MIN) / span) * 100)
        const { r, g, b } = hsvToRgb(clampedH, sCell, vCell)
        setPx(x, y, r, g, b)
      }
    }

    // 3. Pixel-art hollow square Reticle on Hue Ring (`3x3` white + `5x5` dark border)
    const rad = (clampedH * Math.PI) / 180
    const midR = (RING_INNER_RADIUS + RING_OUTER_RADIUS) / 2
    const hx = Math.round(WHEEL_CENTER + Math.cos(rad) * midR - 0.5)
    const hy = Math.round(WHEEL_CENTER + Math.sin(rad) * midR - 0.5)

    const drawPixelMarker = (cx: number, cy: number) => {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const cheb = Math.max(Math.abs(dx), Math.abs(dy))
          if (cheb === 2) {
            setPx(cx + dx, cy + dy, 24, 21, 33)
          } else if (cheb === 1) {
            setPx(cx + dx, cy + dy, 248, 246, 242)
          }
        }
      }
    }

    drawPixelMarker(hx, hy)

    // 4. Pixel-art hollow square Reticle on SV Grid
    const sx = Math.round(SV_BOX_MIN + (clampedS / 100) * span)
    const sy = Math.round(SV_BOX_MAX - (clampedV / 100) * span)
    drawPixelMarker(sx, sy)

    ctx.putImageData(new ImageData(frame, N, N), 0, 0)
  }, [staticRingRgba, clampedH, clampedS, clampedV])

  const getNormalizedPoint = (
    el: HTMLCanvasElement,
    clientX: number,
    clientY: number
  ): { normX: number; normY: number } => {
    const rect = el.getBoundingClientRect()
    const w = rect.width > 0 ? rect.width : 168
    const h = rect.height > 0 ? rect.height : 168
    return {
      normX: (clientX - rect.left) / w,
      normY: (clientY - rect.top) / h,
    }
  }

  const applyWheelDrag = useCallback(
    (mode: 'ring' | 'sv', normX: number, normY: number) => {
      if (mode === 'ring') {
        const nextHue = wheelPointToHue(normX, normY)
        onChange(nextHue, clampedS, clampedV)
      } else {
        const { s, v } = wheelPointToSv(normX, normY)
        onChange(clampedH, s, v)
      }
    },
    [clampedH, clampedS, clampedV, onChange]
  )

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = canvasRef.current
    if (!el) return

    const { normX, normY } = getNormalizedPoint(el, e.clientX, e.clientY)
    const region = classifyWheelPoint(normX, normY)
    if (region === 'outside') return

    e.preventDefault()
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // ignore synthetic event capture errors
      }
    }

    activeDragRef.current = { pointerId: e.pointerId, mode: region }
    applyWheelDrag(region, normX, normY)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = activeDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const el = canvasRef.current
    if (!el) return
    e.preventDefault()
    const { normX, normY } = getNormalizedPoint(el, e.clientX, e.clientY)
    applyWheelDrag(drag.mode, normX, normY)
  }

  const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeDragRef.current?.pointerId === e.pointerId) {
      activeDragRef.current = null
    }
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="p-1.5 bg-[var(--bg-panel)] border-2 border-[var(--border-pixel)] shrink-0">
          <canvas
            ref={canvasRef}
            width={PIXEL_WHEEL_GRID_SIZE}
            height={PIXEL_WHEEL_GRID_SIZE}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUpOrCancel}
            onPointerCancel={handlePointerUpOrCancel}
            style={{ touchAction: 'none' }}
            className="w-40 h-40 sm:w-44 sm:h-44 block pixelated cursor-crosshair select-none"
            data-testid={`${testId}-canvas`}
          />
        </div>

        <div className="flex-1 w-full space-y-1.5 text-xs">
          <div className="grid grid-cols-3 gap-1.5">
            <div className="p-1.5 bg-[var(--bg-panel)] border-2 border-[var(--border-pixel)] text-center">
              <div className="text-[10px] text-[var(--text-secondary)]">H</div>
              <div
                className="font-mono font-bold text-[var(--text-primary)]"
                data-testid={`${testId}-readout-h`}
              >
                {clampedH}°
              </div>
            </div>
            <div className="p-1.5 bg-[var(--bg-panel)] border-2 border-[var(--border-pixel)] text-center">
              <div className="text-[10px] text-[var(--text-secondary)]">S</div>
              <div
                className="font-mono font-bold text-[var(--text-primary)]"
                data-testid={`${testId}-readout-s`}
              >
                {clampedS}%
              </div>
            </div>
            <div className="p-1.5 bg-[var(--bg-panel)] border-2 border-[var(--border-pixel)] text-center">
              <div className="text-[10px] text-[var(--text-secondary)]">V</div>
              <div
                className="font-mono font-bold text-[var(--text-primary)]"
                data-testid={`${testId}-readout-v`}
              >
                {clampedV}%
              </div>
            </div>
          </div>

          {/* Stepped Pixel Quick-Hue Swatch Strip (12 retro 30-degree steps) */}
          <div className="grid grid-cols-12 gap-0.5 p-1 bg-[var(--bg-panel)] border border-[var(--border-pixel)]">
            {Array.from({ length: 12 }, (_, idx) => {
              const stepHue = idx * 30
              const { r, g, b } = hsvToRgb(stepHue, 85, 95)
              const active = Math.abs(((clampedH - stepHue + 540) % 360) - 180) <= 15
              return (
                <button
                  key={stepHue}
                  type="button"
                  onClick={() =>
                    onChange(
                      stepHue,
                      Math.max(20, clampedS),
                      Math.max(25, clampedV)
                    )
                  }
                  style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
                  title={`H:${stepHue}°`}
                  className={`h-5 cursor-pointer ${
                    active
                      ? 'border-2 border-[var(--border-strong)] outline-1 outline-[var(--accent-primary)] z-10'
                      : 'border border-[var(--border-pixel)]'
                  }`}
                  data-testid={`${testId}-quick-hue-${stepHue}`}
                />
              )
            })}
          </div>

          {hintText && (
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {hintText}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
