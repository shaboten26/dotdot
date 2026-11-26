import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  IosPwaTopBlurFix,
  isIosStandalonePwa,
} from '../components/common/IosPwaTopBlurFix'

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'navigator'
)
const originalMatchMedia = window.matchMedia

function mockEnvironment(opts: {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  standalone?: boolean
  displayModeStandalone?: boolean
}) {
  Object.defineProperty(window, 'navigator', {
    configurable: true,
    value: {
      ...window.navigator,
      userAgent: opts.userAgent,
      platform: opts.platform ?? 'iPhone',
      maxTouchPoints: opts.maxTouchPoints ?? 5,
      standalone: opts.standalone,
    },
  })

  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      query === '(display-mode: standalone)'
        ? Boolean(opts.displayModeStandalone)
        : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-ios-standalone')
  if (originalNavigatorDescriptor) {
    Object.defineProperty(window, 'navigator', originalNavigatorDescriptor)
  }
  window.matchMedia = originalMatchMedia
})

describe('Stage 2: iPhone Home-Screen Standalone PWA Top Blur Suppression', () => {
  it('activates solid top cap + fixed clip sentinel ONLY on iOS standalone PWA and keeps regular Safari / Android / Desktop completely untouched', () => {
    // 1. Regular mobile Safari on iPhone (NOT standalone) -> MUST NOT render or mutate root attribute
    mockEnvironment({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: false,
      displayModeStandalone: false,
    })
    expect(isIosStandalonePwa()).toBe(false)
    const { unmount: unmountSafari } = render(<IosPwaTopBlurFix />)
    expect(screen.queryByTestId('ios-pwa-top-solid-cap')).toBeNull()
    expect(screen.queryByTestId('ios-pwa-top-blur-fix')).toBeNull()
    expect(document.documentElement.hasAttribute('data-ios-standalone')).toBe(
      false
    )
    unmountSafari()

    // 2. Android standalone PWA -> MUST NOT render iOS-specific top elements
    mockEnvironment({
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
      standalone: false,
      displayModeStandalone: true,
    })
    expect(isIosStandalonePwa()).toBe(false)
    const { unmount: unmountAndroid } = render(<IosPwaTopBlurFix />)
    expect(screen.queryByTestId('ios-pwa-top-solid-cap')).toBeNull()
    expect(screen.queryByTestId('ios-pwa-top-blur-fix')).toBeNull()
    unmountAndroid()

    // 3. iPhone Home-Screen Standalone PWA (`navigator.standalone === true`) -> activates both suppression layers!
    mockEnvironment({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
      displayModeStandalone: true,
    })
    expect(isIosStandalonePwa()).toBe(true)
    render(<IosPwaTopBlurFix />)
    expect(screen.getByTestId('ios-pwa-top-solid-cap')).toBeTruthy()
    expect(screen.getByTestId('ios-pwa-top-blur-fix')).toBeTruthy()
    expect(document.documentElement.getAttribute('data-ios-standalone')).toBe(
      'true'
    )

    // 4. Verify index.html & manifest.webmanifest status-bar / theme-color sync with lavender --bg-surface
    const indexHtml = fs.readFileSync(
      path.resolve(process.cwd(), 'index.html'),
      'utf8'
    )
    expect(indexHtml).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="default" />'
    )
    expect(indexHtml).toContain('content="#faf6f0"')
    expect(indexHtml).toContain('content="#292133"')

    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), 'public/manifest.webmanifest'),
        'utf8'
      )
    ) as { background_color: string; theme_color: string }
    expect(manifest.background_color).toBe('#1f1926')
    expect(manifest.theme_color).toBe('#292133')
  })
})
