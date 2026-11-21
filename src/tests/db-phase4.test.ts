import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  createNewProject,
  deleteLibraryPalette,
  DotDotDatabase,
  initializeDatabase,
  loadProjectFull,
  saveProjectFull,
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

describe('IndexedDB (Dexie), Palettes & Environment Pack ZIP Round-Trip', () => {
  it('initializes 6 default palettes, enforces >=1 palette invariant, and persists projects + history', async () => {
    const testDb = new DotDotDatabase(`test-db-${Date.now()}-1`)
    const init = await initializeDatabase(testDb)

    expect(init.palettes.length).toBe(6)
    expect(init.settings.language).toBe('ja')
    expect(init.settings.activeProjectId).toBeTruthy()

    // Try deleting palettes down to 1 -> 6th deletion must be blocked!
    for (let i = 0; i < 5; i++) {
      const ok = await deleteLibraryPalette(init.palettes[i].id, testDb)
      expect(ok).toBe(true)
    }
    const deleteLast = await deleteLibraryPalette(init.palettes[5].id, testDb)
    expect(deleteLast).toBe(false)
    expect(await testDb.palettes.count()).toBe(1)

    await testDb.delete()
  })

  it('exports full workspace to Environment Pack ZIP and restores pixel data, layers, palettes, settings & Undo/Redo history identically', async () => {
    const sourceDb = new DotDotDatabase(`test-db-src-${Date.now()}`)
    await initializeDatabase(sourceDb)

    // Update settings
    await sourceDb.settings.put({
      id: 'app-settings',
      theme: 'dark',
      language: 'ko',
      historyLimit: 50,
      showGrid: false,
      checkerboardDark: true,
      confirmDestructive: true,
      soundEnabled: false,
      activeProjectId: null,
      gallerySortMode: 'newest',
    })

    // Create a custom 16x16 project with 2 layers and undo/redo history
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

    // Export Environment Pack ZIP
    const zipBytes = await exportEnvironmentPackZip(sourceDb)
    expect(zipBytes.byteLength).toBeGreaterThan(200)

    // Validate before importing into a completely separate DB
    const validated = inspectAndValidateEnvPack(zipBytes)
    expect(validated.manifest.counts.projects).toBe(2) // initial project + Hero Sprite
    expect(validated.manifest.counts.palettes).toBe(6)
    expect(validated.settings.language).toBe('ko')
    expect(validated.settings.theme).toBe('dark')

    const destDb = new DotDotDatabase(`test-db-dst-${Date.now()}`)
    await initializeDatabase(destDb)
    await applyValidatedEnvPack(validated, destDb)

    const restoredHero = await loadProjectFull(created.project.id, destDb)
    expect(restoredHero).not.toBeNull()
    expect(restoredHero!.project.name).toBe('Hero Sprite')
    expect(restoredHero!.project.palette.colors).toEqual(['#112233', '#FF1E3C', '#00DCFF'])
    expect(restoredHero!.layers.length).toBe(2)
    expect(restoredHero!.layers[1].clipping).toBe(true)
    expect(restoredHero!.layers[1].opacity).toBe(80)
    expect(restoredHero!.layers[1].blendMode).toBe('screen')

    expect(getPixel(restoredHero!.layers[0].data, 16, 16, 4, 5)).toEqual(RED)
    expect(getPixel(restoredHero!.layers[1].data, 16, 16, 4, 5)).toEqual(CYAN)

    // Verify Undo history survived ZIP export & import and actually undoes the pixel!
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
    const beforeCount = await safeDb.projects.count()

    // Malformed ZIP (not a zip)
    expect(() => inspectAndValidateEnvPack(new Uint8Array([1, 2, 3, 4]))).toThrow()

    // Valid ZIP container missing manifest.json
    const badZip = zipSync({ 'foo.txt': strToU8('hello') })
    expect(() => inspectAndValidateEnvPack(badZip)).toThrow(/MISSING_MANIFEST/)

    // Existing DB remains completely untouched
    expect(await safeDb.projects.count()).toBe(beforeCount)
    await safeDb.delete()
  })
})
