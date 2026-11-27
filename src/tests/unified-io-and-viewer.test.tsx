import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { unzipSync } from 'fflate'
import { App } from '../App'
import { db, resetAllAppData } from '../db/database'
import { encodeRgbaToPng } from '../engine/compositor'
import { encodeAnimatedGifSync } from '../engine/gifEncoder'
import { encodeAsepriteBytes } from '../engine/aseprite'
import {
  encodeFramesToAnimatedSvg,
  encodeNumberedPngFramesZip,
  encodeRgba1xToIco,
  encodeRgbaToBmp32,
  encodeRgbaToCrispSvg,
} from '../engine/multiFormatExport'
import { detectArtworkFileKind } from '../components/common/UnifiedImportModal'
import { normalizeProjectPalette } from '../engine/indexedPalette'

describe('Unified Import, Multi-Format Export & Animated Detail Viewer (v2.6.x)', () => {
  beforeEach(async () => {
    await resetAllAppData(db)
  })

  afterEach(async () => {
    cleanup()
    await resetAllAppData(db)
  })

  it('1. Multi-Format Export Encoders: encodes crisp SVG, animated CSS-keyframe SVG, 32-bit BGRA BMP, ICO (<=256px), and numbered PNG ZIP accurately', () => {
    const rgba1x = new Uint8ClampedArray(4 * 4 * 4)
    // Red horizontal run at row 0 (x=0..2), Semi-transparent Teal at (3,3)
    for (let x = 0; x < 3; x++) {
      const i = x * 4
      rgba1x[i] = 255
      rgba1x[i + 1] = 0
      rgba1x[i + 2] = 0
      rgba1x[i + 3] = 255
    }
    const last = (3 * 4 + 3) * 4
    rgba1x[last] = 0
    rgba1x[last + 1] = 180
    rgba1x[last + 2] = 160
    rgba1x[last + 3] = 128

    // Crisp SVG merges horizontal run into width="3"
    const svg = encodeRgbaToCrispSvg(rgba1x, 4, 4, 10)
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).toContain('width="40" height="40" viewBox="0 0 4 4"')
    expect(svg).toContain('<rect x="0" y="0" width="3" height="1" fill="#FF0000"/>')
    expect(svg).toContain('fill-opacity="0.502"')

    // Animated SVG generates CSS step-end keyframes for 2 frames
    const frame2 = new Uint8ClampedArray(4 * 4 * 4)
    frame2.set([30, 120, 255, 255], (1 * 4 + 1) * 4)
    const animSvg = encodeFramesToAnimatedSvg(
      [
        { rgba: rgba1x, durationMs: 120 },
        { rgba: frame2, durationMs: 180 },
      ],
      4,
      4,
      8,
      true
    )
    expect(animSvg).toContain('@keyframes dotdot-f0')
    expect(animSvg).toContain('@keyframes dotdot-f1')
    expect(animSvg).toContain('300ms step-end infinite')

    // 32-bit BMP ('BM' header + 54-byte offset + bottom-up BGRA)
    const bmp = encodeRgbaToBmp32(rgba1x, 4, 4)
    expect(bmp[0]).toBe(0x42) // 'B'
    expect(bmp[1]).toBe(0x4d) // 'M'
    expect(bmp.length).toBe(54 + 4 * 4 * 4)

    // ICO clamps maximum dimensions <= 256x256px and embeds PNG payload
    const { icoBytes, icoWidth, icoHeight } = encodeRgba1xToIco(rgba1x, 4, 4, 100)
    expect(icoWidth).toBe(256)
    expect(icoHeight).toBe(256)
    expect(icoBytes[2]).toBe(1) // ICO type = 1
    expect(icoBytes[6]).toBe(0) // 0 means 256px in ICO spec
    expect(icoBytes[22]).toBe(0x89) // Embedded PNG magic byte

    // Numbered PNG ZIP bundles all frames with duration labels
    const zipBytes = encodeNumberedPngFramesZip(
      'hero',
      [
        { rgba: rgba1x, durationMs: 100 },
        { rgba: frame2, durationMs: 250 },
      ],
      4,
      4,
      2,
      true
    )
    const unzipped = unzipSync(zipBytes)
    expect(Object.keys(unzipped).sort()).toEqual([
      'hero_001_100ms.png',
      'hero_002_250ms.png',
    ])
  })

  it('2. Auto-Detection (`detectArtworkFileKind`): distinguishes PNG, GIF89a/87a, and Aseprite by magic header even with mismatched extensions', () => {
    const pngBytes = encodeRgbaToPng(new Uint8ClampedArray(16), 2, 2)
    const gifBytes = encodeAnimatedGifSync({
      width: 2,
      height: 2,
      frames: [{ rgba: new Uint8ClampedArray(16), durationMs: 100 }],
    }).gif
    const pal = normalizeProjectPalette({
      name: 'Test',
      colors: ['#000000', '#FF0000'],
    })
    const aseRes = encodeAsepriteBytes({
      width: 2,
      height: 2,
      layerMetas: [
        {
          id: 'l1',
          name: 'Layer 1',
          visible: true,
          locked: false,
          opacity: 100,
          blendMode: 'normal',
          clipping: false,
        },
      ],
      frames: [{ id: 'f1', durationMs: 100 }],
      cels: {},
      celBuffers: {},
      palette: pal,
      paletteColors: pal.colors,
    })

    expect(detectArtworkFileKind('renamed.bin', pngBytes)).toBe('png')
    expect(detectArtworkFileKind('renamed.bin', gifBytes)).toBe('gif')
    expect(detectArtworkFileKind('renamed.bin', aseRes.bytes)).toBe('aseprite')
    expect(detectArtworkFileKind('unknown.txt', new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('3. Editor & Detail UX: hides Editor 3-line imports, shows `画像を出力` for 1f vs `アニメーションを出力` + `このフレームを出力` for >=2f, and animates multi-frame Detail preview', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // Create 16x16 artwork
    fireEvent.click(await screen.findByTestId('empty-create-artwork-btn'))
    fireEvent.click(screen.getByTestId('builtin-preset-16x16'))
    fireEvent.click(screen.getByTestId('confirm-create-artwork-btn'))
    await screen.findByTestId('workspace-tab-tools')

    // 1-frame Editor 3-line menu: NO import items, shows `画像を出力`, NO `このフレームを出力`, NO `スプライトシート出力`
    fireEvent.click(screen.getByTestId('editor-menu-btn'))
    expect(screen.queryByTestId('editor-import-png-btn')).toBeNull()
    expect(screen.queryByTestId('editor-import-gif-btn')).toBeNull()
    expect(screen.queryByTestId('editor-import-aseprite-btn')).toBeNull()
    expect(screen.queryByTestId('editor-export-current-frame-btn')).toBeNull()
    expect(screen.queryByTestId('editor-export-spritesheet-btn')).toBeNull()
    const editorExport1f = screen.getByTestId('editor-export-btn')
    expect(editorExport1f.textContent).toContain('画像を出力')

    // Open `画像を出力` modal -> default format is PNG, and SVG/WebP/BMP/JPEG/ICO options exist
    fireEvent.click(editorExport1f)
    expect(await screen.findByTestId('unified-export-modal')).toBeTruthy()
    const formatSelectBtn = screen.getByTestId('export-format-select')
    expect(formatSelectBtn.textContent).toContain('PNG')
    fireEvent.click(formatSelectBtn)
    expect(await screen.findByText(/SVG（ベクター/)).toBeTruthy()
    expect(screen.getByText(/WebP/)).toBeTruthy()
    expect(screen.getByText(/BMP/)).toBeTruthy()
    expect(screen.getByText(/ICO/)).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape' })

    // Paint Frame 1 and add Frame 2 -> becomes 2-frame animation
    const drawBtn = screen.getByTestId('draw-button')
    fireEvent.pointerDown(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(drawBtn, { pointerId: 1, pointerType: 'touch' })
    fireEvent.click(screen.getByTestId('workspace-tab-layers'))
    fireEvent.click(await screen.findByTestId('add-first-frame-btn'))
    await screen.findByTestId('workspace-tab-timeline')

    // 2-frame Editor 3-line menu: shows `アニメーションを出力` AND `このフレームを出力`!
    fireEvent.click(screen.getByTestId('editor-menu-btn'))
    const editorExportAnim = await screen.findByTestId('editor-export-btn')
    expect(editorExportAnim.textContent).toContain('アニメーションを出力')
    const currentFrameBtn = screen.getByTestId('editor-export-current-frame-btn')
    expect(currentFrameBtn.textContent).toContain('このフレームを出力')

    // Clicking `このフレームを出力` opens still export modal (default PNG, no Aseprite project option)
    fireEvent.click(currentFrameBtn)
    expect(await screen.findByTestId('unified-export-modal')).toBeTruthy()
    expect(screen.getByTestId('export-format-select').textContent).toContain('PNG')
    fireEvent.keyDown(window, { key: 'Escape' })

    // Navigate to Project Viewing Screen (`/project/:id`) for this 2-frame animation
    fireEvent.click(screen.getByTestId('editor-menu-btn'))
    fireEvent.click(await screen.findByTestId('editor-view-detail-btn'))

    // Detail screen shows animated preview (`data-animated="true"`), `frameCount = 2`, Sprite Sheet button, and `アニメーションを出力` (default GIF + Animated SVG option)
    await waitFor(() => {
      expect(screen.getByTestId('detail-project-size').textContent).not.toBe('—')
    })
    const detailPreviewImg = await screen.findByTestId('detail-preview-img')
    await waitFor(() => {
      expect(detailPreviewImg.getAttribute('data-animated')).toBe('true')
    })
    expect(screen.getByTestId('detail-frame-count').textContent).toBe('2')
    expect(screen.getByTestId('detail-export-spritesheet-btn')).toBeTruthy()
    const detailAnimExportBtn = screen.getByTestId('detail-export-btn')
    expect(detailAnimExportBtn.textContent).toContain('アニメーションを出力')

    fireEvent.click(detailAnimExportBtn)
    expect(await screen.findByTestId('unified-export-modal')).toBeTruthy()
    const animFormatSelect = screen.getByTestId('export-format-select')
    expect(animFormatSelect.textContent).toContain('GIF')
    fireEvent.click(animFormatSelect)
    expect(await screen.findByText(/アニメーションSVG/)).toBeTruthy()
    expect(screen.getByText(/連番PNG ZIP/)).toBeTruthy()
  })
})
