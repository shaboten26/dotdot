import Dexie, { type Table } from 'dexie'
import type {
  AppSettings,
  LayerPixelRecord,
  LayerRuntime,
  PaletteData,
  ProjectHistoryRecord,
  ProjectPalette,
  ProjectRecord,
  SerializedHistoryEntry,
} from '../types'
import { buildInitialPalettes } from './defaultPalettes'
import { createPixelBuffer, MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../engine/pixelBuffer'
import { exportCompositePngBytes } from '../engine/compositor'

export class DotDotDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>
  layerPixels!: Table<LayerPixelRecord, string>
  palettes!: Table<PaletteData, string>
  histories!: Table<ProjectHistoryRecord, string>
  settings!: Table<AppSettings, string>

  constructor(name = 'dotdot-studio-db') {
    super(name)
    this.version(1).stores({
      projects: 'id, order, createdAt, updatedAt, name',
      layerPixels: 'key, projectId, layerId',
      palettes: 'id, order, updatedAt',
      histories: 'projectId, updatedAt',
      settings: 'id',
    })
  }
}

export const db = new DotDotDatabase()

export const DEFAULT_APP_SETTINGS: AppSettings = {
  id: 'app-settings',
  theme: 'system',
  language: 'ja',
  historyLimit: 100,
  showGrid: true,
  checkerboardDark: false,
  confirmDestructive: true,
  soundEnabled: false,
  activeProjectId: null,
  gallerySortMode: 'manual',
}

export function generateId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name ?? ''
  const msg = (err as { message?: string }).message ?? ''
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    msg.toLowerCase().includes('quota')
  )
}

/**
 * Ensure settings, initial palettes (at least 6 on first launch, never 0), and an initial project exist.
 */
export async function initializeDatabase(targetDb: DotDotDatabase = db): Promise<{
  settings: AppSettings
  palettes: PaletteData[]
}> {
  let settings = await targetDb.settings.get('app-settings')
  if (!settings) {
    settings = { ...DEFAULT_APP_SETTINGS }
    await targetDb.settings.put(settings)
  }

  let palettes = await targetDb.palettes.orderBy('order').toArray()
  if (palettes.length === 0) {
    palettes = buildInitialPalettes()
    await targetDb.palettes.bulkPut(palettes)
  }

  const projectCount = await targetDb.projects.count()
  if (projectCount === 0) {
    const firstProject = await createNewProject(
      {
        name: 'Untitled 01',
        width: 32,
        height: 32,
        palette: {
          name: palettes[0].name,
          colors: [...palettes[0].colors],
          sourcePaletteId: palettes[0].id,
        },
      },
      targetDb
    )
    settings = { ...settings, activeProjectId: firstProject.project.id }
    await targetDb.settings.put(settings)
  } else if (!settings.activeProjectId) {
    const first = await targetDb.projects.orderBy('order').first()
    if (first) {
      settings = { ...settings, activeProjectId: first.id }
      await targetDb.settings.put(settings)
    }
  } else {
    const exists = await targetDb.projects.get(settings.activeProjectId)
    if (!exists) {
      const first = await targetDb.projects.orderBy('order').first()
      settings = { ...settings, activeProjectId: first?.id ?? null }
      await targetDb.settings.put(settings)
    }
  }

  return { settings, palettes }
}

export interface CreateProjectParams {
  name: string
  width: number
  height: number
  palette: ProjectPalette
}

