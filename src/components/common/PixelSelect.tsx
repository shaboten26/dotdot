import React, { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { PixelIcon, type PixelIconName } from './PixelIcon'
import { useApp } from '../../state/AppContext'

export interface PixelSelectOption<T extends string | number> {
  value: T
  label: string
  icon?: PixelIconName
  swatchColors?: string[]
  subLabel?: string
}

export interface PixelSelectProps<T extends string | number> {
  value: T
  options: ReadonlyArray<PixelSelectOption<T>>
  onChange: (next: T) => void
  ariaLabel?: string
  disabled?: boolean
  className?: string
  buttonClassName?: string
  align?: 'left' | 'right'
  direction?: 'down' | 'up'
  testId?: string
}

/**
 * Section 10: Custom Pixel-Art Dropdown (`PixelSelect`)
 * Replaces all native OS `<select>` elements across the entire app:
 * - Crisp 2px pixel borders, unified theme colors, zero shadows
 * - Checkmark indicator on active option
 * - Opens on tap, selects immediately, closes on outside tap or Escape
 * - Scrollable long list constrained inside mobile viewport (never overflows screen edges)
 * - Full keyboard navigation (ArrowUp/Down, Enter, Space, Escape)
 */
export function PixelSelect<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
  buttonClassName = '',
  align = 'left',
  direction = 'down',
  testId,
}: PixelSelectProps<T>) {
  const { reducedMotion } = useApp()
  const [open, setOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const selectedOption =
    options.find((o) => o.value === value) ?? options[0] ?? null

  useEffect(() => {
    const idx = options.findIndex((o) => o.value === value)
    if (idx >= 0) setFocusIdx(idx)
  }, [value, options])

  useEffect(() => {
    if (!open) return
    const onPointerDownOutside = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDownOutside)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDownOutside)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
      } else {
        setFocusIdx((i) => Math.min(options.length - 1, i + 1))
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
      } else {
        setFocusIdx((i) => Math.max(0, i - 1))
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault()
      const opt = options[focusIdx]
      if (opt) {
        onChange(opt.value)
        setOpen(false)
      }
    }
  }

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
        data-testid={testId}
        className={`w-full min-h-[40px] px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs font-bold text-left ${
          open ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
        } ${buttonClassName}`}
      >
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          {selectedOption?.icon && (
            <PixelIcon name={selectedOption.icon} size={14} />
          )}
          <span className="truncate">{selectedOption?.label ?? ''}</span>
        </span>
        <PixelIcon name={open ? 'arrowUp' : 'arrowDown'} size={12} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            initial={
              reducedMotion
                ? { opacity: 1 }
                : { opacity: 0, y: direction === 'up' ? 4 : -4 }
            }
            animate={{ opacity: 1, y: 0 }}
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, y: direction === 'up' ? 4 : -4 }
            }
            transition={{ duration: reducedMotion ? 0 : 0.1 }}
            className={`absolute z-50 min-w-full w-max max-w-[min(90vw,320px)] max-h-60 overflow-y-auto pixel-panel p-1 space-y-0.5 ${
              direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
            } ${align === 'right' ? 'right-0' : 'left-0'}`}
          >
            {options.map((opt, idx) => {
              const selected = opt.value === value
              const focused = idx === focusIdx
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setFocusIdx(idx)}
                  onClick={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  data-testid={
                    testId ? `${testId}-opt-${String(opt.value)}` : undefined
                  }
                  className={`w-full min-h-[38px] px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs font-bold text-left border-2 cursor-pointer ${
                    selected
                      ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] border-[var(--border-strong)]'
                      : focused
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border-[var(--border-pixel)]'
                        : 'bg-transparent text-[var(--text-primary)] border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="w-3.5 h-3.5 inline-flex items-center justify-center shrink-0">
                      {selected && <PixelIcon name="check" size={12} />}
                    </span>
                    {opt.icon && <PixelIcon name={opt.icon} size={14} />}
                    <span className="truncate">{opt.label}</span>
                    {opt.subLabel && (
                      <span className="text-[10px] opacity-75 shrink-0">
                        {opt.subLabel}
                      </span>
                    )}
                  </span>

                  {opt.swatchColors && opt.swatchColors.length > 0 && (
                    <span className="flex items-center gap-0.5 shrink-0">
                      {opt.swatchColors.slice(0, 6).map((hex, cIdx) => (
                        <span
                          key={cIdx}
                          style={{ backgroundColor: hex }}
                          className="w-3 h-3 border border-[var(--border-pixel)]"
                        />
                      ))}
                    </span>
                  )}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
