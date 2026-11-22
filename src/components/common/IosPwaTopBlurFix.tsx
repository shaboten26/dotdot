import { useEffect, useState } from 'react'

/**
 * Detect whether the app is running inside an iOS / iPadOS standalone PWA environment.
 * Avoids injecting the fixed top element on Android or desktop browsers (Section 1).
 */
export function isIosStandalonePwa(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  const maxTouchPoints = navigator.maxTouchPoints || 0

  const isIosDevice =
    /iPhone|iPad|iPod/i.test(ua) ||
    (platform === 'MacIntel' && maxTouchPoints > 1)

  if (!isIosDevice) return false

  const navStandalone = Boolean(
    (navigator as Navigator & { standalone?: boolean }).standalone
  )
  const mqStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches

  return navStandalone || mqStandalone
}

/**
 * Section 1: iOS 27 PWA Top Progressive Blur Workaround
 * Reference: https://qiita.com/na-trium-144/items/0add98a80ca2391e3f17
 *
 * Renders an empty 11px `position: fixed; top: 0` element with `background-color: var(--bg-surface)`
 * and `background-clip: text; -webkit-background-clip: text; pointer-events: none` ONLY when running
 * as an iOS standalone PWA.
 */
export function IosPwaTopBlurFix() {
  const [enabled, setEnabled] = useState<boolean>(() => isIosStandalonePwa())

  useEffect(() => {
    setEnabled(isIosStandalonePwa())
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(display-mode: standalone)')
    const onChange = () => setEnabled(isIosStandalonePwa())
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  if (!enabled) return null

  return (
    <div
      aria-hidden="true"
      data-testid="ios-pwa-top-blur-fix"
      className="ios-pwa-top-blur-fix"
    />
  )
}
