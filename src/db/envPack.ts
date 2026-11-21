import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type {
  AppSettings,
  CanvasSnapshot,
  LayerMeta,
  LayerPixelRecord,
  PaletteData,
  ProjectHistoryRecord,
  ProjectRecord,
  SerializedHistoryEntry,
  SerializedPixelPatch,
} from '../types'
import { DEFAULT_APP_SETTINGS, DotDotDatabase, db } from './database'
import { exportCompositePngBytes } from '../engine/compositor'

export const ENV_PACK_FORMAT = 'dotdot-environment-pack'
export const ENV_PACK_VERSION = 1

export interface EnvPackManifest {
  format: typeof ENV_PACK_FORMAT
  formatVersion: number
  appVersion: string
  exportedAt: number
  projectOrder: string[]
  paletteOrder: string[]
  counts: {
    projects: number
    palettes: number
    totalLayers: number
    totalHistoryEntries: number
  }
}

interface EncodedPixelPatchJson {
  layerId: string
  indicesB64: string
  beforeB64: string
  afterB64: string
}

interface EncodedSnapshotJson {
  width: number
  height: number
  activeLayerId: string
  layers: Array<{
    meta: LayerMeta
    dataB64: string
  }>
}

interface EncodedHistoryEntryJson {
  id: string
  label: string
  timestamp: number
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette'
  pixelPatches?: EncodedPixelPatchJson[]
  beforeStructure?: EncodedSnapshotJson
  afterStructure?: EncodedSnapshotJson
  beforeSelectionB64?: string | null
  afterSelectionB64?: string | null
  beforePalette?: ProjectRecord['palette']
  afterPalette?: ProjectRecord['palette']
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

function uint32ToBytes(arr: Uint32Array): Uint8Array {
  const out = new Uint8Array(arr.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < arr.length; i++) {
    view.setUint32(i * 4, arr[i], true)
  }
  return out
}

function bytesToUint32(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new Error('Corrupted Uint32Array byte length in history')
  }
  const len = bytes.byteLength / 4
  const out = new Uint32Array(len)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < len; i++) {
    out[i] = view.getUint32(i * 4, true)
  }
  return out
}

function encodeSnapshot(snap?: CanvasSnapshot): EncodedSnapshotJson | undefined {
  if (!snap) return undefined
  return {
    width: snap.width,
    height: snap.height,
    activeLayerId: snap.activeLayerId,
    layers: snap.layers.map((l) => ({
      meta: l.meta,
      dataB64: bytesToBase64(l.data),
    })),
  }
}

function decodeSnapshot(enc?: EncodedSnapshotJson): CanvasSnapshot | undefined {
  if (!enc) return undefined
  return {
    width: enc.width,
    height: enc.height,
    activeLayerId: enc.activeLayerId,
    layers: enc.layers.map((l) => {
      const data = base64ToBytes(l.dataB64)
      if (data.byteLength !== enc.width * enc.height * 4) {
        throw new Error('Corrupted snapshot layer dimensions in history')
      }
      return {
        meta: l.meta,
        data,
      }
    }),
  }
}

function encodeHistoryStack(stack: SerializedHistoryEntry[]): Uint8Array {
  const encoded: EncodedHistoryEntryJson[] = stack.map((e) => ({
    id: e.id,
    label: e.label,
    timestamp: e.timestamp,
    kind: e.kind,
    pixelPatches: e.pixelPatches?.map((p) => ({
      layerId: p.layerId,
      indicesB64: bytesToBase64(uint32ToBytes(p.indices)),
      beforeB64: bytesToBase64(p.before),
      afterB64: bytesToBase64(p.after),
    })),
    beforeStructure: encodeSnapshot(e.beforeStructure),
    afterStructure: encodeSnapshot(e.afterStructure),
    beforeSelectionB64:
      e.beforeSelection === undefined
        ? undefined
        : e.beforeSelection === null
          ? null
          : bytesToBase64(e.beforeSelection),
    afterSelectionB64:
      e.afterSelection === undefined
        ? undefined
        : e.afterSelection === null
          ? null
          : bytesToBase64(e.afterSelection),
    beforePalette: e.beforePalette,
    afterPalette: e.afterPalette,
  }))
  return strToU8(JSON.stringify(encoded))
}