export async function createNewProject(
  params: CreateProjectParams,
  targetDb: DotDotDatabase = db
): Promise<{ project: ProjectRecord; layers: LayerRuntime[] }> {
  const width = Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(params.width)))
  const height = Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(params.height)))
  const now = Date.now()
  const projectId = generateId('proj')
  const layerId = generateId('layer')

  const initialData = createPixelBuffer(width, height) // Completely transparent RGBA(0,0,0,0)
  const layerRuntime: LayerRuntime = {
    id: layerId,
    name: 'Layer 1',
    visible: true,
    opacity: 100,
    blendMode: 'normal',
    clipping: false,
    data: initialData,
  }

  const { png: thumbnailPng } = exportCompositePngBytes([layerRuntime], width, height, 1)

  const existingProjects = await targetDb.projects.toArray()
  const minOrder =
    existingProjects.length > 0
      ? Math.min(...existingProjects.map((p) => p.order)) - 1
      : 0

  const safeColors =
    params.palette.colors.length > 0
      ? params.palette.colors.slice(0, 256)
      : ['#000000', '#FFFFFF']

  const project: ProjectRecord = {
    id: projectId,
    name: params.name.trim() || 'Untitled',
    width,
    height,
    layers: [
      {
        id: layerId,
        name: layerRuntime.name,
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
      },
    ],
    activeLayerId: layerId,
    palette: {
      name: params.palette.name || 'Palette',
      colors: [...safeColors],
      sourcePaletteId: params.palette.sourcePaletteId,
    },
    selectedColorIndex: 0,
    order: minOrder,
    thumbnailPng,
    createdAt: now,
    updatedAt: now,
  }

  await targetDb.transaction(
    'rw',
    [targetDb.projects, targetDb.layerPixels, targetDb.histories, targetDb.settings],
    async () => {
      await targetDb.projects.put(project)
      await targetDb.layerPixels.put({
        key: `${projectId}:${layerId}`,
        projectId,
        layerId,
        data: new Uint8Array(initialData),
      })
      await targetDb.histories.put({
        projectId,
        undoStack: [],
        redoStack: [],
        updatedAt: now,
      })
      const currentSettings = await targetDb.settings.get('app-settings')
      if (currentSettings) {
        await targetDb.settings.put({
          ...currentSettings,
          activeProjectId: projectId,
        })
      }
    }
  )

  return { project, layers: [layerRuntime] }
}

export async function loadProjectFull(
  projectId: string,
  targetDb: DotDotDatabase = db
): Promise<{
  project: ProjectRecord
  layers: LayerRuntime[]
  history: ProjectHistoryRecord
} | null> {
  const project = await targetDb.projects.get(projectId)
  if (!project) return null

  const pixelRows = await targetDb.layerPixels.where('projectId').equals(projectId).toArray()
  const pixelMap = new Map<string, Uint8Array>()
  for (const row of pixelRows) {
    pixelMap.set(row.layerId, row.data)
  }

  const expectedByteLength = project.width * project.height * 4
  const layers: LayerRuntime[] = project.layers.map((meta) => {
    const raw = pixelMap.get(meta.id)
    let data: Uint8ClampedArray
    if (raw && raw.byteLength === expectedByteLength) {
      data = new Uint8ClampedArray(raw)
    } else {
      data = createPixelBuffer(project.width, project.height)
      if (raw) {
        data.set(raw.subarray(0, Math.min(raw.length, expectedByteLength)))
      }
    }
    return { ...meta, data }
  })

  const history =
    (await targetDb.histories.get(projectId)) ?? {
      projectId,
      undoStack: [],
      redoStack: [],
      updatedAt: project.updatedAt,
    }

  return { project, layers, history }
}

export interface SaveProjectPayload {
  project: ProjectRecord
  layers: readonly LayerRuntime[]
  history?: {
    undoStack: SerializedHistoryEntry[]
    redoStack: SerializedHistoryEntry[]
  }
}

/**
 * Atomically persist committed project state, layer buffers, thumbnail PNG, and history.
 * If storage quota is exceeded while saving large history, retries saving project & pixels
 * with trimmed history so artwork data is NEVER lost (Section 14-2).
 */
