import { describe, expect, it } from 'vitest'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import {
  compositeFloatingShapeOntoLayer,
  rasterizeTransformedShape,
} from '../engine/transform'
import {
  applySelectionOutline,
  computeSelectionOutlineMask,
  copySelection,
  cutSelection,
  flipSelectionContent,
  invertSelectionMask,
  mergeSelectionMasks,
  moveSelectionContent,
  pasteClipboard,
  selectEllipseMask,
  selectRectangleMask,
  selectSameColor,
} from '../engine/selection'
import {
  compositeLayers,
  decodePngBasic,
  exportCompositePngBytes,
  getDefaultExportScale,
  getExportScaleOptions,
  MAX_EXPORT_DIMENSION,
  MAX_LAYERS,
  mergeTwoLayers,
} from '../engine/compositor'
import {
  captureCanvasSnapshot,
  createPixelPatch,
  HistoryManager,
  type EditorRuntimeStateForHistory,
} from '../engine/history'
import type { FloatingShapeState, LayerRuntime } from '../types'

const RED = { r: 255, g: 0, b: 0, a: 255 }
const GREEN = { r: 0, g: 255, b: 0, a: 255 }
const BLUE = { r: 0, g: 0, b: 255, a: 255 }
const WHITE = { r: 255, g: 255, b: 255, a: 255 }

describe('Shape Transform (90deg / 5deg Nearest-Neighbor & Non-destructive)', () => {
  it('rotates 90deg losslessly and 5deg increments from original buffer with zero anti-aliasing', () => {
    const src = createPixelBuffer(4, 2)
    for (let x = 0; x < 4; x++) {
      setPixel(src, 4, 2, x, 0, RED)
      setPixel(src, 4, 2, x, 1, BLUE)
    }

    const baseState: FloatingShapeState = {
      sourceBuffer: src,
      sourceWidth: 4,
      sourceHeight: 2,
      offsetX: 4,
      offsetY: 4,
      rotationDeg: 90,
    }

    const rot90 = rasterizeTransformedShape(baseState)
    expect(rot90.width).toBe(2)
    expect(rot90.height).toBe(4)

    const rot360 = rasterizeTransformedShape({
      ...baseState,
      rotationDeg: 5 * 72,
    })
    expect(rot360.width).toBe(4)
    expect(rot360.height).toBe(2)
    expect(Array.from(rot360.buffer)).toEqual(Array.from(src))

    const rot15 = rasterizeTransformedShape({
      ...baseState,
      rotationDeg: 15,
    })
    for (let i = 0; i < rot15.buffer.length; i += 4) {
      const a = rot15.buffer[i + 3]
      expect(a === 0 || a === 255).toBe(true)
      if (a === 255) {
        const isRed = rot15.buffer[i] === 255 && rot15.buffer[i + 2] === 0
        const isBlue = rot15.buffer[i] === 0 && rot15.buffer[i + 2] === 255
        expect(isRed || isBlue).toBe(true)
      }
    }

    const layer = createPixelBuffer(12, 12)
    setPixel(layer, 12, 12, 5, 5, GREEN)
    const preview = compositeFloatingShapeOntoLayer(layer, 12, 12, {
      ...baseState,
      rotationDeg: 0,
    })
    expect(getPixel(layer, 12, 12, 5, 5)).toEqual(GREEN)
    expect(getPixel(preview, 12, 12, 5, 5)).toEqual(BLUE)
  })
})

