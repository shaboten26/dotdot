import React, { startTransition, useCallback } from 'react'
import { useNavigate, type To } from 'react-router'
import { useApp } from '../../state/AppContext'

export function useViewTransitionNavigate() {
  const navigate = useNavigate()
  const { reducedMotion } = useApp()
  return useCallback(
    (to: To, options?: { replace?: boolean }) => {
      if (
        !reducedMotion &&
        typeof document !== 'undefined' &&
        'startViewTransition' in document
      ) {
        ;(document as Document & {
          startViewTransition: (cb: () => void) => unknown
        }).startViewTransition(() => {
          startTransition(() => {
            navigate(to, options)
          })
        })
      } else {
        startTransition(() => {
          navigate(to, options)
        })
      }
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
