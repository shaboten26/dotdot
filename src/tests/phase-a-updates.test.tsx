import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  BACKUP_REMINDER_INTERVAL_MS,
  BACKUP_SNOOZE_INTERVAL_MS,
  BUILT_IN_CANVAS_PRESETS,
  hasCanvasPresetDimensions,
  shouldShowBackupReminder,
} from '../db/database'
import {
  computeResizeAnchorOffset,
  countPixelsOutsideResizedCanvas,
  createPixelBuffer,
  extractLayerCanvasView,
  getPixel,
  resizeLayersWithAnchor,
  setPixel,
} from '../engine/pixelBuffer'
import { stampPoints } from '../engine/brush'
import { applyFloodFill, applyGradientFloodFill } from '../engine/floodFill'
import {
  computeShapeBounds,
  drawCubicBezier,
  drawLine,
  rasterizeEllipse,
  rasterizeRectangle,
} from '../engine/rasterize'
import { selectRectangleMask } from '../engine/selection'
import { HistoryManager } from '../engine/history'
import { PixelSlider } from '../components/common/PixelSlider'
import type { LayerRuntime } from '../types'

const RED = { r: 1, g: 1, b: 1, a: 255 }
const BLUE = { r: 2, g: 2, b: 2, a: 255 }
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 }