function decodeHistoryStack(raw: Uint8Array): SerializedHistoryEntry[] {
  const parsed = JSON.parse(strFromU8(raw)) as EncodedHistoryEntryJson[]
  if (!Array.isArray(parsed)) {
    throw new Error('History stack is not an array')
  }

  return parsed.map((e) => {
    const pixelPatches: SerializedPixelPatch[] | undefined = e.pixelPatches?.map((p) => {
      const indices = bytesToUint32(base64ToBytes(p.indicesB64))
      const before = base64ToBytes(p.beforeB64)
      const after = base64ToBytes(p.afterB64)
      if (before.length !== indices.length * 4 || after.length !== indices.length * 4) {
        throw new Error('Corrupted pixel patch length in history')
      }
      return {
        layerId: p.layerId,
        indices,
        before,
        after,
      }
    })

    return {
      id: e.id,
      label: e.label,
      timestamp: e.timestamp,
      kind: e.kind,
      pixelPatches,
      beforeStructure: decodeSnapshot(e.beforeStructure),
      afterStructure: decodeSnapshot(e.afterStructure),
      beforeSelection:
        e.beforeSelectionB64 === undefined
          ? undefined
          : e.beforeSelectionB64 === null
            ? null
            : base64ToBytes(e.beforeSelectionB64),
      afterSelection:
        e.afterSelectionB64 === undefined
          ? undefined
          : e.afterSelectionB64 === null
            ? null
            : base64ToBytes(e.afterSelectionB64),
      beforePalette: e.beforePalette,
      afterPalette: e.afterPalette,
    }
  })
}

/**
 * Export entire dotdot state (projects, layers, pixel data, palettes, settings, order, metadata, undo/redo history)
 * into a structured ZIP archive (`environment-pack.zip`).
 */
export async function exportEnvironmentPackZip(
  targetDb: DotDotDatabase = db
): Promise<Uint8Array> {
  const settings = (await targetDb.settings.get('app-settings')) ?? DEFAULT_APP_SETTINGS
  const palettes = await targetDb.palettes.orderBy('order').toArray()
  const projects = await targetDb.projects.orderBy('order').toArray()
  const allPixels = await targetDb.layerPixels.toArray()
  const allHistories = await targetDb.histories.toArray()

  const pixelByKey = new Map<string, Uint8Array>()
  for (const row of allPixels) {
    pixelByKey.set(row.key, row.data)
  }

  const historyByProject = new Map<string, ProjectHistoryRecord>()
  for (const h of allHistories) {
    historyByProject.set(h.projectId, h)
  }

  const zipEntries: Zippable = {}
  let totalLayers = 0
  let totalHistoryEntries = 0

  // Palettes
  palettes.forEach((pal, idx) => {
    const fileIdx = String(idx + 1).padStart(3, '0')
    zipEntries[`palettes/palette-${fileIdx}.json`] = strToU8(
      JSON.stringify(pal, null, 2)
    )
  })

  // Projects, raw layer pixel binaries, and undo/redo history binaries
  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i]
    const dirName = `projects/${proj.id}`
    const { thumbnailPng: _thumb, ...serializableProject } = proj

    zipEntries[`${dirName}/project.json`] = strToU8(
      JSON.stringify(serializableProject, null, 2)
    )

    for (const layerMeta of proj.layers) {
      totalLayers++
      const raw =
        pixelByKey.get(`${proj.id}:${layerMeta.id}`) ??
        new Uint8Array(proj.width * proj.height * 4)
      zipEntries[`${dirName}/layers/${layerMeta.id}.bin`] = raw
    }

    const hist = historyByProject.get(proj.id) ?? {
      projectId: proj.id,
      undoStack: [],
      redoStack: [],
      updatedAt: proj.updatedAt,
    }
    totalHistoryEntries += hist.undoStack.length + hist.redoStack.length
    zipEntries[`${dirName}/history/undo.bin`] = encodeHistoryStack(hist.undoStack)
    zipEntries[`${dirName}/history/redo.bin`] = encodeHistoryStack(hist.redoStack)
  }

  const manifest: EnvPackManifest = {
    format: ENV_PACK_FORMAT,
    formatVersion: ENV_PACK_VERSION,
    appVersion: '1.0.0',
    exportedAt: Date.now(),
    projectOrder: projects.map((p) => p.id),
    paletteOrder: palettes.map((p) => p.id),
    counts: {
      projects: projects.length,
      palettes: palettes.length,
      totalLayers,
      totalHistoryEntries,
    },
  }

  zipEntries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  zipEntries['settings.json'] = strToU8(JSON.stringify(settings, null, 2))
  zipEntries['README.txt'] = strToU8(
    [
      'dotdot Environment Pack Archive',
      `Format Version: ${ENV_PACK_VERSION}`,
      `Exported At: ${new Date(manifest.exportedAt).toISOString()}`,
      `Projects: ${manifest.counts.projects}`,
      `Palettes: ${manifest.counts.palettes}`,
      '',
      'Import this ZIP file inside dotdot Settings > Environment Pack to restore your full workspace.',
    ].join('\n')
  )

  return zipSync(zipEntries, { level: 6 })
}

