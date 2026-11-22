import Dexie, { type Table } from 'dexie'
import type {
  AppSettings,
  BackupReminderMeta,
  CanvasSizePreset,
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
import {
  createPixelBuffer,
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  normalizeLayerGeometry,
} from '../engine/pixelBuffer'
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
    // Version 2: Non-destructive layer geometry (offsetX, offsetY, dataWidth, dataHeight) + customCanvasPresets
    this.version(2)
      .stores({
        projects: 'id, order, createdAt, updatedAt, name',
        layerPixels: 'key, projectId, layerId',
        palettes: 'id, order, updatedAt',
        histories: 'projectId, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const projectsTable = tx.table<ProjectRecord, string>('projects')
        const settingsTable = tx.table<AppSettings, string>('settings')
        await projectsTable.toCollection().modify((proj) => {
          if (Array.isArray(proj.layers)) {
            proj.layers = proj.layers.map((l) => ({
              ...l,
              offsetX: typeof l.offsetX === 'number' ? l.offsetX : 0,
              offsetY: typeof l.offsetY === 'number' ? l.offsetY : 0,
              dataWidth: typeof l.dataWidth === 'number' ? l.dataWidth : proj.width,
              dataHeight: typeof l.dataHeight === 'number' ? l.dataHeight : proj.height,
            }))
          }
        })
        await settingsTable.toCollection().modify((s) => {
          if (!Array.isArray(s.customCanvasPresets)) {
            s.customCanvasPresets = []
          }
          if (typeof s.eyedropperDoubleTap !== 'boolean') {
            s.eyedropperDoubleTap = true
          }
          if (!s.backupMeta || typeof s.backupMeta !== 'object') {
            s.backupMeta = {
              lastExportAt: null,
              lastNotifiedAt: null,
              nextNotifyAt: null,
              firstProjectCreatedAt: null,
            }
          }
        })
      })
  }
}

export const db = new DotDotDatabase()

/**
 * Section 4-1: Unified Built-in Standard Canvas Size Presets (exact 5 standard presets).
 * Displayed identically in both New Artwork creation and Canvas Resize modals, and cannot be deleted.
 */
export const BUILT_IN_CANVAS_PRESETS: ReadonlyArray<CanvasSizePreset> = [
  { id: 'builtin-16x16', name: '16 × 16', width: 16, height: 16, builtIn: true },
  { id: 'builtin-32x32', name: '32 × 32', width: 32, height: 32, builtIn: true },
  { id: 'builtin-64x64', name: '64 × 64', width: 64, height: 64, builtIn: true },
  { id: 'builtin-96x96', name: '96 × 96', width: 96, height: 96, builtIn: true },
  { id: 'builtin-128x128', name: '128 × 128', width: 128, height: 128, builtIn: true },
]

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

export const DEFAULT_BACKUP_META: BackupReminderMeta = {
  lastExportAt: null,
  lastNotifiedAt: null,
  nextNotifyAt: null,
  firstProjectCreatedAt: null,
}

export const BACKUP_REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
export const BACKUP_SNOOZE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Section 11: Evaluate whether the Environment Pack backup reminder banner/modal should be shown now.
 * - Never triggers if 0 artworks exist and `firstProjectCreatedAt` is null.
 * - If `nextNotifyAt !== null` (e.g. user chose "Remind Later" for +7 days), waits until `now >= nextNotifyAt`.
 * - Otherwise triggers if `lastExportAt !== null` and `now - lastExportAt >= 30 days`,
 *   OR `lastExportAt === null` and `firstProjectCreatedAt !== null` and `now - firstProjectCreatedAt >= 30 days`.
 */
export function shouldShowBackupReminder(
  backupMeta: BackupReminderMeta | undefined | null,
  now = Date.now()
): boolean {
  if (!backupMeta) return false
  const { lastExportAt, nextNotifyAt, firstProjectCreatedAt } = backupMeta

  if (typeof nextNotifyAt === 'number' && Number.isFinite(nextNotifyAt)) {
    return now >= nextNotifyAt
  }

  if (typeof lastExportAt === 'number' && Number.isFinite(lastExportAt)) {
    return now - lastExportAt >= BACKUP_REMINDER_INTERVAL_MS
  }

  if (typeof firstProjectCreatedAt === 'number' && Number.isFinite(firstProjectCreatedAt)) {
    return now - firstProjectCreatedAt >= BACKUP_REMINDER_INTERVAL_MS
  }

  return false
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
  eyedropperDoubleTap: true,
  activeProjectId: null,
  gallerySortMode: 'manual',
  uiSize: { ...DEFAULT_UI_SIZE_CONFIG },
  customCanvasPresets: [],
  backupMeta: { ...DEFAULT_BACKUP_META },
}

