import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { App } from '../App'
import { resetAllAppData, db } from '../db/database'

afterEach(async () => {
  cleanup()
  await resetAllAppData(db)
})

describe('Step 5 Timeline, Linked/Empty/Independent Cels, PC vs Touch Modality & GIF Export E2E', () => {
  it('switches Workspace Tab (`ツール` <-> `レイヤー` [1f] -> `タイムライン` [>=2f]), syncs Linked Cels + 1-step Undo, hides Draw button on PC mouse, and opens GIF export + single-project size in Viewer', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // 1. Create a 16x16 artwork
    const createBtn = await screen.findByTestId('empty-create-artwork-btn')
    fireEvent.click(createBtn)
    fireEvent.change(screen.getByTestId('new-project-name-input'), {
      target: { value: 'Slime Walk' },
    })
    fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    // 2. Verify initial 1-frame workspace tab shows `ツール` and `レイヤー (1)`
    const toolsTab = await screen.findByTestId('workspace-tab-tools')
    const layersTab = screen.getByTestId('workspace-tab-layers')
    expect(toolsTab.textContent).toContain('ツール')
    expect(layersTab.textContent).toContain('レイヤー')

    // Draw a pixel on Frame 1 via Draw button (touch modality)
    const drawBtn = screen.getByTestId('draw-button')
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // 3. Switch to `レイヤー` workspace tab -> convert 1-frame still into 2-frame animation!
    fireEvent.click(layersTab)
    expect(await screen.findByTestId('inline-layers-workspace')).toBeTruthy()
    fireEvent.click(screen.getByTestId('convert-to-animation-dup-btn'))

    // Tab automatically upgrades from `レイヤー` to `タイムライン (2)`!
    const timelineTab = await screen.findByTestId('workspace-tab-timeline')
    expect(timelineTab.textContent).toContain('タイムライン (2)')
    expect(screen.getByTestId('timeline-workspace-panel')).toBeTruthy()

    // 4. Add a 3rd Linked frame (`timeline-dup-linked-frame-btn`) and verify cel badge shows `リンクセル`
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
    await waitFor(() => {
      expect(screen.getByTestId('active-cel-kind-badge').textContent).toContain('独立セル')
    })
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('undo-btn'))
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    await waitFor(() => {
      expect(screen.getByTestId('active-cel-kind-badge').textContent).toContain('空セル')
    })

    // Link Frame 3 to Frame 2 -> both share a Linked Cel; drawing once updates shared buffer & 1-step Undo reverts both!
    fireEvent.click(screen.getByTestId('timeline-frame-header-1')) // Select Frame 2
    fireEvent.click(screen.getByTestId('timeline-dup-linked-frame-btn')) // Insert Linked Frame 3 sharing Frame 2's celId
    await waitFor(() => {
      expect(screen.getByTestId('active-cel-kind-badge').textContent).toContain('リンクセル')
    })
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('quick-color-3'))
    const drawBtnLinked = await screen.findByTestId('draw-button')
    fireEvent.pointerDown(drawBtnLinked, { pointerId: 3, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtnLinked, { pointerId: 3, pointerType: 'touch' })
    // Single Undo reverts the shared Linked Cel across all linked frames
    fireEvent.click(screen.getByTestId('undo-btn'))
    fireEvent.click(screen.getByTestId('redo-btn'))
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    // Delete the extra test frame so frame count returns to 3
    fireEvent.click(screen.getByTestId('timeline-del-frame-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('workspace-tab-timeline').textContent).toContain('3')
    })

    // Batch duration update across all frames to 150ms
    fireEvent.click(screen.getByTestId('open-batch-ms-btn'))
    const batchInput = await screen.findByTestId('batch-ms-input')
    fireEvent.change(batchInput, { target: { value: '150' } })
    fireEvent.click(screen.getByTestId('batch-apply-all-btn'))
    await waitFor(() => {
      expect(
        (screen.getByTestId('active-frame-ms-input') as HTMLInputElement).value
      ).toBe('150')
    })

    // Toggle Onion Skin popover
    fireEvent.click(screen.getByTestId('timeline-onion-btn'))
    expect(await screen.findByTestId('onion-skin-popover')).toBeTruthy()

    // Open GIF Export Modal from Timeline
    fireEvent.click(screen.getByTestId('timeline-export-gif-btn'))
    expect(await screen.findByTestId('export-gif-modal')).toBeTruthy()
    expect(screen.getByTestId('export-gif-output-size').textContent).toContain('2000')
    fireEvent.click(screen.getByLabelText('閉じる'))

    // 5. Switch back to `ツール` tab and verify PC mouse pointer hides Draw button, touch pointer restores it
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

    // Touch pointer brings Draw button back immediately
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

    // 6. Navigate to Project Viewing Screen (`/project/:id`) and verify Frame Count + Single-Project Estimated Size + GIF Export button
    fireEvent.click(screen.getByTestId('editor-menu-btn'))
    fireEvent.click(await screen.findByTestId('editor-view-detail-btn'))

    const frameCountEl = await screen.findByTestId('detail-frame-count')
    expect(frameCountEl.textContent).toBe('3')
    const sizeEl = screen.getByTestId('detail-project-size')
    expect(sizeEl.textContent).toMatch(/B|KB|MB/)
    expect(screen.getByTestId('detail-export-gif-btn')).toBeTruthy()
  })
})