export async function saveProjectFull(
  payload: SaveProjectPayload,
  targetDb: DotDotDatabase = db
): Promise<{ savedAt: number; quotaTrimmed: boolean }> {
  const now = Date.now()
  const { project, layers, history } = payload

  const { png: thumbnailPng } = exportCompositePngBytes(
    layers,
    project.width,
    project.height,
    1
  )

  const updatedProject: ProjectRecord = {
    ...project,
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      clipping: l.clipping,
    })),
    thumbnailPng,
    updatedAt: now,
  }

  const pixelRecords: LayerPixelRecord[] = layers.map((l) => ({
    key: `${project.id}:${l.id}`,
    projectId: project.id,
    layerId: l.id,
    data: new Uint8Array(l.data),
  }))

  const activeLayerKeys = new Set(pixelRecords.map((r) => r.key))

  const writeTx = async (
    undoStack?: SerializedHistoryEntry[],
    redoStack?: SerializedHistoryEntry[]
  ) => {
    await targetDb.transaction(
      'rw',
      [targetDb.projects, targetDb.layerPixels, targetDb.histories],
      async () => {
        await targetDb.projects.put(updatedProject)
        // Remove orphan layer pixel rows for deleted layers
        const existingRows = await targetDb.layerPixels
          .where('projectId')
          .equals(project.id)
          .primaryKeys()
        const staleKeys = existingRows.filter((k) => !activeLayerKeys.has(k))
        if (staleKeys.length > 0) {
          await targetDb.layerPixels.bulkDelete(staleKeys)
        }
        await targetDb.layerPixels.bulkPut(pixelRecords)

        if (undoStack !== undefined && redoStack !== undefined) {
          await targetDb.histories.put({
            projectId: project.id,
            undoStack,
            redoStack,
            updatedAt: now,
          })
        }
      }
    )
  }

  try {
    await writeTx(history?.undoStack, history?.redoStack)
    return { savedAt: now, quotaTrimmed: false }
  } catch (err) {
    if (isQuotaError(err) && history) {
      // Trim oldest half of history and retry so pixel work is preserved
      const halfUndo = history.undoStack.slice(Math.ceil(history.undoStack.length / 2))
      await writeTx(halfUndo, [])
      return { savedAt: now, quotaTrimmed: true }
    }
    throw err
  }
}

export async function deleteProjectById(
  projectId: string,
  targetDb: DotDotDatabase = db
): Promise<void> {
  await targetDb.transaction(
    'rw',
    [targetDb.projects, targetDb.layerPixels, targetDb.histories, targetDb.settings],
    async () => {
      await targetDb.projects.delete(projectId)
      await targetDb.layerPixels.where('projectId').equals(projectId).delete()
      await targetDb.histories.delete(projectId)

      const settings = await targetDb.settings.get('app-settings')
      if (settings && settings.activeProjectId === projectId) {
        const remaining = await targetDb.projects.orderBy('order').first()
        await targetDb.settings.put({
          ...settings,
          activeProjectId: remaining?.id ?? null,
        })
      }
    }
  )
}

/**
 * Delete a palette from the library ONLY if more than 1 palette exists (Section 10-3 & 13-3).
 */
export async function deleteLibraryPalette(
  paletteId: string,
  targetDb: DotDotDatabase = db
): Promise<boolean> {
  return targetDb.transaction('rw', targetDb.palettes, async () => {
    const count = await targetDb.palettes.count()
    if (count <= 1) {
      return false
    }
    await targetDb.palettes.delete(paletteId)
    return true
  })
}

export interface StorageStatusInfo {
  usageBytes: number | null
  quotaBytes: number | null
  persisted: boolean | null
  supported: boolean
}

export async function getStorageStatus(): Promise<StorageStatusInfo> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { usageBytes: null, quotaBytes: null, persisted: null, supported: false }
  }

  let usageBytes: number | null = null
  let quotaBytes: number | null = null
  let persisted: boolean | null = null

  try {
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate()
      usageBytes = est.usage ?? null
      quotaBytes = est.quota ?? null
    }
  } catch {
    // ignore estimate failure
  }

  try {
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted()
    }
  } catch {
    // ignore persisted failure
  }

  return { usageBytes, quotaBytes, persisted, supported: true }
}

export async function requestStoragePersistence(): Promise<{
  granted: boolean
  supported: boolean
}> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persist !== 'function'
  ) {
    return { granted: false, supported: false }
  }

  try {
    const granted = await navigator.storage.persist()
    return { granted, supported: true }
  } catch {
    return { granted: false, supported: true }
  }
}

export async function resetAllAppData(targetDb: DotDotDatabase = db): Promise<void> {
  await targetDb.transaction(
    'rw',
    [
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.palettes,
      targetDb.histories,
      targetDb.settings,
    ],
    async () => {
      await targetDb.projects.clear()
      await targetDb.layerPixels.clear()
      await targetDb.palettes.clear()
      await targetDb.histories.clear()
      await targetDb.settings.clear()
    }
  )
  await initializeDatabase(targetDb)
}