describe('Selection Engine (Wand 4/8, Rect, Ellipse, Union, Invert, Move, Flip, Outline, Cut/Copy/Paste)', () => {
  it('supports 4/8 wand, rect, ellipse, additive union, and inversion', () => {
    const buf = createPixelBuffer(8, 8)
    setPixel(buf, 8, 8, 1, 1, RED)
    setPixel(buf, 8, 8, 2, 2, RED)

    const wand4 = selectSameColor(buf, 8, 8, 1, 1, 4)
    const wand8 = selectSameColor(buf, 8, 8, 1, 1, 8)
    expect(wand4.reduce((a, b) => a + b, 0)).toBe(1)
    expect(wand8.reduce((a, b) => a + b, 0)).toBe(2)

    const rect = selectRectangleMask(8, 8, { x: 4, y: 4 }, { x: 5, y: 5 })
    expect(rect.reduce((a, b) => a + b, 0)).toBe(4)

    const union = mergeSelectionMasks(wand8, rect)
    expect(union.reduce((a, b) => a + b, 0)).toBe(6)

    const inv = invertSelectionMask(union, 8, 8)
    expect(inv.reduce((a, b) => a + b, 0)).toBe(64 - 6)

    const ell = selectEllipseMask(10, 10, { x: 2, y: 2 }, { x: 7, y: 7 })
    expect(ell.reduce((a, b) => a + b, 0)).toBeGreaterThan(20)
  })

  it('moves selection 1px clearing source, flips H/V, and cuts/copies/pastes accurately', () => {
    const buf = createPixelBuffer(8, 8)
    setPixel(buf, 8, 8, 2, 2, RED)
    setPixel(buf, 8, 8, 3, 2, BLUE)
    const mask = selectRectangleMask(8, 8, { x: 2, y: 2 }, { x: 3, y: 2 })

    const moved = moveSelectionContent(buf, mask, 8, 8, 1, 2)
    expect(getPixel(moved.nextBuffer, 8, 8, 2, 2).a).toBe(0)
    expect(getPixel(moved.nextBuffer, 8, 8, 3, 4)).toEqual(RED)
    expect(getPixel(moved.nextBuffer, 8, 8, 4, 4)).toEqual(BLUE)
    expect(moved.nextMask[4 * 8 + 3]).toBe(1)

    const flipped = flipSelectionContent(buf, mask, 8, 8, 'horizontal')
    expect(getPixel(flipped.nextBuffer, 8, 8, 2, 2)).toEqual(BLUE)
    expect(getPixel(flipped.nextBuffer, 8, 8, 3, 2)).toEqual(RED)

    const clip = copySelection(buf, mask, 8, 8)
    expect(clip).not.toBeNull()
    const cut = cutSelection(buf, mask, 8, 8)
    expect(getPixel(cut.nextBuffer, 8, 8, 2, 2).a).toBe(0)

    const pasted = pasteClipboard(cut.nextBuffer, clip!, 8, 8, 5, 6)
    expect(getPixel(pasted.nextBuffer, 8, 8, 5, 6)).toEqual(RED)
    expect(getPixel(pasted.nextBuffer, 8, 8, 6, 6)).toEqual(BLUE)
  })

  it('distinguishes Normal outline vs Pixel-Perfect outline around a selection', () => {
    const w = 7
    const h = 7
    const singlePixelMask = selectRectangleMask(w, h, { x: 3, y: 3 }, { x: 3, y: 3 })

    const normalOutline = computeSelectionOutlineMask(singlePixelMask, w, h, 'normal', 1)
    const ppOutline = computeSelectionOutlineMask(singlePixelMask, w, h, 'pixelPerfect', 1)

    expect(normalOutline.reduce((a, b) => a + b, 0)).toBe(8)
    expect(ppOutline.reduce((a, b) => a + b, 0)).toBe(4)

    const buf = createPixelBuffer(w, h)
    setPixel(buf, w, h, 3, 3, WHITE)
    const outlined = applySelectionOutline(buf, singlePixelMask, w, h, 'pixelPerfect', 1, RED)
    expect(getPixel(outlined, w, h, 3, 2)).toEqual(RED)
    expect(getPixel(outlined, w, h, 2, 2).a).toBe(0)
  })
})

