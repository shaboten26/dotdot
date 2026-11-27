import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import { App } from '../App'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import { expandSymmetricPoints, resolveCanvasPoint } from '../engine/symmetry'
import { stampPoints } from '../engine/brush'
import { applyFloodFill } from '../engine/floodFill'
import { drawLine } from '../engine/rasterize'
import {
  analyzeArtworkColors,
  countFixedIndexUsageAcrossProject,
  deletePaletteSlotWithReplacement,
  generateColorHarmonyCompanions,
  generateIntermediateRampColors,
  generatePixelArtToneVariant,
  hexToCielab,
  insertColorsIntoIndexedPalette,
  removeUnusedColorsFromIndexedPalette,
  replaceColorAcrossTimeline,
  restorePaletteOriginalOrder,
  sortProjectPalette,
} from '../engine/paletteTools'
import {
  convertRgbaBuffersToIndexed,
  moveIndexedPaletteDisplaySlot,
  normalizeProjectPalette,
  updateIndexedPaletteSlotColor,
} from '../engine/indexedPalette'
import { compositeLayers, exportCompositePngBytes } from '../engine/compositor'
import {
  decodePngLossless,
  downscaleByIntegerBlock,
  inspectPngForImport,
} from '../engine/pngImport'
import { generateSpriteSheet } from '../engine/spriteSheet'
import { encodeAsepriteBytes, parseAsepriteBytes } from '../engine/aseprite'
import {
  createNewProject,
  db,
  detectPreferredLanguage,
  DotDotDatabase,
  initializeDatabase,
  loadProjectFull,
  normalizeAppSettings,
  resetAllAppData,
} from '../db/database'
import { migrateDatabaseToIndexedColor } from '../db/indexedMigration'
import {
  applyValidatedEnvPack,
  exportEnvironmentPackZip,
  inspectAndValidateEnvPack,
} from '../db/envPack'
import { makeCellKey } from '../engine/animation'
import {
  DARK_THEME_VARIANTS,
  LIGHT_THEME_VARIANTS,
  resolveActiveThemeTokens,
} from '../theme/themes'
import {
  MAX_OPAQUE_PALETTE_COLORS,
  TRANSPARENT_COLOR_INDEX,
  TRANSPARENT_INDEX,
  type LayerRuntime,
  type ProjectPalette,
} from '../types'

const SUITE_PALETTE: ProjectPalette = normalizeProjectPalette({
  name: 'SuitePal',
  colors: ['#FF0000', '#00FF00', '#0000FF', '#0080FF', '#FFFFFF', '#0C2238'],
})

