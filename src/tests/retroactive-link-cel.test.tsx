import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { App } from '../App'
import { resetAllAppData, db, loadProjectFull } from '../db/database'
import { getPixel } from '../engine/pixelBuffer'
import { projectFrameLayers } from '../engine/animation'

afterEach(async () => {
  cleanup()
  await resetAllAppData(db)
})

describe('Retroactive Link-Cel Creation, Overwrite Confirmation, Source Switching & Undo/Redo E2E', () => {
  it('converts an existing independent cel into a linked cel with preview + overwrite confirmation, propagates edits, switches link source, unlinks, and restores pixels + references via Undo/Redo', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // 1. Create a 16x16 artwork
    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.change(screen.getByTestId('new-project-name-input'), {
      target: { value: 'Retro Link Test' },
    })
    fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    // Frame 1: draw color #1 at center cursor (8, 8)
    const drawBtn = await screen.findByTestId('draw-button')
    fireEvent.click(screen.getByTestId('quick-color-1'))
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })

    // Add Frame 2 (independent duplicate) and Frame 3 (independent duplicate)
    fireEvent.click(screen.getByTestId('workspace-tab-layers'))
    fireEvent.click(await screen.findByTestId('add-first-frame-btn'))
    await screen.findByTestId('timeline-workspace-panel')

    // On Frame 2: paint a DIFFERENT color (#2) at center (8, 8) so Frame 2 has distinct pixel data!
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('quick-color-2'))
    const drawBtn2 = await screen.findByTestId('draw-button')
    fireEvent.pointerDown(drawBtn2, { pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn2, { pointerId: 2, pointerType: 'touch' })

    // Duplicate Frame 2 as independent Frame 3, and paint color #3 on Frame 3
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    fireEvent.click(screen.getByTestId('timeline-dup-frame-btn'))
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('quick-color-3'))
    const drawBtn3 = await screen.findByTestId('draw-button')
    fireEvent.pointerDown(drawBtn3, { pointerId: 3, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn3, { pointerId: 3, pointerType: 'touch' })

    // Switch back to Timeline and select Frame 2 (Independent Cel B)
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    fireEvent.click(screen.getByTestId('timeline-frame-header-1'))
    expect(screen.getByTestId('timeline-cel-menu-btn').textContent).toContain('独立セル')

    // 2. Open Cel menu -> click `リンクセルに変更` (`open-link-cel-modal-btn`)
    fireEvent.click(screen.getByTestId('timeline-cel-menu-btn'))
    const openLinkModalBtn = await screen.findByTestId('open-link-cel-modal-btn')
    expect(openLinkModalBtn.textContent).toContain('リンクセルに変更')
    fireEvent.click(openLinkModalBtn)

    // 3. LinkCelModal opens with Frame 1 (#1) and Frame 3 (#3) as candidates (Frame 2 self is excluded!)
    expect(await screen.findByTestId('link-cel-modal')).toBeTruthy()
    expect(screen.getByTestId('link-cel-preview-section')).toBeTruthy()
    expect(screen.getByTestId('link-cel-overwrite-notice')).toBeTruthy()

    // Click apply -> because Frame 2 has distinct pixel data, explicit Overwrite Confirmation must appear!
    fireEvent.click(screen.getByTestId('apply-link-cel-btn'))
    const confirmBox = await screen.findByTestId('link-cel-overwrite-confirm-box')
    expect(confirmBox.textContent).toContain(
      'リンクセルに変更すると、このセル独自の画像データは参照元の画像データに置き換わります'
    )

    // Cancel confirmation -> modal stays open and Frame 2 remains Independent!
    fireEvent.click(screen.getByTestId('cancel-link-overwrite-btn'))
    expect(screen.queryByTestId('link-cel-overwrite-confirm-box')).toBeNull()

    // Click apply again and confirm overwrite -> Frame 2 becomes Linked to Frame 1!
    fireEvent.click(screen.getByTestId('apply-link-cel-btn'))
    fireEvent.click(await screen.findByTestId('confirm-link-overwrite-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('link-cel-modal')).toBeNull()
      expect(screen.getByTestId('timeline-cel-menu-btn').textContent).toContain('リンクセル')
    })

    // Verify shared sibling highlight in timeline (`data-shared-with-active="true"` on Frame 1)
    const projects = await db.projects.toArray()
    const projId = projects[0]!.id
    const loadedLinked = (await loadProjectFull(projId, db))!
    const layerId = loadedLinked.layers[0]!.id
    expect(
      screen.getByTestId(`cel-${layerId}-0`).getAttribute('data-shared-with-active')
    ).toBe('true')

    // 4. Edit linked source Frame 1 (paint color #4 at cursor) -> verify Frame 2 reflects the exact edit!
    fireEvent.click(screen.getByTestId('timeline-frame-header-0'))
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('quick-color-4'))
    const drawBtnEditSrc = await screen.findByTestId('draw-button')
    fireEvent.pointerDown(drawBtnEditSrc, { pointerId: 4, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtnEditSrc, { pointerId: 4, pointerType: 'touch' })

    // Undo the paint stroke, then Undo the Link operation -> Frame 2 restores Independent status AND its original color #2!
    fireEvent.click(screen.getByTestId('undo-btn'))
    fireEvent.click(screen.getByTestId('undo-btn'))

    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    fireEvent.click(screen.getByTestId('timeline-frame-header-1'))
    expect(screen.getByTestId('timeline-cel-menu-btn').textContent).toContain('独立セル')

    // Verify Redo re-applies the Link cleanly!
    fireEvent.click(screen.getByTestId('workspace-tab-tools'))
    fireEvent.click(screen.getByTestId('redo-btn'))
    fireEvent.click(screen.getByTestId('workspace-tab-timeline'))
    expect(screen.getByTestId('timeline-cel-menu-btn').textContent).toContain('リンクセル')

    // 5. Switch existing Linked Cel (Frame 2) to reference Frame 3 (`参照先を変更`)!
    fireEvent.click(screen.getByTestId('timeline-cel-menu-btn'))
    expect(screen.getByTestId('active-cel-shared-frames').textContent).toContain('#1, #2')
    const changeTargetBtn = screen.getByTestId('open-link-cel-modal-btn')
    expect(changeTargetBtn.textContent).toContain('参照先を変更')
    fireEvent.click(changeTargetBtn)

    // Frame 3 (`index 2`) is auto-selected as the switchable candidate; apply & confirm overwrite
    expect(await screen.findByTestId('link-cel-modal')).toBeTruthy()
    fireEvent.click(screen.getByTestId(`link-source-candidate-${layerId}-2`))
    fireEvent.click(screen.getByTestId('apply-link-cel-btn'))
    fireEvent.click(await screen.findByTestId('confirm-link-overwrite-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('link-cel-modal')).toBeNull()
    })

    // Frame 1 is now Independent again (`●`), while Frame 2 & Frame 3 share the link (`#2, #3`)!
    expect(screen.getByTestId(`cel-${layerId}-0`).getAttribute('data-cel-kind')).toBe(
      'independent'
    )
    expect(screen.getByTestId(`cel-${layerId}-1`).getAttribute('data-cel-kind')).toBe(
      'linked'
    )
    expect(screen.getByTestId(`cel-${layerId}-2`).getAttribute('data-cel-kind')).toBe(
      'linked'
    )

    // Verify pixel data of Frame 2 matches Frame 3 in persisted state after unmount flush
    cleanup()
    const finalLoaded = (await loadProjectFull(projId, db))!
    const f2Layers = projectFrameLayers(
      finalLoaded.layers,
      finalLoaded.timeline.cels,
      finalLoaded.timeline.celBuffers,
      finalLoaded.timeline.frames[1]!.id,
      16,
      16
    )
    const f3Layers = projectFrameLayers(
      finalLoaded.layers,
      finalLoaded.timeline.cels,
      finalLoaded.timeline.celBuffers,
      finalLoaded.timeline.frames[2]!.id,
      16,
      16
    )
    expect(getPixel(f2Layers[0]!.data, 16, 16, 8, 8)).toEqual(
      getPixel(f3Layers[0]!.data, 16, 16, 8, 8)
    )
  }, 15000)
})
