import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '../../state/AppContext'
import { PixelIcon } from './PixelIcon'

export function ToastContainer() {
  const { toasts, dismissToast, reducedMotion } = useApp()

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[70] flex flex-col items-center gap-2 pointer-events-none w-[92vw] max-w-sm pt-safe">
      <AnimatePresence>
        {toasts.map((toast) => {
          const styleCls =
            toast.type === 'error'
              ? 'pixel-btn-danger'
              : toast.type === 'success'
                ? 'pixel-btn-teal'
                : 'pixel-panel text-[var(--text-primary)]'

          return (
            <motion.button
              key={toast.id}
              type="button"
              onClick={() => dismissToast(toast.id)}
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reducedMotion ? 0 : 0.14 }}
              className={`pointer-events-auto px-3.5 py-2 border-2 border-[var(--border-pixel)] text-xs font-bold flex items-center gap-2 ${styleCls}`}
            >
              <PixelIcon
                name={toast.type === 'error' ? 'close' : 'check'}
                size={14}
              />
              <span>{toast.text}</span>
            </motion.button>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
