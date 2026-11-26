import React, { startTransition, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate, type To } from 'react-router'
import { useApp } from '../../state/AppContext'

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => {
    ready?: Promise<void>
    finished?: Promise<void>
  }
}

/**
 * Synchronously commits React Router navigation inside `document.startViewTransition`
 * using `flushSync` so the browser captures genuine before/after DOM snapshots
 * (including shared `view-transition-name: artwork-<id>` elements).
 * Safely falls back to `startTransition` when `prefers-reduced-motion` is active,
 * when View Transition API is unsupported (e.g. older browsers / JSDOM), or if a transition throws.
 */
export function useViewTransitionNavigate() {
  const navigate = useNavigate()
  const { reducedMotion } = useApp()

  return useCallback(
    (to: To, options?: { replace?: boolean }) => {
      const vtDoc =
        typeof document !== 'undefined'
          ? (document as ViewTransitionDocument)
          : null

      if (
        !reducedMotion &&
        vtDoc &&
        typeof vtDoc.startViewTransition === 'function' &&
        document.visibilityState !== 'hidden'
      ) {
        let navigated = false
        try {
          vtDoc.startViewTransition(() => {
            flushSync(() => {
              navigated = true
              navigate(to, options)
            })
          })
          return
        } catch {
          if (!navigated) {
            startTransition(() => {
              navigate(to, options)
            })
          }
          return
        }
      }

      startTransition(() => {
        navigate(to, options)
      })
    },
    [navigate, reducedMotion]
  )
}

interface VTButtonLinkProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  to: To
  replace?: boolean
}

export function VTButtonLink({
  to,
  replace,
  onClick,
  children,
  ...rest
}: VTButtonLinkProps) {
  const vtNavigate = useViewTransitionNavigate()
  return (
    <button
      type="button"
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) {
          vtNavigate(to, { replace })
        }
      }}
      {...rest}
    >
      {children}
    </button>
  )
}
