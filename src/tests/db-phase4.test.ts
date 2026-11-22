import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  createNewProject,
  DEFAULT_BACKUP_META,
  deleteLibraryPalette,
  DotDotDatabase,
  initializeDatabase,
  loadProjectFull,
  saveProjectFull,
  UI_SIZE_PRESETS,
} from '../db/database'
import {
  applyValidatedEnvPack,
  exportEnvironmentPackZip,
  inspectAndValidateEnvPack,
} from '../db/envPack'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import { createPixelPatch, HistoryManager } from '../engine/history'

const RED = { r: 255, g: 30, b: 60, a: 255 }
const CYAN = { r: 0, g: 220, b: 255, a: 255 }

describe('IndexedDB (Dexie), Palettes, Startup Invariants & Environment Pack ZIP Round-Trip', () => {
  it('initializes 6 default palettes with 0 initial artworks and enforces >=1 palette invariant', async () => {
    const testDb = new DotDotDatabase(`test-db-${Date.now()}-1`)
    const init = await initializeDatabase(testDb)

    expect(init.palettes.length).toBe(6)
    expect(init.settings.language).toBe('ja')
    expect(init.settings.eyedropperDoubleTap).toBe(true)
    expect(await testDb.projects.count()).toBe(0)
    expect(init.settings.activeProjectId).toBeNull()

    for (let i = 0; i < 5; i++) {
      const ok = await deleteLibraryPalette(init.palettes[i].id, testDb)
      expect(ok).toBe(true)
    }
    const deleteLast = await deleteLibraryPalette(init.palettes[5].id, testDb)
    expect(deleteLast).toBe(false)
    expect(await testDb.palettes.count()).toBe(1)

    await testDb.delete()
  })

  it('exports full workspace (including custom presets, off-canvas layer buffers, UI size & Undo/Redo history) to ZIP and restores identically', async () => {
    const sourceDb = new DotDotDatabase(`test-db-src-${Date.now()}`)
    await initializeDatabase(sourceDb)

    await sourceDb.settings.put({
      id: 'app-settings',
      theme: 'dark',
      language: 'ko',
      historyLimit: 50,
      showGrid: false,
      checkerboardDark: true,
      confirmDestructive: true,
      soundEnabled: false,
      eyedropperDoubleTap: false,
      activeProjectId: null,
      gallerySortMode: 'newest',
      uiSize: {
        ...UI_SIZE_PRESETS.large,
        preset: 'custom',
        drawButtonVh: 18,
      },
      customCanvasPresets: [
        { id: 'cp-1', name: 'Wide Banner', width: 96, height: 32 },
      ],
      backupMeta: {
        ...DEFAULT_BACKUP_META,
        lastExportAt: 50000,
      },
    })

    const created = await createNewProject(
      {
        name: 'Hero Sprite',
        width: 16,
        height: 16,
        palette: {
          name: 'Custom Hero Palette',
          colors: ['#112233', '#FF1E3C', '#00DCFF'],
        },
      },
      sourceDb
    )

    const beforeLayer1 = createPixelBuffer(16, 16)
    const afterLayer1 = new Uint8ClampedArray(beforeLayer1)
    setPixel(afterLayer1, 16, 16, 4, 5, RED)

    const layer2Data = createPixelBuffer(16, 16)
    setPixel(layer2Data, 16, 16, 4, 5, CYAN)

    const historyMgr = new HistoryManager(50)
    const patch = createPixelPatch(created.layers[0].id, beforeLayer1, afterLayer1)!
    historyMgr.push({
      id: 'h-1',
      label: 'Pen',
      timestamp: 12345,
      kind: 'pixel-diff',
      pixelPatches: [patch],
    })

    const fullLayers = [
      { ...created.layers[0], data: afterLayer1 },
      {
        id: 'layer-2',
        name: 'Highlight Clip',
        visible: true,
        opacity: 80,
        blendMode: 'screen' as const,
        clipping: true,
        offsetX: 0,
        offsetY: 0,
        dataWidth: 16,
        dataHeight: 16,
        data: layer2Data,
      },
    ]

    await saveProjectFull(
      {
        project: {
          ...created.project,
          selectedColorIndex: 2,
        },
        layers: fullLayers,
        history: historyMgr.serialize(),
      },
      sourceDb
    )

    const zipBytes = await exportEnvironmentPackZip(sourceDb)
    expect(zipBytes.byteLength).toBeGreaterThan(200)

    const validated = inspectAndValidateEnvPack(zipBytes)
    expect(validated.manifest.counts.projects).toBe(1)
    expect(validated.manifest.counts.palettes).toBe(6)
    expect(validated.settings.language).toBe('ko')
    expect(validated.settings.theme).toBe('dark')
    expect(validated.settings.eyedropperDoubleTap).toBe(false)
    expect(validated.settings.customCanvasPresets.length).toBe(1)
    expect(validated.settings.uiSize.drawButtonVh).toBe(18)

    const destDb = new DotDotDatabase(`test-db-dst-${Date.now()}`)
    await initializeDatabase(destDb)
    await applyValidatedEnvPack(validated, destDb)

    const restoredSettings = await destDb.settings.get('app-settings')
    expect(restoredSettings?.uiSize.drawButtonVh).toBe(18)
    expect(restoredSettings?.eyedropperDoubleTap).toBe(false)
    expect(restoredSettings?.customCanvasPresets[0]?.name).toBe('Wide Banner')

    const restoredHero = await loadProjectFull(created.project.id, destDb)
    expect(restoredHero).not.toBeNull()
    expect(restoredHero!.project.name).toBe('Hero Sprite')
    expect(restoredHero!.layers.length).toBe(2)
    expect(restoredHero!.layers[1].clipping).toBe(true)
    expect(getPixel(restoredHero!.layers[0].data, 16, 16, 4, 5)).toEqual(RED)
    expect(getPixel(restoredHero!.layers[1].data, 16, 16, 4, 5)).toEqual(CYAN)

    expect(restoredHero!.history.undoStack.length).toBe(1)
    const restoredHistoryMgr = new HistoryManager(50)
    restoredHistoryMgr.hydrate(restoredHero!.history)
    const undoneState = restoredHistoryMgr.undo({
      width: 16,
      height: 16,
      layers: restoredHero!.layers,
      activeLayerId: restoredHero!.project.activeLayerId,
      selectionMask: null,
      palette: restoredHero!.project.palette,
    })!
    expect(getPixel(undoneState.layers[0].data, 16, 16, 4, 5).a).toBe(0)

    await sourceDb.delete()
    await destDb.delete()
  })

  it('rejects corrupted or malformed Environment Pack ZIP without losing existing IndexedDB data', async () => {
    const safeDb = new DotDotDatabase(`test-db-safe-${Date.now()}`)
    await initializeDatabase(safeDb)
    await createNewProject(
      {
        name: 'Protected Artwork',
        width: 16,
        height: 16,
        palette: { name: 'P', colors: ['#000000'] },
      },
      safeDb
    )
    const beforeCount = await safeDb.projects.count()

    expect(() => inspectAndValidateEnvPack(new Uint8Array([1, 2, 3, 4]))).toThrow()
    const badZip = zipSync({ 'foo.txt': strToU8('hello') })
    expect(() => inspectAndValidateEnvPack(badZip)).toThrow(/MISSING_MANIFEST/)

    expect(await safeDb.projects.count()).toBe(beforeCount)
    await safeDb.delete()
  })
})
