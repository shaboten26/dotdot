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
  UiSizeConfig,
  UiSizePreset,
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

export const UI_SIZE_PRESETS: Record<Exclude<UiSizePreset, 'custom'>, UiSizeConfig> = {
  compact: {
    preset: 'compact',
    overallScale: 92,
    toolIconSize: 16,
    toolButtonHeight: 44,
    toolLabelSize: 10,
    swatchSize: 30,
    checkboxSize: 16,
    uiGap: 4,
    drawButtonVh: 12,
  },
  standard: {
    preset: 'standard',
    overallScale: 100,
    toolIconSize: 20,
    toolButtonHeight: 48,
    toolLabelSize: 11,
    swatchSize: 34,
    checkboxSize: 20,
    uiGap: 6,
    drawButtonVh: 15,
  },
  large: {
    preset: 'large',
    overallScale: 110,
    toolIconSize: 24,
    toolButtonHeight: 56,
    toolLabelSize: 13,
    swatchSize: 40,
    checkboxSize: 24,
    uiGap: 8,
    drawButtonVh: 17,
  },
}

export const DEFAULT_UI_SIZE_CONFIG: UiSizeConfig = {
  ...UI_SIZE_PRESETS.standard,
}

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
  uiSize: { ...DEFAULT_UI_SIZE_CONFIG },
}

export function normalizeAppSettings(raw?: Partial<AppSettings> | null): AppSettings {
  const uiSize: UiSizeConfig = {
    ...DEFAULT_UI_SIZE_CONFIG,
    ...(raw?.uiSize ?? {}),
  }
  return {
    ...DEFAULT_APP_SETTINGS,
    ...(raw ?? {}),
    id: 'app-settings',
    uiSize,
  }
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
 * Spec v2 Section 5-1:
 * Initialize settings & 6 default palettes ONLY.
 * Do NOT auto-create an empty canvas on startup; users begin on the Artwork Gallery screen
 * and create a project explicitly (or pick an existing one).
 */
export async function initializeDatabase(targetDb: DotDotDatabase = db): Promise<{
  settings: AppSettings
  palettes: PaletteData[]
}> {
  const storedSettings = await targetDb.settings.get('app-settings')
  let settings = normalizeAppSettings(storedSettings)

  let palettes = await targetDb.palettes.orderBy('order').toArray()
  if (palettes.length === 0) {
    palettes = buildInitialPalettes()
    await targetDb.palettes.bulkPut(palettes)
  }

  // Validate activeProjectId if one was previously saved
  if (settings.activeProjectId) {
    const exists = await targetDb.projects.get(settings.activeProjectId)
    if (!exists) {
      const first = await targetDb.projects.orderBy('order').first()
      settings = { ...settings, activeProjectId: first?.id ?? null }
    }
  }

  await targetDb.settings.put(settings)
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
          ...normalizeAppSettings(currentSettings),
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
          ...normalizeAppSettings(settings),
          activeProjectId: remaining?.id ?? null,
        })
      }
    }
  )
}

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
