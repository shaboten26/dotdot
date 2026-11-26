import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { App } from '../App'
import { resetAllAppData, db, loadProjectFull, createNewProject } from '../db/database'
import { PixelIcon } from '../components/common/PixelIcon'
import { getPixel } from '../engine/pixelBuffer'

afterEach(async () => {
  cleanup()
  await resetAllAppData(db)
})

describe('v2.4.x UI Unification, Viewer Solid Background, Tab-Bar Frame Controls, Selection Undo Preservation & Cross-Canvas Copy/Paste', () => {
  it('1 & 7: unifies all numerals (including .font-mono and inputs) to readable DotGothic16 pixel font & applies retro-cute dark/light theme tokens with zero shadows and smooth ViewTransition CSS', () => {
    const cssPath = path.resolve(process.cwd(), 'src/index.css')
    const css = fs.readFileSync(cssPath, 'utf8')

    // All numerals & text (including .font-mono, inputs, buttons, tabular-nums) prioritize readable DotGothic16
    expect(css).not.toContain('DotDotPixelDigits')
    expect(css).toContain('--font-sans: "DotGothic16"')
    expect(css).toContain('--font-mono: "DotGothic16"')
    expect(css).toContain('input[type="number"]')
    expect(css).toContain('font-family: var(--font-mono)')

    // Lavender Cream & Dusk Plum retro-cute pixel-art studio palette + strict zero-shadow rule + ViewTransition
    expect(css).toContain('--bg-surface: #faf6f0')
    expect(css).toContain('--bg-surface: #292133')
    expect(css).toContain('--accent-primary: #7b62ad')
    expect(css).toContain('--accent-teal: #578a75')
    expect(css).toContain('box-shadow: none !important')
    expect(css).toContain('::view-transition-old(root)')
    expect(css).toContain('::view-transition-new(root)')
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

  it('3 & 4: removes #1/3 100ms timeline badge, keeps tab-bar arrow + play controls visible in BOTH Tool and Timeline tabs, omits custom cursor UI, and supports non-destructive H/V flip preview', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // Create a new 16x16 artwork
    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    await screen.findByTestId('workspace-tab-tools')
    const drawBtn = screen.getByTestId('draw-button')
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // Open Global Settings -> verify custom cursor feature is NOT present & toggle H/V Flip Preview ON
    fireEvent.click(screen.getByTestId('open-global-editor-settings-btn'))
    expect(await screen.findByTestId('global-flip-preview-section')).toBeTruthy()
    expect(screen.queryByTestId('new-custom-cursor-btn')).toBeNull()
    expect(screen.queryByTestId('cursor-design-default-btn')).toBeNull()

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

    fireEvent.click(screen.getByTestId('close-global-editor-settings-btn'))
    fireEvent.click(screen.getByTestId('viewport-flip-preview-badge'))
    expect(screen.queryByTestId('viewport-flip-preview-badge')).toBeNull()

    // Re-enable Horizontal Flip Preview and add a 2nd frame
    fireEvent.click(screen.getByTestId('open-global-editor-settings-btn'))
    fireEvent.click(screen.getByTestId('global-flip-preview-h-btn'))
    fireEvent.click(screen.getByTestId('close-global-editor-settings-btn'))

    fireEvent.click(screen.getByTestId('workspace-tab-layers'))
    fireEvent.click(await screen.findByTestId('add-first-frame-btn'))

    // In Timeline tab (`>=2` frames):
    // - `#1/3 100ms` (`timeline-active-frame-status`) is completely removed!
    // - Extra `timeline-transport-dock` is removed!
    // - `tabbar-frame-controls` (`quick-prev-frame-btn`, `quick-play-toggle-btn`, `quick-next-frame-btn`) IS visible in the tab strip on Timeline tab AND Tool tab!
    expect(screen.queryByTestId('timeline-active-frame-status')).toBeNull()
    expect(screen.queryByTestId('timeline-transport-dock')).toBeNull()
    expect(await screen.findByTestId('tabbar-frame-controls')).toBeTruthy()
    expect(screen.getByTestId('quick-prev-frame-btn')).toBeTruthy()
    expect(screen.getByTestId('quick-play-toggle-btn').textContent).toContain('2/2')
    expect(screen.getByTestId('quick-next-frame-btn')).toBeTruthy()

    // Add 3rd empty frame and verify tab-bar frame controls update (`3/3`) on Timeline tab
    fireEvent.click(screen.getByTestId('timeline-add-empty-frame-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('quick-play-toggle-btn').textContent).toContain('3/3')
    })

    // Step Prev -> `2/3`, Step Next -> `3/3` while Timeline tab is active
    fireEvent.click(screen.getByTestId('quick-prev-frame-btn'))
    expect(screen.getByTestId('quick-play-toggle-btn').textContent).toContain('2/3')
    fireEvent.click(screen.getByTestId('quick-next-frame-btn'))
    expect(screen.getByTestId('quick-play-toggle-btn').textContent).toContain('3/3')

    // Step back to Frame #1 (`1/3`) so `layers[0].data` in DB reflects Frame #1 where we drew `(8, 8)`
    fireEvent.click(screen.getByTestId('quick-prev-frame-btn'))
    fireEvent.click(screen.getByTestId('quick-prev-frame-btn'))
    expect(screen.getByTestId('quick-play-toggle-btn').textContent).toContain('1/3')

    // Switch to Tool tab -> exact same `tabbar-frame-controls` remains in the tab zone!
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    expect(screen.getByTestId('tabbar-frame-controls')).toBeTruthy()
    expect(screen.getByTestId('quick-play-toggle-btn').textContent).toContain('1/3')

    // Toggle Play -> Pause via `quick-play-toggle-btn`
    const playToggle = screen.getByTestId('quick-play-toggle-btn')
    fireEvent.click(playToggle)
    expect(playToggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(playToggle)
    expect(playToggle.getAttribute('aria-pressed')).toBe('false')

    // Verify underlying pixel buffer on Frame #1 was NEVER mutated by flip preview!
    await waitFor(async () => {
      const allProjects = await db.projects.toArray()
      const loaded = (await loadProjectFull(allProjects[0]!.id, db))!
      const drawnPx = getPixel(loaded.layers[0]!.data, 16, 16, 8, 8)
      expect(drawnPx.a).toBe(255)
      const mirroredPx = getPixel(loaded.layers[0]!.data, 16, 16, 7, 8)
      expect(mirroredPx.a).toBe(0)
    })
  }, 15000)

  it('6: Viewing screen (/project/:id) uses solid page background (--bg-app) instead of checkerboard behind transparent pixels', async () => {
    const created = await createNewProject(
      {
        name: '透過確認アート',
        width: 16,
        height: 16,
        palette: { name: 'Std', colors: ['#112233', '#DDEEFF'] },
      },
      db
    )

    window.history.pushState({}, '', `/project/${created.project.id}`)
    render(<App />)

    const previewCard = await screen.findByTestId('detail-preview-card')
    expect(previewCard.className).toContain('bg-[var(--bg-app)]')
    // Must NOT carry inline checkerboard backgroundImage
    expect(previewCard.style.backgroundImage).toBe('')
  })

  it('8: Undoing a straight line drawn inside a selection reverts ONLY the line while keeping the selection active', async () => {
    const created = await createNewProject(
      {
        name: '選択内直線Undo',
        width: 16,
        height: 16,
        palette: { name: 'Std', colors: ['#E11D48', '#10B981'] },
      },
      db
    )

    window.history.pushState({}, '', `/editor/${created.project.id}`)
    render(<App />)

    await screen.findByTestId('workspace-tab-tools')
    const viewport = screen.getByTestId('canvas-viewport')
    const drawBtn = screen.getByTestId('draw-button')

    // Mock viewport bounding box (160x160) so touch slides map deterministically
    Object.defineProperty(viewport, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 160,
        bottom: 160,
        width: 160,
        height: 160,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    })

    // 1. Switch to Select tool -> Rectangle selection mode
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(await screen.findByTestId('select-type-rect'))
    // Close tool detail popover so `selection-ready-bar` reflects active selection clearly
    fireEvent.click(screen.getByTestId('tool-select'))

    // Start selection at current virtual cursor (8, 8)
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // Move virtual cursor down-right and confirm rectangle selection
    fireEvent.pointerDown(viewport, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 40,
      clientY: 40,
    })
    fireEvent.pointerMove(viewport, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 110,
      clientY: 110,
    })
    fireEvent.pointerUp(viewport, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 110,
      clientY: 110,
    })
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // Selection is now active (`selection-ready-bar` visible)
    expect(await screen.findByTestId('selection-ready-bar')).toBeTruthy()

    // 2. Switch to Straight Line tool and draw a line inside the selection
    fireEvent.click(screen.getByTestId('tool-line'))
    // Set line start point
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })
    // Move virtual cursor up-left inside selection and commit line end point
    fireEvent.pointerDown(viewport, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    })
    fireEvent.pointerMove(viewport, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 60,
      clientY: 60,
    })
    fireEvent.pointerUp(viewport, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 60,
      clientY: 60,
    })
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // Verify pixels were actually drawn onto the layer (255 = TRANSPARENT_INDEX)
    await waitFor(async () => {
      const afterLine = (await loadProjectFull(created.project.id, db))!
      const nonZero = afterLine.layers[0]!.data.some((v) => v !== 255)
      expect(nonZero).toBe(true)
    })

    // 3. Press Undo ONCE:
    // - Drawn line pixels MUST be reverted to all transparent (255)
    // - Selection MUST remain active (`selection-ready-bar` still visible!)
    fireEvent.click(screen.getByTestId('undo-btn'))

    await waitFor(async () => {
      const afterUndo = (await loadProjectFull(created.project.id, db))!
      const anyOpaque = afterUndo.layers[0]!.data.some((v) => v !== 255)
      expect(anyOpaque).toBe(false)
    })
    expect(screen.getByTestId('selection-ready-bar')).toBeTruthy()
  }, 15000)

  it('9: Copies pixels from Artwork A and pastes them onto Artwork B (cross-canvas clipboard)', async () => {
    const projA = await createNewProject(
      {
        name: 'コピー元作品A',
        width: 16,
        height: 16,
        palette: { name: 'Std', colors: ['#DC2626', '#2563EB'] },
      },
      db
    )
    const projB = await createNewProject(
      {
        name: '貼り付け先作品B',
        width: 16,
        height: 16,
        palette: { name: 'Std', colors: ['#16A34A', '#FACC15'] },
      },
      db
    )

    window.history.pushState({}, '', `/editor/${projA.project.id}`)
    render(<App />)

    await screen.findByTestId('workspace-tab-tools')
    const drawBtn = screen.getByTestId('draw-button')

    // 1. Switch back to Pen tool explicitly and draw red pixel (#DC2626 -> R=220, G=38, B=38) at center (8, 8) on Artwork A
    fireEvent.click(screen.getByTestId('tool-pen'))
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // 2. Switch to Select tool -> Magic Wand mode and select pixel (8, 8), then Copy
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(await screen.findByTestId('select-type-wand'))
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })
    expect(await screen.findByTestId('selection-ready-bar')).toBeTruthy()

    // Open Select Tool options -> click Copy (`select-copy-btn`)
    fireEvent.click(screen.getByTestId('tool-select'))
    const copyBtn = await screen.findByTestId('select-copy-btn')
    fireEvent.click(copyBtn)

    // 3. Navigate back to Gallery -> open Artwork B -> enter Editor for Artwork B
    fireEvent.click(screen.getByTestId('nav-gallery-btn'))
    const tileB = await screen.findByTestId(`gallery-tile-${projB.project.id}`)
    fireEvent.click(tileB)
    fireEvent.click(await screen.findByTestId('detail-open-editor-btn'))

    await screen.findByTestId('workspace-tab-tools')

    // 4. Open Select Tool options on Artwork B -> Paste (`select-paste-btn`) is enabled and pastes Artwork A's red pixel!
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(screen.getByTestId('tool-select'))
    const pasteBtn = (await screen.findByTestId('select-paste-btn')) as HTMLButtonElement
    expect(pasteBtn.disabled).toBe(false)
    fireEvent.click(pasteBtn)

    await waitFor(async () => {
      const loadedB = (await loadProjectFull(projB.project.id, db))!
      const pastedPx = getPixel(
        loadedB.layers[0]!.data,
        16,
        16,
        8,
        8,
        loadedB.project.palette
      )
      expect(pastedPx).toEqual({ r: 220, g: 38, b: 38, a: 255 })
    })
  }, 15000)
})
