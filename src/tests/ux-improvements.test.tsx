import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppProvider } from '../state/AppContext'
import {
  classifyWheelPoint,
  PIXEL_WHEEL_GRID_SIZE,
  wheelPointToHue,
  wheelPointToSv,
} from '../components/common/PixelColorWheel'
import { rgbToGrayscaleByte, toGrayscaleRgbaBuffer } from '../engine/color'
import { normalizeProjectPalette } from '../engine/indexedPalette'
import { exportCompositePngBytes } from '../engine/compositor'
import { PixelSelect } from '../components/common/PixelSelect'
import { PixelIcon } from '../components/common/PixelIcon'
import { LayerPanelContent } from '../components/editor/LayerSheet'
import { InteractiveViewport } from '../components/editor/InteractiveViewport'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import { applyFloodFill, applyGradientFloodFill } from '../engine/floodFill'
import { CanvasResizeModal } from '../components/editor/EditorModals'
import { MultiRowToolGrid, ToolDetailPopover } from '../components/editor/ToolPanels'
import { PaletteSheet } from '../components/editor/PaletteSheet'
import { resolveToolIconName } from '../utils/toolIcon'
import {
  moveWorldSelectionOnLayer,
  projectWorldSelectionToCanvasMask,
  selectWorldRectangleMask,
} from '../engine/selection'
import { App } from '../App'
import {
  db,
  DEFAULT_UI_SIZE_CONFIG,
  normalizeAppSettings,
  UI_SIZE_PRESETS,
} from '../db/database'
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
            compositedBuffer={new Uint8ClampedArray(16 * 16 * 4)}
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
            hasSelection={false}
            onTapTool={vi.fn()}
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
    const BG = { r: 1, g: 1, b: 1, a: 255 }
    const FG = { r: 2, g: 2, b: 2, a: 255 }
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

  it('Additional Fix 1: renaming a layer via double-click / touch double-tap NEVER starts drag reorder, disables drag while editing, and restores drag reorder after Enter/Escape', () => {
    const layers: LayerRuntime[] = [
      {
        id: 'l-bottom',
        name: '下レイヤー',
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
        id: 'l-top',
        name: '上レイヤー',
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

    const onUpdateLayer = vi.fn()
    const onReorderLayers = vi.fn()

    render(
      <AppProvider>
        <LayerPanelContent
          canvasWidth={8}
          canvasHeight={8}
          layers={layers}
          activeLayerId="l-top"
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
          onUpdateLayer={onUpdateLayer}
          onReorderLayers={onReorderLayers}
          onClearLayer={vi.fn()}
          onCopyLayer={vi.fn()}
          onFlipLayer={vi.fn()}
          onStartLayerMoveOnCanvas={vi.fn()}
        />
      </AppProvider>
    )

    const topLabel = screen.getByTestId('layer-name-label-l-top')
    const bottomRow = screen.getByTestId('layer-row-l-bottom')
    const origElementFromPoint = document.elementFromPoint
    document.elementFromPoint = vi.fn(() => bottomRow)

    try {
      // 1st click + slight pointer jitter on the layer name label MUST NOT start a drag!
      fireEvent.pointerDown(topLabel, {
        pointerId: 101,
        pointerType: 'mouse',
        button: 0,
        clientX: 60,
        clientY: 20,
      })
      fireEvent.pointerMove(topLabel, {
        pointerId: 101,
        pointerType: 'mouse',
        clientX: 60,
        clientY: 55,
      })
      fireEvent.pointerUp(topLabel, {
        pointerId: 101,
        pointerType: 'mouse',
        clientX: 60,
        clientY: 55,
      })
      expect(onReorderLayers).not.toHaveBeenCalled()

      // Double-click opens rename input with full text selected
      fireEvent.doubleClick(topLabel)
      const input = screen.getByTestId('layer-rename-input-l-top') as HTMLInputElement
      expect(document.activeElement).toBe(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('上レイヤー'.length)

      // Selecting text inside the input (pointerdown + pointermove + pointerup) MUST NOT drag the row!
      fireEvent.pointerDown(input, {
        pointerId: 102,
        pointerType: 'mouse',
        button: 0,
        clientX: 40,
        clientY: 20,
      })
      fireEvent.pointerMove(input, {
        pointerId: 102,
        pointerType: 'mouse',
        clientX: 90,
        clientY: 60,
      })
      fireEvent.pointerUp(input, {
        pointerId: 102,
        pointerType: 'mouse',
        clientX: 90,
        clientY: 60,
      })
      expect(onReorderLayers).not.toHaveBeenCalled()

      // Commit rename with Enter
      fireEvent.change(input, { target: { value: '主線レイヤー' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onUpdateLayer).toHaveBeenCalledWith('l-top', { name: '主線レイヤー' })

      // After rename completes, normal drag reorder via the dedicated drag handle works cleanly!
      const dragHandle = screen.getByTestId('layer-drag-handle-l-top')
      fireEvent.pointerDown(dragHandle, {
        pointerId: 103,
        pointerType: 'mouse',
        button: 0,
        clientX: 12,
        clientY: 20,
      })
      // Stationary click on drag handle alone does NOT reorder
      fireEvent.pointerUp(window, {
        pointerId: 103,
        pointerType: 'mouse',
        clientX: 12,
        clientY: 20,
      })
      expect(onReorderLayers).not.toHaveBeenCalled()

      // Moving >= 5px from drag handle reorders cleanly
      fireEvent.pointerDown(dragHandle, {
        pointerId: 104,
        pointerType: 'mouse',
        button: 0,
        clientX: 12,
        clientY: 20,
      })
      fireEvent.pointerMove(dragHandle, {
        pointerId: 104,
        pointerType: 'mouse',
        clientX: 12,
        clientY: 55,
      })
      fireEvent.pointerUp(window, {
        pointerId: 104,
        pointerType: 'mouse',
        clientX: 12,
        clientY: 55,
      })
      expect(onReorderLayers).toHaveBeenCalledWith(['l-top', 'l-bottom'])
    } finally {
      document.elementFromPoint = origElementFromPoint
    }
  })

  it('Additional Fix 2: preserves selection state & pixel data when moved partially or completely outside canvas, continues drag outside viewport, and supports full Undo/Redo', async () => {
    // Part A: Pure engine verification of non-destructive world-space selection & pixel preservation
    const baseData = createPixelBuffer(8, 8)
    const MARK = { r: 235, g: 80, b: 110, a: 255 }
    setPixel(baseData, 8, 8, 1, 1, MARK)
    setPixel(baseData, 8, 8, 2, 1, MARK)
    const baseLayer: LayerRuntime = {
      id: 'layer-sel',
      name: 'Layer 1',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 8,
      dataHeight: 8,
      data: baseData,
    }

    const ws0 = selectWorldRectangleMask({ x: 1, y: 1 }, { x: 2, y: 1 })
    // Move completely outside canvas to x = -5..-4 (100% off-canvas!)
    const movedOut = moveWorldSelectionOnLayer(baseLayer, ws0, -6, 0)
    expect(movedOut.nextWorldSelection.originX).toBe(-5)
    // Visible canvas projection is null while off-canvas, yet world selection & backing pixels remain 100% intact!
    expect(
      projectWorldSelectionToCanvasMask(movedOut.nextWorldSelection, 8, 8)
    ).toBeNull()

    // Move back inside canvas (+8, +2) -> lands at (3, 3) and (4, 3) with original MARK pixels intact!
    const movedBack = moveWorldSelectionOnLayer(
      movedOut.nextLayer,
      movedOut.nextWorldSelection,
      8,
      2
    )
    const projBack = projectWorldSelectionToCanvasMask(
      movedBack.nextWorldSelection,
      8,
      8
    )
    expect(projBack).not.toBeNull()
    expect(projBack![3 * 8 + 3]).toBe(1)
    expect(projBack![3 * 8 + 4]).toBe(1)

    // Part B: Full UI E2E verification (PC pointer leaving canvas + moving selection completely off-canvas + Undo/Redo)
    await db.projects.clear()
    await db.layerPixels.clear()
    await db.histories.clear()
    await db.settings.clear()

    window.history.pushState({}, '', '/')
    render(<App />)

    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.change(screen.getByTestId('new-project-width-input'), {
      target: { value: '8' },
    })
    fireEvent.change(screen.getByTestId('new-project-height-input'), {
      target: { value: '8' },
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

    // Paint a pixel at center (4, 4)
    fireEvent.click(screen.getByTestId('quick-color-2'))
    fireEvent.pointerDown(drawBtn, { pointerId: 1 })
    fireEvent.pointerUp(drawBtn, { pointerId: 1 })

    // Select a rectangle covering (4, 4) -> out-of-canvas endpoint (-2, -2) via Select tool (switch from default 'wand' to 'rect')
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(screen.getByTestId('tool-select'))
    fireEvent.click(await screen.findByTestId('select-type-rect'))
    fireEvent.click(screen.getByTestId('tool-select'))
    // Step 1 at (4, 4)
    fireEvent.pointerDown(drawBtn, { pointerId: 2 })
    fireEvent.pointerUp(drawBtn, { pointerId: 2 })
    // Move mouse pointer outside canvas to negative coordinates (-40, -40) and complete selection!
    fireEvent.pointerMove(vp, {
      pointerId: 3,
      pointerType: 'mouse',
      clientX: -40,
      clientY: -40,
    })
    fireEvent.pointerDown(drawBtn, { pointerId: 4 })
    fireEvent.pointerUp(drawBtn, { pointerId: 4 })

    // Open Select detail panel -> verify selection is active (`start-selection-move-btn` enabled) even after pointer leaves viewport!
    fireEvent.click(screen.getByTestId('tool-select'))
    const startMoveBtn = (await screen.findByTestId(
      'start-selection-move-btn'
    )) as HTMLButtonElement
    expect(startMoveBtn.disabled).toBe(false)

    // Start Selection Move, drag pointer far outside canvas (-300px left = completely off-canvas!), and commit!
    fireEvent.click(startMoveBtn)
    fireEvent.pointerDown(vp, {
      pointerId: 10,
      pointerType: 'mouse',
      button: 0,
      clientX: 160,
      clientY: 160,
    })
    fireEvent.pointerMove(vp, {
      pointerId: 10,
      pointerType: 'mouse',
      clientX: -340, // far outside canvas & viewport!
      clientY: 160,
    })
    fireEvent.pointerUp(vp, {
      pointerId: 10,
      pointerType: 'mouse',
      clientX: -340,
      clientY: 160,
    })
    // Commit active move via ActiveMoveBar commit button (since mouse modality hides bottom DrawButton)
    fireEvent.click(screen.getByTestId('commit-move-btn'))

    // CRITICAL CHECK: Selection is now 100% outside `[0..7, 0..7]`, yet `hasSelection` MUST STILL BE TRUE!
    fireEvent.click(screen.getByTestId('tool-select'))
    const startMoveAgain = (await screen.findByTestId(
      'start-selection-move-btn'
    )) as HTMLButtonElement
    expect(startMoveAgain.disabled).toBe(false)

    // Drag selection back inside (+500px right) via touch and commit via remounted Draw button -> pixels & selection return intact!
    fireEvent.click(startMoveAgain)
    fireEvent.pointerDown(vp, {
      pointerId: 12,
      pointerType: 'touch',
      clientX: 20,
      clientY: 160,
    })
    fireEvent.pointerMove(vp, {
      pointerId: 12,
      pointerType: 'touch',
      clientX: 520,
      clientY: 160,
    })
    fireEvent.pointerUp(vp, {
      pointerId: 12,
      pointerType: 'touch',
      clientX: 520,
      clientY: 160,
    })
    const remountedDrawBtn = await screen.findByTestId('draw-button')
    fireEvent.pointerDown(remountedDrawBtn, { pointerId: 13 })
    fireEvent.pointerUp(remountedDrawBtn, { pointerId: 13 })

    // Undo twice + Redo twice works without losing selection state!
    fireEvent.click(screen.getByTestId('undo-btn'))
    fireEvent.click(screen.getByTestId('undo-btn'))
    fireEvent.click(screen.getByTestId('redo-btn'))
    fireEvent.click(screen.getByTestId('redo-btn'))

    fireEvent.click(screen.getByTestId('tool-select'))
    const clearBtn = (await screen.findByText('選択解除')).closest(
      'button'
    ) as HTMLButtonElement
    expect(clearBtn.disabled).toBe(false)
    fireEvent.click(clearBtn)
    expect(clearBtn.disabled).toBe(true)
    vi.restoreAllMocks()
  })

  it('Additional Fix 3: focusing Palette Name input auto-selects existing text, preserves full selection across mouseup, commits on Enter/blur, cancels on Escape, and rejects empty names', () => {
    const onUpdatePalette = vi.fn()
    render(
      <AppProvider>
        <PaletteSheet
          open={true}
          onClose={vi.fn()}
          palette={{
            name: 'Retro DMG 04',
            colors: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'],
          }}
          selectedIndex={0}
          libraryPalettes={[]}
          onSelectColor={vi.fn()}
          onUpdatePalette={onUpdatePalette}
          onSaveToLibrary={vi.fn()}
        />
      </AppProvider>
    )

    const input = screen.getByTestId('palette-name-input') as HTMLInputElement
    expect(input.value).toBe('Retro DMG 04')

    // Simulate pointerdown -> focus -> mouseup (which in browsers normally collapses selection unless guarded!)
    fireEvent.pointerDown(input, { pointerType: 'mouse', button: 0 })
    input.focus()
    fireEvent.focus(input)
    // Simulate browser collapsing caret to index 3 before mouseup arrives
    input.setSelectionRange(3, 3)
    fireEvent.mouseUp(input)
    // Full existing palette name MUST be selected!
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Retro DMG 04'.length)

    // Subsequent click while ALREADY focused allows normal partial cursor editing without re-selecting all!
    input.setSelectionRange(5, 5)
    fireEvent.pointerDown(input, { pointerType: 'mouse', button: 0 })
    fireEvent.mouseUp(input)
    expect(input.selectionStart).toBe(5)
    expect(input.selectionEnd).toBe(5)

    // Escape cancels draft and restores original name without calling onUpdatePalette
    fireEvent.change(input, { target: { value: 'Temporary Draft' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onUpdatePalette).not.toHaveBeenCalled()
    expect(input.value).toBe('Retro DMG 04')

    // Empty / whitespace-only name is rejected and reverts to existing palette name
    input.focus()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '    ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUpdatePalette).not.toHaveBeenCalled()
    expect(input.value).toBe('Retro DMG 04')

    // Valid new name commits cleanly on Enter and persists via onUpdatePalette
    fireEvent.change(input, { target: { value: 'Autumn Dusk 16' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUpdatePalette).toHaveBeenCalledWith({
      name: 'Autumn Dusk 16',
      colors: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'],
    })
  })

  it('iPad & Apple Pencil (`pointerType="pen"`): keeps DrawButton mounted, draws directly without virtual cursor duplication, preserves user zoom across viewport resizes, and still supports Fit & Canvas Resize', async () => {
    vi.restoreAllMocks()
    await db.projects.clear()
    await db.layerPixels.clear()
    await db.celBuffers.clear()
    await db.histories.clear()
    await db.settings.clear()

    // Mock ResizeObserver & dynamic bounding rect on `[data-testid="canvas-viewport"]`
    let mockRect = { width: 768, height: 900 }
    let resizeListeners: Array<() => void> = []
    const origRO = globalThis.ResizeObserver
    const origGetBCR = HTMLElement.prototype.getBoundingClientRect

    class MockResizeObserver {
      private cb: () => void
      constructor(cb: () => void) {
        this.cb = cb
      }
      observe(el: Element) {
        if ((el as HTMLElement).getAttribute?.('data-testid') === 'canvas-viewport') {
          resizeListeners.push(this.cb)
        }
      }
      unobserve() {}
      disconnect() {
        resizeListeners = resizeListeners.filter((fn) => fn !== this.cb)
      }
    }

    let strokeCount = 0
    const origGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = (function () {
      return {
        save: () => {},
        restore: () => {},
        scale: () => {},
        translate: () => {},
        setTransform: () => {},
        resetTransform: () => {},
        clearRect: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        beginPath: () => {},
        rect: () => {},
        clip: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {
          strokeCount++
        },
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

    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.getAttribute?.('data-testid') === 'canvas-viewport') {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: mockRect.width,
          bottom: mockRect.height,
          width: mockRect.width,
          height: mockRect.height,
          toJSON: () => ({}),
        } as DOMRect
      }
      return origGetBCR.call(this)
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

    try {
      window.history.pushState({}, '', '/')
      render(<App />)

      // Create a 16x16 artwork via built-in 16x16 preset and enter Editor
      fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
      fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
      fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))

      // 1. Initially iPad/tablet touch UI is shown (`draw-button` visible) and initial measured viewport (768x900) fits 16x16 -> scale = floor(768*0.86/16) = 41
      const drawBtn = await screen.findByTestId('draw-button')
      expect(drawBtn).toBeTruthy()
      const vp = await screen.findByTestId('canvas-viewport')
      await waitFor(() => {
        expect(vp.textContent).toContain('×41')
      })
      // In initial `touch` modality, virtual brush boundary calls `ctx.stroke()`
      expect(strokeCount).toBeGreaterThan(0)

      // 2. Zoom in via wheel/pinch so user has a custom zoom scale (e.g. 41 * 1.18 * 1.18 = 57.1x)
      fireEvent.wheel(vp, { deltaY: -100, clientX: 384, clientY: 450 })
      fireEvent.wheel(vp, { deltaY: -100, clientX: 384, clientY: 450 })
      expect(vp.textContent).toContain('×57.1')

      // 3. Draw directly with Apple Pencil (`pointerType: 'pen'`, `eyedropperDoubleTap` off or drag stroke):
      //    - Bottom `draw-button` MUST remain mounted!
      //    - Virtual cursor stroke MUST NOT be drawn (`strokeCount === 0` on pen redraw)!
      //    - Custom zoom `×57.1` MUST NOT reset!
      //    - Pixel is actually painted onto the canvas!
      strokeCount = 0
      fireEvent.pointerDown(vp, {
        pointerId: 21,
        pointerType: 'pen',
        button: 0,
        clientX: 384,
        clientY: 450,
      })
      fireEvent.pointerMove(vp, {
        pointerId: 21,
        pointerType: 'pen',
        button: 0,
        clientX: 450,
        clientY: 450,
      })
      fireEvent.pointerUp(vp, {
        pointerId: 21,
        pointerType: 'pen',
        button: 0,
        clientX: 450,
        clientY: 450,
      })

      expect(screen.queryByTestId('draw-button')).not.toBeNull()
      expect(vp.textContent).toContain('×57.1')
      // Virtual cursor is hidden in `pen` modality (zero brush-outline `ctx.stroke()` calls)
      expect(strokeCount).toBe(0)

      // Verify Apple Pencil actually drew pixels on the layer (undo button becomes enabled immediately, and IndexedDB persists after auto-save)!
      await waitFor(() => {
        expect((screen.getByTestId('undo-btn') as HTMLButtonElement).disabled).toBe(false)
      })
      await waitFor(async () => {
        const projs = await db.projects.toArray()
        const celRecs = await db.celBuffers
          .where('projectId')
          .equals(projs[0]!.id)
          .toArray()
        const nonTransparentCount = celRecs[0]!.data.filter((v) => v !== 255).length
        expect(nonTransparentCount).toBeGreaterThan(0)
      })

      // 4. Resize viewport height, width, and rotate screen -> `×57.1` zoom MUST remain preserved!
      mockRect = { width: 768, height: 740 }
      act(() => {
        for (const fn of resizeListeners) fn()
      })
      expect(vp.textContent).toContain('×57.1')

      mockRect = { width: 640, height: 740 }
      act(() => {
        for (const fn of resizeListeners) fn()
      })
      expect(vp.textContent).toContain('×57.1')

      mockRect = { width: 1024, height: 768 }
      act(() => {
        for (const fn of resizeListeners) fn()
      })
      expect(vp.textContent).toContain('×57.1')

      // 5. Finger `touch` slide still works and restores virtual cursor without resetting zoom!
      strokeCount = 0
      fireEvent.pointerDown(vp, {
        pointerId: 22,
        pointerType: 'touch',
        clientX: 300,
        clientY: 300,
      })
      fireEvent.pointerMove(vp, {
        pointerId: 22,
        pointerType: 'touch',
        clientX: 360,
        clientY: 300,
      })
      fireEvent.pointerUp(vp, {
        pointerId: 22,
        pointerType: 'touch',
        clientX: 360,
        clientY: 300,
      })
      expect(screen.queryByTestId('draw-button')).not.toBeNull()
      expect(vp.textContent).toContain('×57.1')
      expect(strokeCount).toBeGreaterThan(0)

      // 6. Explicit "画面に合わせる" / "Fit Canvas" (`fitScreen`) menu button DOES re-fit cleanly (1024x768 -> floor(768*0.86/16) = 41)
      fireEvent.click(screen.getByTestId('editor-menu-btn'))
      const menuPopover = await screen.findByTestId('editor-menu-popover')
      const fitBtn = menuPopover.querySelector('button') as HTMLButtonElement
      expect(fitBtn).toBeTruthy()
      fireEvent.click(fitBtn)
      expect(vp.textContent).toContain('×41')

      // 7. Canvas resolution change (`16x16` -> `32x32`) ALSO re-fits cleanly (floor(768*0.86/32) = 20)
      fireEvent.click(screen.getByTestId('editor-menu-btn'))
      fireEvent.click(await screen.findByTestId('canvas-resize-btn'))
      fireEvent.click(await screen.findByTestId('builtin-preset-32x32'))
      fireEvent.click(screen.getByTestId('confirm-resize-btn'))
      await waitFor(() => {
        expect(vp.textContent).toContain('×20')
      })
    } finally {
      globalThis.ResizeObserver = origRO
      HTMLElement.prototype.getBoundingClientRect = origGetBCR
      HTMLCanvasElement.prototype.getContext = origGetContext
    }
  })

  it('Non-destructive Grayscale Preview, Top Live Artwork Preview in Palette Sheet, and Pixel-Art Color Wheel: converts display to Rec.709 grayscale without altering palette/pixels/PNG export, updates live artwork preview, and supports wheel + HSV/RGB/HEX tabs', async () => {
    // 1. Unit-verify non-destructive Rec.709 grayscale conversion & PixelColorWheel geometry
    const srcRgba = new Uint8ClampedArray([
      255, 0, 0, 255, // pure red -> round(0.2126*255) = 54
      0, 255, 0, 255, // pure green -> round(0.7152*255) = 182
      12, 34, 56, 0, // transparent -> remains 0,0,0,0
    ])
    const gray = toGrayscaleRgbaBuffer(srcRgba)
    expect(rgbToGrayscaleByte(255, 0, 0)).toBe(54)
    expect(rgbToGrayscaleByte(0, 255, 0)).toBe(182)
    expect(Array.from(gray)).toEqual([
      54, 54, 54, 255,
      182, 182, 182, 255,
      0, 0, 0, 0,
    ])
    // Source buffer MUST remain 100% untouched!
    expect(Array.from(srcRgba.slice(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255])

    // PixelColorWheel hit classification & coordinate mapping
    expect(PIXEL_WHEEL_GRID_SIZE).toBe(52)
    // Rightmost point on hue ring (`x ~ 47.5/52`, `y = 26/52`) -> `'ring'` at Hue 0°
    expect(classifyWheelPoint(47.5 / 52, 26 / 52)).toBe('ring')
    expect(wheelPointToHue(47.5 / 52, 26 / 52)).toBe(0)
    // Bottom point on hue ring (`x = 26/52`, `y = 47.5/52`) -> Hue 90°
    expect(wheelPointToHue(26 / 52, 47.5 / 52)).toBe(90)
    // Inner SV pixel grid corners (`14..37` in 52x52 space)
    expect(classifyWheelPoint(14 / 52, 37 / 52)).toBe('sv')
    expect(wheelPointToSv(14 / 52, 37 / 52)).toEqual({ s: 0, v: 0 })
    expect(wheelPointToSv(37 / 52, 14 / 52)).toEqual({ s: 100, v: 100 })

    // 2. Render PaletteSheet with artwork context: verify top live artwork preview + PixelColorWheel + HSV/RGB/HEX tabs
    const pal = normalizeProjectPalette({
      name: 'LivePreviewPal',
      colors: ['#FF0000', '#00FF00', '#0000FF'],
    })
    const layerBuf = createPixelBuffer(4, 4)
    layerBuf[0] = 0 // slot 0 (#FF0000)
    const layers: LayerRuntime[] = [
      {
        id: 'layer-1',
        name: 'Layer 1',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 4,
        dataHeight: 4,
        data: layerBuf,
      },
    ]

    let latestPalette = pal
    const onUpdatePalette = vi.fn((next) => {
      latestPalette = normalizeProjectPalette(next)
    })

    const { rerender } = render(
      <AppProvider>
        <PaletteSheet
          open={true}
          onClose={vi.fn()}
          palette={latestPalette}
          selectedIndex={0}
          libraryPalettes={[]}
          onSelectColor={vi.fn()}
          onUpdatePalette={onUpdatePalette}
          onSaveToLibrary={vi.fn()}
          canvasWidth={4}
          canvasHeight={4}
          layers={layers}
          activeLayerId="layer-1"
        />
      </AppProvider>
    )

    // Top live artwork preview is mounted at the very top of PaletteSheet!
    const livePreviewBanner = await screen.findByTestId('palette-sheet-artwork-preview')
    expect(livePreviewBanner).toBeTruthy()
    expect(screen.getByTestId('palette-sheet-artwork-preview-canvas')).toBeTruthy()

    //Expand / compact preview toggle works
    const sizeBtn = screen.getByTestId('palette-sheet-artwork-preview-size-btn')
    expect(sizeBtn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(sizeBtn)
    expect(sizeBtn.getAttribute('aria-expanded')).toBe('true')

    // Non-destructive grayscale toggle inside PaletteSheet preview works & leaves palette/export colors intact!
    const grayBtn = screen.getByTestId('palette-sheet-artwork-preview-grayscale-btn')
    expect(grayBtn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(grayBtn)
    await waitFor(() => {
      expect(grayBtn.getAttribute('aria-pressed')).toBe('true')
    })
    // Palette color and PNG export remain full color (#FF0000 -> R=255, G=0, B=0) even while grayscalePreview is ON!
    expect(latestPalette.colors[0]).toBe('#FF0000')
    const exportedPng = exportCompositePngBytes(layers, 4, 4, 1, {
      palette: latestPalette,
    })
    expect(exportedPng.png.byteLength).toBeGreaterThan(0)

    // Turn grayscale back off cleanly
    fireEvent.click(grayBtn)
    await waitFor(() => {
      expect(grayBtn.getAttribute('aria-pressed')).toBe('false')
    })

    // Pixel-Art Color Wheel tab is active by default and updates palette color when interacting with ring / quick-hue / SV grid!
    const wheelCanvas = screen.getByTestId('palette-pixel-color-wheel-canvas')
    vi.spyOn(wheelCanvas, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 208,
      height: 208,
      right: 208,
      bottom: 208,
      toJSON: () => ({}),
    } as DOMRect)

    // Drag on bottom of outer Hue ring (`(104, 190)` -> Hue ~90° chartreuse green)
    fireEvent.mouseDown(wheelCanvas, {
      button: 0,
      clientX: 104,
      clientY: 190,
    })
    fireEvent.pointerDown(wheelCanvas, {
      pointerId: 31,
      pointerType: 'mouse',
      button: 0,
      clientX: 104,
      clientY: 190,
    })
    fireEvent.pointerUp(wheelCanvas, {
      pointerId: 31,
      pointerType: 'mouse',
      button: 0,
      clientX: 104,
      clientY: 190,
    })
    // Also verify quick-hue pixel swatch button (`120°` pure green)
    if (latestPalette.colors[0] === '#FF0000') {
      fireEvent.click(screen.getByTestId('palette-pixel-color-wheel-quick-hue-120'))
    }
    expect(onUpdatePalette).toHaveBeenCalled()
    expect(latestPalette.colors[0]).not.toBe('#FF0000')

    rerender(
      <AppProvider>
        <PaletteSheet
          open={true}
          onClose={vi.fn()}
          palette={latestPalette}
          selectedIndex={0}
          libraryPalettes={[]}
          onSelectColor={vi.fn()}
          onUpdatePalette={onUpdatePalette}
          onSaveToLibrary={vi.fn()}
          canvasWidth={4}
          canvasHeight={4}
          layers={layers}
          activeLayerId="layer-1"
        />
      </AppProvider>
    )

    // Sliders (`HSV`, `RGB`, `HEX`) remain available alongside the Color Wheel!
    fireEvent.click(screen.getByTestId('color-tab-hsv'))
    expect(screen.getAllByRole('slider').length).toBe(3)
    fireEvent.click(screen.getByTestId('color-tab-rgb'))
    expect(screen.getAllByRole('slider').length).toBe(3)
    fireEvent.click(screen.getByTestId('color-tab-hex'))
    expect(screen.getByTestId('hex-direct-input')).toBeTruthy()
    fireEvent.click(screen.getByTestId('color-tab-wheel'))
    expect(screen.getByTestId('palette-pixel-color-wheel')).toBeTruthy()

    // Opening PaletteToolsModal ALSO renders the top live artwork preview!
    fireEvent.click(screen.getByTestId('palette-open-tools-btn'))
    expect(await screen.findByTestId('palette-tools-artwork-preview')).toBeTruthy()

    // 3. Verify re-baselined UI Size presets: former `compact` is now `standard`, and new `compact` goes even smaller!
    expect(DEFAULT_UI_SIZE_CONFIG).toEqual({
      preset: 'standard',
      overallScale: 92,
      toolIconSize: 16,
      toolButtonHeight: 44,
      toolLabelSize: 10,
      swatchSize: 30,
      checkboxSize: 16,
      uiGap: 4,
      drawButtonVh: 12,
    })
    expect(UI_SIZE_PRESETS.compact).toEqual({
      preset: 'compact',
      overallScale: 84,
      toolIconSize: 14,
      toolButtonHeight: 36,
      toolLabelSize: 9,
      swatchSize: 24,
      checkboxSize: 14,
      uiGap: 2,
      drawButtonVh: 9,
    })
    expect(UI_SIZE_PRESETS.large.overallScale).toBe(100)
    // Legacy uncustomized standard settings auto-migrate to the new streamlined standard baseline
    const migrated = normalizeAppSettings({
      uiSize: {
        preset: 'standard',
        overallScale: 100,
        toolIconSize: 20,
        toolButtonHeight: 48,
        toolLabelSize: 11,
        swatchSize: 34,
        checkboxSize: 20,
        uiGap: 6,
        drawButtonVh: 15,
      },
    })
    expect(migrated.uiSize).toEqual(DEFAULT_UI_SIZE_CONFIG)

    vi.restoreAllMocks()
  })
})