describe('Compositor, Clipping, Blend Modes & Lossless Nearest-Neighbor PNG Export (4000px Max / ~2000px Default)', () => {
  it('supports up to 100 layers constant, blend modes, opacity, clipping, and non-destructive merge down', () => {
    expect(MAX_LAYERS).toBe(100)

    const baseData = createPixelBuffer(4, 4)
    setPixel(baseData, 4, 4, 1, 1, { r: 200, g: 100, b: 50, a: 255 })

    const clipData = createPixelBuffer(4, 4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        setPixel(clipData, 4, 4, x, y, { r: 128, g: 128, b: 128, a: 255 })
      }
    }

    const baseLayer: LayerRuntime = {
      id: 'l1',
      name: 'Base',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 4,
      dataHeight: 4,
      data: baseData,
    }
    const clipLayer: LayerRuntime = {
      id: 'l2',
      name: 'ClipShadow',
      visible: true,
      opacity: 100,
      blendMode: 'multiply',
      clipping: true,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 4,
      dataHeight: 4,
      data: clipData,
    }

    const comp = compositeLayers([baseLayer, clipLayer], 4, 4)
    expect(getPixel(comp, 4, 4, 0, 0).a).toBe(0)
    const inside = getPixel(comp, 4, 4, 1, 1)
    expect(inside.a).toBe(255)
    expect(inside.r).toBeCloseTo(Math.round((200 * 128) / 255), 0)

    const merged = mergeTwoLayers(baseLayer, clipLayer, 4, 4)
    expect(Array.from(merged.data)).toEqual(Array.from(comp))
  })

  it('computes valid export scales <= 4000px, defaults to floor(2000 / L) <= 2000px long edge, and encodes/decodes transparent PNG losslessly', () => {
    expect(MAX_EXPORT_DIMENSION).toBe(4000)

    const scales32 = getExportScaleOptions(32, 32)
    expect(scales32[0]).toEqual({ scale: 1, width: 32, height: 32, label: '1x (32×32px)' })
    const last32 = scales32[scales32.length - 1]
    expect(last32.scale).toBe(125) // 32 * 125 = 4000 <= 4000
    expect(last32.width).toBeLessThanOrEqual(4000)

    // Initial scale MUST be floor(2000 / L) (minimum 1x) so output long edge NEVER exceeds 2000px by default
    expect(getDefaultExportScale(256, 256)).toBe(7)  // 1792x1792px
    expect(getDefaultExportScale(128, 128)).toBe(15) // 1920x1920px
    expect(getDefaultExportScale(96, 96)).toBe(20)   // 1920x1920px
    expect(getDefaultExportScale(80, 80)).toBe(25)   // 2000x2000px
    expect(getDefaultExportScale(64, 64)).toBe(31)   // 1984x1984px
    expect(getDefaultExportScale(32, 32)).toBe(62)   // 1984x1984px
    expect(getDefaultExportScale(128, 64)).toBe(15)  // rectangular L=128 -> 15x (1920x960px)

    const layerData = createPixelBuffer(2, 2)
    setPixel(layerData, 2, 2, 0, 0, RED)
    const layer: LayerRuntime = {
      id: 'l1',
      name: 'Layer 1',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 2,
      dataHeight: 2,
      data: layerData,
    }

    const { png, outWidth, outHeight } = exportCompositePngBytes([layer], 2, 2, 3)
    expect(outWidth).toBe(6)
    expect(outHeight).toBe(6)

    const decoded = decodePngBasic(png)
    expect(decoded.width).toBe(6)
    expect(decoded.height).toBe(6)
    expect(getPixel(decoded.data, 6, 6, 2, 2)).toEqual(RED)
    expect(getPixel(decoded.data, 6, 6, 3, 2)).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })
})

describe('Sparse Diff HistoryManager (Undo/Redo, Limits & Serialization)', () => {
  it('records sparse pixel diffs, enforces history limit, and round-trips serialization', () => {
    const mgr = new HistoryManager(2)
    const buf0 = createPixelBuffer(4, 4)
    const buf1 = new Uint8ClampedArray(buf0)
    setPixel(buf1, 4, 4, 0, 0, RED)
    const buf2 = new Uint8ClampedArray(buf1)
    setPixel(buf2, 4, 4, 1, 1, GREEN)
    const buf3 = new Uint8ClampedArray(buf2)
    setPixel(buf3, 4, 4, 2, 2, BLUE)

    const p1 = createPixelPatch('l1', buf0, buf1)!
    const p2 = createPixelPatch('l1', buf1, buf2)!
    const p3 = createPixelPatch('l1', buf2, buf3)!

    expect(p1.indices.length).toBe(1)

    mgr.push({ id: '1', label: 'stroke1', timestamp: 1, kind: 'pixel-diff', pixelPatches: [p1] })
    mgr.push({ id: '2', label: 'stroke2', timestamp: 2, kind: 'pixel-diff', pixelPatches: [p2] })
    mgr.push({ id: '3', label: 'stroke3', timestamp: 3, kind: 'pixel-diff', pixelPatches: [p3] })

    expect(mgr.getUndoCount()).toBe(2)

    const serialized = mgr.serialize()
    const mgr2 = new HistoryManager(2)
    mgr2.hydrate(serialized)

    let runtimeState: EditorRuntimeStateForHistory = {
      width: 4,
      height: 4,
      layers: [
        {
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
          data: buf3,
        },
      ],
      activeLayerId: 'l1',
      selectionMask: null,
      palette: { name: 'Default', colors: ['#FF0000'] },
    }

    runtimeState = mgr2.undo(runtimeState)!
    expect(getPixel(runtimeState.layers[0].data, 4, 4, 2, 2).a).toBe(0)
    expect(getPixel(runtimeState.layers[0].data, 4, 4, 1, 1)).toEqual(GREEN)

    runtimeState = mgr2.redo(runtimeState)!
    expect(getPixel(runtimeState.layers[0].data, 4, 4, 2, 2)).toEqual(BLUE)

    const snap = captureCanvasSnapshot(4, 4, runtimeState.layers, 'l1')
    expect(snap.layers.length).toBe(1)
  })
})