describe('Phase A Additions: Transparent Slot, 9-Way Anchor Resize, Standard Presets, Multi-Layer Move, Backup Reminder & Out-of-Canvas Endpoints', () => {
  it('paints transparent RGBA(0,0,0,0) across Pen, Dither, Flood Fill, Gradient Fill, Line, Bezier, and Shape while keeping "." dither pixels intact', () => {
    const w = 8
    const h = 8
    const buf = createPixelBuffer(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        setPixel(buf, w, h, x, y, RED)
      }
    }

    // 1. Pen with transparent color + Checkerboard dither (pattern 5 = 50%): half cleared, half stays RED
    stampPoints(buf, [{ x: 0, y: 0 }], {
      width: w,
      height: h,
      size: 2,
      shape: 'square',
      color: TRANSPARENT,
      dither: 5,
    })
    let transparentCount = 0
    let redCount = 0
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const px = getPixel(buf, w, h, x, y)
        if (px.a === 0) transparentCount++
        else if (px.r === RED.r) redCount++
      }
    }
    expect(transparentCount).toBe(2)
    expect(redCount).toBe(2)

    // 2. Line, Bezier & Shape with transparent color clear pixels to alpha=0 (TRANSPARENT_INDEX)
    const buf2 = createPixelBuffer(w, h)
    buf2.fill(BLUE.r)
    drawLine(buf2, { x: 0, y: 0 }, { x: 3, y: 0 }, {
      width: w,
      height: h,
      size: 1,
      shape: 'square',
      dither: 1,
      color: TRANSPARENT,
      pixelPerfect: true,
    })
    expect(getPixel(buf2, w, h, 2, 0)).toEqual(TRANSPARENT)

    drawCubicBezier(
      buf2,
      { x: 0, y: 2 },
      { x: 2, y: 2 },
      { x: 5, y: 2 },
      { x: 7, y: 2 },
      {
        width: w,
        height: h,
        size: 1,
        shape: 'square',
        dither: 1,
        color: TRANSPARENT,
      }
    )
    expect(getPixel(buf2, w, h, 4, 2)).toEqual(TRANSPARENT)

    rasterizeRectangle(
      buf2,
      computeShapeBounds({ x: 1, y: 4 }, { x: 3, y: 6 }, false),
      {
        width: w,
        height: h,
        filled: true,
        strokeSize: 1,
        dither: 1,
        color: TRANSPARENT,
      }
    )
    expect(getPixel(buf2, w, h, 2, 5)).toEqual(TRANSPARENT)

    // 3. Flood Fill & Gradient Fill with transparent color
    const buf3 = createPixelBuffer(4, 4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        setPixel(buf3, 4, 4, x, y, RED)
      }
    }
    applyFloodFill(buf3, {
      width: 4,
      height: 4,
      seedX: 0,
      seedY: 0,
      color: TRANSPARENT,
      connectivity: 4,
      dither: 1,
    })
    expect(getPixel(buf3, 4, 4, 3, 3)).toEqual(TRANSPARENT)

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        setPixel(buf3, 4, 4, x, y, RED)
      }
    }
    applyGradientFloodFill(buf3, {
      width: 4,
      height: 4,
      startX: 0,
      startY: 0,
      endX: 3,
      endY: 0,
      color: TRANSPARENT,
      steps: 4,
    })
    expect(getPixel(buf3, 4, 4, 0, 0)).toEqual(TRANSPARENT)
  })

  it('enforces exact 5 standard canvas size presets and prevents duplicate custom preset dimensions', () => {
    expect(
      BUILT_IN_CANVAS_PRESETS.map((p) => `${p.width}x${p.height}`)
    ).toEqual(['16x16', '32x32', '64x64', '96x96', '128x128'])

    const customs = [
      { id: 'c1', name: 'Sprite', width: 48, height: 64 },
    ]
    expect(hasCanvasPresetDimensions(customs, 32, 32)).toBe(true)
    expect(hasCanvasPresetDimensions(customs, 48, 64)).toBe(true)
    expect(hasCanvasPresetDimensions(customs, 48, 64, 'c1')).toBe(false)
    expect(hasCanvasPresetDimensions(customs, 64, 48)).toBe(false)
  })

  it('resizes canvas across all 9 anchors deterministically while preserving relative layer positions and off-canvas pixels', () => {
    expect(computeResizeAnchorOffset(4, 4, 7, 7, 'center')).toEqual({
      shiftX: 1,
      shiftY: 1,
    })
    expect(computeResizeAnchorOffset(4, 4, 8, 8, 'bottom-right')).toEqual({
      shiftX: 4,
      shiftY: 4,
    })
    expect(computeResizeAnchorOffset(4, 4, 8, 8, 'top-left')).toEqual({
      shiftX: 0,
      shiftY: 0,
    })

    const d1 = createPixelBuffer(4, 4)
    setPixel(d1, 4, 4, 0, 0, RED)
    const d2 = createPixelBuffer(4, 4)
    setPixel(d2, 4, 4, 3, 3, BLUE)

    const l1: LayerRuntime = {
      id: 'l1',
      name: 'L1',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 4,
      dataHeight: 4,
      data: d1,
    }
    const l2: LayerRuntime = {
      id: 'l2',
      name: 'L2',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 1,
      offsetY: -1,
      dataWidth: 4,
      dataHeight: 4,
      data: d2,
    }

    const { layers: grown } = resizeLayersWithAnchor(
      [l1, l2],
      4,
      4,
      8,
      8,
      'bottom-right'
    )
    // l1 had RED at world (0,0) -> shifted (+4,+4) -> world (4,4)
    // l2 had BLUE at world (1+3, -1+3) = (4,2) -> shifted (+4,+4) -> world (8,6) (preserved off-canvas!)
    const view1 = extractLayerCanvasView(grown[0], 8, 8)
    expect(getPixel(view1, 8, 8, 4, 4)).toEqual(RED)
    // Verify l2's pixel at world (8,6) is preserved in grown[1] backing buffer at (8 - offsetX, 6 - offsetY)
    expect(
      getPixel(
        grown[1].data,
        grown[1].dataWidth,
        grown[1].dataHeight,
        8 - grown[1].offsetX,
        6 - grown[1].offsetY
      )
    ).toEqual(BLUE)

    const outside = countPixelsOutsideResizedCanvas(
      [l1],
      4,
      4,
      2,
      2,
      'bottom-right'
    )
    expect(outside).toBe(1)
  })

  it('supports undo/redo of multi-layer batch offset moves preserving relative positions', () => {
    const mgr = new HistoryManager(20)
    const l1: LayerRuntime = {
      id: 'l1',
      name: 'L1',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 5,
      offsetY: 6,
      dataWidth: 8,
      dataHeight: 8,
      data: createPixelBuffer(8, 8),
    }
    const l2: LayerRuntime = {
      ...l1,
      id: 'l2',
      name: 'L2',
      offsetX: 8,
      offsetY: 10,
    }

    mgr.push({
      id: 'hm-1',
      label: 'Move Selected Layers',
      timestamp: 100,
      kind: 'layer-offset',
      layerOffsetChanges: [
        {
          layerId: 'l1',
          beforeOffsetX: 0,
          beforeOffsetY: 0,
          afterOffsetX: 5,
          afterOffsetY: 6,
        },
        {
          layerId: 'l2',
          beforeOffsetX: 3,
          beforeOffsetY: 4,
          afterOffsetX: 8,
          afterOffsetY: 10,
        },
      ],
    })

    const undone = mgr.undo({
      width: 8,
      height: 8,
      layers: [l1, l2],
      activeLayerId: 'l1',
      selectionMask: null,
      palette: { name: 'P', colors: ['#000000'] },
    })!
    expect(undone.layers[0].offsetX).toBe(0)
    expect(undone.layers[1].offsetX).toBe(3)

    const redone = mgr.redo(undone)!
    expect(redone.layers[0].offsetX).toBe(5)
    expect(redone.layers[1].offsetY).toBe(10)
  })

  it('handles out-of-canvas endpoints cleanly for Line, Ellipse, and Selection', () => {
    const w = 8
    const h = 8
    const buf = createPixelBuffer(w, h)
    drawLine(buf, { x: -4, y: -4 }, { x: 11, y: 11 }, {
      width: w,
      height: h,
      size: 1,
      shape: 'square',
      dither: 1,
      color: RED,
    })
    expect(getPixel(buf, w, h, 0, 0)).toEqual(RED)
    expect(getPixel(buf, w, h, 7, 7)).toEqual(RED)

    const bufEll = createPixelBuffer(w, h)
    rasterizeEllipse(
      bufEll,
      computeShapeBounds({ x: -2, y: -2 }, { x: 9, y: 9 }, false),
      {
        width: w,
        height: h,
        filled: true,
        strokeSize: 1,
        dither: 1,
        color: BLUE,
      }
    )
    expect(getPixel(bufEll, w, h, 4, 4)).toEqual(BLUE)

    const sel = selectRectangleMask(w, h, { x: -5, y: 2 }, { x: 12, y: 3 })
    expect(sel.reduce((a, b) => a + b, 0)).toBe(16)
  })

  it('evaluates 30-day / 7-day Environment Pack backup reminder accurately', () => {
    const t0 = 1_000_000_000
    const dayMs = 24 * 60 * 60 * 1000
    expect(
      shouldShowBackupReminder(
        {
          lastExportAt: null,
          lastNotifiedAt: null,
          nextNotifyAt: null,
          firstProjectCreatedAt: null,
        },
        t0 + 40 * dayMs
      )
    ).toBe(false)

    const metaNever = {
      lastExportAt: null,
      lastNotifiedAt: null,
      nextNotifyAt: null,
      firstProjectCreatedAt: t0,
    }
    expect(
      shouldShowBackupReminder(metaNever, t0 + BACKUP_REMINDER_INTERVAL_MS - dayMs)
    ).toBe(false)
    expect(
      shouldShowBackupReminder(metaNever, t0 + BACKUP_REMINDER_INTERVAL_MS + dayMs)
    ).toBe(true)

    const snoozedAt = t0 + BACKUP_REMINDER_INTERVAL_MS + dayMs
    const metaSnoozed = {
      ...metaNever,
      lastNotifiedAt: snoozedAt,
      nextNotifyAt: snoozedAt + BACKUP_SNOOZE_INTERVAL_MS,
    }
    expect(shouldShowBackupReminder(metaSnoozed, snoozedAt + 3 * dayMs)).toBe(false)
    expect(
      shouldShowBackupReminder(metaSnoozed, snoozedAt + BACKUP_SNOOZE_INTERVAL_MS + dayMs)
    ).toBe(true)

    const exportedAt = snoozedAt + BACKUP_SNOOZE_INTERVAL_MS + dayMs
    const metaExported = {
      lastExportAt: exportedAt,
      lastNotifiedAt: exportedAt,
      nextNotifyAt: exportedAt + BACKUP_REMINDER_INTERVAL_MS,
      firstProjectCreatedAt: t0,
    }
    expect(shouldShowBackupReminder(metaExported, exportedAt + 10 * dayMs)).toBe(false)
    expect(
      shouldShowBackupReminder(
        metaExported,
        exportedAt + BACKUP_REMINDER_INTERVAL_MS + dayMs
      )
    ).toBe(true)
  })

  it('renders PixelSlider with +/- step buttons that step accurately and disable at min/max', () => {
    const values: number[] = []
    const { rerender } = render(
      <PixelSlider
        min={1}
        max={3}
        step={1}
        value={1}
        ariaLabel="Size"
        onChange={(v) => values.push(v)}
        testId="test-slider"
      />
    )
    const decBtn = screen.getByTestId('test-slider-minus') as HTMLButtonElement
    const incBtn = screen.getByTestId('test-slider-plus') as HTMLButtonElement
    expect(decBtn.disabled).toBe(true)
    expect(incBtn.disabled).toBe(false)

    fireEvent.click(incBtn)
    expect(values).toEqual([2])

    rerender(
      <PixelSlider
        min={1}
        max={3}
        step={1}
        value={3}
        ariaLabel="Size"
        onChange={(v) => values.push(v)}
        testId="test-slider"
      />
    )
    expect(incBtn.disabled).toBe(true)
    expect(decBtn.disabled).toBe(false)
  })
})
