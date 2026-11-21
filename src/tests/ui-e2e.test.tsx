import { describe, expect, it, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from '../App'
import { db } from '../db/database'

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => {
    return {
      save: () => {},
      restore: () => {},
      scale: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      arc: () => {},
      setLineDash: () => {},
      putImageData: () => {},
      drawImage: () => {},
      strokeText: () => {},
      fillText: () => {},
      measureText: (txt: string) => ({ width: txt.length * 6 }),
      imageSmoothingEnabled: false,
    } as unknown as CanvasRenderingContext2D
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext

  if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:mock-png-url'
  }
  if (!URL.revokeObjectURL) {
    URL.revokeObjectURL = () => {}
  }
})

describe('Spec v2 Full React UI Workflow Integration Tests', () => {
  it('starts on Empty Gallery, creates artwork -> Editor, toggles tool options on re-tap, uses PixelCheckbox for Shape Fill, transforms, edits Layers/Palette/UI Sizes, and switches 3 languages & themes', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // 1. Spec v2 Section 5-1: App starts on Gallery with Empty State (no auto-created empty canvas)
    const emptyCreateBtn = await screen.findByTestId('empty-create-artwork-btn')
    expect(emptyCreateBtn).toBeTruthy()
    expect(await db.projects.count()).toBe(0)

    // 2. Open New Artwork modal, pick 24x24, create -> navigates to /editor/:id
    fireEvent.click(emptyCreateBtn)
    fireEvent.change(screen.getByTestId('new-project-name-input'), {
      target: { value: 'Retro Cat' },
    })
    fireEvent.change(screen.getByTestId('new-project-width-input'), {
      target: { value: '24' },
    })
    fireEvent.change(screen.getByTestId('new-project-height-input'), {
      target: { value: '24' },
    })
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    // 3. Editor loads with localized large Draw button ('描く') & tool detail panel CLOSED initially (Spec v2 Section 6 & 7)
    const drawBtn = await screen.findByTestId('draw-button')
    expect(drawBtn.textContent).toContain('描く')
    expect(screen.queryByTestId('tool-detail-panel')).toBeNull()

    // 4. Spec v2 Section 7: Re-tapping active tool ('pen') opens detail panel; tapping again closes it!
    const penBtn = screen.getByTestId('tool-pen')
    fireEvent.click(penBtn)
    expect(await screen.findByTestId('tool-detail-panel')).toBeTruthy()
    expect(screen.getByTestId('toggle-pixel-perfect').getAttribute('aria-checked')).toBe('true')

    // Tap active pen again -> closes detail panel
    fireEvent.click(penBtn)
    await waitFor(() => {
      expect(screen.queryByTestId('tool-detail-panel')).toBeNull()
    })

    // Re-open pen options, then tap another tool ('shape') -> closes previous detail panel and selects 'shape'
    fireEvent.click(penBtn)
    expect(await screen.findByTestId('tool-detail-panel')).toBeTruthy()
    const shapeBtn = screen.getByTestId('tool-shape')
    fireEvent.click(shapeBtn)
    await waitFor(() => {
      expect(screen.queryByTestId('tool-detail-panel')).toBeNull()
    })

    // Tap 'shape' a second time -> opens Shape detail panel with single 'Fill' PixelCheckbox (Spec v2 Section 8)
    fireEvent.click(shapeBtn)
    const fillCheckbox = await screen.findByTestId('shape-filled-checkbox')
    expect(fillCheckbox.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(fillCheckbox)
    expect(fillCheckbox.getAttribute('aria-checked')).toBe('true')
    // Close shape options by tapping shape again
    fireEvent.click(shapeBtn)

    // 5. Place shape in 2 steps via Draw button -> Floating Transform Bar -> Rotate 5° & 90° -> Commit -> Undo & Redo
    fireEvent.pointerDown(drawBtn, { pointerId: 1 })
    fireEvent.pointerUp(drawBtn, { pointerId: 1 })
    fireEvent.pointerDown(drawBtn, { pointerId: 2 })
    fireEvent.pointerUp(drawBtn, { pointerId: 2 })

    const transformPanel = await screen.findByTestId('transform-panel')
    fireEvent.click(screen.getByTestId('rot-right-5'))
    expect(transformPanel.textContent).toContain('5°')
    fireEvent.click(screen.getByTestId('rot-right-90'))
    expect(transformPanel.textContent).toContain('95°')
    fireEvent.click(screen.getByTestId('commit-shape-btn'))

    const undoBtn = screen.getByTestId('undo-btn') as HTMLButtonElement
    await waitFor(() => {
      expect(undoBtn.disabled).toBe(false)
    })
    fireEvent.click(undoBtn)
    const redoBtn = screen.getByTestId('redo-btn') as HTMLButtonElement
    await waitFor(() => {
      expect(redoBtn.disabled).toBe(false)
    })
    fireEvent.click(redoBtn)

    // 6. Layers Sheet: Add layer & toggle Clipping PixelCheckbox
    fireEvent.click(screen.getByTestId('open-layers-btn'))
    fireEvent.click(await screen.findByTestId('add-layer-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('open-layers-btn').textContent).toContain('2')
    })
    const clipCheck = screen.getByTestId('toggle-clipping-btn')
    fireEvent.click(clipCheck)
    expect(clipCheck.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })

    // 7. Palette Sheet: Edit HEX directly
    fireEvent.click(screen.getByTestId('open-palette-btn'))
    fireEvent.click(await screen.findByTestId('color-tab-hex'))
    fireEvent.change(screen.getByTestId('hex-direct-input'), {
      target: { value: '#46827A' },
    })
    fireEvent.keyDown(window, { key: 'Escape' })

    // 8. Navigate back to Gallery -> open Artwork Detail -> check PNG export scales for 24x24
    fireEvent.click(screen.getByTestId('nav-gallery-btn'))
    const createdProj = (await db.projects.toArray())[0]!
    fireEvent.click(await screen.findByTestId(`gallery-detail-${createdProj.id}`))
    fireEvent.click(await screen.findByTestId('detail-export-png-btn'))
    const scaleSelect = (await screen.findByTestId(
      'export-scale-select'
    )) as HTMLSelectElement
    expect(scaleSelect.options[0].textContent).toContain('1x (24×24px)')
    expect(scaleSelect.options.length).toBe(83)
    fireEvent.keyDown(window, { key: 'Escape' })

    // 9. Navigate to Settings -> Test UI Size Presets (Spec v2 Section 12), Languages (ko / en), and Dark/Light themes
    fireEvent.click(screen.getByTestId('detail-back-btn'))
    fireEvent.click(await screen.findByTestId('gallery-settings-btn'))

    const largePresetBtn = await screen.findByTestId('ui-preset-large')
    fireEvent.click(largePresetBtn)
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--tool-icon-size')).toBe(
        '24px'
      )
      expect(document.documentElement.style.getPropertyValue('--draw-btn-vh')).toBe(
        '17dvh'
      )
    })

    fireEvent.click(screen.getByTestId('ui-size-reset-btn'))
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--tool-icon-size')).toBe(
        '20px'
      )
    })

    fireEvent.click(screen.getByTestId('lang-btn-ko'))
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('ko')
      expect(screen.getByText('환경 설정')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('lang-btn-en'))
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('en')
      expect(screen.getByText('Settings')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('theme-btn-dark'))
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
    fireEvent.click(screen.getByTestId('theme-btn-light'))
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })
  })
})
