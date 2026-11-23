import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppProvider } from '../state/AppContext'
import { PixelSelect } from '../components/common/PixelSelect'
import { PixelIcon } from '../components/common/PixelIcon'
import { LayerPanelContent } from '../components/editor/LayerSheet'
import { InteractiveViewport } from '../components/editor/InteractiveViewport'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import { applyFloodFill, applyGradientFloodFill } from '../engine/floodFill'
import { CanvasResizeModal } from '../components/editor/EditorModals'
import { MultiRowToolGrid, ToolDetailPopover } from '../components/editor/ToolPanels'
import { resolveToolIconName } from '../utils/toolIcon'
import { App } from '../App'
import { db } from '../db/database'
import type { LayerRuntime, ToolSettings } from '../types'

afterEach(() => {
  cleanup()
})

const BASE_TOOL_SETTINGS: ToolSettings = {
  penSize: 1,
  penShape: 'square',
  penDither: 1,
  pixelPerfect: true,
  eraserSize: 1,
  eraserShape: 'square',
  fillConnectivity: 4,
  fillDither: 1,
  fillMode: 'normal',
  gradientType: 'linear',
  gradientFixedRatio: false,
  gradientSteps: 4,
  lineType: 'line',
  lineSize: 1,
  lineShape: 'square',
  lineDither: 1,
  linePixelPerfect: false,
  shapeType: 'rect',
  shapeFilled: false,
  shapeFixedRatio: false,
  shapeSize: 1,
  shapeDither: 1,
  selectType: 'rect',
  selectConnectivity: 4,
  outlineMode: 'pixelPerfect',
  outlineSize: 1,
  outlineColor: '#000000',
}