export function hasCanvasPresetDimensions(
  customPresets: ReadonlyArray<CanvasSizePreset>,
  width: number,
  height: number,
  excludeId?: string
): boolean {
  const w = Math.round(width)
  const h = Math.round(height)
  for (const b of BUILT_IN_CANVAS_PRESETS) {
    if (b.width === w && b.height === h) return true
  }
  for (const c of customPresets) {
    if (excludeId && c.id === excludeId) continue
    if (c.width === w && c.height === h) return true
  }
  return false
}

export function normalizeCustomPresets(
  raw?: ReadonlyArray<Partial<CanvasSizePreset>> | null
): CanvasSizePreset[] {
  if (!Array.isArray(raw)) return []
  const result: CanvasSizePreset[] = []
  const seenDims = new Set<string>(
    BUILT_IN_CANVAS_PRESETS.map((b) => `${b.width}x${b.height}`)
  )
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item) continue
    const w = Math.max(
      MIN_CANVAS_SIZE,
      Math.min(MAX_CANVAS_SIZE, Math.round(Number(item.width) || 32))
    )
    const h = Math.max(
      MIN_CANVAS_SIZE,
      Math.min(MAX_CANVAS_SIZE, Math.round(Number(item.height) || 32))
    )
    const dimKey = `${w}x${h}`
    if (seenDims.has(dimKey)) continue
    seenDims.add(dimKey)

    const id =
      typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : `preset-${i}-${w}x${h}`
    const name =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : `${w} × ${h}`
    result.push({
      id,
      name,
      width: w,
      height: h,
      builtIn: false,
    })
  }
  return result
}

