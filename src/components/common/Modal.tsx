import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { PixelIcon } from './PixelIcon'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  maxWidthClass?: string
}

/**
 * Pixel-Art Modal Dialog:
 * - Rendered via `createPortal(..., document.body)` so nested modals (e.g. `PaletteToolsModal`
 *   opened inside `PaletteSheet`'s `motion.div` which creates a transform containing block!)
 *   ALWAYS position against the true browser viewport and NEVER push their header/close button off-screen!
 * - Uses an explicit CSS Grid (`grid-rows-[auto_minmax(0,1fr)]`) inside `max-h-[85dvh]` so the
 *   title bar + `×` button stay strictly pinned at row 1 regardless of how tall `children` are.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  maxWidthClass = 'max-w-md',
}: ModalProps) {
  const { reducedMotion } = useApp()
  const { t } = useI18n()
  const bodyScrollRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const wasOpenRef = useRef(false)

  // Reset scrollTop ONLY when transitioning from closed (`false`) -> open (`true`).
  // Never depend on `onClose` here, because inline `onClose={() => ...}` callbacks recreate on every parent
  // state update (color wheel drag, palette selection, slider drag, etc.) and would otherwise reset `scrollTop = 0`!
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (bodyScrollRef.current) {
        bodyScrollRef.current.scrollTop = 0
      }
    }
    wasOpenRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const modalNode = (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-safe"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: reducedMotion ? 0 : 0.22,
              ease: [0.22, 1, 0.36, 1],
            }}
            onClick={onClose}
            className="fixed inset-0 bg-black/55"
          />
          <motion.div
            initial={
              reducedMotion
                ? { opacity: 1 }
                : { opacity: 0, y: 24, scale: 0.975 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, y: 18, scale: 0.985 }
            }
            transition={
              reducedMotion
                ? { duration: 0 }
                : {
                    type: 'spring',
                    stiffness: 420,
                    damping: 36,
                    mass: 0.88,
                  }
            }
            style={{ maxHeight: 'min(85dvh, 85vh)' }}
            className={`relative z-10 w-full ${maxWidthClass} min-h-0 grid grid-rows-[auto_minmax(0,1fr)] pixel-panel pb-safe overflow-hidden`}
          >
            {/* Retro Pixel Title Bar with Decorative Corner Pixels (strictly pinned in Grid row 1) */}
            <div className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b-2 border-[var(--border-pixel)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 bg-[var(--accent-primary)] border border-[var(--border-pixel)] shrink-0"
                  aria-hidden="true"
                />
                <h2 className="text-sm font-bold tracking-wide truncate text-[var(--text-primary)]">
                  {title}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center shrink-0"
                data-testid="modal-close-btn"
              >
                <PixelIcon name="close" size={16} />
              </button>
            </div>
            <div
              ref={bodyScrollRef}
              className="p-4 min-h-0 overflow-y-auto overscroll-contain"
              data-testid="modal-scroll-body"
            >
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )

  return typeof document !== 'undefined'
    ? createPortal(modalNode, document.body)
    : modalNode
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
  extraContent?: React.ReactNode
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
  extraContent,
}: ConfirmDialogProps) {
  const { t } = useI18n()
  return (
    <Modal open={open} title={title} onClose={onCancel} maxWidthClass="max-w-sm">
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{message}</p>
        {extraContent}
        <div className="flex gap-2.5 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 min-h-[44px] px-4 pixel-btn text-xs font-bold"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 min-h-[44px] px-4 text-xs font-bold ${
              destructive ? 'pixel-btn pixel-btn-danger' : 'pixel-btn pixel-btn-active'
            }`}
          >
            {confirmLabel ?? t('confirm')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
