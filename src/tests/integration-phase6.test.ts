import { describe, expect, it } from 'vitest'
import { TRANSLATIONS, translate } from '../i18n/translations'
import { compositeLayers, MAX_LAYERS } from '../engine/compositor'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import {
  clampViewportTransform,
  screenToCanvasPixel,
  zoomAroundPoint,
} from '../utils/coordinates'
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

  it('composites 50 stacked layers (256x256 max capability check) cleanly', () => {
    expect(MAX_LAYERS).toBe(50)
    const w = 64
    const h = 64
    const layers: LayerRuntime[] = []

    for (let i = 0; i < MAX_LAYERS; i++) {
      const buf = createPixelBuffer(w, h)
      setPixel(buf, w, h, i % w, Math.floor(i / w), {
        r: (i * 5) % 256,
        g: 100,
        b: 200,
        a: 255,
      })
      layers.push({
        id: `layer-${i}`,
        name: `Layer ${i + 1}`,
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        data: buf,
      })
    }

    const comp = compositeLayers(layers, w, h)
    expect(getPixel(comp, w, h, 0, 0).a).toBe(255)
    expect(getPixel(comp, w, h, 49, 0).a).toBe(255)
    expect(getPixel(comp, w, h, 50, 0).a).toBe(0)
  })

  it('anchors focal pixel during pinch/wheel zoom and prevents canvas from panning completely off-screen', () => {
    const initial = { scale: 8, panX: 40, panY: 60 }
    const focusX = 120
    const focusY = 140
    const beforePixel = screenToCanvasPixel(focusX, focusY, initial)

    const zoomed = zoomAroundPoint(initial, 16, focusX, focusY, 32, 32, 390, 600)
    const afterPixel = screenToCanvasPixel(focusX, focusY, zoomed)
    expect(afterPixel).toEqual(beforePixel)

    // Extreme off-screen pan gets clamped back so user never loses the canvas
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
})
