import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { hsvToRgb } from '../../engine/color'

/**
 * Smooth High-Precision Color Wheel & Saturation/Value Square Picker
 * - Prioritizes effortless, accurate touch / Apple Pencil / mouse usability over coarse pixelation!
 * - Renders at 220x220 device resolution with smooth continuous Hue Ring (0..360°) and smooth SV Square (0..100%).
 * - Generous hit targets and clean circular reticles so dragging along the outer ring or inner SV box never slips.
 */
export const PIXEL_WHEEL_GRID_SIZE = 220
const WHEEL_CENTER = PIXEL_WHEEL_GRID_SIZE / 2 // 110
const RING_OUTER_RADIUS = 106
const RING_INNER_RADIUS = 80
const SV_BOX_MIN = 54
const SV_BOX_MAX = 166 // 112x112 smooth SV square safely inscribed inside inner radius 80!

export type PixelWheelHitRegion = 'ring' | 'sv' | 'outside'

export function classifyWheelPoint(
  normX: number,
  normY: number
): PixelWheelHitRegion {
  const gx = normX * PIXEL_WHEEL_GRID_SIZE
  const gy = normY * PIXEL_WHEEL_GRID_SIZE

  if (
    gx >= SV_BOX_MIN - 4 &&
    gx <= SV_BOX_MAX + 4 &&
    gy >= SV_BOX_MIN - 4 &&
    gy <= SV_BOX_MAX + 4
  ) {
    return 'sv'
  }

  const dist = Math.hypot(gx - WHEEL_CENTER, gy - WHEEL_CENTER)
  if (dist >= RING_INNER_RADIUS - 10 && dist <= RING_OUTER_RADIUS + 12) {
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

  // Precompute smooth anti-aliased continuous 360-degree Hue Ring once
  const staticRingRgba = useMemo(() => {
    const N = PIXEL_WHEEL_GRID_SIZE
    const buf = new Uint8ClampedArray(N * N * 4)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - WHEEL_CENTER
        const dy = y + 0.5 - WHEEL_CENTER
        const d = Math.hypot(dx, dy)
        if (d < RING_INNER_RADIUS - 1.2 || d > RING_OUTER_RADIUS + 1.2) continue

        const off = (y * N + x) * 4
        const rawDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
        const { r, g, b } = hsvToRgb(rawDeg, 100, 100)

        // Smooth sub-pixel edge feathering on ring inner/outer border for clean circular appearance
        let alpha = 1
        if (d < RING_INNER_RADIUS) {
          alpha = Math.max(0, 1 - (RING_INNER_RADIUS - d) / 1.2)
        } else if (d > RING_OUTER_RADIUS) {
          alpha = Math.max(0, 1 - (d - RING_OUTER_RADIUS) / 1.2)
        }

        buf[off] = r
        buf[off + 1] = g
        buf[off + 2] = b
        buf[off + 3] = Math.round(alpha * 255)
      }
    }
    return buf
  }, [])

  // Render smooth continuous Hue Ring + SV Square + crisp high-contrast handles
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

    const frame = new Uint8ClampedArray(staticRingRgba)
    const span = SV_BOX_MAX - SV_BOX_MIN

    // Smooth continuous SV gradient square
    for (let y = SV_BOX_MIN; y <= SV_BOX_MAX; y++) {
      const vPct = ((SV_BOX_MAX - y) / span) * 100
      for (let x = SV_BOX_MIN; x <= SV_BOX_MAX; x++) {
        const sPct = ((x - SV_BOX_MIN) / span) * 100
        const { r, g, b } = hsvToRgb(clampedH, sPct, vPct)
        const off = (y * N + x) * 4
        frame[off] = r
        frame[off + 1] = g
        frame[off + 2] = b
        frame[off + 3] = 255
      }
    }

    ctx.clearRect(0, 0, N, N)
    ctx.putImageData(new ImageData(frame, N, N), 0, 0)

    // Subtle crisp frame around SV square
    ctx.save()
    ctx.strokeStyle = 'rgba(24, 21, 33, 0.55)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(
      SV_BOX_MIN - 0.5,
      SV_BOX_MIN - 0.5,
      span + 1,
      span + 1
    )

    const drawCircularThumb = (
      cx: number,
      cy: number,
      fillStyle: string,
      radius: number
    ) => {
      if (typeof ctx.arc === 'function') {
        ctx.beginPath()
        ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2)
        ctx.fillStyle = '#181521'
        ctx.fill()

        ctx.beginPath()
        ctx.arc(cx, cy, radius + 0.5, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fill()

        ctx.beginPath()
        ctx.arc(cx, cy, Math.max(2, radius - 2), 0, Math.PI * 2)
        ctx.fillStyle = fillStyle
        ctx.fill()
      } else {
        ctx.fillStyle = '#181521'
        ctx.fillRect(cx - radius - 2, cy - radius - 2, (radius + 2) * 2, (radius + 2) * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
      }
    }

    // 1. Hue Ring Handle
    const rad = (clampedH * Math.PI) / 180
    const midR = (RING_INNER_RADIUS + RING_OUTER_RADIUS) / 2
    const hx = WHEEL_CENTER + Math.cos(rad) * midR
    const hy = WHEEL_CENTER + Math.sin(rad) * midR
    const pureHueRgb = hsvToRgb(clampedH, 100, 100)
    drawCircularThumb(
      hx,
      hy,
      `rgb(${pureHueRgb.r}, ${pureHueRgb.g}, ${pureHueRgb.b})`,
      7
    )

    // 2. SV Square Handle
    const sx = SV_BOX_MIN + (clampedS / 100) * span
    const sy = SV_BOX_MAX - (clampedV / 100) * span
    const activeRgb = hsvToRgb(clampedH, clampedS, clampedV)
    drawCircularThumb(
      sx,
      sy,
      `rgb(${activeRgb.r}, ${activeRgb.g}, ${activeRgb.b})`,
      7
    )

    ctx.restore()
  }, [staticRingRgba, clampedH, clampedS, clampedV])

  const getNormalizedPoint = (
    el: HTMLCanvasElement,
    clientX: number,
    clientY: number
  ): { normX: number; normY: number } => {
    const rect = el.getBoundingClientRect()
    const w = rect.width > 0 ? rect.width : 184
    const h = rect.height > 0 ? rect.height : 184
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
        <div className="p-2 bg-[var(--bg-panel)] border-2 border-[var(--border-pixel)] shrink-0">
          <canvas
            ref={canvasRef}
            width={PIXEL_WHEEL_GRID_SIZE}
            height={PIXEL_WHEEL_GRID_SIZE}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUpOrCancel}
            onPointerCancel={handlePointerUpOrCancel}
            style={{ touchAction: 'none' }}
            className="w-44 h-44 sm:w-48 sm:h-48 block cursor-crosshair select-none"
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

          {/* Quick-Hue Swatch Strip (12 steps) */}
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
