import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { App } from '../App'
import { resetAllAppData, db, loadProjectFull } from '../db/database'
import { PixelIcon } from '../components/common/PixelIcon'
import { getPixel } from '../engine/pixelBuffer'

afterEach(async () => {
  cleanup()
  await resetAllAppData(db)
})

describe('v2.4.0 UI Unification, Gear Icon, Timeline Transport Dock, Non-Destructive Flip Preview & Retro-Cute Theme', () => {
  it('1 & 7: unifies all numerals (including .font-mono and inputs) to readable DotGothic16 pixel font & applies retro-cute dark/light theme tokens with zero shadows', () => {
    const cssPath = path.resolve(process.cwd(), 'src/index.css')
    const css = fs.readFileSync(cssPath, 'utf8')

    // All numerals & text (including .font-mono, inputs, buttons, tabular-nums) prioritize readable DotGothic16 (NOT tiny Silkscreen digits)
    expect(css).not.toContain('DotDotPixelDigits')
    expect(css).toContain('--font-sans: "DotGothic16"')
    expect(css).toContain('--font-mono: "DotGothic16"')
    expect(css).toContain('input[type="number"]')
    expect(css).toContain('font-family: var(--font-mono)')

    // Retro-cute ivory & dusk blue-gray console palette + strict zero-shadow rule
    expect(css).toContain('--bg-surface: #f7f3e8')
    expect(css).toContain('--bg-surface: #252a36')
    expect(css).toContain('--accent-primary: #6d65a8')
    expect(css).toContain('--accent-teal: #3f8c82')
    expect(css).toContain('box-shadow: none !important')
  })

  it('2 & 5: renders an unmistakable 8-tooth symmetric pixel-art gear icon with center hole and crisp pixel cel icons', () => {
    const { container } = render(
      <div>
        <PixelIcon name="settings" size={16} />
        <PixelIcon name="celDot" size={12} />
        <PixelIcon name="celDiamond" size={12} />
        <PixelIcon name="celEmpty" size={12} />
        <PixelIcon name="crosshair" size={12} />
      </div>
    )
    const svgs = container.querySelectorAll('svg')
    expect(svgs.length).toBe(5)
    for (const svg of Array.from(svgs)) {
      expect(svg.getAttribute('shape-rendering')).toBe('crispEdges')
      expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    }

    // Verify the `settings` gear SVG has diagonal teeth (`y=2` has 3 runs: top-left tooth, top tooth, top-right tooth)
    // and a hollow center hole (`y=7` has 2 runs: left tooth+rim and right rim+tooth, leaving x=5..10 open!)
    const gearRects = Array.from(svgs[0]!.querySelectorAll('rect')).map((r) => ({
      x: Number(r.getAttribute('x')),
      y: Number(r.getAttribute('y')),
      w: Number(r.getAttribute('width')),
    }))
    const row2 = gearRects.filter((r) => r.y === 2)
    expect(row2).toEqual([
      { x: 2, y: 2, w: 2 },
      { x: 6, y: 2, w: 4 },
      { x: 12, y: 2, w: 2 },
    ])
    const row7 = gearRects.filter((r) => r.y === 7)
    expect(row7).toEqual([
      { x: 1, y: 7, w: 4 },
      { x: 11, y: 7, w: 4 },
    ])
  })

  it('3 & 4: places Play/Pause/Stop/Prev/Next in tool operation dock during Timeline view (no duplicate timeline play buttons) and supports non-destructive H/V flip preview without mutating pixels', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // Create a new 16x16 artwork (leaving name blank resolves initial name to "下書き1")
    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    // Paint pixel (0, 0) using mouse click at top-left so asymmetric pixel exists
    await screen.findByTestId('workspace-tab-tools')
    const drawBtn = screen.getByTestId('draw-button')
    // Default virtual cursor starts at center (8, 8); move cursor or draw at (8,8), then test pixel preservation
    // Let's switch to mouse click at (0, 0) via viewport or move cursor
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // Open Global Settings from Tool Tab's 10th slot -> toggle Horizontal & Vertical Flip Preview ON
    fireEvent.click(screen.getByTestId('open-global-editor-settings-btn'))
    expect(await screen.findByTestId('global-flip-preview-section')).toBeTruthy()
    const flipHBtn = screen.getByTestId('global-flip-preview-h-btn')
    const flipVBtn = screen.getByTestId('global-flip-preview-v-btn')

    fireEvent.click(flipHBtn)
    expect(flipHBtn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('viewport-flip-preview-badge').textContent).toContain(
      '左右反転中'
    )

    fireEvent.click(flipVBtn)
    expect(flipVBtn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('viewport-flip-preview-badge').textContent).toContain(
      '上下左右反転中'
    )

    // Close modal & reset via viewport badge -> returns cleanly to normal orientation
    fireEvent.click(screen.getByTestId('close-global-editor-settings-btn'))
    fireEvent.click(screen.getByTestId('viewport-flip-preview-badge'))
    expect(screen.queryByTestId('viewport-flip-preview-badge')).toBeNull()

    // Re-enable Horizontal Flip Preview, add a 2nd frame, and verify Timeline Transport Dock!
    fireEvent.click(screen.getByTestId('open-global-editor-settings-btn'))
    fireEvent.click(screen.getByTestId('global-flip-preview-h-btn'))
    fireEvent.click(screen.getByTestId('close-global-editor-settings-btn'))

    fireEvent.click(screen.getByTestId('workspace-tab-layers'))
    fireEvent.click(await screen.findByTestId('add-first-frame-btn'))

    // Now in Timeline view (`>=2` frames):
    // - Tool operation area shows `timeline-transport-dock` with Prev / Play-Pause / Stop / Next / Global Settings
    // - Duplicate `timeline-play-btn`, `timeline-prev-frame-btn`, `timeline-next-frame-btn` do NOT exist!
    expect(await screen.findByTestId('timeline-transport-dock')).toBeTruthy()
    expect(screen.queryByTestId('timeline-play-btn')).toBeNull()
    expect(screen.queryByTestId('timeline-prev-frame-btn')).toBeNull()
    expect(screen.queryByTestId('timeline-next-frame-btn')).toBeNull()

    // Add 3rd empty frame so we can test Prev / Next / Play / Stop rewind to Frame #1
    fireEvent.click(screen.getByTestId('timeline-add-empty-frame-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('timeline-active-frame-status').textContent).toContain(
        '#3/3'
      )
    })

    // Step Prev -> Frame #2/3, Step Next -> Frame #3/3
    fireEvent.click(screen.getByTestId('dock-prev-frame-btn'))
    expect(screen.getByTestId('timeline-active-frame-status').textContent).toContain(
      '#2/3'
    )
    fireEvent.click(screen.getByTestId('dock-next-frame-btn'))
    expect(screen.getByTestId('timeline-active-frame-status').textContent).toContain(
      '#3/3'
    )

    // Toggle Play -> Pause -> Stop (rewinds to #1/3 and stops playback)
    const playToggle = screen.getByTestId('dock-play-toggle-btn')
    fireEvent.click(playToggle)
    expect(playToggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('dock-stop-btn'))
    expect(playToggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('timeline-active-frame-status').textContent).toContain(
      '#1/3'
    )

    // Verify underlying pixel buffer was NEVER mutated by flip preview!
    const allProjects = await db.projects.toArray()
    expect(allProjects[0]!.name).toBe('無題の作品 01')
    const loaded = (await loadProjectFull(allProjects[0]!.id, db))!
    expect(loaded.layers[0]!.name).toBe('Layer 1')
    const drawnPx = getPixel(loaded.layers[0]!.data, 16, 16, 8, 8)
    expect(drawnPx.a).toBe(255)
    // Mirrored coordinate (7, 8) remains untouched transparent `{ r: 0, g: 0, b: 0, a: 0 }`!
    const mirroredPx = getPixel(loaded.layers[0]!.data, 16, 16, 7, 8)
    expect(mirroredPx.a).toBe(0)
  }, 15000)
})