export interface ValidatedEnvPack {
  manifest: EnvPackManifest
  settings: AppSettings
  palettes: PaletteData[]
  projects: ProjectRecord[]
  layerPixels: LayerPixelRecord[]
  histories: ProjectHistoryRecord[]
}

/**
 * Unpack and strictly validate an Environment Pack ZIP in memory BEFORE touching IndexedDB.
 * Throws a descriptive Error if the archive is corrupted, malformed, or violates invariants.
 */
export function inspectAndValidateEnvPack(zipBytes: Uint8Array): ValidatedEnvPack {
  if (!zipBytes || zipBytes.byteLength < 22) {
    throw new Error('INVALID_ZIP: Archive is empty or too small')
  }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zipBytes)
  } catch {
    throw new Error('INVALID_ZIP: Failed to decompress ZIP archive')
  }

  const manifestRaw = files['manifest.json']
  if (!manifestRaw) {
    throw new Error('MISSING_MANIFEST: manifest.json not found in archive')
  }

  let manifest: EnvPackManifest
  try {
    manifest = JSON.parse(strFromU8(manifestRaw)) as EnvPackManifest
  } catch {
    throw new Error('INVALID_MANIFEST: manifest.json is not valid JSON')
  }

  if (manifest.format !== ENV_PACK_FORMAT) {
    throw new Error('UNSUPPORTED_FORMAT: Not a dotdot environment pack')
  }
  if (manifest.formatVersion !== ENV_PACK_VERSION) {
    throw new Error(`UNSUPPORTED_VERSION: Unsupported version ${manifest.formatVersion}`)
  }

  const settingsRaw = files['settings.json']
  if (!settingsRaw) {
    throw new Error('MISSING_SETTINGS: settings.json not found in archive')
  }
  const parsedSettings = JSON.parse(strFromU8(settingsRaw)) as Partial<AppSettings>
  const settings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    ...parsedSettings,
    id: 'app-settings',
  }

  // Parse and validate palettes (must have at least 1 palette)
  const palettePaths = Object.keys(files)
    .filter((k) => k.startsWith('palettes/') && k.endsWith('.json'))
    .sort()

  if (palettePaths.length === 0) {
    throw new Error('INVALID_PALETTES: Environment pack must contain at least 1 palette')
  }

  const palettes: PaletteData[] = palettePaths.map((path, idx) => {
    const pal = JSON.parse(strFromU8(files[path])) as PaletteData
    if (
      !pal ||
      typeof pal.id !== 'string' ||
      typeof pal.name !== 'string' ||
      !Array.isArray(pal.colors) ||
      pal.colors.length === 0 ||
      pal.colors.length > 256
    ) {
      throw new Error(`INVALID_PALETTE_DATA: Invalid palette in ${path}`)
    }
    return {
      ...pal,
      order: typeof pal.order === 'number' ? pal.order : idx,
    }
  })

  // Parse and validate all projects referenced in manifest.projectOrder (or projects/*/project.json)
  const projectJsonPaths = Object.keys(files).filter(
    (k) => k.startsWith('projects/') && k.endsWith('/project.json')
  )

  if (projectJsonPaths.length !== manifest.counts.projects) {
    throw new Error('COUNT_MISMATCH: Project count does not match manifest')
  }

  const projects: ProjectRecord[] = []
  const layerPixels: LayerPixelRecord[] = []
  const histories: ProjectHistoryRecord[] = []

  for (const projPath of projectJsonPaths) {
    const proj = JSON.parse(strFromU8(files[projPath])) as Omit<ProjectRecord, 'thumbnailPng'>
    if (
      !proj ||
      typeof proj.id !== 'string' ||
      typeof proj.width !== 'number' ||
      typeof proj.height !== 'number' ||
      proj.width < 1 ||
      proj.width > 256 ||
      proj.height < 1 ||
      proj.height > 256 ||
      !Array.isArray(proj.layers) ||
      proj.layers.length < 1 ||
      proj.layers.length > 50
    ) {
      throw new Error(`INVALID_PROJECT: Invalid project metadata at ${projPath}`)
    }

    const baseDir = `projects/${proj.id}`
    const expectedBytes = proj.width * proj.height * 4
    const runtimeLayersForThumb = []

    for (const layerMeta of proj.layers) {
      const layerBinPath = `${baseDir}/layers/${layerMeta.id}.bin`
      const layerBin = files[layerBinPath]
      if (!layerBin) {
        throw new Error(`MISSING_LAYER_BIN: Missing layer binary ${layerBinPath}`)
      }
      if (layerBin.byteLength !== expectedBytes) {
        throw new Error(
          `CORRUPT_LAYER_BIN: Expected ${expectedBytes} bytes, got ${layerBin.byteLength} in ${layerBinPath}`
        )
      }

      const copy = new Uint8Array(layerBin)
      layerPixels.push({
        key: `${proj.id}:${layerMeta.id}`,
        projectId: proj.id,
        layerId: layerMeta.id,
        data: copy,
      })

      runtimeLayersForThumb.push({
        ...layerMeta,
        data: new Uint8ClampedArray(copy),
      })
    }

    // Regenerate lossless 1x thumbnail PNG for gallery
    const { png: thumbnailPng } = exportCompositePngBytes(
      runtimeLayersForThumb,
      proj.width,
      proj.height,
      1
    )

    projects.push({
      ...proj,
      thumbnailPng,
    })

    const undoBin = files[`${baseDir}/history/undo.bin`]
    const redoBin = files[`${baseDir}/history/redo.bin`]
    const undoStack = undoBin ? decodeHistoryStack(undoBin) : []
    const redoStack = redoBin ? decodeHistoryStack(redoBin) : []

    histories.push({
      projectId: proj.id,
      undoStack,
      redoStack,
      updatedAt: proj.updatedAt,
    })
  }

  // Sort projects and palettes according to order
  projects.sort((a, b) => a.order - b.order)
  palettes.sort((a, b) => a.order - b.order)

  return {
    manifest,
    settings,
    palettes,
    projects,
    layerPixels,
    histories,
  }
}

/**
 * Atomically replace all IndexedDB data with a pre-validated Environment Pack.
 * Because validation already succeeded in memory and writes occur inside a single Dexie transaction,
 * existing user data is never partially wiped on error.
 */
export async function applyValidatedEnvPack(
  pack: ValidatedEnvPack,
  targetDb: DotDotDatabase = db
): Promise<void> {
  await targetDb.transaction(
    'rw',
    [
      targetDb.settings,
      targetDb.palettes,
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.histories,
    ],
    async () => {
      await targetDb.settings.clear()
      await targetDb.palettes.clear()
      await targetDb.projects.clear()
      await targetDb.layerPixels.clear()
      await targetDb.histories.clear()

      await targetDb.settings.put(pack.settings)
      await targetDb.palettes.bulkPut(pack.palettes)
      if (pack.projects.length > 0) {
        await targetDb.projects.bulkPut(pack.projects)
      }
      if (pack.layerPixels.length > 0) {
        await targetDb.layerPixels.bulkPut(pack.layerPixels)
      }
      if (pack.histories.length > 0) {
        await targetDb.histories.bulkPut(pack.histories)
      }
    }
  )
}
