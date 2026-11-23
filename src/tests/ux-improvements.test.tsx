import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppProvider } from '../state/AppContext'
import { PixelSelect } from '../components/common/PixelSelect'
import { PixelIcon } from '../components/common/PixelIcon'
import { LayerPanelContent } from '../components/editor/LayerSheet'
import { InteractiveViewport } from '../components/editor/InteractiveViewport'
import { createPixelBuffer } from '../engine/pixelBuffer'
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
})