describe('v2.5.0+ Indexed Color, Migration, Multi-Theme & Core Features Suite', () => {
  it('1. Symmetry Editing: reflects exact center for both even (8x8) and odd (7x7) canvases across Pen, Line & Fill', () => {
    const evenPts = expandSymmetricPoints({ x: 1, y: 2 }, 8, 8, 'quad')
    expect(evenPts).toEqual([
      { x: 1, y: 2 },
      { x: 6, y: 2 },
      { x: 1, y: 5 },
      { x: 6, y: 5 },
    ])

    const oddCenter = expandSymmetricPoints({ x: 3, y: 3 }, 7, 7, 'quad')
    expect(oddCenter).toEqual([{ x: 3, y: 3 }])
    const oddEdge = expandSymmetricPoints({ x: 0, y: 3 }, 7, 7, 'horizontal')
    expect(oddEdge).toEqual([
      { x: 0, y: 3 },
      { x: 6, y: 3 },
    ])

    const buf = createPixelBuffer(8, 8)
    stampPoints(buf, [{ x: 0, y: 1 }], {
      width: 8,
      height: 8,
      size: 1,
      shape: 'square',
      colorIndex: 0,
      dither: 1,
      symmetry: 'quad',
    })
    expect(buf[1 * 8 + 0]).toBe(0)
    expect(buf[1 * 8 + 7]).toBe(0)
    expect(buf[6 * 8 + 0]).toBe(0)
    expect(buf[6 * 8 + 7]).toBe(0)

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
        colorIndex: 1,
        selectionMask: null,
        symmetry: 'horizontal',
      }
    )
    expect(lineBuf[1 * 9 + 7]).toBe(1)
    expect(lineBuf[1 * 9 + 6]).toBe(1)
  })

  it('2. Seamless Torus Wrap: wraps brush strokes and flood-fill across opposite borders modulo W x H', () => {
    expect(resolveCanvasPoint(-1, 8, 8, 8, 'both')).toEqual({ x: 7, y: 0 })
    expect(resolveCanvasPoint(-1, 2, 8, 8, 'horizontal')).toEqual({ x: 7, y: 2 })
    expect(resolveCanvasPoint(-1, 2, 8, 8, 'vertical')).toBeNull()

    const brushBuf = createPixelBuffer(8, 8)
    stampPoints(brushBuf, [{ x: 0, y: 4 }], {
      width: 8,
      height: 8,
      size: 3,
      shape: 'square',
      colorIndex: 2,
      dither: 1,
      seamlessWrap: 'both',
    })
    expect(brushBuf[4 * 8 + 7]).toBe(2)

    const fillBuf = createPixelBuffer(4, 4)
    for (let y = 0; y < 4; y++) {
      setPixel(fillBuf, 4, 4, 2, y, 4)
    }
    applyFloodFill(fillBuf, {
      width: 4,
      height: 4,
      seedX: 0,
      seedY: 0,
      colorIndex: 0,
      connectivity: 4,
      dither: 1,
      selectionMask: null,
      seamlessWrap: 'horizontal',
    })
    expect(fillBuf[0 * 4 + 3]).toBe(0)
    expect(fillBuf[0 * 4 + 2]).toBe(4)
  })

  it('3. PNG Resolution Restoration: embeds & verifies dotdot-meta, detects external integer blocks, and guards blurred edits', () => {
    const layerData = createPixelBuffer(4, 4)
    setPixel(layerData, 4, 4, 0, 0, 0) // #FF0000
    setPixel(layerData, 4, 4, 3, 2, 3) // #0080FF
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

    const exportedWithMeta = exportCompositePngBytes([layer], 4, 4, 6, {
      palette: SUITE_PALETTE,
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

    const exportedNoMeta = exportCompositePngBytes([layer], 4, 4, 6, {
      palette: SUITE_PALETTE,
      embedMetadata: false,
    })
    const inspHeur = inspectPngForImport(exportedNoMeta.png)
    expect(inspHeur.confidence).toBe('heuristic')
    expect(inspHeur.recommendedScale).toBe(6)

    // Mutate 1 sub-pixel inside a 6x6 block -> falls back safely to 1x!
    const decodedMut = decodePngLossless(exportedWithMeta.png)
    const mutOff = (0 * 24 + 1) * 4
    decodedMut.data[mutOff] = 12
    decodedMut.data[mutOff + 1] = 34
    decodedMut.data[mutOff + 2] = 56
    decodedMut.data[mutOff + 3] = 255
    const convertedMut = convertRgbaBuffersToIndexed(
      [{ id: 'm', width: 24, height: 24, rgba: decodedMut.data }],
      SUITE_PALETTE
    )
    const mutLayer: LayerRuntime = {
      ...layer,
      dataWidth: 24,
      dataHeight: 24,
      data: convertedMut.buffers.get('m')!,
    }
    const reencodedEdited = exportCompositePngBytes([mutLayer], 24, 24, 1, {
      palette: convertedMut.palette,
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
    setPixel(cel1, 4, 4, 0, 0, 0) // #FF0000
    const cel2 = createPixelBuffer(4, 4)
    setPixel(cel2, 4, 4, 1, 1, 1) // #00FF00
    const hiddenCel = createPixelBuffer(4, 4)
    setPixel(hiddenCel, 4, 4, 0, 0, 2) // #0000FF

    const res = generateSpriteSheet({
      projectName: 'HeroWalk',
      canvasWidth: 4,
      canvasHeight: 4,
      palette: SUITE_PALETTE,
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

    expect(res.columns).toBe(2)
    expect(res.rows).toBe(2)
    expect(res.sheetWidth).toBe(26)
    expect(res.sheetHeight).toBe(26)
    expect(res.metadata.frames).toHaveLength(3)
    expect(res.metadata.frames[0]!.duration).toBe(120)
    expect(res.metadata.frames[1]!.frame).toEqual({ x: 14, y: 4, w: 8, h: 8 })

    const decodedSheet = decodePngLossless(res.pngBytes)
    expect(getPixel(decodedSheet.data, 26, 26, 4, 4)).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 255,
    })
  })

  it('5. 8bpp Indexed Aseprite (.ase/.aseprite) Codec: round-trips multi-layer, multi-frame, durations, palette & Linked Cels losslessly', () => {
    const asePal = normalizeProjectPalette({
      name: 'AsePal',
      colors: ['#FA7828', '#28B4F0', '#181521'],
    })
    const cShared = createPixelBuffer(6, 6)
    setPixel(cShared, 6, 6, 2, 3, 0) // #FA7828
    const cIndep = createPixelBuffer(6, 6)
    setPixel(cIndep, 6, 6, 5, 5, 1) // #28B4F0

    const encoded = encodeAsepriteBytes({
      width: 6,
      height: 6,
      palette: asePal,
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
    })

    expect(encoded.linkedCelCount).toBe(2)

    const parsed = parseAsepriteBytes(encoded.bytes)
    expect(parsed.width).toBe(6)
    expect(parsed.height).toBe(6)
    expect(parsed.colorDepth).toBe(8)
    expect(parsed.layerCount).toBe(2)
    expect(parsed.frameCount).toBe(3)
    expect(parsed.linkedCelCount).toBe(2)
    expect(parsed.layers[0]!.name).toBe('Background')
    expect(parsed.layers[0]!.locked).toBe(true)
    expect(parsed.layers[1]!.visible).toBe(false)
    expect(parsed.layers[1]!.blendMode).toBe('multiply')
    expect(parsed.frames.map((f) => f.durationMs)).toEqual([90, 180, 90])

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
        getPixel(
          cb.data,
          cb.dataWidth,
          cb.dataHeight,
          2 - cb.offsetX,
          3 - cb.offsetY,
          parsed.palette
        )
      ).toEqual({
        r: 250,
        g: 120,
        b: 40,
        a: 255,
      })
    }

    expect(() => parseAsepriteBytes(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('6. Indexed Palette Engine: fixed-index vs displayOrder separation, live slot edit reflection, safe in-use color deletion & Linked-Cel replacement', () => {
    expect(hexToCielab('#FFFF00').L).toBeGreaterThan(hexToCielab('#0000FF').L)

    const initialPal = normalizeProjectPalette({
      name: 'Test',
      colors: ['#FFFFFF', '#000000', '#0000FF', '#FFFF00'],
    })

    // Paint pixel (0,0) with fixed index 2 (#0000FF)
    const sharedBuf = createPixelBuffer(4, 4)
    setPixel(sharedBuf, 4, 4, 0, 0, 2)
    setPixel(sharedBuf, 4, 4, 1, 0, 2)

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

    // Reordering displayOrder via sort or drag MUST NOT change artwork pixel color!
    const sorted = sortProjectPalette(
      initialPal,
      TRANSPARENT_COLOR_INDEX,
      'lightness-asc'
    )
    expect(sorted.nextSelectedIndex).toBe(TRANSPARENT_COLOR_INDEX)
    expect(sorted.palette.colors[0]).toBe('#000000')
    expect(sorted.palette.colors[3]).toBe('#FFFFFF')
    const compAfterSort = compositeLayers([layerMeta], 4, 4, {
      palette: sorted.palette,
    })
    expect(getPixel(compAfterSort, 4, 4, 0, 0)).toEqual({
      r: 0,
      g: 0,
      b: 255,
      a: 255,
    })

    // Manual slot move also preserves fixed index & artwork color
    const moved = moveIndexedPaletteDisplaySlot(sorted.palette, 0, 3, 0)
    expect(moved.nextSelectedSlot).toBe(3)
    const compAfterMove = compositeLayers([layerMeta], 4, 4, {
      palette: moved.palette,
    })
    expect(getPixel(compAfterMove, 4, 4, 0, 0)).toEqual({
      r: 0,
      g: 0,
      b: 255,
      a: 255,
    })

    // Editing a palette slot color updates all pixels referencing that fixed index immediately!
    const sortedTrack = sortProjectPalette(initialPal, 2, 'lightness-asc')
    const blueDisplaySlot = sortedTrack.nextSelectedIndex
    const editedPal = updateIndexedPaletteSlotColor(
      sortedTrack.palette,
      blueDisplaySlot,
      '#12AB34'
    )
    const compAfterEdit = compositeLayers([layerMeta], 4, 4, {
      palette: editedPal,
    })
    expect(getPixel(compAfterEdit, 4, 4, 0, 0)).toEqual({
      r: 0x12,
      g: 0xab,
      b: 0x34,
      a: 255,
    })

    const restored = restorePaletteOriginalOrder(
      sortedTrack.palette,
      sortedTrack.nextSelectedIndex
    )!
    expect(restored.palette.colors).toEqual(initialPal.colors)
    expect(restored.nextSelectedIndex).toBe(2)

    const analysis = analyzeArtworkColors({
      width: 4,
      height: 4,
      layers: [layerMeta],
      palette: initialPal,
    })
    expect(analysis.usedColorCount).toBe(1)
    expect(analysis.opaquePixels).toBe(2)
    expect(analysis.unusedPaletteColors).toHaveLength(3)

    const cels = {
      'l1:f1': { kind: 'cel' as const, celId: 'shared-1' },
      'l1:f2': { kind: 'cel' as const, celId: 'shared-1' },
    }
    const celBuffers = {
      'shared-1': {
        id: 'shared-1',
        offsetX: 0,
        offsetY: 0,
        dataWidth: 4,
        dataHeight: 4,
        data: sharedBuf,
      },
    }

    expect(
      countFixedIndexUsageAcrossProject({
        fixedIndex: 2,
        cels,
        celBuffers,
      })
    ).toEqual({ pixelCount: 2, celCount: 1 })

    // Safe deletion of in-use slot 2 (#0000FF) replacing with slot 3 (#FFFF00)
    const delRes = deletePaletteSlotWithReplacement({
      palette: initialPal,
      deleteDisplaySlot: 2,
      selectedDisplaySlot: 2,
      replacementTarget: { kind: 'slot', displaySlot: 3 },
      layerMetas: [layerMeta],
      frames: [
        { id: 'f1', durationMs: 100 },
        { id: 'f2', durationMs: 100 },
      ],
      cels,
      celBuffers,
      activeFrameId: 'f1',
      canvasWidth: 4,
      canvasHeight: 4,
    })!
    expect(delRes.replacedPixelCount).toBe(2)
    expect(delRes.nextPalette.colors).toEqual(['#FFFFFF', '#000000', '#FFFF00'])
    expect(
      getPixel(delRes.nextCelBuffers['shared-1']!.data, 4, 4, 0, 0, delRes.nextPalette)
    ).toEqual({ r: 255, g: 255, b: 0, a: 255 })

    // Color replacement across timeline preserves linked cel sharing
    const replaced = replaceColorAcrossTimeline({
      sourceHex: '#0000FF',
      targetHexOrTransparent: '#FF0000',
      palette: initialPal,
      layerMetas: [layerMeta],
      frames: [
        { id: 'f1', durationMs: 100 },
        { id: 'f2', durationMs: 100 },
      ],
      cels,
      celBuffers,
      activeFrameId: 'f1',
      canvasWidth: 4,
      canvasHeight: 4,
    })
    expect(replaced.affectedCelCount).toBe(1)
    expect(replaced.replacedPixelCount).toBe(2)
    expect(replaced.pixelPatches).toHaveLength(1)
    expect(replaced.pixelPatches[0]!.celId).toBe('shared-1')
    expect(
      getPixel(
        replaced.nextCelBuffers['shared-1']!.data,
        4,
        4,
        0,
        0,
        replaced.nextPalette
      )
    ).toEqual({ r: 255, g: 0, b: 0, a: 255 })
  })

  it('7. Resumable RGBA-to-Indexed DB Migration, >255 Quantization, Semi-Transparent Dithering & Legacy v1 EnvPack Auto-Migration', async () => {
    const testDbName = `dotdot-indexed-mig-${Date.now()}`
    const testDb = new DotDotDatabase(testDbName)
    try {
      await initializeDatabase(testDb)

      // Seed a legacy unmigrated RGBA project with >255 colors (300 unique RGB colors) + semi-transparent pixels + linked cels!
      const w = 20
      const h = 20
      const legacyRgba = new Uint8Array(w * h * 4)
      for (let i = 0; i < 300; i++) {
        const off = i * 4
        legacyRgba[off] = (i * 37) & 0xff
        legacyRgba[off + 1] = (i * 73) & 0xff
        legacyRgba[off + 2] = (i * 19 + 40) & 0xff
        legacyRgba[off + 3] = i < 16 ? 128 : 255
      }

      await testDb.projects.put({
        id: 'legacy-proj-1',
        name: 'Legacy Rainbow',
        width: w,
        height: h,
        layers: [
          {
            id: 'l-leg',
            name: 'Layer 1',
            visible: true,
            opacity: 100,
            blendMode: 'normal',
            clipping: false,
            offsetX: 0,
            offsetY: 0,
            dataWidth: w,
            dataHeight: h,
          },
        ],
        activeLayerId: 'l-leg',
        frames: [
          { id: 'f1', durationMs: 100 },
          { id: 'f2', durationMs: 100 },
        ],
        cels: {
          'l-leg:f1': { kind: 'cel', celId: 'shared-leg' },
          'l-leg:f2': { kind: 'cel', celId: 'shared-leg' },
        },
        activeFrameId: 'f1',
        palette: { name: 'OldPal', colors: ['#000000', '#FFFFFF'] },
        selectedColorIndex: 0,
        order: 0,
        createdAt: 1000,
        updatedAt: 2000,
      })
      await testDb.celBuffers.put({
        key: 'legacy-proj-1:shared-leg',
        projectId: 'legacy-proj-1',
        celId: 'shared-leg',
        offsetX: 0,
        offsetY: 0,
        dataWidth: w,
        dataHeight: h,
        data: legacyRgba,
      })
      await testDb.layerPixels.put({
        key: 'legacy-proj-1:l-leg',
        projectId: 'legacy-proj-1',
        layerId: 'l-leg',
        offsetX: 0,
        offsetY: 0,
        dataWidth: w,
        dataHeight: h,
        data: legacyRgba,
      })

      const summary = await migrateDatabaseToIndexedColor(testDb)
      expect(summary.migratedCount).toBe(1)
      expect(summary.quantizedProjectIds).toContain('legacy-proj-1')
      expect(summary.semiTransparentProjectIds).toContain('legacy-proj-1')

      const loaded = (await loadProjectFull('legacy-proj-1', testDb))!
      expect(loaded.project.pixelFormat).toBe('indexed-v1')
      expect(loaded.project.palette.colors.length).toBeLessThanOrEqual(
        MAX_OPAQUE_PALETTE_COLORS
      )
      expect(loaded.project.migrationReport?.wasQuantized).toBe(true)
      expect(loaded.project.migrationReport?.hadSemiTransparentPixels).toBe(true)
      expect(loaded.project.migrationReport?.beforePreviewPng?.byteLength).toBeGreaterThan(20)
      expect(loaded.project.migrationReport?.afterPreviewPng?.byteLength).toBeGreaterThan(20)

      // Linked cel sharing & 1-byte buffer invariant strictly preserved!
      expect(loaded.layers[0]!.data.byteLength).toBe(w * h)
      expect(loaded.layers[0]!.data[399]).toBe(TRANSPARENT_INDEX)
      expect(loaded.timeline.cels['l-leg:f1']).toEqual(
        loaded.timeline.cels['l-leg:f2']
      )

      // Export v2 EnvPack and verify formatVersion === 2
      const v2Zip = await exportEnvironmentPackZip(testDb)
      const validatedV2 = inspectAndValidateEnvPack(v2Zip)
      expect(validatedV2.manifest.formatVersion).toBe(2)

      // Also verify legacy v1 RGBA EnvPack ZIP imports & auto-converts cleanly!
      const v1RawRgba = new Uint8Array(4 * 4 * 4)
      v1RawRgba[0] = 250
      v1RawRgba[1] = 20
      v1RawRgba[2] = 60
      v1RawRgba[3] = 255
      const legacyV1Zip = zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            format: 'dotdot-environment-pack',
            formatVersion: 1,
            appVersion: '2.4.0',
            exportedAt: 12345,
            projectOrder: ['proj-v1'],
            paletteOrder: ['pal-1'],
            counts: {
              projects: 1,
              palettes: 1,
              totalLayers: 1,
              totalHistoryEntries: 0,
            },
          })
        ),
        'settings.json': strToU8(
          JSON.stringify({ id: 'app-settings', theme: 'light', language: 'ja' })
        ),
        'palettes/palette-001.json': strToU8(
          JSON.stringify({
            id: 'pal-1',
            name: 'V1Pal',
            colors: ['#FA143C', '#FFFFFF'],
            order: 0,
            createdAt: 1,
            updatedAt: 1,
          })
        ),
        'projects/proj-v1/project.json': strToU8(
          JSON.stringify({
            id: 'proj-v1',
            name: 'V1 Sprite',
            width: 4,
            height: 4,
            layers: [
              {
                id: 'lv1',
                name: 'Layer 1',
                visible: true,
                opacity: 100,
                blendMode: 'normal',
                clipping: false,
              },
            ],
            activeLayerId: 'lv1',
            palette: { name: 'V1Pal', colors: ['#FA143C', '#FFFFFF'] },
            selectedColorIndex: 0,
            order: 0,
            createdAt: 1,
            updatedAt: 1,
          })
        ),
        'projects/proj-v1/layers/lv1.bin': v1RawRgba,
      })

      const validatedV1 = inspectAndValidateEnvPack(legacyV1Zip)
      expect(validatedV1.manifest.formatVersion).toBe(1)

      const restoreDb = new DotDotDatabase(`${testDbName}-v1-restore`)
      try {
        await applyValidatedEnvPack(validatedV1, restoreDb)
        const restoredV1 = (await loadProjectFull('proj-v1', restoreDb))!
        expect(restoredV1.project.pixelFormat).toBe('indexed-v1')
        expect(restoredV1.layers[0]!.data.byteLength).toBe(16)
        expect(
          getPixel(restoredV1.layers[0]!.data, 4, 4, 0, 0, restoredV1.project.palette)
        ).toEqual({ r: 250, g: 20, b: 60, a: 255 })
      } finally {
        await restoreDb.delete()
      }
    } finally {
      await testDb.delete()
    }
  })
})

