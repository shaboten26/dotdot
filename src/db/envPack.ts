import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type {
  AppSettings,
  CanvasSnapshot,
  CelBufferRecord,
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerOffsetTransition,
  LayerPixelRecord,
  LayerRuntime,
  PaletteData,
  ProjectHistoryRecord,
  ProjectRecord,
  SerializedHistoryEntry,
  SerializedPixelPatch,
  StampAsset,
  TimelineSnapshot,
} from '../types'
import { DEFAULT_APP_SETTINGS, DotDotDatabase, db, normalizeAppSettings } from './database'
import { exportCompositePngBytes, MAX_LAYERS } from '../engine/compositor'
import { normalizeLayerGeometry } from '../engine/pixelBuffer'
import { projectFrameLayers } from '../engine/animation'

export const ENV_PACK_FORMAT = 'dotdot-environment-pack'
export const ENV_PACK_VERSION = 1

export interface EnvPackManifest {
  format: typeof ENV_PACK_FORMAT
  formatVersion: number
  appVersion: string
  exportedAt: number
  projectOrder: string[]
  paletteOrder: string[]
  stampOrder?: string[]
  counts: {
    projects: number
    palettes: number
    stamps?: number
    totalLayers: number
    totalCels?: number
    totalHistoryEntries: number
  }
}

interface EncodedCelGeometryMeta {
  celId: string
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
}

interface EncodedPixelPatchJson {
  layerId: string
  celId?: string
  indicesB64: string
  beforeB64: string
  afterB64: string
  beforeGeometry?: {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
  }
  afterGeometry?: {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
  }
}

interface EncodedTimelineSnapshotJson {
  frames: FrameMeta[]
  cels: CelMap
  activeFrameId: string
  celBuffers: Array<{
    id: string
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
    dataB64: string
  }>
}

interface EncodedSnapshotJson {
  width: number
  height: number
  activeLayerId: string
  layers: Array<{
    meta: LayerMeta
    dataB64: string
  }>
  timeline?: EncodedTimelineSnapshotJson
}

interface EncodedHistoryEntryJson {
  id: string
  label: string
  timestamp: number
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette' | 'layer-offset'
  frameId?: string
  celAllocation?: {
    cellKey: string
    allocatedCelId: string
  }
  pixelPatches?: EncodedPixelPatchJson[]
  layerOffsetChange?: LayerOffsetTransition
  layerOffsetChanges?: LayerOffsetTransition[]
  beforeStructure?: EncodedSnapshotJson
  afterStructure?: EncodedSnapshotJson
  beforeSelectionB64?: string | null
  afterSelectionB64?: string | null
  beforeWorldSelection?: {
    originX: number
    originY: number
    width: number
    height: number
    maskB64: string
  } | null
  afterWorldSelection?: {
    originX: number
    originY: number
    width: number
    height: number
    maskB64: string
  } | null
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

function encodeTimelineSnapshot(
  tl?: TimelineSnapshot
): EncodedTimelineSnapshotJson | undefined {
  if (!tl) return undefined
  return {
    frames: tl.frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
    cels: { ...tl.cels },
    activeFrameId: tl.activeFrameId,
    celBuffers: tl.celBuffers.map((cb) => ({
      id: cb.id,
      offsetX: cb.offsetX,
      offsetY: cb.offsetY,
      dataWidth: cb.dataWidth,
      dataHeight: cb.dataHeight,
      dataB64: bytesToBase64(cb.data),
    })),
  }
}

function decodeTimelineSnapshot(
  enc?: EncodedTimelineSnapshotJson
): TimelineSnapshot | undefined {
  if (!enc) return undefined
  return {
    frames: enc.frames.map((f) => ({ id: f.id, durationMs: f.durationMs })),
    cels: { ...enc.cels },
    activeFrameId: enc.activeFrameId,
    celBuffers: enc.celBuffers.map((cb) => {
      const data = base64ToBytes(cb.dataB64)
      if (data.byteLength !== cb.dataWidth * cb.dataHeight * 4) {
        throw new Error('Corrupted timeline snapshot celBuffer dimensions in history')
      }
      return {
        id: cb.id,
        offsetX: cb.offsetX,
        offsetY: cb.offsetY,
        dataWidth: cb.dataWidth,
        dataHeight: cb.dataHeight,
        data,
      }
    }),
  }
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
    timeline: encodeTimelineSnapshot(snap.timeline),
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
      const expectedW =
        typeof l.meta.dataWidth === 'number' && l.meta.dataWidth > 0
          ? l.meta.dataWidth
          : enc.width
      const expectedH =
        typeof l.meta.dataHeight === 'number' && l.meta.dataHeight > 0
          ? l.meta.dataHeight
          : enc.height
      if (data.byteLength !== expectedW * expectedH * 4) {
        throw new Error('Corrupted snapshot layer dimensions in history')
      }
      return {
        meta: l.meta,
        data,
      }
    }),
    timeline: decodeTimelineSnapshot(enc.timeline),
  }
}