export function normalizeBackupMeta(
  raw?: Partial<BackupReminderMeta> | null
): BackupReminderMeta {
  const toNullableMs = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  return {
    lastExportAt: toNullableMs(raw?.lastExportAt),
    lastNotifiedAt: toNullableMs(raw?.lastNotifiedAt),
    nextNotifyAt: toNullableMs(raw?.nextNotifyAt),
    firstProjectCreatedAt: toNullableMs(raw?.firstProjectCreatedAt),
  }
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
    eyedropperDoubleTap:
      typeof raw?.eyedropperDoubleTap === 'boolean' ? raw.eyedropperDoubleTap : true,
    uiSize,
    customCanvasPresets: normalizeCustomPresets(raw?.customCanvasPresets),
    backupMeta: normalizeBackupMeta(raw?.backupMeta),
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

  if (settings.activeProjectId) {
    const exists = await targetDb.projects.get(settings.activeProjectId)
    if (!exists) {
      const first = await targetDb.projects.orderBy('order').first()
      settings = { ...settings, activeProjectId: first?.id ?? null }
    }
  }

  // Backfill firstProjectCreatedAt on legacy DBs that already have projects
  if (settings.backupMeta.firstProjectCreatedAt === null) {
    const allProjs = await targetDb.projects.toArray()
    if (allProjs.length > 0) {
      const earliest = Math.min(...allProjs.map((p) => p.createdAt))
      settings = {
        ...settings,
        backupMeta: {
          ...settings.backupMeta,
          firstProjectCreatedAt: earliest,
        },
      }
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

  const initialData = createPixelBuffer(width, height)
  const layerRuntime: LayerRuntime = {
    id: layerId,
    name: 'Layer 1',
    visible: true,
    opacity: 100,
    blendMode: 'normal',
    clipping: false,
    offsetX: 0,
    offsetY: 0,
    dataWidth: width,
    dataHeight: height,
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
        offsetX: 0,
        offsetY: 0,
        dataWidth: width,
        dataHeight: height,
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
        offsetX: 0,
        offsetY: 0,
        dataWidth: width,
        dataHeight: height,
      })
      await targetDb.histories.put({
        projectId,
        undoStack: [],
        redoStack: [],
        updatedAt: now,
      })
      const currentSettings = normalizeAppSettings(
        await targetDb.settings.get('app-settings')
      )
      await targetDb.settings.put({
        ...currentSettings,
        activeProjectId: projectId,
        backupMeta: {
          ...currentSettings.backupMeta,
          firstProjectCreatedAt:
            currentSettings.backupMeta.firstProjectCreatedAt ?? now,
        },
      })
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
  const pixelMap = new Map<string, LayerPixelRecord>()
  for (const row of pixelRows) {
    pixelMap.set(row.layerId, row)
  }

  const layers: LayerRuntime[] = project.layers.map((meta) => {
    const row = pixelMap.get(meta.id)
    const raw = row?.data
    const geo = normalizeLayerGeometry(
      {
        offsetX: meta.offsetX ?? row?.offsetX,
        offsetY: meta.offsetY ?? row?.offsetY,
        dataWidth: meta.dataWidth ?? row?.dataWidth,
        dataHeight: meta.dataHeight ?? row?.dataHeight,
        data: raw ? new Uint8ClampedArray(raw) : createPixelBuffer(project.width, project.height),
      },
      project.width,
      project.height
    )

    const expectedByteLength = geo.dataWidth * geo.dataHeight * 4
    let data: Uint8ClampedArray
    if (raw && raw.byteLength === expectedByteLength) {
      data = new Uint8ClampedArray(raw)
    } else {
      data = createPixelBuffer(geo.dataWidth, geo.dataHeight)
      if (raw) {
        data.set(raw.subarray(0, Math.min(raw.length, expectedByteLength)))
      }
    }
    return {
      ...meta,
      offsetX: geo.offsetX,
      offsetY: geo.offsetY,
      dataWidth: geo.dataWidth,
      dataHeight: geo.dataHeight,
      data,
    }
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
      offsetX: l.offsetX ?? 0,
      offsetY: l.offsetY ?? 0,
      dataWidth: l.dataWidth ?? project.width,
      dataHeight: l.dataHeight ?? project.height,
    })),
    thumbnailPng,
    updatedAt: now,
  }

  const pixelRecords: LayerPixelRecord[] = layers.map((l) => ({
    key: `${project.id}:${l.id}`,
    projectId: project.id,
    layerId: l.id,
    data: new Uint8Array(l.data),
    offsetX: l.offsetX ?? 0,
    offsetY: l.offsetY ?? 0,
    dataWidth: l.dataWidth ?? project.width,
    dataHeight: l.dataHeight ?? project.height,
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

export async function duplicateProjectById(
  projectId: string,
  copySuffix = 'Copy',
  targetDb: DotDotDatabase = db
): Promise<ProjectRecord | null> {
  const loaded = await loadProjectFull(projectId, targetDb)
  if (!loaded) return null

  const now = Date.now()
  const newProjId = generateId('proj')
  const existingProjects = await targetDb.projects.toArray()
  const minOrder =
    existingProjects.length > 0
      ? Math.min(...existingProjects.map((p) => p.order)) - 1
      : 0

  const layerIdMap = new Map<string, string>()
  const nextLayers: LayerRuntime[] = loaded.layers.map((l) => {
    const nlId = generateId('layer')
    layerIdMap.set(l.id, nlId)
    return {
      ...l,
      id: nlId,
      data: new Uint8ClampedArray(l.data),
    }
  })

  const nextActiveId =
    layerIdMap.get(loaded.project.activeLayerId) ?? nextLayers[0]?.id ?? ''
  const { png: thumbnailPng } = exportCompositePngBytes(
    nextLayers,
    loaded.project.width,
    loaded.project.height,
    1
  )

  const newProject: ProjectRecord = {
    ...loaded.project,
    id: newProjId,
    name: `${loaded.project.name} ${copySuffix}`.trim(),
    layers: nextLayers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      clipping: l.clipping,
      offsetX: l.offsetX,
      offsetY: l.offsetY,
      dataWidth: l.dataWidth,
      dataHeight: l.dataHeight,
    })),
    activeLayerId: nextActiveId,
    palette: {
      name: loaded.project.palette.name,
      colors: [...loaded.project.palette.colors],
      sourcePaletteId: loaded.project.palette.sourcePaletteId,
    },
    order: minOrder,
    thumbnailPng,
    createdAt: now,
    updatedAt: now,
  }

  await saveProjectFull(
    {
      project: newProject,
      layers: nextLayers,
      history: { undoStack: [], redoStack: [] },
    },
    targetDb
  )
  return newProject
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
