import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
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
  /** Default `'auto'` inspects viewport space above/below and opens toward the roomier side */
  direction?: 'auto' | 'down' | 'up'
  testId?: string
}

interface MenuPlacement {
  resolvedDirection: 'down' | 'up'
  top?: number
  bottom?: number
  left: number
  minWidth: number
  maxWidth: number
  maxHeight: number
}

const VIEWPORT_MARGIN_PX = 8
const DESIRED_MENU_MAX_HEIGHT_PX = 240
const OPTION_ESTIMATED_HEIGHT_PX = 40

/**
 * Custom Pixel-Art Dropdown (`PixelSelect`) — Updated for Section 4-4:
 * - Renders popup via `createPortal(..., document.body)` with `position: fixed` so parent `overflow: hidden/auto` NEVER clips options!
 * - Automatically calculates available space above & below trigger button (`direction = 'auto'` by default; even if `'down'`/`'up'` is passed, automatically flips if the requested side lacks room while the opposite side has more space).
 * - Clamps horizontal position and max-height so options NEVER overflow the mobile/PC viewport.
 * - Immediately scrolls the listbox on open so the currently selected option (`aria-selected="true"`) is visible inside the menu viewport instead of always starting at index 0!
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
  direction = 'auto',
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
  const [placement, setPlacement] = useState<MenuPlacement>({
    resolvedDirection: direction === 'up' ? 'up' : 'down',
    top: 0,
    left: 0,
    minWidth: 120,
    maxWidth: 320,
    maxHeight: DESIRED_MENU_MAX_HEIGHT_PX,
  })

  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const listboxRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()

  const selectedOption =
    options.find((o) => o.value === value) ?? options[0] ?? null

  useEffect(() => {
    const idx = options.findIndex((o) => o.value === value)
    if (idx >= 0) setFocusIdx(idx)
  }, [value, options])

  const computePlacement = useCallback(() => {
    if (typeof window === 'undefined' || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const vw = Math.max(240, window.innerWidth || 360)
    const vh = Math.max(240, window.innerHeight || 640)

    const spaceBelow = Math.max(0, vh - rect.bottom - VIEWPORT_MARGIN_PX - 4)
    const spaceAbove = Math.max(0, rect.top - VIEWPORT_MARGIN_PX - 4)
    const estimatedContentHeight = Math.min(
      DESIRED_MENU_MAX_HEIGHT_PX,
      Math.max(84, options.length * OPTION_ESTIMATED_HEIGHT_PX + 12)
    )

    let resolvedDirection: 'down' | 'up' = 'down'
    if (direction === 'up') {
      resolvedDirection =
        spaceAbove >= Math.min(120, estimatedContentHeight) || spaceAbove >= spaceBelow
          ? 'up'
          : 'down'
    } else if (direction === 'down') {
      resolvedDirection =
        spaceBelow >= estimatedContentHeight || spaceBelow >= spaceAbove
          ? 'down'
          : 'up'
    } else {
      // 'auto': prefer 'down' when spaceBelow suffices, otherwise pick whichever side has more room
      if (spaceBelow >= estimatedContentHeight) {
        resolvedDirection = 'down'
      } else if (spaceAbove >= estimatedContentHeight) {
        resolvedDirection = 'up'
      } else {
        resolvedDirection = spaceAbove > spaceBelow ? 'up' : 'down'
      }
    }

    const availableVertical =
      resolvedDirection === 'up' ? spaceAbove : spaceBelow
    const maxHeight = Math.max(
      76,
      Math.min(DESIRED_MENU_MAX_HEIGHT_PX, availableVertical)
    )

    const maxAllowedWidth = Math.min(320, vw - VIEWPORT_MARGIN_PX * 2)
    const minWidth = Math.min(Math.max(88, rect.width), maxAllowedWidth)
    let left =
      align === 'right'
        ? Math.max(VIEWPORT_MARGIN_PX, rect.right - Math.max(minWidth, 180))
        : rect.left
    if (left + minWidth > vw - VIEWPORT_MARGIN_PX) {
      left = Math.max(VIEWPORT_MARGIN_PX, vw - VIEWPORT_MARGIN_PX - minWidth)
    }
    if (left < VIEWPORT_MARGIN_PX) {
      left = VIEWPORT_MARGIN_PX
    }

    if (resolvedDirection === 'up') {
      setPlacement({
        resolvedDirection: 'up',
        bottom: Math.max(VIEWPORT_MARGIN_PX, vh - rect.top + 4),
        left,
        minWidth,
        maxWidth: Math.max(minWidth, Math.min(maxAllowedWidth, vw - left - VIEWPORT_MARGIN_PX)),
        maxHeight,
      })
    } else {
      setPlacement({
        resolvedDirection: 'down',
        top: Math.min(vh - maxHeight - VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, rect.bottom + 4)),
        left,
        minWidth,
        maxWidth: Math.max(minWidth, Math.min(maxAllowedWidth, vw - left - VIEWPORT_MARGIN_PX)),
        maxHeight,
      })
    }
  }, [align, direction, options.length])

  // Position menu & scroll active option into view immediately upon opening
  useLayoutEffect(() => {
    if (!open) return
    computePlacement()

    const scrollSelectedIntoView = () => {
      const listEl = listboxRef.current
      if (!listEl) return
      const selectedIdx = options.findIndex((o) => o.value === value)
      if (selectedIdx < 0) return

      const selectedEl = listEl.querySelector(
        '[data-selected-option="true"]'
      ) as HTMLElement | null

      if (selectedEl && selectedEl.offsetHeight > 0 && listEl.clientHeight > 0) {
        const itemTop = selectedEl.offsetTop
        const itemBottom = itemTop + selectedEl.offsetHeight
        const viewTop = listEl.scrollTop
        const viewBottom = viewTop + listEl.clientHeight
        if (itemTop < viewTop || itemBottom > viewBottom) {
          listEl.scrollTop = Math.max(
            0,
            itemTop - Math.floor((listEl.clientHeight - selectedEl.offsetHeight) / 2)
          )
        }
      } else {
        // Fallback for non-layout test environments (e.g. jsdom where clientHeight === 0):
        // Estimate scroll offset when selected option is past the initial visible fold
        const visibleCount = 5
        if (selectedIdx >= visibleCount) {
          listEl.scrollTop = Math.max(
            0,
            (selectedIdx - Math.floor(visibleCount / 2)) * OPTION_ESTIMATED_HEIGHT_PX
          )
        } else {
          listEl.scrollTop = 0
        }
      }
    }

    scrollSelectedIntoView()
    const rafId = window.requestAnimationFrame(scrollSelectedIntoView)
    return () => window.cancelAnimationFrame(rafId)
  }, [open, computePlacement, options, value])

  useEffect(() => {
    if (!open) return
    const onPointerDownOutside = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (
        target &&
        !rootRef.current?.contains(target) &&
        !listboxRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const onViewportChange = () => computePlacement()

    window.addEventListener('pointerdown', onPointerDownOutside)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDownOutside)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, computePlacement])

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

  const popupNode = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={listboxRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          data-direction={placement.resolvedDirection}
          data-testid={testId ? `${testId}-listbox` : undefined}
          initial={
            reducedMotion
              ? { opacity: 1 }
              : {
                  opacity: 0,
                  y: placement.resolvedDirection === 'up' ? 4 : -4,
                }
          }
          animate={{ opacity: 1, y: 0 }}
          exit={
            reducedMotion
              ? { opacity: 0 }
              : {
                  opacity: 0,
                  y: placement.resolvedDirection === 'up' ? 4 : -4,
                }
          }
          transition={{ duration: reducedMotion ? 0 : 0.1 }}
          style={{
            position: 'fixed',
            top: placement.top !== undefined ? `${placement.top}px` : undefined,
            bottom:
              placement.bottom !== undefined ? `${placement.bottom}px` : undefined,
            left: `${placement.left}px`,
            minWidth: `${placement.minWidth}px`,
            maxWidth: `${placement.maxWidth}px`,
            maxHeight: `${placement.maxHeight}px`,
            zIndex: 9999,
          }}
          className="w-max overflow-y-auto pixel-panel p-1 space-y-0.5"
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
                data-selected-option={selected ? 'true' : undefined}
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
  )

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
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
        <PixelIcon
          name={
            open
              ? placement.resolvedDirection === 'up'
                ? 'arrowDown'
                : 'arrowUp'
              : 'arrowDown'
          }
          size={12}
        />
      </button>

      {typeof document !== 'undefined'
        ? createPortal(popupNode, document.body)
        : popupNode}
    </div>
  )
}