describe('v2.5.0+ UI Integration: Stamp Withdrawal, Indexed Palette Safe Deletion & Lavender Multi-Theme Variants', () => {
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

  afterEach(async () => {
    cleanup()
    await resetAllAppData(db)
  })

  it('8. UI Integration: verifies pixel-art cursor speed PixelSlider, advanced palette ramp/shade/harmony/unused-cleanup tools, and 6 Light + 6 Dark distinct retro themes', async () => {
    expect(LIGHT_THEME_VARIANTS).toHaveLength(6)
    expect(DARK_THEME_VARIANTS).toHaveLength(6)

    // Verify perceptual CIELAB intermediate ramp, hue-shifted tint/shade, harmony & unused cleanup helpers
    const ramp3 = generateIntermediateRampColors('#241F31', '#FAF6F0', 3)
    expect(ramp3).toHaveLength(3)
    const L0 = hexToCielab('#241F31').L
    const L1 = hexToCielab(ramp3[0]!).L
    const L2 = hexToCielab(ramp3[1]!).L
    const L3 = hexToCielab(ramp3[2]!).L
    const L4 = hexToCielab('#FAF6F0').L
    expect(L1).toBeGreaterThan(L0)
    expect(L2).toBeGreaterThan(L1)
    expect(L3).toBeGreaterThan(L2)
    expect(L4).toBeGreaterThan(L3)

    const tintHex = generatePixelArtToneVariant('#7B62AD', 'tint')
    const shadeHex = generatePixelArtToneVariant('#7B62AD', 'shade')
    expect(hexToCielab(tintHex).L).toBeGreaterThan(hexToCielab('#7B62AD').L)
    expect(hexToCielab(shadeHex).L).toBeLessThan(hexToCielab('#7B62AD').L)

    expect(generateColorHarmonyCompanions('#7B62AD', 'complementary')).toHaveLength(1)
    expect(generateColorHarmonyCompanions('#7B62AD', 'triadic')).toHaveLength(2)
    expect(generateColorHarmonyCompanions('#7B62AD', 'analogous')).toHaveLength(2)

    const basePal = normalizeProjectPalette({
      name: 'RampBase',
      colors: ['#111111', '#EEEEEE', '#FF0055'],
    })
    const inserted = insertColorsIntoIndexedPalette(basePal, ramp3, 0)
    expect(inserted.addedCount).toBe(3)
    expect(inserted.palette.colors.slice(0, 5)).toEqual([
      '#111111',
      ...ramp3,
      '#EEEEEE',
    ])
    // Fixed index 2 ('#FF0055') stays intact on canvas!
    expect(inserted.palette.colorTable![2]).toBe('#FF0055')

    const usedBuf = createPixelBuffer(4, 4)
    setPixel(usedBuf, 4, 4, 0, 0, 2) // uses fixedIndex 2 ('#FF0055') only
    const cleaned = removeUnusedColorsFromIndexedPalette({
      palette: inserted.palette,
      selectedDisplaySlot: 0,
      layers: [
        {
          id: 'l-clean',
          name: 'L',
          visible: true,
          opacity: 100,
          blendMode: 'normal',
          clipping: false,
          offsetX: 0,
          offsetY: 0,
          dataWidth: 4,
          dataHeight: 4,
          data: usedBuf,
        },
      ],
    })
    expect(cleaned.removedCount).toBe(5)
    expect(cleaned.palette.colors).toEqual(['#FF0055'])

    // Verify browser locale auto-detection (Japanese -> 'ja', Korean -> 'ko', English -> 'en', unknown/other -> 'en')
    expect(detectPreferredLanguage(['ja-JP'])).toBe('ja')
    expect(detectPreferredLanguage(['ko-KR', 'en-US'])).toBe('ko')
    expect(detectPreferredLanguage(['en-GB'])).toBe('en')
    expect(detectPreferredLanguage(['fr-FR', 'de-DE'])).toBe('en')
    expect(detectPreferredLanguage([])).toBe('en')
    expect(detectPreferredLanguage(null)).toBe('ja') // falls back to test navigator ('ja-JP')
    expect(normalizeAppSettings({ language: 'unknown' as never }).language).toBe('ja')

    // Verify legacy removed variant ID gracefully resolves to default theme tokens
    expect(
      resolveActiveThemeTokens(false, 'milk-lilac' as never, 'dusk-plum')['--bg-app']
    ).toBe(LIGHT_THEME_VARIANTS[0]!.tokens['--bg-app'])

    window.history.pushState({}, '', '/')
    render(<App />)

    // Gallery single unified import button directly opens UnifiedImportModal (auto-detecting PNG/GIF/Aseprite)
    const galleryImportBtn = await screen.findByTestId('gallery-import-menu-btn')
    fireEvent.click(galleryImportBtn)
    expect(await screen.findByTestId('unified-import-modal')).toBeTruthy()
    expect(screen.getByTestId('unified-import-file-input')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })

    // Create new artwork -> opens Editor
    const newBtn = await screen.findByTestId('new-artwork-btn')
    fireEvent.click(newBtn)
    const confirmCreate = await screen.findByTestId('confirm-create-artwork-btn')
    fireEvent.click(confirmCreate)

    // Stamp button MUST NOT exist anywhere; Symmetry, Tile Preview & PixelSlider Cursor Speed live inside GlobalEditorSettingsModal!
    expect(screen.queryByTestId('quick-stamp-sheet-btn')).toBeNull()
    expect(screen.queryByTestId('stamp-sheet-modal')).toBeNull()

    const openGlobalSettingsBtn = await screen.findByTestId(
      'open-global-editor-settings-btn'
    )
    fireEvent.click(openGlobalSettingsBtn)
    expect(await screen.findByTestId('global-editor-settings-modal')).toBeTruthy()

    // Cursor speed slider in Editor settings MUST be pixel-art PixelSlider (no native input[type="range"]!)
    const editorCursorSlider = screen.getByTestId('cursor-speed-slider')
    expect(editorCursorSlider.getAttribute('role')).toBe('slider')
    expect(screen.getByTestId('cursor-speed-slider-minus')).toBeTruthy()
    expect(screen.getByTestId('cursor-speed-slider-plus')).toBeTruthy()
    expect(document.querySelector('input[type="range"]')).toBeNull()

    const symHorizBtn = screen.getByTestId('global-symmetry-horizontal')
    expect(symHorizBtn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(symHorizBtn)
    expect(symHorizBtn.getAttribute('aria-pressed')).toBe('true')

    const tile3x3Btn = screen.getByTestId('global-tile-preview-3x3')
    fireEvent.click(tile3x3Btn)
    expect(tile3x3Btn.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByTestId('close-global-editor-settings-btn'))

    // Open PaletteSheet -> verify single unified button (`palette-open-tools-btn`) & NO duplicate `palette-open-create-tools-btn`
    const openPaletteBtn = screen.getByTestId('open-palette-btn')
    fireEvent.click(openPaletteBtn)
    expect(screen.queryByTestId('palette-open-create-tools-btn')).toBeNull()

    const openToolsBtn = await screen.findByTestId('palette-open-tools-btn')
    fireEvent.click(openToolsBtn)
    expect(await screen.findByTestId('palette-tools-modal')).toBeTruthy()
    fireEvent.click(screen.getByTestId('palette-sort-light-asc'))
    expect(await screen.findByTestId('palette-restore-original-btn')).toBeTruthy()

    // Switch to `色生成・中間色` (`create`) tab -> close (`×`) button stays pinned & accessible
    fireEvent.click(screen.getByTestId('palette-tools-tab-create'))
    expect(await screen.findByTestId('palette-create-panel')).toBeTruthy()
    expect(screen.getAllByTestId('modal-close-btn').length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByTestId('palette-insert-ramp-btn'))
    fireEvent.click(screen.getByTestId('palette-add-tone-pair-btn'))

    // Switch to Analyze & Replace tabs -> verify ZERO native input[type="checkbox"] and PixelCheckbox (`role="checkbox"`) in Replace tab!
    fireEvent.click(screen.getByTestId('palette-tools-tab-analyze'))
    expect(await screen.findByTestId('palette-analyze-panel')).toBeTruthy()
    expect(screen.getByTestId('palette-cleanup-unused-btn')).toBeTruthy()

    fireEvent.click(screen.getByTestId('palette-tools-tab-replace'))
    expect(await screen.findByTestId('palette-replace-panel')).toBeTruthy()
    const syncCheckbox = screen.getByTestId('replace-sync-swatch-checkbox')
    expect(syncCheckbox.getAttribute('role')).toBe('checkbox')
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()

    // Navigate to Settings -> verify PixelSlider cursor speed & 6 Light + 6 Dark distinct retro themes!
    window.history.pushState({}, '', '/settings')
    fireEvent(window, new PopStateEvent('popstate'))

    const settingsCursorSlider = await screen.findByTestId(
      'settings-cursor-speed-slider'
    )
    expect(settingsCursorSlider.getAttribute('role')).toBe('slider')
    expect(screen.getByTestId('settings-cursor-speed-slider-minus')).toBeTruthy()
    expect(screen.getByTestId('settings-cursor-speed-slider-plus')).toBeTruthy()
    expect(document.querySelector('input[type="range"]')).toBeNull()

    const themeDetailsBtn = await screen.findByTestId('toggle-theme-details-btn')
    expect(themeDetailsBtn.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('theme-details-panel')).toBeNull()

    fireEvent.click(themeDetailsBtn)
    expect(themeDetailsBtn.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByTestId('theme-details-panel')).toBeTruthy()

    fireEvent.click(screen.getByTestId('light-theme-variant-antique-brass'))
    fireEvent.click(screen.getByTestId('light-theme-variant-urban-concrete'))
    fireEvent.click(screen.getByTestId('dark-theme-variant-royal-velvet'))
    fireEvent.click(screen.getByTestId('dark-theme-variant-tokyo-neon'))
    fireEvent.click(screen.getByTestId('dark-theme-variant-amber-crt'))

    const advToggle = screen.getByTestId('settings-toggle-advanced-btn')
    expect(advToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(advToggle)
    expect(advToggle.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByTestId('settings-embed-png-meta-checkbox')).toBeTruthy()

    // Unused helper guard
    const tmp = await createNewProject({
      name: 'Check',
      width: 4,
      height: 4,
      palette: { name: 'P', colors: ['#112233'] },
    })
    expect(tmp.project.pixelFormat).toBe('indexed-v1')
  })
})
