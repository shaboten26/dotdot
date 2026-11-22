import React, { useCallback, useRef, useState } from 'react'
import { PixelIcon } from './PixelIcon'

export interface PixelSliderProps {
  min: number
  max: number
  step?: number
  /** Optional increment/decrement delta for `[-]` / `[+]` buttons (defaults to `step` or `1` for integer sliders) */
  buttonStep?: number
  value: number
  onChange: (next: number) => void
  ariaLabel?: string
  unit?: string
  disabled?: boolean
  showStepButtons?: boolean
  className?: string
  testId?: string
}

function roundToStepPrecision(val: number, step: number): number {
  if (Number.isInteger(step)) return Math.round(val)
  return Number(val.toFixed(4))
}

/**
 * Section 6: Pixel-Art Rectangular Slider with `[-]` & `[+]` Step Buttons (`PixelSlider`)
 * - Crisp rectangular pixel track & square thumb (zero round smooth caps, zero shadows)
 * - `[-]` and `[+]` step buttons synchronized with slider value:
 *   - Decrement / increment by `buttonStep ?? step`
 *   - Clamped strictly inside `[min, max]` even on rapid clicks
 *   - `[-]` disabled when `value <= min`, `[+]` disabled when `value >= max`
 * - Respects theme colors & UI size variables
 * - Full keyboard accessibility (`role="slider"`, ArrowLeft/Right/Up/Down, Home, End)
 */
export function PixelSlider({
  min,
  max,
  step = 1,
  buttonStep,
  value,
  onChange,
  ariaLabel,
  unit = '',
  disabled = false,
  showStepButtons = true,
  className = '',
  testId,
}: PixelSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const clampedValue = Math.max(min, Math.min(max, value))
  const span = Math.max(1e-6, max - min)
  const ratio = Math.max(0, Math.min(1, (clampedValue - min) / span))
  const btnDelta = buttonStep ?? step

  const atMin = disabled || clampedValue <= min + 1e-9
  const atMax = disabled || clampedValue >= max - 1e-9

  const applySteppedDelta = (dir: -1 | 1) => {
    if (disabled) return
    const rawNext = clampedValue + dir * btnDelta
    const clamped = Math.max(min, Math.min(max, roundToStepPrecision(rawNext, btnDelta)))
    if (clamped !== clampedValue) {
      onChange(clamped)
    }
  }

  const updateFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el || disabled) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      const rawRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const rawVal = min + rawRatio * (max - min)
      const stepped = Math.round((rawVal - min) / step) * step + min
      const next = Math.max(min, Math.min(max, roundToStepPrecision(stepped, step)))
      if (next !== value) {
        onChange(next)
      }
    },
    [disabled, max, min, onChange, step, value]
  )

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    e.preventDefault()
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignore synthetic capture error
      }
    }
    setDragging(true)
    updateFromClientX(e.clientX)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || disabled) return
    updateFromClientX(e.clientX)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    if (typeof e.currentTarget.releasePointerCapture === 'function') {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }
    setDragging(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    let next = clampedValue
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      next = Math.min(max, roundToStepPrecision(clampedValue + step, step))
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      next = Math.max(min, roundToStepPrecision(clampedValue - step, step))
    } else if (e.key === 'Home') {
      e.preventDefault()
      next = min
    } else if (e.key === 'End') {
      e.preventDefault()
      next = max
    } else {
      return
    }
    if (next !== value) {
      onChange(next)
    }
  }

  return (
    <div
      className={`flex items-center gap-1.5 select-none ${className}`}
      data-testid={testId ? `${testId}-wrap` : undefined}
    >
      {showStepButtons && (
        <button
          type="button"
          disabled={atMin}
          onClick={() => applySteppedDelta(-1)}
          aria-label={ariaLabel ? `${ariaLabel} -` : 'Decrease'}
          className="pixel-btn min-w-[32px] min-h-[32px] w-8 h-8 flex items-center justify-center shrink-0"
          data-testid={testId ? `${testId}-minus` : undefined}
        >
          <PixelIcon name="minus" size={12} />
        </button>
      )}

      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clampedValue}
        aria-disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        style={{ touchAction: 'none' }}
        data-testid={testId}
        className={`relative flex-1 min-w-[72px] flex items-center min-h-[36px] py-2 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)] ${
          disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'
        }`}
      >
        {/* Rectangular Pixel Track with Quarter Grid Ticks */}
        <div className="relative w-full h-[10px] bg-[var(--bg-app)] border-2 border-[var(--border-pixel)]">
          <div
            style={{ width: `${ratio * 100}%` }}
            className="h-full bg-[var(--accent-primary)]"
          />
          <span
            className="absolute top-0 bottom-0 left-1/4 w-[2px] bg-[var(--border-pixel)] opacity-45 pointer-events-none"
            aria-hidden="true"
          />
          <span
            className="absolute top-0 bottom-0 left-1/2 w-[2px] bg-[var(--border-pixel)] opacity-60 pointer-events-none"
            aria-hidden="true"
          />
          <span
            className="absolute top-0 bottom-0 left-3/4 w-[2px] bg-[var(--border-pixel)] opacity-45 pointer-events-none"
            aria-hidden="true"
          />
        </div>

        {/* Crisp Rectangular Square-ish Pixel Thumb (fixed aspect, never stretched) */}
        <div
          style={{
            left: `calc(${ratio * 100}% - 8px)`,
          }}
          className={`absolute top-1/2 -translate-y-1/2 w-[16px] h-[20px] shrink-0 border-2 flex items-center justify-center pointer-events-none ${
            dragging
              ? 'bg-[var(--accent-teal)] border-[var(--border-strong)]'
              : 'bg-[var(--bg-panel)] border-[var(--border-strong)]'
          }`}
          aria-hidden="true"
        >
          <span className="w-[4px] h-[8px] bg-[var(--text-primary)]" />
        </div>

        {/* Live Value Callout while actively dragging */}
        {dragging && (
          <div
            style={{
              left: `clamp(16px, ${ratio * 100}%, calc(100% - 16px))`,
            }}
            className="absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 bg-[var(--bg-panel)] border-2 border-[var(--border-strong)] text-[10px] font-bold text-[var(--text-primary)] whitespace-nowrap pointer-events-none z-30"
            aria-hidden="true"
          >
            {clampedValue}
            {unit}
          </div>
        )}
      </div>

      {showStepButtons && (
        <button
          type="button"
          disabled={atMax}
          onClick={() => applySteppedDelta(1)}
          aria-label={ariaLabel ? `${ariaLabel} +` : 'Increase'}
          className="pixel-btn min-w-[32px] min-h-[32px] w-8 h-8 flex items-center justify-center shrink-0"
          data-testid={testId ? `${testId}-plus` : undefined}
        >
          <PixelIcon name="plus" size={12} />
        </button>
      )}
    </div>
  )
}