function encodeHistoryStack(stack: SerializedHistoryEntry[]): Uint8Array {
  const encoded: EncodedHistoryEntryJson[] = stack.map((e) => ({
    id: e.id,
    label: e.label,
    timestamp: e.timestamp,
    kind: e.kind,
    frameId: e.frameId,
    celAllocation: e.celAllocation,
    pixelPatches: e.pixelPatches?.map((p) => ({
      layerId: p.layerId,
      celId: p.celId,
      indicesB64: bytesToBase64(uint32ToBytes(p.indices)),
      beforeB64: bytesToBase64(p.before),
      afterB64: bytesToBase64(p.after),
      beforeGeometry: p.beforeGeometry,
      afterGeometry: p.afterGeometry,
    })),
    layerOffsetChange: e.layerOffsetChange,
    layerOffsetChanges: e.layerOffsetChanges,
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
    beforeWorldSelection:
      e.beforeWorldSelection === undefined
        ? undefined
        : e.beforeWorldSelection === null
          ? null
          : {
              originX: e.beforeWorldSelection.originX,
              originY: e.beforeWorldSelection.originY,
              width: e.beforeWorldSelection.width,
              height: e.beforeWorldSelection.height,
              maskB64: bytesToBase64(e.beforeWorldSelection.mask),
            },
    afterWorldSelection:
      e.afterWorldSelection === undefined
        ? undefined
        : e.afterWorldSelection === null
          ? null
          : {
              originX: e.afterWorldSelection.originX,
              originY: e.afterWorldSelection.originY,
              width: e.afterWorldSelection.width,
              height: e.afterWorldSelection.height,
              maskB64: bytesToBase64(e.afterWorldSelection.mask),
            },
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
        celId: p.celId,
        indices,
        before,
        after,
        beforeGeometry: p.beforeGeometry,
        afterGeometry: p.afterGeometry,
      }
    })

    return {
      id: e.id,
      label: e.label,
      timestamp: e.timestamp,
      kind: e.kind,
      frameId: e.frameId,
      celAllocation: e.celAllocation,
      pixelPatches,
      layerOffsetChange: e.layerOffsetChange,
      layerOffsetChanges: e.layerOffsetChanges,
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
      beforeWorldSelection:
        e.beforeWorldSelection === undefined
          ? undefined
          : e.beforeWorldSelection === null
            ? null
            : {
                originX: e.beforeWorldSelection.originX,
                originY: e.beforeWorldSelection.originY,
                width: e.beforeWorldSelection.width,
                height: e.beforeWorldSelection.height,
                mask: base64ToBytes(e.beforeWorldSelection.maskB64),
              },
      afterWorldSelection:
        e.afterWorldSelection === undefined
          ? undefined
          : e.afterWorldSelection === null
            ? null
            : {
                originX: e.afterWorldSelection.originX,
                originY: e.afterWorldSelection.originY,
                width: e.afterWorldSelection.width,
                height: e.afterWorldSelection.height,
                mask: base64ToBytes(e.afterWorldSelection.maskB64),
              },
      beforePalette: e.beforePalette,
      afterPalette: e.afterPalette,
    }
  })
}

/**
 * Export entire dotdot state (projects, layers including off-canvas pixels, timeline cels, palettes + Lospec attribution, settings + customCanvasPresets, order, metadata, undo/redo history)
 * into a structured ZIP archive (`environment-pack.zip`).
 */
