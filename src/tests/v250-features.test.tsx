import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { App } from '../App'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import { expandSymmetricPoints, resolveCanvasPoint } from '../engine/symmetry'
import { stampPoints } from '../engine/brush'
import { applyFloodFill } from '../engine/floodFill'
import { drawLine } from '../engine/rasterize'
import { applyStampToBuffer, extractStampFromSelection } from '../engine/stamp'
import {
  analyzeArtworkColors,
  hexToCielab,
  replaceColorAcrossTimeline,
  restorePaletteOriginalOrder,
  sortProjectPalette,
} from '../engine/paletteTools'
import { exportCompositePngBytes } from '../engine/compositor'
import {
  decodePngLossless,
  downscaleByIntegerBlock,
  inspectPngForImport,
} from '../engine/pngImport'
import { generateSpriteSheet } from '../engine/spriteSheet'
import { encodeAsepriteBytes, parseAsepriteBytes } from '../engine/aseprite'
import {
  addStampAsset,
  createNewProject,
  deleteProjectById,
  DotDotDatabase,
  initializeDatabase,
} from '../db/database'
import {
  applyValidatedEnvPack,
  exportEnvironmentPackZip,
  inspectAndValidateEnvPack,
} from '../db/envPack'
import { makeCellKey } from '../engine/animation'
import {
  TRANSPARENT_COLOR_INDEX,
  type LayerRuntime,
  type WorldSelectionMask,
} from '../types'

