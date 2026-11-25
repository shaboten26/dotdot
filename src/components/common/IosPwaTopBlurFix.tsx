import { useEffect, useState } from 'react'

/**
 * Detect whether the app is running inside an iOS / iPadOS Home-Screen standalone PWA environment.
 * Returns `false` on regular mobile Safari tabs, Android, and desktop browsers so non-PWA layouts are untouched.
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
 * Fundamental Fix for iPhone Home-Screen Standalone PWA Top Progressive Blur:
 * 1. `index.html` uses `<meta name="apple-mobile-web-app-status-bar-style" content="default">` + synced
 *    `meta[name="theme-color"]` instead of `black-translucent`, preventing iOS 26/27 from extending a ~112px
 *    system Liquid Glass blur gradient over the app header.
 * 2. For iOS standalone WebKit's fixed-header edge detector (and any existing Home-Screen shortcuts),
 *    renders both:
 *    - `.ios-pwa-top-solid-cap`: a real, opaque `position: fixed; top: 0` bar (`height: max(env(safe-area-inset-top, 0px), 12px)`,
 *      `background-color: var(--bg-surface)`, `z-index: 15`) tucked cleanly behind the `z-20`/`z-30` app headers so
 *      header text/buttons are never covered while WebKit sees an authentic opaque fixed top bar.
 *    - `.ios-pwa-top-blur-fix`: a zero-paint top-most `background-clip: text` sentinel (`height: 12px`, `pointer-events: none`).
 * 3. Strictly gated to `isIosStandalonePwa()` so regular Safari, Android, and PC browsers are 100% unaffected.
 */
export function IosPwaTopBlurFix() {
  const [enabled, setEnabled] = useState<boolean>(() => isIosStandalonePwa())

  useEffect(() => {
    const syncState = () => {
      const active = isIosStandalonePwa()
      setEnabled(active)
      if (typeof document !== 'undefined') {
        if (active) {
          document.documentElement.setAttribute('data-ios-standalone', 'true')
        } else {
          document.documentElement.removeAttribute('data-ios-standalone')
        }
      }
    }

    syncState()
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mq = window.matchMedia('(display-mode: standalone)')
    mq.addEventListener('change', syncState)
    return () => mq.removeEventListener('change', syncState)
  }, [])

  if (!enabled) return null

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="ios-pwa-top-solid-cap"
        className="ios-pwa-top-solid-cap"
      />
      <div
        aria-hidden="true"
        data-testid="ios-pwa-top-blur-fix"
        className="ios-pwa-top-blur-fix"
      />
    </>
  )
}