export async function exportEnvironmentPackZip(
  targetDb: DotDotDatabase = db
): Promise<Uint8Array> {
  const settings = normalizeAppSettings(
    (await targetDb.settings.get('app-settings')) ?? DEFAULT_APP_SETTINGS
  )
  const palettes = await targetDb.palettes.orderBy('order').toArray()
  const stamps = await targetDb.stamps.orderBy('order').toArray()
  const projects = await targetDb.projects.orderBy('order').toArray()
  const allPixels = await targetDb.layerPixels.toArray()
  const allCels = await targetDb.celBuffers.toArray()
  const allHistories = await targetDb.histories.toArray()

  const pixelByKey = new Map<string, LayerPixelRecord>()
  for (const row of allPixels) {
    pixelByKey.set(row.key, row)
  }

  const celsByProject = new Map<string, CelBufferRecord[]>()
  for (const row of allCels) {
    const arr = celsByProject.get(row.projectId) ?? []
    arr.push(row)
    celsByProject.set(row.projectId, arr)
  }

  const historyByProject = new Map<string, ProjectHistoryRecord>()
  for (const h of allHistories) {
    historyByProject.set(h.projectId, h)
  }

  const zipEntries: Zippable = {}
  let totalLayers = 0
  let totalCels = 0
  let totalHistoryEntries = 0

  palettes.forEach((pal, idx) => {
    const fileIdx = String(idx + 1).padStart(3, '0')
    zipEntries[`palettes/palette-${fileIdx}.json`] = strToU8(
      JSON.stringify(pal, null, 2)
    )
  })

  stamps.forEach((stamp, idx) => {
    const fileIdx = String(idx + 1).padStart(3, '0')
    const { data, ...stampMeta } = stamp
    zipEntries[`stamps/stamp-${fileIdx}.json`] = strToU8(
      JSON.stringify(stampMeta, null, 2)
    )
    zipEntries[`stamps/stamp-${fileIdx}.bin`] = new Uint8Array(data)
  })

  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i]
    const dirName = `projects/${proj.id}`
    const normalizedLayersMeta = proj.layers.map((layerMeta) => {
      const row = pixelByKey.get(`${proj.id}:${layerMeta.id}`)
      const dw = layerMeta.dataWidth ?? row?.dataWidth ?? proj.width
      const dh = layerMeta.dataHeight ?? row?.dataHeight ?? proj.height
      const ox = layerMeta.offsetX ?? row?.offsetX ?? 0
      const oy = layerMeta.offsetY ?? row?.offsetY ?? 0
      return {
        ...layerMeta,
        offsetX: ox,
        offsetY: oy,
        dataWidth: dw,
        dataHeight: dh,
      }
    })

    const { thumbnailPng: _thumb, ...serializableProject } = proj
    zipEntries[`${dirName}/project.json`] = strToU8(
      JSON.stringify(
        {
          ...serializableProject,
          layers: normalizedLayersMeta,
        },
        null,
        2
      )
    )

    for (const layerMeta of normalizedLayersMeta) {
      totalLayers++
      const row = pixelByKey.get(`${proj.id}:${layerMeta.id}`)
      const expectedLen =
        (layerMeta.dataWidth ?? proj.width) *
        (layerMeta.dataHeight ?? proj.height) *
        4
      const raw = row?.data ?? new Uint8Array(expectedLen)
      zipEntries[`${dirName}/layers/${layerMeta.id}.bin`] = raw
    }

    const projCels = celsByProject.get(proj.id) ?? []
    if (projCels.length > 0) {
      const celManifest: EncodedCelGeometryMeta[] = []
      for (const celRow of projCels) {
        totalCels++
        celManifest.push({
          celId: celRow.celId,
          offsetX: celRow.offsetX,
          offsetY: celRow.offsetY,
          dataWidth: celRow.dataWidth,
          dataHeight: celRow.dataHeight,
        })
        zipEntries[`${dirName}/cels/${celRow.celId}.bin`] = celRow.data
      }
      zipEntries[`${dirName}/cels/manifest.json`] = strToU8(
        JSON.stringify(celManifest, null, 2)
      )
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
    appVersion: '2.5.0',
    exportedAt: Date.now(),
    projectOrder: projects.map((p) => p.id),
    paletteOrder: palettes.map((p) => p.id),
    stampOrder: stamps.map((s) => s.id),
    counts: {
      projects: projects.length,
      palettes: palettes.length,
      stamps: stamps.length,
      totalLayers,
      totalCels,
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
  stamps: StampAsset[]
  hasStampsInArchive: boolean
  projects: ProjectRecord[]
  layerPixels: LayerPixelRecord[]
  celBuffers: CelBufferRecord[]
  histories: ProjectHistoryRecord[]
}

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
  const settings: AppSettings = normalizeAppSettings(parsedSettings)

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

  const projectJsonPaths = Object.keys(files).filter(
    (k) => k.startsWith('projects/') && k.endsWith('/project.json')
  )

  if (projectJsonPaths.length !== manifest.counts.projects) {
    throw new Error('COUNT_MISMATCH: Project count does not match manifest')
  }

  const projects: ProjectRecord[] = []
  const layerPixels: LayerPixelRecord[] = []
  const celBuffers: CelBufferRecord[] = []
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
      proj.layers.length > MAX_LAYERS
    ) {
      throw new Error(`INVALID_PROJECT: Invalid project metadata at ${projPath}`)
    }

    const baseDir = `projects/${proj.id}`
    const runtimeLayersForThumb: LayerRuntime[] = []
    const normalizedMetaList: LayerMeta[] = []

    for (const layerMeta of proj.layers) {
      const layerBinPath = `${baseDir}/layers/${layerMeta.id}.bin`
      const layerBin = files[layerBinPath]
      if (!layerBin) {
        throw new Error(`MISSING_LAYER_BIN: Missing layer binary ${layerBinPath}`)
      }

      const geo = normalizeLayerGeometry(
        {
          offsetX: layerMeta.offsetX,
          offsetY: layerMeta.offsetY,
          dataWidth: layerMeta.dataWidth,
          dataHeight: layerMeta.dataHeight,
          data: new Uint8ClampedArray(0),
        },
        proj.width,
        proj.height
      )
      const expectedBytes = geo.dataWidth * geo.dataHeight * 4
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
        offsetX: geo.offsetX,
        offsetY: geo.offsetY,
        dataWidth: geo.dataWidth,
        dataHeight: geo.dataHeight,
      })

      const normalizedMeta: LayerMeta = {
        ...layerMeta,
        offsetX: geo.offsetX,
        offsetY: geo.offsetY,
        dataWidth: geo.dataWidth,
        dataHeight: geo.dataHeight,
      }
      normalizedMetaList.push(normalizedMeta)

      runtimeLayersForThumb.push({
        ...normalizedMeta,
        offsetX: geo.offsetX,
        offsetY: geo.offsetY,
        dataWidth: geo.dataWidth,
        dataHeight: geo.dataHeight,
        data: new Uint8ClampedArray(copy),
      })
    }

    // Optional timeline `cels/manifest.json` + `cels/<celId>.bin`
    const celManifestPath = `${baseDir}/cels/manifest.json`
    const celManifestRaw = files[celManifestPath]
    const runtimeCelBuffers: Record<string, CelBufferRuntime> = {}
    if (celManifestRaw) {
      const celMetaList = JSON.parse(
        strFromU8(celManifestRaw)
      ) as EncodedCelGeometryMeta[]
      if (!Array.isArray(celMetaList)) {
        throw new Error(`INVALID_CEL_MANIFEST: Invalid cel manifest at ${celManifestPath}`)
      }
      for (const celMeta of celMetaList) {
        const celBinPath = `${baseDir}/cels/${celMeta.celId}.bin`
        const celBin = files[celBinPath]
        if (!celBin) {
          throw new Error(`MISSING_CEL_BIN: Missing cel binary ${celBinPath}`)
        }
        const geo = normalizeLayerGeometry(
          {
            offsetX: celMeta.offsetX,
            offsetY: celMeta.offsetY,
            dataWidth: celMeta.dataWidth,
            dataHeight: celMeta.dataHeight,
            data: new Uint8ClampedArray(0),
          },
          proj.width,
          proj.height
        )
        const expectedBytes = geo.dataWidth * geo.dataHeight * 4
        if (celBin.byteLength !== expectedBytes) {
          throw new Error(
            `CORRUPT_CEL_BIN: Expected ${expectedBytes} bytes, got ${celBin.byteLength} in ${celBinPath}`
          )
        }
        const copy = new Uint8Array(celBin)
        celBuffers.push({
          key: `${proj.id}:${celMeta.celId}`,
          projectId: proj.id,
          celId: celMeta.celId,
          offsetX: geo.offsetX,
          offsetY: geo.offsetY,
          dataWidth: geo.dataWidth,
          dataHeight: geo.dataHeight,
          data: copy,
        })
        runtimeCelBuffers[celMeta.celId] = {
          id: celMeta.celId,
          offsetX: geo.offsetX,
          offsetY: geo.offsetY,
          dataWidth: geo.dataWidth,
          dataHeight: geo.dataHeight,
          data: new Uint8ClampedArray(copy),
        }
      }
    }

    const thumbLayers =
      Array.isArray(proj.frames) &&
      proj.frames.length >= 1 &&
      proj.cels &&
      Object.keys(runtimeCelBuffers).length > 0
        ? projectFrameLayers(
            normalizedMetaList,
            proj.cels,
            runtimeCelBuffers,
            proj.frames[0]!.id,
            proj.width,
            proj.height
          )
        : runtimeLayersForThumb

    const { png: thumbnailPng } = exportCompositePngBytes(
      thumbLayers,
      proj.width,
      proj.height,
      1
    )

    projects.push({
      ...proj,
      layers: normalizedMetaList,
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

  projects.sort((a, b) => a.order - b.order)
  palettes.sort((a, b) => a.order - b.order)

  const stampJsonPaths = Object.keys(files)
    .filter((k) => k.startsWith('stamps/') && k.endsWith('.json'))
    .sort()

  const hasStampsInArchive =
    stampJsonPaths.length > 0 || typeof manifest.counts.stamps === 'number'

  const stamps: StampAsset[] = stampJsonPaths.map((jsonPath, idx) => {
    const meta = JSON.parse(strFromU8(files[jsonPath]!)) as Omit<StampAsset, 'data'>
    const binPath = jsonPath.replace(/\.json$/, '.bin')
    const bin = files[binPath]
    if (
      !meta ||
      typeof meta.id !== 'string' ||
      typeof meta.name !== 'string' ||
      typeof meta.width !== 'number' ||
      typeof meta.height !== 'number' ||
      meta.width < 1 ||
      meta.width > 256 ||
      meta.height < 1 ||
      meta.height > 256 ||
      !bin ||
      bin.byteLength !== meta.width * meta.height * 4
    ) {
      throw new Error(`INVALID_STAMP_DATA: Invalid stamp in ${jsonPath}`)
    }
    return {
      ...meta,
      order: typeof meta.order === 'number' ? meta.order : idx,
      data: new Uint8Array(bin),
    }
  })
  stamps.sort((a, b) => a.order - b.order)

  return {
    manifest,
    settings,
    palettes,
    stamps,
    hasStampsInArchive,
    projects,
    layerPixels,
    celBuffers,
    histories,
  }
}

export async function applyValidatedEnvPack(
  pack: ValidatedEnvPack,
  targetDb: DotDotDatabase = db
): Promise<void> {
  await targetDb.transaction(
    'rw',
    [
      targetDb.settings,
      targetDb.palettes,
      targetDb.stamps,
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.celBuffers,
      targetDb.histories,
    ],
    async () => {
      await targetDb.settings.clear()
      await targetDb.palettes.clear()
      if (pack.hasStampsInArchive) {
        await targetDb.stamps.clear()
      }
      await targetDb.projects.clear()
      await targetDb.layerPixels.clear()
      await targetDb.celBuffers.clear()
      await targetDb.histories.clear()

      await targetDb.settings.put(pack.settings)
      await targetDb.palettes.bulkPut(pack.palettes)
      if (pack.hasStampsInArchive && pack.stamps.length > 0) {
        await targetDb.stamps.bulkPut(pack.stamps)
      }
      if (pack.projects.length > 0) {
        await targetDb.projects.bulkPut(pack.projects)
      }
      if (pack.layerPixels.length > 0) {
        await targetDb.layerPixels.bulkPut(pack.layerPixels)
      }
      if (pack.celBuffers.length > 0) {
        await targetDb.celBuffers.bulkPut(pack.celBuffers)
      }
      if (pack.histories.length > 0) {
        await targetDb.histories.bulkPut(pack.histories)
      }
    }
  )
}