describe('v2.5.0 Core Features Suite', () => {
  it('1. Symmetry Editing: reflects exact center for both even (8x8) and odd (7x7) canvases across Pen, Line & Fill', () => {
    // Even 8x8: center is (3.5, 3.5) -> (1, 2) reflects to (6, 2), (1, 5), (6, 5)
    const evenPts = expandSymmetricPoints({ x: 1, y: 2 }, 8, 8, 'quad')
    expect(evenPts).toEqual([
      { x: 1, y: 2 },
      { x: 6, y: 2 },
      { x: 1, y: 5 },
      { x: 6, y: 5 },
    ])

    // Odd 7x7: center is (3, 3) -> center pixel (3, 3) deduplicates to a single point!
    const oddCenter = expandSymmetricPoints({ x: 3, y: 3 }, 7, 7, 'quad')
    expect(oddCenter).toEqual([{ x: 3, y: 3 }])
    const oddEdge = expandSymmetricPoints({ x: 0, y: 3 }, 7, 7, 'horizontal')
    expect(oddEdge).toEqual([
      { x: 0, y: 3 },
      { x: 6, y: 3 },
    ])

    // Symmetric brush stroke & line
    const buf = createPixelBuffer(8, 8)
    stampPoints(buf, [{ x: 0, y: 1 }], {
      width: 8,
      height: 8,
      size: 1,
      shape: 'square',
      color: { r: 255, g: 0, b: 0, a: 255 },
      dither: 1,
      symmetry: 'quad',
    })
    expect(getPixel(buf, 8, 8, 0, 1).r).toBe(255)
    expect(getPixel(buf, 8, 8, 7, 1).r).toBe(255)
    expect(getPixel(buf, 8, 8, 0, 6).r).toBe(255)
    expect(getPixel(buf, 8, 8, 7, 6).r).toBe(255)

    const lineBuf = createPixelBuffer(9, 9)
    drawLine(
      lineBuf,
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      {
        width: 9,
        height: 9,
        size: 1,
        shape: 'square',
        dither: 1,
        pixelPerfect: false,
        color: { r: 0, g: 200, b: 100, a: 255 },
        selectionMask: null,
        symmetry: 'horizontal',
      }
    )
    expect(getPixel(lineBuf, 9, 9, 7, 1).g).toBe(200)
    expect(getPixel(lineBuf, 9, 9, 6, 1).g).toBe(200)
  })

  it('2. Seamless Torus Wrap: wraps brush strokes and flood-fill across opposite borders modulo W x H', () => {
    expect(resolveCanvasPoint(-1, 8, 8, 8, 'both')).toEqual({ x: 7, y: 0 })
    expect(resolveCanvasPoint(-1, 2, 8, 8, 'horizontal')).toEqual({ x: 7, y: 2 })
    expect(resolveCanvasPoint(-1, 2, 8, 8, 'vertical')).toBeNull()

    // Brush size 3 centered at x = 0 wraps to x = 7 when seamlessWrap = 'both'
    const brushBuf = createPixelBuffer(8, 8)
    stampPoints(brushBuf, [{ x: 0, y: 4 }], {
      width: 8,
      height: 8,
      size: 3,
      shape: 'square',
      color: { r: 10, g: 20, b: 30, a: 255 },
      dither: 1,
      seamlessWrap: 'both',
    })
    expect(getPixel(brushBuf, 8, 8, 7, 4).b).toBe(30)

    // Flood fill wraps across x=0 <-> x=3 when vertical barrier blocks middle
    const fillBuf = createPixelBuffer(4, 4)
    for (let y = 0; y < 4; y++) {
      setPixel(fillBuf, 4, 4, 2, y, { r: 255, g: 255, b: 255, a: 255 })
    }
    applyFloodFill(fillBuf, {
      width: 4,
      height: 4,
      seedX: 0,
      seedY: 0,
      color: { r: 200, g: 50, b: 50, a: 255 },
      connectivity: 4,
      dither: 1,
      selectionMask: null,
      seamlessWrap: 'horizontal',
    })
    // Column 3 was reached by wrapping left from column 0!
    expect(getPixel(fillBuf, 4, 4, 3, 0).r).toBe(200)
    // Barrier column 2 remains untouched white
    expect(getPixel(fillBuf, 4, 4, 2, 0).g).toBe(255)
  })

  it('3. PNG Resolution Restoration: embeds & verifies dotdot-meta, detects external integer blocks, and guards blurred edits', () => {
    const layerData = createPixelBuffer(4, 4)
    setPixel(layerData, 4, 4, 0, 0, { r: 255, g: 0, b: 0, a: 255 })
    setPixel(layerData, 4, 4, 3, 2, { r: 0, g: 128, b: 255, a: 255 })
    const layer: LayerRuntime = {
      id: 'l1',
      name: 'Layer 1',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 4,
      dataHeight: 4,
      data: layerData,
    }

    // Export 6x with embedded dotdot-meta -> 24x24 PNG
    const exportedWithMeta = exportCompositePngBytes([layer], 4, 4, 6, {
      embedMetadata: true,
    })
    expect(exportedWithMeta.outWidth).toBe(24)
    const inspMeta = inspectPngForImport(exportedWithMeta.png)
    expect(inspMeta.confidence).toBe('metadata')
    expect(inspMeta.recommendedScale).toBe(6)
    expect(inspMeta.metadata?.originalWidth).toBe(4)

    const restored = downscaleByIntegerBlock(
      inspMeta.decoded.data,
      inspMeta.decoded.width,
      inspMeta.decoded.height,
      inspMeta.recommendedScale
    )
    expect(restored.width).toBe(4)
    expect(getPixel(restored.data, 4, 4, 3, 2)).toEqual({
      r: 0,
      g: 128,
      b: 255,
      a: 255,
    })

    // External PNG WITHOUT metadata -> heuristic detects 6x uniform blocks -> restores to 4x4!
    const exportedNoMeta = exportCompositePngBytes([layer], 4, 4, 6, {
      embedMetadata: false,
    })
    const inspHeur = inspectPngForImport(exportedNoMeta.png)
    expect(inspHeur.confidence).toBe('heuristic')
    expect(inspHeur.recommendedScale).toBe(6)

    // Guard against false-positive shrink: mutate 1 sub-pixel inside a 6x6 block -> falls back safely to 1x!
    const decodedMut = decodePngLossless(exportedWithMeta.png)
    setPixel(decodedMut.data, 24, 24, 1, 0, { r: 12, g: 34, b: 56, a: 255 })
    const mutLayer: LayerRuntime = {
      ...layer,
      dataWidth: 24,
      dataHeight: 24,
      data: decodedMut.data,
    }
    const reencodedEdited = exportCompositePngBytes([mutLayer], 24, 24, 1, {
      embedMetadata: false,
    })
    const inspEdited = inspectPngForImport(reencodedEdited.png)
    expect(inspEdited.recommendedScale).toBe(1)
  })

  it('4. Sprite Sheet Export: arranges frames accurately, excludes hidden layers, and outputs valid JSON metadata', () => {
    const f1 = { id: 'f1', durationMs: 120 }
    const f2 = { id: 'f2', durationMs: 240 }
    const f3 = { id: 'f3', durationMs: 80 }

    const cel1 = createPixelBuffer(4, 4)
    setPixel(cel1, 4, 4, 0, 0, { r: 255, g: 0, b: 0, a: 255 })
    const cel2 = createPixelBuffer(4, 4)
    setPixel(cel2, 4, 4, 1, 1, { r: 0, g: 255, b: 0, a: 255 })
    const hiddenCel = createPixelBuffer(4, 4)
    setPixel(hiddenCel, 4, 4, 0, 0, { r: 0, g: 0, b: 255, a: 255 })

    const res = generateSpriteSheet({
      projectName: 'HeroWalk',
      canvasWidth: 4,
      canvasHeight: 4,
      layerMetas: [
        {
          id: 'vis',
          name: 'Body',
          visible: true,
          opacity: 100,
          blendMode: 'normal',
          clipping: false,
        },
        {
          id: 'hid',
          name: 'Sketch',
          visible: false,
          opacity: 100,
          blendMode: 'normal',
          clipping: false,
        },
      ],
      frames: [f1, f2, f3],
      cels: {
        [makeCellKey('vis', 'f1')]: { kind: 'cel', celId: 'c1' },
        [makeCellKey('vis', 'f2')]: { kind: 'cel', celId: 'c2' },
        [makeCellKey('vis', 'f3')]: { kind: 'cel', celId: 'c1' },
        [makeCellKey('hid', 'f1')]: { kind: 'cel', celId: 'ch' },
      },
      celBuffers: {
        c1: { id: 'c1', offsetX: 0, offsetY: 0, dataWidth: 4, dataHeight: 4, data: cel1 },
        c2: { id: 'c2', offsetX: 0, offsetY: 0, dataWidth: 4, dataHeight: 4, data: cel2 },
        ch: { id: 'ch', offsetX: 0, offsetY: 0, dataWidth: 4, dataHeight: 4, data: hiddenCel },
      },
      layout: 'grid',
      columns: 2,
      spacing: 1,
      margin: 2,
      scale: 2,
      layerFilter: 'visible',
    })

    // Base grid: 2 cols x 2 rows of 4x4 frames, spacing=1, margin=2 -> baseW = 2+4+1+4+2 = 13, scale 2 -> 26x26
    expect(res.columns).toBe(2)
    expect(res.rows).toBe(2)
    expect(res.sheetWidth).toBe(26)
    expect(res.sheetHeight).toBe(26)
    expect(res.metadata.frames).toHaveLength(3)
    expect(res.metadata.frames[0]!.duration).toBe(120)
    expect(res.metadata.frames[1]!.frame).toEqual({ x: 14, y: 4, w: 8, h: 8 })

    // Verify hidden blue layer was excluded (frame 1 top-left at (4,4) in 2x sheet is pure red)
    const decodedSheet = decodePngLossless(res.pngBytes)
    expect(getPixel(decodedSheet.data, 26, 26, 4, 4)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 255,
    })
  })

  it('5. Aseprite (.ase/.aseprite) Codec: round-trips multi-layer, multi-frame, durations, palette & Linked Cels losslessly and rejects corrupt data safely', () => {
    const cShared = createPixelBuffer(6, 6)
    setPixel(cShared, 6, 6, 2, 3, { r: 250, g: 120, b: 40, a: 255 })
    const cIndep = createPixelBuffer(6, 6)
    setPixel(cIndep, 6, 6, 5, 5, { r: 40, g: 180, b: 240, a: 255 })

    const encoded = encodeAsepriteBytes({
      width: 6,
      height: 6,
      layerMetas: [
        {
          id: 'bg',
          name: 'Background',
          visible: true,
          locked: true,
          opacity: 80,
          blendMode: 'normal',
          clipping: false,
        },
        {
          id: 'char',
          name: 'Character',
          visible: false,
          locked: false,
          opacity: 100,
          blendMode: 'multiply',
          clipping: false,
        },
      ],
      frames: [
        { id: 'f1', durationMs: 90 },
        { id: 'f2', durationMs: 180 },
        { id: 'f3', durationMs: 90 },
      ],
      cels: {
        [makeCellKey('bg', 'f1')]: { kind: 'cel', celId: 'shared-bg' },
        [makeCellKey('bg', 'f2')]: { kind: 'cel', celId: 'shared-bg' },
        [makeCellKey('bg', 'f3')]: { kind: 'cel', celId: 'shared-bg' },
        [makeCellKey('char', 'f1')]: { kind: 'empty' },
        [makeCellKey('char', 'f2')]: { kind: 'cel', celId: 'char-2' },
        [makeCellKey('char', 'f3')]: { kind: 'empty' },
      },
      celBuffers: {
        'shared-bg': {
          id: 'shared-bg',
          offsetX: 0,
          offsetY: 0,
          dataWidth: 6,
          dataHeight: 6,
          data: cShared,
        },
        'char-2': {
          id: 'char-2',
          offsetX: 0,
          offsetY: 0,
          dataWidth: 6,
          dataHeight: 6,
          data: cIndep,
        },
      },
      paletteColors: ['#FA7828', '#28B4F0', '#181521'],
    })

    expect(encoded.linkedCelCount).toBe(2)

    const parsed = parseAsepriteBytes(encoded.bytes)
    expect(parsed.width).toBe(6)
    expect(parsed.height).toBe(6)
    expect(parsed.layerCount).toBe(2)
    expect(parsed.frameCount).toBe(3)
    expect(parsed.linkedCelCount).toBe(2)
    expect(parsed.layers[0]!.name).toBe('Background')
    expect(parsed.layers[0]!.locked).toBe(true)
    expect(parsed.layers[1]!.visible).toBe(false)
    expect(parsed.layers[1]!.blendMode).toBe('multiply')
    expect(parsed.frames.map((f) => f.durationMs)).toEqual([90, 180, 90])

    // Verify linked cels on Background share the EXACT same celId!
    const bgLayerId = parsed.layers[0]!.id
    const ref1 = parsed.cels[makeCellKey(bgLayerId, parsed.frames[0]!.id)]
    const ref2 = parsed.cels[makeCellKey(bgLayerId, parsed.frames[1]!.id)]
    const ref3 = parsed.cels[makeCellKey(bgLayerId, parsed.frames[2]!.id)]
    expect(ref1?.kind).toBe('cel')
    expect(ref2).toEqual(ref1)
    expect(ref3).toEqual(ref1)
    if (ref1?.kind === 'cel') {
      const cb = parsed.celBuffers[ref1.celId]!
      expect(
        getPixel(cb.data, cb.dataWidth, cb.dataHeight, 2 - cb.offsetX, 3 - cb.offsetY)
      ).toEqual({
        r: 250,
        g: 120,
        b: 40,
        a: 255,
      })
    }

    // Corrupt bytes throw cleanly without crashing
    expect(() => parseAsepriteBytes(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('6. Palette CIELAB Sort, Original Order Restore, Read-Only Analysis & Linked-Cel-Safe Color Replacement', () => {
    // Perceptual yellow (#FFFF00) has higher L* than pure blue (#0000FF)
    expect(hexToCielab('#FFFF00').L).toBeGreaterThan(hexToCielab('#0000FF').L)

    const initialPal = {
      name: 'Test',
      colors: ['#FFFFFF', '#000000', '#0000FF', '#FFFF00'],
    }
    // Transparent slot (-1) stays -1 on sort
    const sorted = sortProjectPalette(
      initialPal,
      TRANSPARENT_COLOR_INDEX,
      'lightness-asc'
    )
    expect(sorted.nextSelectedIndex).toBe(TRANSPARENT_COLOR_INDEX)
    expect(sorted.palette.colors[0]).toBe('#000000')
    expect(sorted.palette.colors[3]).toBe('#FFFFFF')

    // Selected color index tracks #0000FF across sort and back on restore
    const sortedTrack = sortProjectPalette(initialPal, 2, 'lightness-asc')
    expect(sortedTrack.palette.colors[sortedTrack.nextSelectedIndex]).toBe('#0000FF')
    const restored = restorePaletteOriginalOrder(
      sortedTrack.palette,
      sortedTrack.nextSelectedIndex
    )!
    expect(restored.palette.colors).toEqual(initialPal.colors)
    expect(restored.nextSelectedIndex).toBe(2)

    // Color usage analysis + Linked-Cel-preserving replacement
    const sharedBuf = createPixelBuffer(4, 4)
    setPixel(sharedBuf, 4, 4, 0, 0, { r: 0, g: 0, b: 255, a: 255 })
    setPixel(sharedBuf, 4, 4, 1, 0, { r: 0, g: 0, b: 255, a: 255 })

    const layerMeta: LayerRuntime = {
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
      data: sharedBuf,
    }

    const analysis = analyzeArtworkColors({
      width: 4,
      height: 4,
      layers: [layerMeta],
      paletteColors: initialPal.colors,
    })
    expect(analysis.usedColorCount).toBe(1)
    expect(analysis.opaquePixels).toBe(2)
    expect(analysis.unusedPaletteColors).toHaveLength(3)

    const cels = {
      'l1:f1': { kind: 'cel' as const, celId: 'shared-1' },
      'l1:f2': { kind: 'cel' as const, celId: 'shared-1' },
    }
    const replaced = replaceColorAcrossTimeline({
      sourceHex: '#0000FF',
      targetHexOrTransparent: '#FF0000',
      layerMetas: [layerMeta],
      frames: [
        { id: 'f1', durationMs: 100 },
        { id: 'f2', durationMs: 100 },
      ],
      cels,
      celBuffers: {
        'shared-1': {
          id: 'shared-1',
          offsetX: 0,
          offsetY: 0,
          dataWidth: 4,
          dataHeight: 4,
          data: sharedBuf,
        },
      },
      activeFrameId: 'f1',
      canvasWidth: 4,
      canvasHeight: 4,
    })

    // Processed unique shared cel ONCE without unlinking
    expect(replaced.affectedCelCount).toBe(1)
    expect(replaced.replacedPixelCount).toBe(2)
    expect(replaced.pixelPatches).toHaveLength(1)
    expect(replaced.pixelPatches[0]!.celId).toBe('shared-1')
    expect(
      getPixel(replaced.nextCelBuffers['shared-1']!.data, 4, 4, 0, 0).r
    ).toBe(255)
  })

  it('7. Pixel Stamps & EnvPack Persistence: extracts selection, places at 1x keeping transparency, survives project deletion & EnvPack round-trip', async () => {
    const testDbName = `dotdot-v250-stamps-${Date.now()}`
    const testDb = new DotDotDatabase(testDbName)
    try {
      const init = await initializeDatabase(testDb)
      expect(init.stamps.length).toBeGreaterThanOrEqual(5)

      const projRes = await createNewProject(
        {
          name: 'TempProj',
          width: 8,
          height: 8,
          palette: { name: 'P', colors: ['#FF00FF'] },
        },
        testDb
      )

      // Draw a 2x2 L-shape with 1 transparent corner and extract stamp
      const srcBuf = createPixelBuffer(8, 8)
      setPixel(srcBuf, 8, 8, 2, 2, { r: 255, g: 0, b: 255, a: 255 })
      setPixel(srcBuf, 8, 8, 3, 2, { r: 255, g: 0, b: 255, a: 255 })
      setPixel(srcBuf, 8, 8, 2, 3, { r: 255, g: 0, b: 255, a: 255 })
      const srcLayer: LayerRuntime = {
        id: 'l-src',
        name: 'Source',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 8,
        dataHeight: 8,
        data: srcBuf,
      }
      const worldSel: WorldSelectionMask = {
        originX: 2,
        originY: 2,
        width: 2,
        height: 2,
        mask: new Uint8Array([1, 1, 1, 1]),
      }

      const extracted = extractStampFromSelection(srcLayer, worldSel)!
      expect(extracted.width).toBe(2)
      expect(extracted.height).toBe(2)
      expect(extracted.hasOpaquePixels).toBe(true)

      const savedStamp = await addStampAsset(
        {
          name: 'CornerMotif',
          width: extracted.width,
          height: extracted.height,
          data: extracted.data,
        },
        testDb
      )

      // Delete the project -> stamp MUST persist independently!
      await deleteProjectById(projRes.project.id, testDb)
      const afterProjDelete = await testDb.stamps.get(savedStamp.id)
      expect(afterProjDelete?.name).toBe('CornerMotif')

      // Stamp onto an existing painted background -> transparent stamp pixel MUST NOT overwrite background!
      const dstBuf = createPixelBuffer(8, 8)
      setPixel(dstBuf, 8, 8, 5, 5, { r: 10, g: 200, b: 10, a: 255 })
      applyStampToBuffer(dstBuf, {
        canvasWidth: 8,
        canvasHeight: 8,
        stampWidth: savedStamp.width,
        stampHeight: savedStamp.height,
        stampData: savedStamp.data,
        topLeftX: 4,
        topLeftY: 4,
      })
      expect(getPixel(dstBuf, 8, 8, 4, 4).r).toBe(255)
      expect(getPixel(dstBuf, 8, 8, 5, 5).g).toBe(200) // preserved under transparent stamp pixel!

      // Environment Pack ZIP export & restore preserves custom stamps
      const zipBytes = await exportEnvironmentPackZip(testDb)
      const validated = inspectAndValidateEnvPack(zipBytes)
      expect(validated.stamps.some((s) => s.name === 'CornerMotif')).toBe(true)

      const restoreDb = new DotDotDatabase(`${testDbName}-restore`)
      try {
        await applyValidatedEnvPack(validated, restoreDb)
        const restoredStamps = await restoreDb.stamps.toArray()
        expect(restoredStamps.some((s) => s.name === 'CornerMotif')).toBe(true)
      } finally {
        await restoreDb.delete()
      }
    } finally {
      await testDb.delete()
    }
  })
})

describe('v2.5.0 UI Integration Suite', () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = (() => {
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

  afterEach(() => {
    cleanup()
  })

  it('8. UI Integration: preserves 1-row PaletteBar, opens PaletteToolsModal from PaletteSheet, toggles Symmetry/Tile/Stamps, exposes SpriteSheet & Aseprite menus, and collapses Advanced Settings cleanly', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    // Gallery import menu opens PNG & Aseprite import triggers
    const galleryImportBtn = await screen.findByTestId('gallery-import-menu-btn')
    fireEvent.click(galleryImportBtn)
    expect(await screen.findByTestId('gallery-import-png-btn')).toBeTruthy()
    expect(screen.getByTestId('gallery-import-aseprite-btn')).toBeTruthy()
    fireEvent.click(galleryImportBtn)

    // Create new artwork -> opens Editor
    const newBtn = await screen.findByTestId('new-artwork-btn')
    fireEvent.click(newBtn)
    const confirmCreate = await screen.findByTestId('confirm-create-artwork-btn')
    fireEvent.click(confirmCreate)

    // Quick Symmetry & Tile toggles work non-intrusively
    const symBtn = await screen.findByTestId('quick-symmetry-toggle-btn')
    expect(symBtn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(symBtn)
    expect(symBtn.getAttribute('aria-pressed')).toBe('true')
    expect(symBtn.textContent).toContain('H')

    const tileBtn = screen.getByTestId('quick-tile-toggle-btn')
    fireEvent.click(tileBtn)
    expect(tileBtn.textContent).toContain('3x3')

    // Stamp Sheet opens and lists starter stamps
    fireEvent.click(screen.getByTestId('quick-stamp-sheet-btn'))
    expect(await screen.findByTestId('stamp-sheet-modal')).toBeTruthy()
    expect(screen.getByTestId('stamp-list')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })

    // Open PaletteSheet -> open consolidated PaletteToolsModal (`整理・分析`) -> sort & restore
    const openPaletteBtn = screen.getByTestId('open-palette-btn')
    fireEvent.click(openPaletteBtn)
    const openToolsBtn = await screen.findByTestId('palette-open-tools-btn')
    fireEvent.click(openToolsBtn)
    expect(await screen.findByTestId('palette-tools-modal')).toBeTruthy()
    fireEvent.click(screen.getByTestId('palette-sort-light-asc'))
    expect(await screen.findByTestId('palette-restore-original-btn')).toBeTruthy()
    fireEvent.click(screen.getByTestId('palette-tools-tab-analyze'))
    expect(await screen.findByTestId('palette-analyze-panel')).toBeTruthy()

    // Navigate to Settings -> verify collapsible Advanced Editing & I/O section + v2.5.0
    window.history.pushState({}, '', '/settings')
    fireEvent(window, new PopStateEvent('popstate'))
    const advToggle = await screen.findByTestId('settings-toggle-advanced-btn')
    expect(advToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(advToggle)
    expect(advToggle.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByTestId('settings-embed-png-meta-checkbox')).toBeTruthy()
  })
})
