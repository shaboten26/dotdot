import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { App } from '../App'
import { resetAllAppData, db } from '../db/database'

afterEach(async () => {
  cleanup()
  await resetAllAppData(db)
})

describe('Streamlined Timeline, Layer Workspace Separation, GIF Visibility & Viewer Swipe E2E', () => {
  it('reuses original Layer UI in 1-frame mode (no GIF button, no duplicate tool-tab layer button), streamlines >=2f Timeline with Settings/Cel popovers, and supports horizontal swipe in Viewer', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // 1. Create a 16x16 artwork ("Slime Walk")
    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.change(screen.getByTestId('new-project-name-input'), {
      target: { value: 'Slime Walk' },
    })
    fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    // 2. Tool tab has NO duplicate layer button; 1-frame workspace tab shows `レイヤー (1)`
    const toolsTab = await screen.findByTestId('workspace-tab-tools')
    const layersTab = screen.getByTestId('workspace-tab-layers')
    expect(toolsTab.textContent).toContain('ツール')
    expect(layersTab.textContent).toContain('レイヤー')
    expect(screen.queryByTestId('open-layers-btn')).toBeNull()

    // 1-frame still artwork MUST NOT show GIF export in header menu
    fireEvent.click(screen.getByTestId('editor-menu-btn'))
    expect(await screen.findByTestId('editor-export-png-btn')).toBeTruthy()
    expect(screen.queryByTestId('editor-export-gif-btn')).toBeNull()
    fireEvent.click(screen.getByTestId('editor-menu-btn'))

    // Draw a pixel on Frame 1 via Draw button (touch modality)
    const drawBtn = screen.getByTestId('draw-button')
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // 3. Switch to `レイヤー` tab -> verify original LayerPanelContent (`add-layer-btn`) + `+ フレーム追加` (`add-first-frame-btn`)
    fireEvent.click(layersTab)
    expect(await screen.findByTestId('inline-layers-workspace')).toBeTruthy()
    expect(screen.getByTestId('add-layer-btn')).toBeTruthy()
    fireEvent.click(screen.getByTestId('add-first-frame-btn'))

    // Tab automatically upgrades from `レイヤー` to `タイムライン (2)`!
    const timelineTab = await screen.findByTestId('workspace-tab-timeline')
    expect(timelineTab.textContent).toContain('タイムライン (2)')
    expect(screen.getByTestId('timeline-workspace-panel')).toBeTruthy()
    // Timeline MUST NOT have a GIF export button inside its area
    expect(screen.queryByTestId('timeline-export-gif-btn')).toBeNull()

    // 4. Open Cel Actions menu (`timeline-cel-menu-btn`), add Linked duplicate frame, unlink, clear, and verify 1-step Undo!
    fireEvent.click(screen.getByTestId('timeline-cel-menu-btn'))
    expect(await screen.findByTestId('cel-actions-popover')).toBeTruthy()
    fireEvent.click(screen.getByTestId('timeline-dup-linked-frame-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('workspace-tab-timeline').textContent).toContain('3')
    })
    expect(screen.getByTestId('active-cel-kind-badge').textContent).toContain('リンクセル')

    // Unlink Frame 3 -> badge transitions to `独立セル`
    fireEvent.click(screen.getByTestId('cel-unlink-active-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('active-cel-kind-badge').textContent).toContain('独立セル')
    })

    // Clear Frame 3 to Empty -> badge transitions to `空セル`
    fireEvent.click(screen.getByTestId('cel-clear-active-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('active-cel-kind-badge').textContent).toContain('空セル')
    })

    // Drawing onto Empty Cel auto-allocates an Independent Cel, and 1-step Undo restores Empty Cel!
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    const drawBtnForEmpty = await screen.findByTestId('draw-button')
    fireEvent.pointerDown(drawBtnForEmpty, { pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtnForEmpty, { pointerId: 2, pointerType: 'touch' })
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    expect(screen.getByTestId('timeline-cel-menu-btn').textContent).toContain('独立セル')
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('undo-btn'))
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    expect(screen.getByTestId('timeline-cel-menu-btn').textContent).toContain('空セル')

    // 5. Open scrollable Animation Settings Modal (`timeline-settings-btn`) -> test grouped sections, scroll body, batch ms, direction, Onion Skin, bottom-most section, and Close button!
    fireEvent.click(screen.getByTestId('timeline-settings-btn'))
    const animModal = await screen.findByTestId('timeline-settings-popover')
    expect(animModal.getAttribute('role')).toBe('dialog')
    const scrollBody = screen.getByTestId('animation-settings-scroll-body')
    expect(scrollBody.className).toContain('overflow-y-auto')
    expect(scrollBody.className).toContain('overscroll-contain')
    expect(screen.getByTestId('anim-settings-link-timeline-group')).toBeTruthy()
    const batchInput = screen.getByTestId('batch-ms-input')
    fireEvent.change(batchInput, { target: { value: '150' } })
    fireEvent.click(screen.getByTestId('batch-apply-all-btn'))
    await waitFor(() => {
      expect(
        (screen.getByTestId('active-frame-ms-input') as HTMLInputElement).value
      ).toBe('150')
    })
    fireEvent.click(screen.getByTestId('onion-enabled-checkbox'))
    fireEvent.click(screen.getByTestId('timeline-dir-pingpong-btn'))
    fireEvent.click(screen.getByTestId('close-animation-settings-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('timeline-settings-popover')).toBeNull()
    })

    // 6. Switch back to `ツール` tab -> verify PC mouse pointer hides Draw button, touch restores it
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    const viewport = document.querySelector('canvas')!.parentElement!
    fireEvent.pointerDown(viewport, {
      pointerId: 10,
      pointerType: 'mouse',
      button: 0,
      clientX: 40,
      clientY: 40,
    })
    fireEvent.pointerUp(viewport, {
      pointerId: 10,
      pointerType: 'mouse',
      button: 0,
      clientX: 40,
      clientY: 40,
    })
    await waitFor(() => {
      expect(screen.queryByTestId('draw-button')).toBeNull()
    })

    fireEvent.pointerDown(viewport, {
      pointerId: 11,
      pointerType: 'touch',
      clientX: 50,
      clientY: 50,
    })
    fireEvent.pointerUp(viewport, {
      pointerId: 11,
      pointerType: 'touch',
      clientX: 50,
      clientY: 50,
    })
    expect(await screen.findByTestId('draw-button')).toBeTruthy()

    // 7. Create a 2nd 1-frame still artwork ("Still Tree") so we can test both GIF visibility AND horizontal swipe in Viewer!
    fireEvent.click(screen.getByTestId('nav-gallery-btn'))
    fireEvent.click(await screen.findByTestId('new-artwork-btn'))
    fireEvent.change(screen.getByTestId('new-project-name-input'), {
      target: { value: 'Still Tree' },
    })
    fireEvent.click(screen.getByTestId('builtin-preset-32x32'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))
    await screen.findByTestId('workspace-tab-tools')
    fireEvent.click(screen.getByTestId('nav-gallery-btn'))

    // Default gallery sort (`updated` / newest first) places [0] "Still Tree" (1f still) -> [1] "Slime Walk" (3f animation)
    const allProjs = await db.projects.toArray()
    const stillProj = allProjs.find((p) => p.name === 'Still Tree')!
    fireEvent.click(await screen.findByTestId(`gallery-tile-${stillProj.id}`))

    // [0] Still Tree has only 1 frame -> GIF export button MUST NOT be shown!
    expect((await screen.findByTestId('detail-frame-count')).textContent).toBe('1')
    expect(screen.queryByTestId('detail-export-gif-btn')).toBeNull()

    // Vertical scroll gesture on Viewer MUST NOT switch artworks
    const swipeSurface = screen.getByTestId('project-detail-swipe-surface')
    fireEvent.pointerDown(swipeSurface, {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 180,
      clientY: 300,
    })
    fireEvent.pointerMove(swipeSurface, {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 175,
      clientY: 120,
    })
    fireEvent.pointerUp(swipeSurface, {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 175,
      clientY: 120,
    })
    expect(screen.getByTestId('detail-header-title').textContent).toBe('Still Tree')

    // Right swipe at first artwork ([0]) MUST NOT move past the beginning
    fireEvent.pointerDown(swipeSurface, {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 90,
      clientY: 220,
    })
    fireEvent.pointerMove(swipeSurface, {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 230,
      clientY: 222,
    })
    fireEvent.pointerUp(swipeSurface, {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 230,
      clientY: 222,
    })
    expect(screen.getByTestId('detail-header-title').textContent).toBe('Still Tree')

    // Left swipe on Viewer switches to NEXT artwork ([1] "Slime Walk")!
    fireEvent.pointerDown(swipeSurface, {
      pointerId: 23,
      pointerType: 'touch',
      clientX: 240,
      clientY: 220,
    })
    fireEvent.pointerMove(swipeSurface, {
      pointerId: 23,
      pointerType: 'touch',
      clientX: 100,
      clientY: 224,
    })
    fireEvent.pointerUp(swipeSurface, {
      pointerId: 23,
      pointerType: 'touch',
      clientX: 100,
      clientY: 224,
    })

    await waitFor(() => {
      expect(screen.getByTestId('detail-header-title').textContent).toBe('Slime Walk')
    })
    // Slime Walk has 3 frames -> GIF export button IS visible, and default scale for 16x16 is 125x (2000x2000px <= 2000px)
    expect(screen.getByTestId('detail-frame-count').textContent).toBe('3')
    const gifBtn = screen.getByTestId('detail-export-gif-btn')
    fireEvent.click(gifBtn)
    expect(await screen.findByTestId('export-gif-modal')).toBeTruthy()
    expect(screen.getByTestId('export-gif-output-size').textContent).toContain('2000')
    fireEvent.click(screen.getByLabelText('閉じる'))

    // Left swipe at last artwork ([1]) MUST NOT move past the end
    const swipeSurfaceAtEnd = screen.getByTestId('project-detail-swipe-surface')
    fireEvent.pointerDown(swipeSurfaceAtEnd, {
      pointerId: 24,
      pointerType: 'touch',
      clientX: 240,
      clientY: 220,
    })
    fireEvent.pointerMove(swipeSurfaceAtEnd, {
      pointerId: 24,
      pointerType: 'touch',
      clientX: 100,
      clientY: 222,
    })
    fireEvent.pointerUp(swipeSurfaceAtEnd, {
      pointerId: 24,
      pointerType: 'touch',
      clientX: 100,
      clientY: 222,
    })
    expect(screen.getByTestId('detail-header-title').textContent).toBe('Slime Walk')

    // Right swipe on Viewer switches back to PREVIOUS artwork ([0] "Still Tree")!
    fireEvent.pointerDown(swipeSurfaceAtEnd, {
      pointerId: 25,
      pointerType: 'touch',
      clientX: 90,
      clientY: 220,
    })
    fireEvent.pointerMove(swipeSurfaceAtEnd, {
      pointerId: 25,
      pointerType: 'touch',
      clientX: 230,
      clientY: 222,
    })
    fireEvent.pointerUp(swipeSurfaceAtEnd, {
      pointerId: 25,
      pointerType: 'touch',
      clientX: 230,
      clientY: 222,
    })

    await waitFor(() => {
      expect(screen.getByTestId('detail-header-title').textContent).toBe('Still Tree')
    })
    expect(screen.queryByTestId('detail-export-gif-btn')).toBeNull()

    // 8. Open "Still Tree" in Editor and verify SelectionReadyBar -> Compact ActiveMoveBar 1px directional buttons + Marching Ants overlay purity!
    fireEvent.click(screen.getByTestId('detail-open-editor-btn'))
    const stillDrawBtn = await screen.findByTestId('draw-button')

    // Paint 1 pixel at center (16, 16) with color #1
    fireEvent.click(screen.getByTestId('quick-color-1'))
    fireEvent.pointerDown(stillDrawBtn, { pointerId: 30, pointerType: 'touch' })
    fireEvent.pointerUp(stillDrawBtn, { pointerId: 30, pointerType: 'touch' })

    // Select 1x1 rect at (16, 16) (Step 1 start + Step 2 end) -> `selection-ready-bar` appears BEFORE move starts
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.pointerDown(stillDrawBtn, { pointerId: 31, pointerType: 'touch' })
    fireEvent.pointerUp(stillDrawBtn, { pointerId: 31, pointerType: 'touch' })
    fireEvent.pointerDown(stillDrawBtn, { pointerId: 32, pointerType: 'touch' })
    fireEvent.pointerUp(stillDrawBtn, { pointerId: 32, pointerType: 'touch' })

    expect(await screen.findByTestId('selection-ready-bar')).toBeTruthy()
    fireEvent.click(screen.getByTestId('quick-start-selection-move-btn'))

    // Now in Move mode -> `selection-ready-bar` switches to compact `active-move-bar` with 1px directional buttons!
    expect(screen.queryByTestId('selection-ready-bar')).toBeNull()
    expect(await screen.findByTestId('active-move-bar')).toBeTruthy()
    expect(screen.getByTestId('active-move-offset-badge').textContent).toContain('+0,+0px')

    fireEvent.click(screen.getByTestId('move-step-right'))
    fireEvent.click(screen.getByTestId('move-step-right'))
    fireEvent.click(screen.getByTestId('move-step-down'))
    expect(screen.getByTestId('active-move-offset-badge').textContent).toContain('+2,+1px')

    fireEvent.click(screen.getByTestId('move-step-left'))
    fireEvent.click(screen.getByTestId('move-step-up'))
    expect(screen.getByTestId('active-move-offset-badge').textContent).toContain('+1,+0px')

    // Cancel restores original state without modifying pixel data
    fireEvent.click(screen.getByTestId('cancel-move-btn'))
    expect(await screen.findByTestId('selection-ready-bar')).toBeTruthy()

    // Start move again, move (+1, +1), and commit -> verify pixel moved cleanly and marching ants NEVER baked into cel buffer!
    fireEvent.click(screen.getByTestId('quick-start-selection-move-btn'))
    fireEvent.click(await screen.findByTestId('move-step-right'))
    fireEvent.click(screen.getByTestId('move-step-down'))
    fireEvent.click(screen.getByTestId('commit-move-btn'))

    // Clear selection -> selection-ready-bar disappears cleanly
    fireEvent.click(await screen.findByTestId('quick-clear-selection-btn'))
    expect(screen.queryByTestId('selection-ready-bar')).toBeNull()

    // 9. Global Workspace/Input Settings (`設定`) in Tool Tab's vacated 10th slot:
    // - No extra workspace tab was added (only `ツール` and `レイヤー`/`タイムライン` exist)
    expect(screen.queryByTestId('workspace-tab-settings')).toBeNull()
    const globalSettingsBtn = screen.getByTestId('open-global-editor-settings-btn')
    expect(globalSettingsBtn.textContent).toContain('設定')
    fireEvent.click(globalSettingsBtn)

    const globalModal = await screen.findByTestId('global-editor-settings-modal')
    expect(globalModal).toBeTruthy()
    // Ensure animation settings & tool-specific settings are NOT mixed into Global Settings
    expect(globalModal.textContent).not.toContain('オニオンスキン')
    expect(globalModal.textContent).not.toContain('ピクセルパーフェクト')

    // Change Cursor Speed via preset (`高速 1.8x`) and Cursor Size (`大`)
    fireEvent.click(screen.getByTestId('cursor-speed-preset-1.8'))
    await waitFor(() => {
      expect(screen.getByTestId('cursor-speed-value').textContent).toContain('1.80x')
    })
    fireEvent.click(screen.getByTestId('cursor-size-large'))

    // Create a Custom Cursor (8x8) with custom Hotspot (3, 4) and save & apply
    fireEvent.click(screen.getByTestId('new-custom-cursor-btn'))
    expect(await screen.findByTestId('custom-cursor-editor')).toBeTruthy()
    fireEvent.click(screen.getByTestId('custom-cursor-grid-8'))
    const cursorNameInput = screen.getByTestId('custom-cursor-name-input') as HTMLInputElement
    fireEvent.change(cursorNameInput, { target: { value: 'ドット十字' } })
    fireEvent.pointerDown(screen.getByTestId('cursor-cell-3-4'))
    fireEvent.pointerUp(screen.getByTestId('cursor-cell-3-4'))
    fireEvent.click(screen.getByTestId('custom-cursor-tool-hotspot'))
    fireEvent.pointerDown(screen.getByTestId('cursor-cell-3-4'))
    fireEvent.pointerUp(screen.getByTestId('cursor-cell-3-4'))
    fireEvent.click(screen.getByTestId('save-custom-cursor-btn'))

    await waitFor(() => {
      expect(globalModal.textContent).toContain('ドット十字')
      expect(globalModal.textContent).toContain('8×8 · Hotspot (3,4)')
    })

    // Toggle shared Double-Tap Eyedropper setting OFF in Global Settings, close, and verify Eyedropper tool detail reflects the exact same state!
    const globalDoubleTap = screen.getByTestId('global-toggle-eyedropper-doubletap')
    expect(globalDoubleTap.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(globalDoubleTap)
    await waitFor(() => {
      expect(globalDoubleTap.getAttribute('aria-checked')).toBe('false')
    })

    fireEvent.click(screen.getByTestId('close-global-editor-settings-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('global-editor-settings-modal')).toBeNull()
    })

    // Open Eyedropper tool options -> same `eyedropperDoubleTap` state is `false`!
    fireEvent.click(screen.getByTestId('tool-eyedropper'))
    fireEvent.click(screen.getByTestId('tool-eyedropper'))
    const toolDoubleTap = await screen.findByTestId('toggle-eyedropper-doubletap')
    expect(toolDoubleTap.getAttribute('aria-checked')).toBe('false')
    // Restore back to true via tool detail and verify bidirectional sync
    fireEvent.click(toolDoubleTap)
    await waitFor(() => {
      expect(toolDoubleTap.getAttribute('aria-checked')).toBe('true')
    })
  }, 15000)
})
