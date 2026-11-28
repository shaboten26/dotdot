import { describe, expect, it } from 'vitest'
import { TRANSLATIONS, translate } from '../i18n/translations'
import { compositeLayers, MAX_LAYERS } from '../engine/compositor'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import {
  clampViewportTransform,
  computeFitViewport,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  resizeViewportPreservingZoom,
  screenToCanvasPixel,
  zoomAroundPoint,
} from '../utils/coordinates'
import { modalityFromPointerType } from '../utils/inputDetect'
import type { LayerRuntime } from '../types'

describe('Phase 6 Integration: i18n Completeness, 50-Layer Compositing & Viewport Math', () => {
  it('has 100% matching non-empty translation keys across Japanese, English, and Korean', () => {
    const jaKeys = Object.keys(TRANSLATIONS.ja).sort()
    const enKeys = Object.keys(TRANSLATIONS.en).sort()
    const koKeys = Object.keys(TRANSLATIONS.ko).sort()

    expect(enKeys).toEqual(jaKeys)
    expect(koKeys).toEqual(jaKeys)

    for (const key of jaKeys as Array<keyof typeof TRANSLATIONS.ja>) {
      expect(translate('ja', key).length).toBeGreaterThan(0)
      expect(translate('en', key).length).toBeGreaterThan(0)
      expect(translate('ko', key).length).toBeGreaterThan(0)
    }
  })

  it('composites 100 stacked layers (256x256 max capability check) cleanly', () => {
    expect(MAX_LAYERS).toBe(100)
    const w = 64
    const h = 64
    const layers: LayerRuntime[] = []

    const colors = Array.from({ length: 120 }, (_, i) => {
      const r = ((i * 7 + 13) % 250)
        .toString(16)
        .padStart(2, '0')
      return `#${r}64C8`.toUpperCase()
    })
    for (let i = 0; i < MAX_LAYERS; i++) {
      const buf = createPixelBuffer(w, h)
      setPixel(buf, w, h, i % w, Math.floor(i / w), i)
      layers.push({
        id: `layer-${i}`,
        name: `Layer ${i + 1}`,
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: w,
        dataHeight: h,
        data: buf,
      })
    }

    const comp = compositeLayers(layers, w, h, {
      palette: { name: '100-Layer Pal', colors },
    })
    expect(getPixel(comp, w, h, 0, 0).a).toBe(255)
    expect(getPixel(comp, w, h, 35, 1).a).toBe(255)
    expect(getPixel(comp, w, h, 36, 1).a).toBe(0)
  })

  it('anchors focal pixel during pinch/wheel zoom and prevents canvas from panning completely off-screen', () => {
    const initial = { scale: 8, panX: 40, panY: 60 }
    const focusX = 120
    const focusY = 140
    const beforePixel = screenToCanvasPixel(focusX, focusY, initial)

    const zoomed = zoomAroundPoint(initial, 16, focusX, focusY, 32, 32, 390, 600)
    const afterPixel = screenToCanvasPixel(focusX, focusY, zoomed)
    expect(afterPixel).toEqual(beforePixel)

    const clamped = clampViewportTransform(
      { scale: 8, panX: -99999, panY: 99999 },
      32,
      32,
      390,
      600
    )
    expect(clamped.panX).toBeGreaterThan(-32 * 8)
    expect(clamped.panY).toBeLessThan(600)
  })

  it('classifies touch, mouse, pen, and unknown pointer types accurately without throwing', () => {
    expect(modalityFromPointerType('touch')).toBe('touch')
    expect(modalityFromPointerType('mouse')).toBe('mouse')
    expect(modalityFromPointerType('pen')).toBe('pen')
    expect(modalityFromPointerType('')).toBe('mouse')
    expect(modalityFromPointerType('unknown-stylus')).toBe('mouse')
  })

  it('preserves zoom scale and center canvas coordinate across height, width, rotation, and repeated incremental viewport resizes without drift', () => {
    const canvasW = 32
    const canvasH = 32
    const prevW = 768
    const prevH = 900

    // User zoomed in to 24x around an area of interest
    const zoomedIn = { scale: 24, panX: -120, panY: -80 }
    const origCenterCanvasX = (prevW / 2 - zoomedIn.panX) / zoomedIn.scale
    const origCenterCanvasY = (prevH / 2 - zoomedIn.panY) / zoomedIn.scale

    // 1. Height change (e.g. dock/panel toggle or browser bar)
    const afterHeightChange = resizeViewportPreservingZoom(
      zoomedIn,
      prevW,
      prevH,
      768,
      760,
      canvasW,
      canvasH
    )
    expect(afterHeightChange.scale).toBe(24)
    const nextCenterX1 = (768 / 2 - afterHeightChange.panX) / afterHeightChange.scale
    const nextCenterY1 = (760 / 2 - afterHeightChange.panY) / afterHeightChange.scale
    expect(nextCenterX1).toBeCloseTo(origCenterCanvasX, 6)
    expect(nextCenterY1).toBeCloseTo(origCenterCanvasY, 6)

    // 2. Width change (e.g. split-view / window resize)
    const afterWidthChange = resizeViewportPreservingZoom(
      afterHeightChange,
      768,
      760,
      620,
      760,
      canvasW,
      canvasH
    )
    expect(afterWidthChange.scale).toBe(24)
    const nextCenterX2 = (620 / 2 - afterWidthChange.panX) / afterWidthChange.scale
    expect(nextCenterX2).toBeCloseTo(origCenterCanvasX, 6)

    // 3. Screen rotation equivalent (768x900 -> 1024x700)
    const rotated = resizeViewportPreservingZoom(
      zoomedIn,
      prevW,
      prevH,
      1024,
      700,
      canvasW,
      canvasH
    )
    expect(rotated.scale).toBe(24)
    expect((1024 / 2 - rotated.panX) / rotated.scale).toBeCloseTo(origCenterCanvasX, 6)
    expect((700 / 2 - rotated.panY) / rotated.scale).toBeCloseTo(origCenterCanvasY, 6)

    // 4. Repeated 1px incremental resize steps back and forth must NOT accumulate rounding drift!
    let stepTransform = { ...zoomedIn }
    let curH = prevH
    for (let i = 0; i < 25; i++) {
      stepTransform = resizeViewportPreservingZoom(
        stepTransform,
        prevW,
        curH,
        prevW,
        curH - 1,
        canvasW,
        canvasH
      )
      curH -= 1
    }
    for (let i = 0; i < 25; i++) {
      stepTransform = resizeViewportPreservingZoom(
        stepTransform,
        prevW,
        curH,
        prevW,
        curH + 1,
        canvasW,
        canvasH
      )
      curH += 1
    }
    expect(stepTransform.scale).toBe(24)
    expect(stepTransform.panX).toBeCloseTo(zoomedIn.panX, 6)
    expect(stepTransform.panY).toBeCloseTo(zoomedIn.panY, 6)

    // 5. Clamping & MIN_ZOOM_SCALE / MAX_ZOOM_SCALE remain enforced
    const extreme = resizeViewportPreservingZoom(
      { scale: MAX_ZOOM_SCALE + 50, panX: -999999, panY: 999999 },
      prevW,
      prevH,
      400,
      400,
      canvasW,
      canvasH
    )
    expect(extreme.scale).toBe(MAX_ZOOM_SCALE)
    expect(extreme.scale).toBeGreaterThanOrEqual(MIN_ZOOM_SCALE)
    expect(extreme.panX).toBeGreaterThan(-canvasW * MAX_ZOOM_SCALE)
    expect(extreme.panY).toBeLessThan(400)

    // Explicit fit helper remains intact
    const fitted = computeFitViewport(canvasW, canvasH, 400, 400, 0.86)
    expect(fitted.scale).toBe(Math.floor((400 * 0.86) / canvasW))
  })
})