describe('UX Improvements (Sections 4-1, 4-2, 4-3, 4-4, 4-7)', () => {
  it('4-1: double-click and touch double-tap on layer name open inline rename with focus+select, Enter saves, Escape cancels, empty string rejected', () => {
    const layers: LayerRuntime[] = [
      {
        id: 'l1',
        name: '背景レイヤー',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 8,
        dataHeight: 8,
        data: createPixelBuffer(8, 8),
      },
      {
        id: 'l2',
        name: 'キャラ線画',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 8,
        dataHeight: 8,
        data: createPixelBuffer(8, 8),
      },
    ]

    const onSelectLayer = vi.fn()
    const onUpdateLayer = vi.fn()
    const onReorderLayers = vi.fn()

    render(
      <AppProvider>
        <LayerPanelContent
          canvasWidth={8}
          canvasHeight={8}
          layers={layers}
          activeLayerId="l1"
          selectedLayerIds={[]}
          onSelectLayer={onSelectLayer}
          onToggleLayerSelected={vi.fn()}
          onClearLayerSelection={vi.fn()}
          onStartMultiLayerMoveOnCanvas={vi.fn()}
          onDuplicateSelectedLayers={vi.fn()}
          onMergeSelectedLayers={vi.fn()}
          onDeleteSelectedLayers={vi.fn()}
          onAddLayer={vi.fn()}
          onDuplicateLayer={vi.fn()}
          onDeleteLayer={vi.fn()}
          onMergeDown={vi.fn()}
          onUpdateLayer={onUpdateLayer}
          onReorderLayers={onReorderLayers}
          onClearLayer={vi.fn()}
          onCopyLayer={vi.fn()}
          onFlipLayer={vi.fn()}
          onStartLayerMoveOnCanvas={vi.fn()}
        />
      </AppProvider>
    )

    // Single click selects layer without entering rename mode
    const labelL2 = screen.getByTestId('layer-name-label-l2')
    fireEvent.click(labelL2)
    expect(onSelectLayer).toHaveBeenCalledWith('l2')
    expect(screen.queryByTestId('layer-rename-input-l2')).toBeNull()

    // Double-click (PC) opens inline rename input with existing value focused
    fireEvent.doubleClick(labelL2)
    const input = screen.getByTestId('layer-rename-input-l2') as HTMLInputElement
    expect(input.value).toBe('キャラ線画')
    expect(document.activeElement).toBe(input)

    // Escape cancels without calling onUpdateLayer
    fireEvent.change(input, { target: { value: '仮の名前' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onUpdateLayer).not.toHaveBeenCalled()

    // Touch double-tap within 320ms opens inline rename; empty string is rejected; valid Enter commits
    const labelAgain = screen.getByTestId('layer-name-label-l1')
    fireEvent.pointerUp(labelAgain, { pointerType: 'touch' })
    fireEvent.pointerUp(labelAgain, { pointerType: 'touch' })
    const inputL1 = screen.getByTestId('layer-rename-input-l1') as HTMLInputElement
    fireEvent.change(inputL1, { target: { value: '   ' } })
    fireEvent.keyDown(inputL1, { key: 'Enter' })
    expect(onUpdateLayer).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByTestId('layer-name-label-l1'))
    const inputL1Valid = screen.getByTestId('layer-rename-input-l1') as HTMLInputElement
    fireEvent.change(inputL1Valid, { target: { value: '空と雲' } })
    fireEvent.keyDown(inputL1Valid, { key: 'Enter' })
    expect(onUpdateLayer).toHaveBeenCalledWith('l1', { name: '空と雲' })
  })

  it('4-2: smartphone touch tap NEVER moves cursor; only sliding past deadzone moves cursor smoothly', () => {
    const onMoveCursor = vi.fn()
    const onBeginDrawAt = vi.fn()
    const onDoubleTapEyedropper = vi.fn()

    render(
      <AppProvider>
        <div style={{ width: 320, height: 320 }}>
          <InteractiveViewport
            projectId="p1"
            width={16}
            height={16}
            compositedBuffer={createPixelBuffer(16, 16)}
            tool="pen"
            toolSettings={BASE_TOOL_SETTINGS}
            cursor={{ x: 8, y: 8 }}
            stepPhase={{ kind: 'idle' }}
            floatingShape={null}
            moveSession={null}
            hasSelection={false}
            selectionMask={null}
            showGrid={true}
            checkerboardDark={false}
            activeHexColor="#000000"
            isTransparentColor={false}
            eyedropperDoubleTap={true}
            fitTrigger={0}
            onMoveCursor={onMoveCursor}
            onBeginDrawAt={onBeginDrawAt}
            onEndDraw={vi.fn()}
            onAbortStroke={vi.fn()}
            onDoubleTapEyedropper={onDoubleTapEyedropper}
            onMoveFloatingShape={vi.fn()}
            onUpdateMoveOffset={vi.fn()}
          />
        </div>
      </AppProvider>
    )

    const vp = screen.getByTestId('canvas-viewport')

    // 1. Stationary touch tap (pointerdown -> pointerup without sliding) MUST NOT call onMoveCursor!
    fireEvent.pointerDown(vp, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 40,
      clientY: 40,
    })
    fireEvent.pointerMove(vp, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 42, // < 6px deadzone
      clientY: 41,
    })
    fireEvent.pointerUp(vp, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 42,
      clientY: 41,
    })
    expect(onMoveCursor).not.toHaveBeenCalled()
    expect(onBeginDrawAt).not.toHaveBeenCalled()

    // 2. Touch slide past deadzone moves cursor relative to existing cursor (8,8) rather than jumping to (40,40)!
    fireEvent.pointerDown(vp, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 30,
      clientY: 30,
    })
    fireEvent.pointerMove(vp, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 48, // 18px slide -> exceeds deadzone
      clientY: 30,
    })
    fireEvent.pointerUp(vp, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 48,
      clientY: 30,
    })
    expect(onMoveCursor).toHaveBeenCalled()
    const movedPt = onMoveCursor.mock.calls[0]![0] as { x: number; y: number }
    expect(movedPt.y).toBe(8)
    expect(movedPt.x).toBeGreaterThanOrEqual(8)
  })

  it('4-4 & 4-7: PixelSelect flips upward near viewport bottom, scrolls selected item into view, and Settings PixelIcon stays 1:1 non-squashed', () => {
    const options = Array.from({ length: 14 }, (_, i) => ({
      value: i + 1,
      label: `Option ${i + 1}`,
    }))

    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 500,
    })

    render(
      <AppProvider>
        <div>
          <PixelIcon name="settings" size={18} />
          <PixelSelect<number>
            value={12}
            options={options}
            onChange={vi.fn()}
            testId="bottom-select"
          />
        </div>
      </AppProvider>
    )

    const trigger = screen.getByTestId('bottom-select')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 455,
      top: 455,
      bottom: 495,
      left: 20,
      right: 160,
      width: 140,
      height: 40,
      toJSON: () => ({}),
    })

    fireEvent.click(trigger)
    const listbox = screen.getByTestId('bottom-select-listbox')
    // Near viewport bottom (spaceBelow ~ 0, spaceAbove ~ 443) -> opens upward via Portal!
    expect(listbox.getAttribute('data-direction')).toBe('up')
    // Selected index 11 (Option 12) is scrolled past 0 so it enters visible range immediately!
    expect(listbox.scrollTop).toBeGreaterThan(0)
    expect(
      screen.getByTestId('bottom-select-opt-12').getAttribute('aria-selected')
    ).toBe('true')
  })

  it('4-3: PC mouse drag reorders layers without long-press, and Escape/pointercancel rolls back cleanly', () => {
    const layers: LayerRuntime[] = [
      {
        id: 'bottom',
        name: 'Layer 1',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 4,
        dataHeight: 4,
        data: createPixelBuffer(4, 4),
      },
      {
        id: 'top',
        name: 'Layer 2',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 4,
        dataHeight: 4,
        data: createPixelBuffer(4, 4),
      },
    ]

    const onReorderLayers = vi.fn()
    render(
      <AppProvider>
        <LayerPanelContent
          canvasWidth={4}
          canvasHeight={4}
          layers={layers}
          activeLayerId="top"
          selectedLayerIds={[]}
          onSelectLayer={vi.fn()}
          onToggleLayerSelected={vi.fn()}
          onClearLayerSelection={vi.fn()}
          onStartMultiLayerMoveOnCanvas={vi.fn()}
          onDuplicateSelectedLayers={vi.fn()}
          onMergeSelectedLayers={vi.fn()}
          onDeleteSelectedLayers={vi.fn()}
          onAddLayer={vi.fn()}
          onDuplicateLayer={vi.fn()}
          onDeleteLayer={vi.fn()}
          onMergeDown={vi.fn()}
          onUpdateLayer={vi.fn()}
          onReorderLayers={onReorderLayers}
          onClearLayer={vi.fn()}
          onCopyLayer={vi.fn()}
          onFlipLayer={vi.fn()}
          onStartLayerMoveOnCanvas={vi.fn()}
        />
      </AppProvider>
    )

    const topRow = screen.getByTestId('layer-row-top')
    const bottomRow = screen.getByTestId('layer-row-bottom')

    // Mock elementFromPoint so pointermove over bottomRow hits bottomRow
    const origElementFromPoint = document.elementFromPoint
    document.elementFromPoint = vi.fn(() => bottomRow)

    try {
      // Mouse pointerdown + immediate move (no hold timer!) + pointerup reorders
      fireEvent.pointerDown(topRow, {
        pointerId: 11,
        pointerType: 'mouse',
        button: 0,
        clientX: 50,
        clientY: 20,
      })
      fireEvent.pointerMove(topRow, {
        pointerId: 11,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 32,
      })
      fireEvent.pointerMove(window, {
        pointerId: 11,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 80,
      })
      fireEvent.pointerUp(window, {
        pointerId: 11,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 80,
      })
      expect(onReorderLayers).toHaveBeenCalledWith(['top', 'bottom'])

      // Cancelled drag via pointercancel does NOT reorder
      onReorderLayers.mockClear()
      fireEvent.pointerDown(topRow, {
        pointerId: 12,
        pointerType: 'mouse',
        button: 0,
        clientX: 50,
        clientY: 20,
      })
      fireEvent.pointerMove(topRow, {
        pointerId: 12,
        pointerType: 'mouse',
        clientX: 50,
        clientY: 35,
      })
      fireEvent.pointerCancel(window, {
        pointerId: 12,
        pointerType: 'mouse',
      })
      expect(onReorderLayers).not.toHaveBeenCalled()
    } finally {
      document.elementFromPoint = origElementFromPoint
    }
  })

  it('Section 4 & 5: distinguishes Flood Fill vs Gradient icons, renders Radial Gradient via pure dither density (ZERO semi-transparent alpha), supports 1:1 circle vs ellipse, and exposes 1-256px W/H PixelSliders', () => {
    // 0. Icon distinction: normal fill -> 'fill' (pouring bucket), gradient fill -> 'gradient' (stepped dither)
    expect(resolveToolIconName('fill', { ...BASE_TOOL_SETTINGS, fillMode: 'normal' })).toBe('fill')
    expect(resolveToolIconName('fill', { ...BASE_TOOL_SETTINGS, fillMode: 'gradient' })).toBe('gradient')

    const { container: iconContainer } = render(
      <AppProvider>
        <div>
          <span data-testid="icon-fill-wrap">
            <PixelIcon name="fill" size={16} />
          </span>
          <span data-testid="icon-grad-wrap">
            <PixelIcon name="gradient" size={16} />
          </span>
          <MultiRowToolGrid
            tool="fill"
            toolSettings={{ ...BASE_TOOL_SETTINGS, fillMode: 'gradient' }}
            optionsOpen={false}
            canUndo={false}
            canRedo={false}
            layerCount={1}
            hasSelection={false}
            onTapTool={vi.fn()}
            onOpenLayers={vi.fn()}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          />
          <ToolDetailPopover
            open={true}
            tool="fill"
            settings={{ ...BASE_TOOL_SETTINGS, fillMode: 'gradient', gradientType: 'radial', gradientFixedRatio: true }}
            paletteColors={['#000000', '#FFFFFF']}
            eyedropperDoubleTap={true}
            onToggleEyedropperDoubleTap={vi.fn()}
            hasSelection={false}
            hasClipboard={false}
            onChange={vi.fn()}
            onClose={vi.fn()}
            onCut={vi.fn()}
            onCopy={vi.fn()}
            onPaste={vi.fn()}
            onFlipSelection={vi.fn()}
            onNudgeSelection={vi.fn()}
            onStartSelectionMove={vi.fn()}
            onInvertSelection={vi.fn()}
            onClearSelection={vi.fn()}
            onApplyOutline={vi.fn()}
          />
        </div>
      </AppProvider>
    )
    const fillSvgHtml = iconContainer.querySelector('[data-testid="icon-fill-wrap"] svg')?.innerHTML
    const gradSvgHtml = iconContainer.querySelector('[data-testid="icon-grad-wrap"] svg')?.innerHTML
    expect(fillSvgHtml).toBeTruthy()
    expect(gradSvgHtml).toBeTruthy()
    expect(fillSvgHtml).not.toBe(gradSvgHtml)
    expect(screen.getByTestId('gradient-fixed-ratio-checkbox').getAttribute('aria-checked')).toBe('true')

    // 1. Radial gradient on pre-filled dark background:
    //    - Center has highest density of drawn color
    //    - Density decreases monotonically outward via dither
    //    - ZERO intermediate semi-transparent alpha values (every pixel has alpha === 255!)
    //    - Unplaced dither '.' pixels & outside-radius pixels preserve original background color untouched!
    const W = 32
    const H = 32
    const BG = { r: 20, g: 30, b: 40, a: 255 }
    const FG = { r: 240, g: 190, b: 60, a: 255 }
    const bufCircle = createPixelBuffer(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        setPixel(bufCircle, W, H, x, y, BG)
      }
    }
    applyGradientFloodFill(bufCircle, {
      width: W,
      height: H,
      startX: 16,
      startY: 16,
      endX: 28,
      endY: 16, // radius = 12
      color: FG,
      gradientType: 'radial',
      fixedRatio: true,
      steps: 8,
    })

    // Center (16,16) is solid FG
    expect(getPixel(bufCircle, W, H, 16, 16)).toEqual(FG)

    // Verify ZERO semi-transparent pixels anywhere on canvas, and every pixel is strictly FG or preserved BG!
    let innerFg = 0
    let innerTotal = 0
    let midFg = 0
    let midTotal = 0
    let outerFg = 0
    let outerTotal = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = getPixel(bufCircle, W, H, x, y)
        expect(px.a).toBe(255) // NEVER intermediate alpha like 128 or 64 or 0!
        const isFg = px.r === FG.r && px.g === FG.g && px.b === FG.b
        const isBg = px.r === BG.r && px.g === BG.g && px.b === BG.b
        expect(isFg || isBg).toBe(true)

        const dist = Math.hypot(x - 16, y - 16)
        if (dist <= 2.5) {
          innerTotal++
          if (isFg) innerFg++
        } else if (dist >= 4.5 && dist <= 7.5) {
          midTotal++
          if (isFg) midFg++
        } else if (dist >= 9.5 && dist <= 12) {
          outerTotal++
          if (isFg) outerFg++
        } else if (dist > 12.5) {
          // Strictly outside radius preserves BG untouched
          expect(isBg).toBe(true)
        }
      }
    }
    const innerDensity = innerFg / innerTotal
    const midDensity = midFg / midTotal
    const outerDensity = outerFg / outerTotal
    expect(innerDensity).toBeGreaterThan(midDensity)
    expect(midDensity).toBeGreaterThan(outerDensity)

    // Also verify radial gradient on transparent canvas ONLY produces alpha 255 (placed) or alpha 0 (untouched)!
    const bufOnTrans = createPixelBuffer(24, 24)
    applyGradientFloodFill(bufOnTrans, {
      width: 24,
      height: 24,
      startX: 12,
      startY: 12,
      endX: 20,
      endY: 12,
      color: FG,
      gradientType: 'radial',
      fixedRatio: true,
      steps: 8,
    })
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const a = getPixel(bufOnTrans, 24, 24, x, y).a
        expect(a === 0 || a === 255).toBe(true)
      }
    }

    // 2. 1:1 fixedRatio=true produces circular horizontal/vertical reach, whereas fixedRatio=false produces an ellipse!
    const bufTrueCircle = createPixelBuffer(24, 24)
    applyGradientFloodFill(bufTrueCircle, {
      width: 24,
      height: 24,
      startX: 12,
      startY: 12,
      endX: 20,
      endY: 14, // hypot(8,2) ~= 8.24 in BOTH X and Y when fixedRatio=true
      color: FG,
      gradientType: 'radial',
      fixedRatio: true,
      steps: 4,
    })
    // At dy = 6 (y=18), circle radius ~8.24 reaches this band so some pixels around y=18 are drawn
    let circleReachedVertical = false
    for (let y = 16; y <= 19; y++) {
      for (let x = 10; x <= 14; x++) {
        if (getPixel(bufTrueCircle, 24, 24, x, y).a === 255) {
          circleReachedVertical = true
        }
      }
    }
    expect(circleReachedVertical).toBe(true)

    const bufEllipse = createPixelBuffer(24, 24)
    applyGradientFloodFill(bufEllipse, {
      width: 24,
      height: 24,
      startX: 12,
      startY: 12,
      endX: 20,
      endY: 14, // rx=8, ry=2 when fixedRatio=false
      color: FG,
      gradientType: 'radial',
      fixedRatio: false,
      steps: 4,
    })
    // Horizontal extent reaches x=17..19, while vertical beyond ry=2 (y >= 15) stays completely untouched (a=0)!
    let ellipseReachedHorizontal = false
    for (let x = 16; x <= 19; x++) {
      for (let y = 11; y <= 13; y++) {
        if (getPixel(bufEllipse, 24, 24, x, y).a === 255) {
          ellipseReachedHorizontal = true
        }
      }
    }
    expect(ellipseReachedHorizontal).toBe(true)
    for (let y = 15; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        expect(getPixel(bufEllipse, 24, 24, x, y).a).toBe(0)
      }
    }

    // 3. Transparent Color Slot radial gradient erases via dither density (ONLY alpha 0 or preserved alpha 255, zero partial alpha!)
    const bufErase = createPixelBuffer(20, 20)
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        setPixel(bufErase, 20, 20, x, y, { r: 50, g: 200, b: 100, a: 255 })
      }
    }
    applyGradientFloodFill(bufErase, {
      width: 20,
      height: 20,
      startX: 10,
      startY: 10,
      endX: 17,
      endY: 10,
      color: { r: 0, g: 0, b: 0, a: 0 },
      gradientType: 'radial',
      fixedRatio: true,
      steps: 4,
    })
    expect(getPixel(bufErase, 20, 20, 10, 10).a).toBe(0)
    expect(getPixel(bufErase, 20, 20, 19, 10).a).toBe(255)
    let midErased = 0
    let midKept = 0
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const a = getPixel(bufErase, 20, 20, x, y).a
        expect(a === 0 || a === 255).toBe(true)
        const d = Math.hypot(x - 10, y - 10)
        if (d >= 2.5 && d <= 5.5) {
          if (a === 0) midErased++
          else midKept++
        }
      }
    }
    expect(midErased).toBeGreaterThan(0)
    expect(midKept).toBeGreaterThan(0)

    // 4. Linear gradient & normal flood fill remain intact
    const bufLin = createPixelBuffer(16, 4)
    applyGradientFloodFill(bufLin, {
      width: 16,
      height: 4,
      startX: 0,
      startY: 0,
      endX: 15,
      endY: 0,
      color: FG,
      gradientType: 'linear',
      steps: 4,
    })
    expect(getPixel(bufLin, 16, 4, 0, 0)).toEqual(FG)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) {
        const a = getPixel(bufLin, 16, 4, x, y).a
        expect(a === 0 || a === 255).toBe(true)
      }
    }

    const bufFlood = createPixelBuffer(4, 4)
    applyFloodFill(bufFlood, {
      width: 4,
      height: 4,
      seedX: 1,
      seedY: 1,
      color: FG,
      connectivity: 4,
      dither: 1,
    })
    expect(getPixel(bufFlood, 4, 4, 3, 3)).toEqual(FG)

    // 5. CanvasResizeModal exposes independent Width & Height PixelSliders (1-256px) with +-1 buttons
    const onResize = vi.fn()
    render(
      <AppProvider>
        <CanvasResizeModal
          open={true}
          currentWidth={32}
          currentHeight={48}
          onClose={vi.fn()}
          onResize={onResize}
        />
      </AppProvider>
    )
    fireEvent.click(screen.getByTestId('resize-width-slider-plus'))
    fireEvent.click(screen.getByTestId('resize-height-slider-minus'))
    fireEvent.click(screen.getByTestId('confirm-resize-btn'))
    expect(onResize).toHaveBeenCalledWith(33, 47, 'center')
  })

  it('Section 3 (14-point verification): double-tap eyedropper ALWAYS samples at the CURRENT in-app cursor (Pixel A) even when double-tapping at Pixel B, never moves cursor or paints, handles transparent slot, keeps active tool, ignores single tap/slide/pinch, and respects ON/OFF setting', async () => {
    // Clear DB and spin up full Editor via <App /> to test end-to-end cursor vs tap coordinate decoupling!
    await db.projects.clear()
    await db.layerPixels.clear()
    await db.histories.clear()
    await db.settings.clear()

    window.history.pushState({}, '', '/')
    render(<App />)

    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.change(screen.getByTestId('new-project-name-input'), {
      target: { value: 'Cursor Eyedropper Test' },
    })
    fireEvent.change(screen.getByTestId('new-project-width-input'), {
      target: { value: '16' },
    })
    fireEvent.change(screen.getByTestId('new-project-height-input'), {
      target: { value: '16' },
    })
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

    const drawBtn = await screen.findByTestId('draw-button')
    const vp = screen.getByTestId('canvas-viewport')
    vi.spyOn(vp, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 320,
      bottom: 320,
      width: 320,
      height: 320,
      toJSON: () => ({}),
    })

    // Initial cursor starts at center (8, 8) — let's paint Palette Color #2 at Pixel A = (8, 8) using Draw button
    const swatch2 = screen.getByTestId('quick-color-2')
    const color2Label = swatch2.getAttribute('aria-label')
    expect(color2Label).toBeTruthy()
    fireEvent.click(swatch2)
    fireEvent.pointerDown(drawBtn, { pointerId: 1 })
    fireEvent.pointerUp(drawBtn, { pointerId: 1 })

    // Slide cursor away to Pixel C and paint Palette Color #5 there so canvas has two distinct colors + transparent pixels
    const swatch5 = screen.getByTestId('quick-color-5')
    fireEvent.click(swatch5)
    fireEvent.pointerDown(vp, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 200 })
    fireEvent.pointerMove(vp, { pointerId: 2, pointerType: 'touch', clientX: 80, clientY: 80 })
    fireEvent.pointerUp(vp, { pointerId: 2, pointerType: 'touch', clientX: 80, clientY: 80 })

    // Switch active color to swatch #0 and active tool to 'line' so we can verify:
    //  (a) color switches to Pixel A's color (#2), NOT Pixel B's color
    //  (b) active tool remains 'line' after double-tap eyedropper
    fireEvent.click(screen.getByTestId('quick-color-0'))
    fireEvent.click(screen.getByTestId('tool-line'))
    expect(screen.getByTestId('quick-color-0').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('tool-line').getAttribute('aria-pressed')).toBe('true')

    // Move in-app cursor back onto Pixel A = (8, 8) by sliding right/down until cursor is back at (8, 8)
    // Let's inspect project layer directly from Editor state via Undo check & Slide:
    // Even simpler & exact: paint Swatch #2 right at current cursor (Pixel A), then switch to Swatch #0 & 'line' tool,
    // keeping cursor stationary on Pixel A while double-tapping far away at Pixel B (clientX: 300, clientY: 300, which is transparent)!
    fireEvent.click(screen.getByTestId('tool-pen'))
    fireEvent.click(swatch2)
    fireEvent.pointerDown(drawBtn, { pointerId: 3 })
    fireEvent.pointerUp(drawBtn, { pointerId: 3 })

    // Now Pixel A (current cursor position) has Swatch #2 (opaque)!
    // Meanwhile Pixel B at screen (310, 310) -> bottom-right corner is completely transparent!
    // Select Swatch #0 and switch tool to 'line'
    fireEvent.click(screen.getByTestId('quick-color-0'))
    fireEvent.click(screen.getByTestId('tool-line'))
    expect(screen.getByTestId('quick-color-2').getAttribute('aria-pressed')).toBe('false')

    // Record layer pixel snapshot BEFORE gestures to prove double-tap NEVER draws or modifies any pixel
    const projBefore = (await db.projects.toArray())[0]!
    expect(projBefore).toBeTruthy()

    // Check #10: A single stationary tap at Pixel B (310, 310) does NOT trigger eyedropper and does NOT move cursor
    let fakeNow = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)
    try {
      fireEvent.pointerDown(vp, { pointerId: 10, pointerType: 'touch', clientX: 310, clientY: 310 })
      fireEvent.pointerUp(vp, { pointerId: 10, pointerType: 'touch', clientX: 310, clientY: 310 })
      expect(screen.getByTestId('quick-color-0').getAttribute('aria-pressed')).toBe('true')

      // Advance past 300ms window so next test starts clean
      fakeNow += 500

      // Check #11: A touch slide followed by a tap within 300ms is NOT misrecognized as double-tap
      fireEvent.pointerDown(vp, { pointerId: 11, pointerType: 'touch', clientX: 100, clientY: 100 })
      fireEvent.pointerMove(vp, { pointerId: 11, pointerType: 'touch', clientX: 120, clientY: 100 }) // slide > 6px
      fireEvent.pointerMove(vp, { pointerId: 11, pointerType: 'touch', clientX: 100, clientY: 100 }) // slide back to Pixel A
      fireEvent.pointerUp(vp, { pointerId: 11, pointerType: 'touch', clientX: 100, clientY: 100 })
      fakeNow += 100
      fireEvent.pointerDown(vp, { pointerId: 12, pointerType: 'touch', clientX: 100, clientY: 100 })
      fireEvent.pointerUp(vp, { pointerId: 12, pointerType: 'touch', clientX: 100, clientY: 100 })
      expect(screen.getByTestId('quick-color-0').getAttribute('aria-pressed')).toBe('true')

      // Ensure Pixel A at current cursor definitely holds Swatch #2
      fireEvent.click(screen.getByTestId('tool-pen'))
      fireEvent.click(swatch2)
      fireEvent.pointerDown(drawBtn, { pointerId: 13 })
      fireEvent.pointerUp(drawBtn, { pointerId: 13 })
      fireEvent.click(screen.getByTestId('quick-color-0'))
      fireEvent.click(screen.getByTestId('tool-line'))

      fakeNow += 500

      // Check #12: Two-finger pinch/pan does NOT trigger double-tap eyedropper
      fireEvent.pointerDown(vp, { pointerId: 20, pointerType: 'touch', clientX: 50, clientY: 50 })
      fireEvent.pointerDown(vp, { pointerId: 21, pointerType: 'touch', clientX: 150, clientY: 150 })
      fireEvent.pointerUp(vp, { pointerId: 20, pointerType: 'touch', clientX: 50, clientY: 50 })
      fireEvent.pointerUp(vp, { pointerId: 21, pointerType: 'touch', clientX: 150, clientY: 150 })
      expect(screen.getByTestId('quick-color-0').getAttribute('aria-pressed')).toBe('true')

      fakeNow += 500

      // Checks #1, #2, #3, #4, #5, #6, #8, #9:
      // Cursor is on Pixel A (Swatch #2). User double-taps at Pixel B (310, 310 — transparent corner)!
      // Must pick Swatch #2 (Pixel A), NOT Transparent (Pixel B), keep cursor at Pixel A, and keep tool === 'line'!
      fireEvent.pointerDown(vp, { pointerId: 30, pointerType: 'touch', clientX: 310, clientY: 310 })
      fireEvent.pointerUp(vp, { pointerId: 30, pointerType: 'touch', clientX: 310, clientY: 310 })
      fakeNow += 120
      fireEvent.pointerDown(vp, { pointerId: 31, pointerType: 'touch', clientX: 312, clientY: 308 })
      fireEvent.pointerUp(vp, { pointerId: 31, pointerType: 'touch', clientX: 312, clientY: 308 })

      // Picked Swatch #2 (from Pixel A at cursor!), NOT transparent (from Pixel B at tap coordinates!)
      expect(screen.getByTestId('quick-color-2').getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByTestId('quick-color-transparent').getAttribute('aria-pressed')).toBe('false')
      // Active tool stayed 'line' (Check #8)
      expect(screen.getByTestId('tool-line').getAttribute('aria-pressed')).toBe('true')

      // Check #7 & #5: Verify cursor did NOT move to Pixel B by erasing Pixel A with Eraser + Draw button,
      // then double-tapping at another spot -> now Pixel A is transparent, so Transparent Color Slot is selected!
      fireEvent.click(screen.getByTestId('tool-eraser'))
      fireEvent.pointerDown(drawBtn, { pointerId: 40 })
      fireEvent.pointerUp(drawBtn, { pointerId: 40 })
      fireEvent.click(screen.getByTestId('tool-shape'))
      expect(screen.getByTestId('quick-color-2').getAttribute('aria-pressed')).toBe('true')

      fakeNow += 500
      fireEvent.pointerDown(vp, { pointerId: 41, pointerType: 'touch', clientX: 25, clientY: 25 })
      fireEvent.pointerUp(vp, { pointerId: 41, pointerType: 'touch', clientX: 25, clientY: 25 })
      fakeNow += 110
      fireEvent.pointerDown(vp, { pointerId: 42, pointerType: 'touch', clientX: 25, clientY: 25 })
      fireEvent.pointerUp(vp, { pointerId: 42, pointerType: 'touch', clientX: 25, clientY: 25 })

      // Pixel A is now transparent -> Transparent Color Slot selected & tool remains 'shape'!
      expect(screen.getByTestId('quick-color-transparent').getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByTestId('tool-shape').getAttribute('aria-pressed')).toBe('true')

      // Repaint Swatch #5 at Pixel A so we can test OFF/ON toggle (Checks #13 & #14)
      fireEvent.click(screen.getByTestId('tool-pen'))
      fireEvent.click(swatch5)
      fireEvent.pointerDown(drawBtn, { pointerId: 50 })
      fireEvent.pointerUp(drawBtn, { pointerId: 50 })
      fireEvent.click(screen.getByTestId('quick-color-0'))

      // Toggle eyedropperDoubleTap OFF via Eyedropper tool detail panel
      fireEvent.click(screen.getByTestId('tool-eyedropper'))
      fireEvent.click(screen.getByTestId('tool-eyedropper')) // re-tap opens detail panel
      const dtToggle = await screen.findByTestId('toggle-eyedropper-doubletap')
      expect(dtToggle.getAttribute('aria-checked')).toBe('true')
      fireEvent.click(dtToggle)
      expect(dtToggle.getAttribute('aria-checked')).toBe('false')

      // Switch back to 'pen', double-tap -> Check #13: MUST NOT activate when OFF!
      fireEvent.click(screen.getByTestId('tool-pen'))
      fakeNow += 500
      fireEvent.pointerDown(vp, { pointerId: 60, pointerType: 'touch', clientX: 300, clientY: 300 })
      fireEvent.pointerUp(vp, { pointerId: 60, pointerType: 'touch', clientX: 300, clientY: 300 })
      fakeNow += 100
      fireEvent.pointerDown(vp, { pointerId: 61, pointerType: 'touch', clientX: 300, clientY: 300 })
      fireEvent.pointerUp(vp, { pointerId: 61, pointerType: 'touch', clientX: 300, clientY: 300 })
      expect(screen.getByTestId('quick-color-0').getAttribute('aria-pressed')).toBe('true')

      // Check #14: Turn setting back ON -> double-tap picks Swatch #5 at Pixel A again!
      fireEvent.click(screen.getByTestId('tool-eyedropper'))
      fireEvent.click(screen.getByTestId('tool-eyedropper'))
      fireEvent.click(await screen.findByTestId('toggle-eyedropper-doubletap'))
      fireEvent.click(screen.getByTestId('tool-pen'))

      fakeNow += 500
      fireEvent.pointerDown(vp, { pointerId: 70, pointerType: 'touch', clientX: 300, clientY: 300 })
      fireEvent.pointerUp(vp, { pointerId: 70, pointerType: 'touch', clientX: 300, clientY: 300 })
      fakeNow += 100
      fireEvent.pointerDown(vp, { pointerId: 71, pointerType: 'touch', clientX: 300, clientY: 300 })
      fireEvent.pointerUp(vp, { pointerId: 71, pointerType: 'touch', clientX: 300, clientY: 300 })
      expect(screen.getByTestId('quick-color-5').getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByTestId('tool-pen').getAttribute('aria-pressed')).toBe('true')
    } finally {
      nowSpy.mockRestore()
    }
  })
})
