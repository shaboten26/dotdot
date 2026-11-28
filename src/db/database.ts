import Dexie, { type Table } from 'dexie'
import {
  MAX_OPAQUE_PALETTE_COLORS,
  type AppSettings,
  type BackupReminderMeta,
  type CanvasSizePreset,
  type CelBufferRecord,
  type CelBufferRuntime,
  type CelMap,
  type CursorDisplaySize,
  type CustomCursorData,
  type CustomCursorGridSize,
  type DarkThemeVariantId,
  type FrameMeta,
  type GalleryTileSize,
  type LayerPixelRecord,
  type LayerRuntime,
  type LanguageCode,
  type LightThemeVariantId,
  type MigrationStateRecord,
  type PaletteData,
  type ProjectHistoryRecord,
  type ProjectPalette,
  type ProjectRecord,
  type SeamlessWrapMode,
  type SerializedHistoryEntry,
  type StampAsset,
  type SymmetryMode,
  type TilePreviewGrid,
  type UiSizeConfig,
  type UiSizePreset,
} from '../types'
import { buildInitialPalettes } from './defaultPalettes'
import {
  createPixelBuffer,
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
  normalizeLayerGeometry,
} from '../engine/pixelBuffer'
import { exportCompositePngBytes } from '../engine/compositor'
import { normalizeProjectPalette } from '../engine/indexedPalette'
import {
  clampFrameDurationMs,
  createSingleFrameTimelineFromLayers,
  DEFAULT_FRAME_DURATION_MS,
  projectFrameLayers,
  pruneUnreferencedCelBuffers,
  type TimelineState,
} from '../engine/animation'
import {
  convertLegacyProjectDataToIndexed,
  isProjectAlreadyIndexed,
  migrateDatabaseToIndexedColor,
  type DatabaseMigrationSummary,
  type MigrationProgressInfo,
} from './indexedMigration'

export class DotDotDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>
  layerPixels!: Table<LayerPixelRecord, string>
  celBuffers!: Table<CelBufferRecord, string>
  palettes!: Table<PaletteData, string>
  stamps!: Table<StampAsset, string>
  histories!: Table<ProjectHistoryRecord, string>
  settings!: Table<AppSettings, string>
  migrationStates!: Table<MigrationStateRecord, string>

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

    // Version 3: Unified Still (1-frame) + Animation (N-frame) `celBuffers` store & unlimited default Undo/Redo history
    this.version(3)
      .stores({
        projects: 'id, order, createdAt, updatedAt, name',
        layerPixels: 'key, projectId, layerId',
        celBuffers: 'key, projectId, celId',
        palettes: 'id, order, updatedAt',
        histories: 'projectId, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const settingsTable = tx.table<AppSettings, string>('settings')
        await settingsTable.toCollection().modify((s) => {
          if (!s.historyLimitCustomized && s.historyLimit === 100) {
            s.historyLimit = 'unlimited'
          }
        })
      })

    // Version 4: Legacy `stamps` store retained for backward compatibility of existing user data
    this.version(4).stores({
      projects: 'id, order, createdAt, updatedAt, name',
      layerPixels: 'key, projectId, layerId',
      celBuffers: 'key, projectId, celId',
      palettes: 'id, order, updatedAt',
      stamps: 'id, order, updatedAt',
      histories: 'projectId, updatedAt',
      settings: 'id',
    })

    // Version 5: Add `migrationStates` store for safe, resumable, non-blocking RGBA -> 1-byte Indexed Color migration.
    // IMPORTANT (Section 8-5): NEVER run bulk pixel conversion inside Dexie `upgrade()`!
    this.version(5).stores({
      projects: 'id, order, createdAt, updatedAt, name',
      layerPixels: 'key, projectId, layerId',
      celBuffers: 'key, projectId, celId',
      palettes: 'id, order, updatedAt',
      stamps: 'id, order, updatedAt',
      histories: 'projectId, updatedAt',
      settings: 'id',
      migrationStates: 'projectId, stage, updatedAt',
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
    overallScale: 84,
    toolIconSize: 14,
    toolButtonHeight: 36,
    toolLabelSize: 9,
    swatchSize: 24,
    checkboxSize: 14,
    uiGap: 2,
    drawButtonVh: 9,
  },
  standard: {
    preset: 'standard',
    overallScale: 92,
    toolIconSize: 16,
    toolButtonHeight: 44,
    toolLabelSize: 10,
    swatchSize: 30,
    checkboxSize: 16,
    uiGap: 4,
    drawButtonVh: 12,
  },
  large: {
    preset: 'large',
    overallScale: 100,
    toolIconSize: 20,
    toolButtonHeight: 48,
    toolLabelSize: 11,
    swatchSize: 34,
    checkboxSize: 20,
    uiGap: 6,
    drawButtonVh: 15,
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
export const LOW_STORAGE_SNOOZE_INTERVAL_MS = 24 * 60 * 60 * 1000

export const ORIGIN_LOW_STORAGE_WARN_RATIO = 0.85
export const ORIGIN_LOW_STORAGE_CRITICAL_RATIO = 0.95
export const ORIGIN_LOW_STORAGE_WARN_REMAINING_BYTES = 25 * 1024 * 1024
export const ORIGIN_LOW_STORAGE_CRITICAL_REMAINING_BYTES = 8 * 1024 * 1024

export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export interface OriginLowStorageStatus {
  level: 'ok' | 'warning' | 'critical'
  usageBytes: number | null
  quotaBytes: number | null
  remainingBytes: number | null
  usageRatio: number | null
}

export function evaluateOriginLowStorage(
  usageBytes: number | null,
  quotaBytes: number | null
): OriginLowStorageStatus {
  if (
    usageBytes === null ||
    quotaBytes === null ||
    !Number.isFinite(usageBytes) ||
    !Number.isFinite(quotaBytes) ||
    quotaBytes <= 0
  ) {
    return {
      level: 'ok',
      usageBytes,
      quotaBytes,
      remainingBytes: null,
      usageRatio: null,
    }
  }
  const remainingBytes = Math.max(0, quotaBytes - usageBytes)
  const usageRatio = Math.min(1, Math.max(0, usageBytes / quotaBytes))

  if (
    usageRatio >= ORIGIN_LOW_STORAGE_CRITICAL_RATIO ||
    remainingBytes <= ORIGIN_LOW_STORAGE_CRITICAL_REMAINING_BYTES
  ) {
    return {
      level: 'critical',
      usageBytes,
      quotaBytes,
      remainingBytes,
      usageRatio,
    }
  }

  if (
    usageRatio >= ORIGIN_LOW_STORAGE_WARN_RATIO ||
    remainingBytes <= ORIGIN_LOW_STORAGE_WARN_REMAINING_BYTES
  ) {
    return {
      level: 'warning',
      usageBytes,
      quotaBytes,
      remainingBytes,
      usageRatio,
    }
  }

  return {
    level: 'ok',
    usageBytes,
    quotaBytes,
    remainingBytes,
    usageRatio,
  }
}

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

export const MIN_CURSOR_SPEED = 0.25
export const MAX_CURSOR_SPEED = 3.0
export const DEFAULT_CURSOR_SPEED = 1.0

export const VALID_LIGHT_THEME_VARIANTS: ReadonlyArray<LightThemeVariantId> = [
  'lavender-cream',
  'peach-cotton',
  'mint-pocket',
  'antique-brass',
  'urban-concrete',
  'retro-kissaten',
]

export const VALID_DARK_THEME_VARIANTS: ReadonlyArray<DarkThemeVariantId> = [
  'dusk-plum',
  'royal-velvet',
  'tokyo-neon',
  'urban-graphite',
  'forest-apothecary',
  'amber-crt',
]

export const SUPPORTED_LANGUAGE_CODES: ReadonlyArray<LanguageCode> = [
  'ja',
  'en',
  'ko',
  'zh-CN',
  'zh-TW',
  'es',
  'pt',
  'fr',
  'de',
  'ru',
]

export function detectPreferredLanguage(
  rawLocales?: readonly string[] | string | null
): LanguageCode {
  const candidates: string[] = []
  if (Array.isArray(rawLocales)) {
    for (const item of rawLocales) {
      if (typeof item === 'string' && item.trim()) {
        candidates.push(item.trim().toLowerCase())
      }
    }
  } else if (typeof rawLocales === 'string' && rawLocales.trim()) {
    candidates.push(rawLocales.trim().toLowerCase())
  } else if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) {
      for (const item of navigator.languages) {
        if (typeof item === 'string' && item.trim()) {
          candidates.push(item.trim().toLowerCase())
        }
      }
    }
    if (typeof navigator.language === 'string' && navigator.language.trim()) {
      candidates.push(navigator.language.trim().toLowerCase())
    }
  }

  for (const tag of candidates) {
    const normalized = tag.replace(/_/g, '-')
    if (normalized.startsWith('zh')) {
      if (
        normalized.includes('tw') ||
        normalized.includes('hk') ||
        normalized.includes('mo') ||
        normalized.includes('hant')
      ) {
        return 'zh-TW'
      }
      return 'zh-CN'
    }
    const primary = normalized.split('-')[0]
    if (primary === 'ja') return 'ja'
    if (primary === 'ko') return 'ko'
    if (primary === 'en') return 'en'
    if (primary === 'es') return 'es'
    if (primary === 'pt') return 'pt'
    if (primary === 'fr') return 'fr'
    if (primary === 'de') return 'de'
    if (primary === 'ru') return 'ru'
  }
  return 'en'
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  id: 'app-settings',
  theme: 'system',
  lightThemeVariant: 'lavender-cream',
  darkThemeVariant: 'dusk-plum',
  language: detectPreferredLanguage(),
  historyLimit: 'unlimited',
  historyLimitCustomized: false,
  lowStorageSnoozedUntil: null,
  showGrid: true,
  checkerboardDark: false,
  grayscalePreview: false,
  confirmDestructive: true,
  soundEnabled: false,
  eyedropperDoubleTap: true,
  cursorSpeed: DEFAULT_CURSOR_SPEED,
  cursorSize: 'standard',
  activeCursorId: 'standard',
  customCursors: [],
  activeProjectId: null,
  gallerySortMode: 'manual',
  galleryTileSize: 'standard',
  uiSize: { ...DEFAULT_UI_SIZE_CONFIG },
  customCanvasPresets: [],
  backupMeta: { ...DEFAULT_BACKUP_META },
  stampsInitialized: false,
  defaultSymmetryMode: 'none',
  showSymmetryGuide: true,
  defaultTilePreviewGrid: 'off',
  defaultSeamlessWrapMode: 'none',
  embedPngMetadata: true,
  defaultSpriteSheetScale: 1,
  defaultSpriteSheetPadding: 0,
  preferredSelectType: 'wand',
  preferredSelectTypeCustomized: false,
}

export function normalizeCustomCursors(
  raw?: ReadonlyArray<Partial<CustomCursorData>> | null
): CustomCursorData[] {
  if (!Array.isArray(raw)) return []
  const result: CustomCursorData[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!item) continue
    const gridSize: CustomCursorGridSize = item.gridSize === 8 ? 8 : 16
    const total = gridSize * gridSize
    const id =
      typeof item.id === 'string' && item.id.trim() && item.id !== 'standard'
        ? item.id.trim()
        : `cursor-${i + 1}-${gridSize}`
    if (seenIds.has(id)) continue
    seenIds.add(id)

    const name =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 32)
        : `カスタム ${result.length + 1}`

    const hotspotX = Math.max(
      0,
      Math.min(gridSize - 1, Math.round(Number(item.hotspotX) || 0))
    )
    const hotspotY = Math.max(
      0,
      Math.min(gridSize - 1, Math.round(Number(item.hotspotY) || 0))
    )

    const pixels = new Array<string>(total).fill('')
    if (Array.isArray(item.pixels)) {
      for (let p = 0; p < Math.min(total, item.pixels.length); p++) {
        const val = item.pixels[p]
        if (typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val.trim())) {
          pixels[p] = val.trim().toLowerCase()
        }
      }
    }

    result.push({
      id,
      name,
      gridSize,
      hotspotX,
      hotspotY,
      pixels,
    })
  }
  return result
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
  const rawUi = raw?.uiSize
  // Migrate uncustomized legacy `standard` default (`overallScale: 100, toolButtonHeight: 48, swatchSize: 34, drawButtonVh: 15`)
  // to the new `standard` baseline (former `compact`) so existing workspaces immediately reflect the streamlined standard UI!
  const isLegacyUncustomizedStandard = Boolean(
    rawUi &&
      rawUi.preset === 'standard' &&
      rawUi.overallScale === 100 &&
      rawUi.toolIconSize === 20 &&
      rawUi.toolButtonHeight === 48 &&
      rawUi.toolLabelSize === 11 &&
      rawUi.swatchSize === 34 &&
      rawUi.checkboxSize === 20 &&
      rawUi.uiGap === 6 &&
      rawUi.drawButtonVh === 15
  )
  const uiSize: UiSizeConfig = isLegacyUncustomizedStandard
    ? { ...DEFAULT_UI_SIZE_CONFIG }
    : {
        ...DEFAULT_UI_SIZE_CONFIG,
        ...(rawUi ?? {}),
      }

  let historyLimit: number | 'unlimited' = 'unlimited'
  const customized = Boolean(raw?.historyLimitCustomized)
  if (raw?.historyLimit === 'unlimited') {
    historyLimit = 'unlimited'
  } else if (typeof raw?.historyLimit === 'number' && Number.isFinite(raw.historyLimit)) {
    if (!customized && raw.historyLimit === 100) {
      historyLimit = 'unlimited'
    } else {
      historyLimit = Math.max(1, Math.trunc(raw.historyLimit))
    }
  }

  const lightThemeVariant: LightThemeVariantId =
    raw?.lightThemeVariant &&
    VALID_LIGHT_THEME_VARIANTS.includes(raw.lightThemeVariant)
      ? raw.lightThemeVariant
      : 'lavender-cream'

  const darkThemeVariant: DarkThemeVariantId =
    raw?.darkThemeVariant &&
    VALID_DARK_THEME_VARIANTS.includes(raw.darkThemeVariant)
      ? raw.darkThemeVariant
      : 'dusk-plum'

  const rawSpeed = Number(raw?.cursorSpeed)
  const cursorSpeed = Number.isFinite(rawSpeed)
    ? Math.round(
        Math.max(MIN_CURSOR_SPEED, Math.min(MAX_CURSOR_SPEED, rawSpeed)) * 100
      ) / 100
    : DEFAULT_CURSOR_SPEED

  const cursorSize: CursorDisplaySize =
    raw?.cursorSize === 'small' ||
    raw?.cursorSize === 'standard' ||
    raw?.cursorSize === 'large'
      ? raw.cursorSize
      : 'standard'

  const customCursors = normalizeCustomCursors(raw?.customCursors)
  const requestedCursorId =
    typeof raw?.activeCursorId === 'string' && raw.activeCursorId.trim()
      ? raw.activeCursorId.trim()
      : 'standard'
  const activeCursorId =
    requestedCursorId === 'standard' ||
    customCursors.some((c) => c.id === requestedCursorId)
      ? requestedCursorId
      : 'standard'

  const defaultSymmetryMode: SymmetryMode =
    raw?.defaultSymmetryMode === 'horizontal' ||
    raw?.defaultSymmetryMode === 'vertical' ||
    raw?.defaultSymmetryMode === 'quad'
      ? raw.defaultSymmetryMode
      : 'none'

  const defaultTilePreviewGrid: TilePreviewGrid =
    raw?.defaultTilePreviewGrid === '3x3' || raw?.defaultTilePreviewGrid === '5x5'
      ? raw.defaultTilePreviewGrid
      : 'off'

  const defaultSeamlessWrapMode: SeamlessWrapMode =
    raw?.defaultSeamlessWrapMode === 'horizontal' ||
    raw?.defaultSeamlessWrapMode === 'vertical' ||
    raw?.defaultSeamlessWrapMode === 'both'
      ? raw.defaultSeamlessWrapMode
      : 'none'

  const rawSheetScale = Number(raw?.defaultSpriteSheetScale)
  const defaultSpriteSheetScale = Number.isFinite(rawSheetScale)
    ? Math.max(1, Math.min(32, Math.round(rawSheetScale)))
    : 1

  const rawSheetPadding = Number(raw?.defaultSpriteSheetPadding)
  const defaultSpriteSheetPadding = Number.isFinite(rawSheetPadding)
    ? Math.max(0, Math.min(64, Math.round(rawSheetPadding)))
    : 0

  const preferredSelectTypeCustomized = Boolean(
    raw?.preferredSelectTypeCustomized
  )
  const preferredSelectType: AppSettings['preferredSelectType'] =
    preferredSelectTypeCustomized &&
    (raw?.preferredSelectType === 'wand' ||
      raw?.preferredSelectType === 'rect' ||
      raw?.preferredSelectType === 'ellipse')
      ? raw.preferredSelectType
      : 'wand'

  const language: LanguageCode =
    raw?.language &&
    SUPPORTED_LANGUAGE_CODES.includes(raw.language as LanguageCode)
      ? (raw.language as LanguageCode)
      : detectPreferredLanguage()

  return {
    ...DEFAULT_APP_SETTINGS,
    ...(raw ?? {}),
    id: 'app-settings',
    language,
    lightThemeVariant,
    darkThemeVariant,
    historyLimit,
    historyLimitCustomized:
      customized || (typeof historyLimit === 'number' && historyLimit !== 100),
    lowStorageSnoozedUntil:
      typeof raw?.lowStorageSnoozedUntil === 'number' &&
      Number.isFinite(raw.lowStorageSnoozedUntil)
        ? raw.lowStorageSnoozedUntil
        : null,
    grayscalePreview:
      typeof raw?.grayscalePreview === 'boolean' ? raw.grayscalePreview : false,
    eyedropperDoubleTap:
      typeof raw?.eyedropperDoubleTap === 'boolean' ? raw.eyedropperDoubleTap : true,
    cursorSpeed,
    cursorSize,
    activeCursorId,
    customCursors,
    galleryTileSize:
      raw?.galleryTileSize === 'compact' ||
      raw?.galleryTileSize === 'small' ||
      raw?.galleryTileSize === 'standard' ||
      raw?.galleryTileSize === 'large'
        ? (raw.galleryTileSize as GalleryTileSize)
        : 'standard',
    uiSize,
    customCanvasPresets: normalizeCustomPresets(raw?.customCanvasPresets),
    backupMeta: normalizeBackupMeta(raw?.backupMeta),
    stampsInitialized: Boolean(raw?.stampsInitialized),
    defaultSymmetryMode,
    showSymmetryGuide:
      typeof raw?.showSymmetryGuide === 'boolean' ? raw.showSymmetryGuide : true,
    defaultTilePreviewGrid,
    defaultSeamlessWrapMode,
    embedPngMetadata:
      typeof raw?.embedPngMetadata === 'boolean' ? raw.embedPngMetadata : true,
    defaultSpriteSheetScale,
    defaultSpriteSheetPadding,
    preferredSelectType,
    preferredSelectTypeCustomized,
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

export async function initializeDatabase(
  targetDb: DotDotDatabase = db,
  options?: {
    onMigrationProgress?: (info: MigrationProgressInfo) => void
    yieldBetweenProjects?: boolean
  }
): Promise<{
  settings: AppSettings
  palettes: PaletteData[]
  stamps: StampAsset[]
  migrationSummary: DatabaseMigrationSummary
}> {
  const storedSettings = await targetDb.settings.get('app-settings')
  let settings = normalizeAppSettings(storedSettings)

  let palettes = await targetDb.palettes.orderBy('order').toArray()
  if (palettes.length === 0) {
    palettes = buildInitialPalettes()
    await targetDb.palettes.bulkPut(palettes)
  } else {
    // Ensure library palettes adhere to the 255 opaque color cap
    let mutatedLibrary = false
    const clampedPalettes = palettes.map((pal) => {
      if (pal.colors.length > MAX_OPAQUE_PALETTE_COLORS) {
        mutatedLibrary = true
        return {
          ...pal,
          colors: pal.colors.slice(0, MAX_OPAQUE_PALETTE_COLORS),
        }
      }
      return pal
    })
    if (mutatedLibrary) {
      palettes = clampedPalettes
      await targetDb.palettes.bulkPut(palettes)
    }
  }

  // Section 3: Custom brush / pixel stamp feature is withdrawn from new workflows,
  // so we no longer seed built-in stamps on fresh installs, while preserving any existing user stamps in DB!
  const stamps = await targetDb.stamps.orderBy('order').toArray()

  // Section 8: Staged, resumable, quota-safe migration of any legacy RGBA artworks to 1-byte Indexed Color
  const migrationSummary = await migrateDatabaseToIndexedColor(targetDb, {
    onProgress: options?.onMigrationProgress,
    yieldBetweenProjects: options?.yieldBetweenProjects,
  })

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
  return { settings, palettes, stamps, migrationSummary }
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
): Promise<{
  project: ProjectRecord
  layers: LayerRuntime[]
  timeline: TimelineState
}> {
  const width = Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(params.width)))
  const height = Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(params.height)))
  const now = Date.now()
  const projectId = generateId('proj')
  const layerId = generateId('layer')
  const frameId = generateId('frame')

  const initialData = createPixelBuffer(width, height)
  const layerRuntime: LayerRuntime = {
    id: layerId,
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 100,
    blendMode: 'normal',
    clipping: false,
    offsetX: 0,
    offsetY: 0,
    dataWidth: width,
    dataHeight: height,
    data: initialData,
  }

  const timeline = createSingleFrameTimelineFromLayers([layerRuntime], {
    frameId,
    defaultFrameDurationMs: DEFAULT_FRAME_DURATION_MS,
    playbackDirection: 'forward',
    loopPlayback: true,
  })

  const normalizedPalette = normalizeProjectPalette({
    name: params.palette.name || 'Palette',
    colors:
      params.palette.colors.length > 0
        ? params.palette.colors.slice(0, MAX_OPAQUE_PALETTE_COLORS)
        : ['#000000', '#FFFFFF'],
    colorTable: params.palette.colorTable,
    displayOrder: params.palette.displayOrder,
    sourcePaletteId: params.palette.sourcePaletteId,
    author: params.palette.author,
    sourceUrl: params.palette.sourceUrl,
  })

  const { png: thumbnailPng } = exportCompositePngBytes([layerRuntime], width, height, 1, {
    palette: normalizedPalette,
  })

  const existingProjects = await targetDb.projects.toArray()
  const minOrder =
    existingProjects.length > 0
      ? Math.min(...existingProjects.map((p) => p.order)) - 1
      : 0

  const project: ProjectRecord = {
    id: projectId,
    name: params.name.trim() || 'Untitled',
    width,
    height,
    pixelFormat: 'indexed-v1',
    layers: [
      {
        id: layerId,
        name: layerRuntime.name,
        visible: true,
        locked: false,
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
    frames: timeline.frames,
    cels: timeline.cels,
    activeFrameId: timeline.activeFrameId,
    defaultFrameDurationMs: timeline.defaultFrameDurationMs,
    playbackDirection: timeline.playbackDirection,
    loopPlayback: timeline.loopPlayback,
    palette: normalizedPalette,
    selectedColorIndex: 0,
    order: minOrder,
    thumbnailPng,
    createdAt: now,
    updatedAt: now,
  }

  const celRecords: CelBufferRecord[] = Object.values(timeline.celBuffers).map((cb) => ({
    key: `${projectId}:${cb.id}`,
    projectId,
    celId: cb.id,
    offsetX: cb.offsetX,
    offsetY: cb.offsetY,
    dataWidth: cb.dataWidth,
    dataHeight: cb.dataHeight,
    data: new Uint8Array(cb.data),
    format: 'indexed-v1',
  }))

  await targetDb.transaction(
    'rw',
    [
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.celBuffers,
      targetDb.histories,
      targetDb.settings,
    ],
    async () => {
      await targetDb.projects.put(project)
      await targetDb.layerPixels.put({
        key: `${projectId}:${layerId}`,
        projectId,
        layerId,
        data: new Uint8Array(initialData),
        format: 'indexed-v1',
        offsetX: 0,
        offsetY: 0,
        dataWidth: width,
        dataHeight: height,
      })
      if (celRecords.length > 0) {
        await targetDb.celBuffers.bulkPut(celRecords)
      }
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

  return { project, layers: [layerRuntime], timeline }
}

export async function loadProjectFull(
  projectId: string,
  targetDb: DotDotDatabase = db
): Promise<{
  project: ProjectRecord
  layers: LayerRuntime[]
  timeline: TimelineState
  history: ProjectHistoryRecord
} | null> {
  let project = await targetDb.projects.get(projectId)
  if (!project) return null

  let pixelRows = await targetDb.layerPixels.where('projectId').equals(projectId).toArray()
  let celRows = await targetDb.celBuffers.where('projectId').equals(projectId).toArray()
  let historyRow = await targetDb.histories.get(projectId)

  // Defensive lazy-migration fallback if `loadProjectFull` is invoked directly on an unmigrated DB (e.g. in tests)
  if (!isProjectAlreadyIndexed(project, pixelRows, celRows)) {
    const converted = convertLegacyProjectDataToIndexed({
      project,
      layerPixels: pixelRows,
      celBuffers: celRows,
      history: historyRow ?? null,
    })
    await targetDb.transaction(
      'rw',
      [
        targetDb.projects,
        targetDb.layerPixels,
        targetDb.celBuffers,
        targetDb.histories,
      ],
      async () => {
        await targetDb.projects.put(converted.project)
        await targetDb.layerPixels.where('projectId').equals(projectId).delete()
        if (converted.layerPixels.length > 0) {
          await targetDb.layerPixels.bulkPut(converted.layerPixels)
        }
        await targetDb.celBuffers.where('projectId').equals(projectId).delete()
        if (converted.celBuffers.length > 0) {
          await targetDb.celBuffers.bulkPut(converted.celBuffers)
        }
        await targetDb.histories.put(converted.history)
      }
    )
    project = converted.project
    pixelRows = converted.layerPixels
    celRows = converted.celBuffers
    historyRow = converted.history
  }

  const normalizedPalette = normalizeProjectPalette(project.palette)

  const pixelMap = new Map<string, LayerPixelRecord>()
  for (const row of pixelRows) {
    pixelMap.set(row.layerId, row)
  }

  const legacyLayers: LayerRuntime[] = project.layers.map((meta) => {
    const row = pixelMap.get(meta.id)
    const raw = row?.data
    const geo = normalizeLayerGeometry(
      {
        offsetX: meta.offsetX ?? row?.offsetX,
        offsetY: meta.offsetY ?? row?.offsetY,
        dataWidth: meta.dataWidth ?? row?.dataWidth,
        dataHeight: meta.dataHeight ?? row?.dataHeight,
        data: raw ? new Uint8Array(raw) : createPixelBuffer(project.width, project.height),
      },
      project.width,
      project.height
    )

    const expectedByteLength = geo.dataWidth * geo.dataHeight
    let data: Uint8Array
    if (raw && raw.byteLength === expectedByteLength) {
      data = new Uint8Array(raw)
    } else {
      data = createPixelBuffer(geo.dataWidth, geo.dataHeight)
      if (raw) {
        data.set(raw.subarray(0, Math.min(raw.length, expectedByteLength)))
      }
    }
    return {
      ...meta,
      locked: Boolean(meta.locked),
      offsetX: geo.offsetX,
      offsetY: geo.offsetY,
      dataWidth: geo.dataWidth,
      dataHeight: geo.dataHeight,
      data,
    }
  })

  let timeline: TimelineState

  if (
    Array.isArray(project.frames) &&
    project.frames.length >= 1 &&
    project.cels &&
    (celRows.length > 0 || Object.values(project.cels).every((r) => r.kind === 'empty'))
  ) {
    const celBuffers: Record<string, CelBufferRuntime> = {}
    for (const row of celRows) {
      const raw = new Uint8Array(row.data)
      const geo = normalizeLayerGeometry(
        {
          offsetX: row.offsetX,
          offsetY: row.offsetY,
          dataWidth: row.dataWidth,
          dataHeight: row.dataHeight,
          data: raw,
        },
        project.width,
        project.height
      )
      const expectedLen = geo.dataWidth * geo.dataHeight
      let data: Uint8Array
      if (raw.byteLength === expectedLen) {
        data = raw
      } else {
        data = createPixelBuffer(geo.dataWidth, geo.dataHeight)
        data.set(raw.subarray(0, Math.min(raw.length, expectedLen)))
      }
      celBuffers[row.celId] = {
        id: row.celId,
        offsetX: geo.offsetX,
        offsetY: geo.offsetY,
        dataWidth: geo.dataWidth,
        dataHeight: geo.dataHeight,
        data,
      }
    }
    const frames: FrameMeta[] = project.frames.map((f) => ({
      id: f.id,
      durationMs: clampFrameDurationMs(f.durationMs),
    }))
    const activeFrameId =
      project.activeFrameId && frames.some((f) => f.id === project.activeFrameId)
        ? project.activeFrameId
        : frames[0]!.id

    timeline = {
      frames,
      cels: { ...project.cels },
      celBuffers: pruneUnreferencedCelBuffers(project.cels, celBuffers),
      activeFrameId,
      defaultFrameDurationMs: clampFrameDurationMs(
        project.defaultFrameDurationMs ?? DEFAULT_FRAME_DURATION_MS
      ),
      playbackDirection: project.playbackDirection ?? 'forward',
      loopPlayback: project.loopPlayback ?? true,
    }
  } else {
    timeline = createSingleFrameTimelineFromLayers(legacyLayers, {
      frameId: project.frames?.[0]?.id ?? 'frame-1',
      defaultFrameDurationMs: project.defaultFrameDurationMs ?? DEFAULT_FRAME_DURATION_MS,
      playbackDirection: project.playbackDirection ?? 'forward',
      loopPlayback: project.loopPlayback ?? true,
    })
  }

  const activeLayers = projectFrameLayers(
    project.layers,
    timeline.cels,
    timeline.celBuffers,
    timeline.activeFrameId,
    project.width,
    project.height
  )

  const normalizedProject: ProjectRecord = {
    ...project,
    pixelFormat: 'indexed-v1',
    palette: normalizedPalette,
    frames: timeline.frames,
    cels: timeline.cels,
    activeFrameId: timeline.activeFrameId,
    defaultFrameDurationMs: timeline.defaultFrameDurationMs,
    playbackDirection: timeline.playbackDirection,
    loopPlayback: timeline.loopPlayback,
  }

  const history =
    historyRow ?? {
      projectId,
      undoStack: [],
      redoStack: [],
      updatedAt: project.updatedAt,
    }

  return {
    project: normalizedProject,
    layers: activeLayers,
    timeline,
    history,
  }
}

export interface SaveProjectPayload {
  project: ProjectRecord
  layers: readonly LayerRuntime[]
  timeline?: {
    frames: readonly FrameMeta[]
    cels: CelMap
    celBuffers: Readonly<Record<string, CelBufferRuntime>>
    activeFrameId: string
    defaultFrameDurationMs?: number
    playbackDirection?: ProjectRecord['playbackDirection']
    loopPlayback?: boolean
  }
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
  const { project, layers, timeline, history } = payload
  const normalizedPalette = normalizeProjectPalette(project.palette)

  let resolvedFrames: FrameMeta[]
  let resolvedCels: CelMap
  let resolvedCelBuffers: Record<string, CelBufferRuntime>
  let resolvedActiveFrameId: string
  let resolvedDefaultDuration: number
  let resolvedDirection: ProjectRecord['playbackDirection']
  let resolvedLoop: boolean

  if (timeline && timeline.frames.length >= 1) {
    resolvedFrames = timeline.frames.map((f) => ({
      id: f.id,
      durationMs: clampFrameDurationMs(f.durationMs),
    }))
    resolvedCels = { ...timeline.cels }
    resolvedCelBuffers = pruneUnreferencedCelBuffers(resolvedCels, timeline.celBuffers)
    resolvedActiveFrameId =
      timeline.activeFrameId &&
      resolvedFrames.some((f) => f.id === timeline.activeFrameId)
        ? timeline.activeFrameId
        : resolvedFrames[0]!.id
    resolvedDefaultDuration = clampFrameDurationMs(
      timeline.defaultFrameDurationMs ??
        project.defaultFrameDurationMs ??
        DEFAULT_FRAME_DURATION_MS
    )
    resolvedDirection =
      timeline.playbackDirection ?? project.playbackDirection ?? 'forward'
    resolvedLoop = timeline.loopPlayback ?? project.loopPlayback ?? true
  } else {
    const single = createSingleFrameTimelineFromLayers(layers, {
      frameId: project.frames?.[0]?.id ?? 'frame-1',
      defaultFrameDurationMs:
        project.defaultFrameDurationMs ?? DEFAULT_FRAME_DURATION_MS,
      playbackDirection: project.playbackDirection ?? 'forward',
      loopPlayback: project.loopPlayback ?? true,
    })
    resolvedFrames = single.frames
    resolvedCels = single.cels
    resolvedCelBuffers = single.celBuffers
    resolvedActiveFrameId = single.activeFrameId
    resolvedDefaultDuration = single.defaultFrameDurationMs
    resolvedDirection = single.playbackDirection
    resolvedLoop = single.loopPlayback
  }

  const thumbLayers =
    resolvedFrames.length > 1
      ? projectFrameLayers(
          layers,
          resolvedCels,
          resolvedCelBuffers,
          resolvedFrames[0]!.id,
          project.width,
          project.height
        )
      : layers

  const { png: thumbnailPng } = exportCompositePngBytes(
    thumbLayers,
    project.width,
    project.height,
    1,
    { palette: normalizedPalette }
  )

  const updatedProject: ProjectRecord = {
    ...project,
    pixelFormat: 'indexed-v1',
    palette: normalizedPalette,
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: Boolean(l.locked),
      opacity: l.opacity,
      blendMode: l.blendMode,
      clipping: l.clipping,
      offsetX: l.offsetX ?? 0,
      offsetY: l.offsetY ?? 0,
      dataWidth: l.dataWidth ?? project.width,
      dataHeight: l.dataHeight ?? project.height,
    })),
    frames: resolvedFrames,
    cels: resolvedCels,
    activeFrameId: resolvedActiveFrameId,
    defaultFrameDurationMs: resolvedDefaultDuration,
    playbackDirection: resolvedDirection,
    loopPlayback: resolvedLoop,
    thumbnailPng,
    updatedAt: now,
  }

  const pixelRecords: LayerPixelRecord[] = layers.map((l) => ({
    key: `${project.id}:${l.id}`,
    projectId: project.id,
    layerId: l.id,
    data: new Uint8Array(l.data),
    format: 'indexed-v1',
    offsetX: l.offsetX ?? 0,
    offsetY: l.offsetY ?? 0,
    dataWidth: l.dataWidth ?? project.width,
    dataHeight: l.dataHeight ?? project.height,
  }))

  const celRecords: CelBufferRecord[] = Object.values(resolvedCelBuffers).map((cb) => ({
    key: `${project.id}:${cb.id}`,
    projectId: project.id,
    celId: cb.id,
    offsetX: cb.offsetX,
    offsetY: cb.offsetY,
    dataWidth: cb.dataWidth,
    dataHeight: cb.dataHeight,
    data: new Uint8Array(cb.data),
    format: 'indexed-v1',
  }))

  const activeLayerKeys = new Set(pixelRecords.map((r) => r.key))
  const activeCelKeys = new Set(celRecords.map((r) => r.key))

  const writeTx = async (
    undoStack?: SerializedHistoryEntry[],
    redoStack?: SerializedHistoryEntry[]
  ) => {
    await targetDb.transaction(
      'rw',
      [
        targetDb.projects,
        targetDb.layerPixels,
        targetDb.celBuffers,
        targetDb.histories,
      ],
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

        const existingCelKeys = await targetDb.celBuffers
          .where('projectId')
          .equals(project.id)
          .primaryKeys()
        const staleCelKeys = existingCelKeys.filter((k) => !activeCelKeys.has(k))
        if (staleCelKeys.length > 0) {
          await targetDb.celBuffers.bulkDelete(staleCelKeys)
        }
        if (celRecords.length > 0) {
          await targetDb.celBuffers.bulkPut(celRecords)
        }

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
      data: new Uint8Array(l.data),
    }
  })

  const frameIdMap = new Map<string, string>()
  const nextFrames: FrameMeta[] = loaded.timeline.frames.map((f) => {
    const nfId = generateId('frame')
    frameIdMap.set(f.id, nfId)
    return { id: nfId, durationMs: f.durationMs }
  })

  const celIdMap = new Map<string, string>()
  const nextCelBuffers: Record<string, CelBufferRuntime> = {}
  for (const [oldCelId, cb] of Object.entries(loaded.timeline.celBuffers)) {
    const newCelId = generateId('cel')
    celIdMap.set(oldCelId, newCelId)
    nextCelBuffers[newCelId] = {
      ...cb,
      id: newCelId,
      data: new Uint8Array(cb.data),
    }
  }

  const nextCels: CelMap = {}
  for (const [oldKey, ref] of Object.entries(loaded.timeline.cels)) {
    const sep = oldKey.indexOf(':')
    if (sep < 0) continue
    const oldL = oldKey.slice(0, sep)
    const oldF = oldKey.slice(sep + 1)
    const newL = layerIdMap.get(oldL)
    const newF = frameIdMap.get(oldF)
    if (!newL || !newF) continue
    const newKey = `${newL}:${newF}`
    if (ref.kind === 'cel') {
      const mappedCelId = celIdMap.get(ref.celId)
      nextCels[newKey] = mappedCelId
        ? { kind: 'cel', celId: mappedCelId }
        : { kind: 'empty' }
    } else {
      nextCels[newKey] = { kind: 'empty' }
    }
  }

  const nextActiveId =
    layerIdMap.get(loaded.project.activeLayerId) ?? nextLayers[0]?.id ?? ''
  const nextActiveFrameId =
    frameIdMap.get(loaded.timeline.activeFrameId) ?? nextFrames[0]?.id ?? ''

  const clonedPalette = normalizeProjectPalette(loaded.project.palette)

  const { png: thumbnailPng } = exportCompositePngBytes(
    nextLayers,
    loaded.project.width,
    loaded.project.height,
    1,
    { palette: clonedPalette }
  )

  const newProject: ProjectRecord = {
    ...loaded.project,
    id: newProjId,
    name: `${loaded.project.name} ${copySuffix}`.trim(),
    pixelFormat: 'indexed-v1',
    migrationReport: undefined,
    layers: nextLayers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: Boolean(l.locked),
      opacity: l.opacity,
      blendMode: l.blendMode,
      clipping: l.clipping,
      offsetX: l.offsetX,
      offsetY: l.offsetY,
      dataWidth: l.dataWidth,
      dataHeight: l.dataHeight,
    })),
    activeLayerId: nextActiveId,
    frames: nextFrames,
    cels: nextCels,
    activeFrameId: nextActiveFrameId,
    palette: clonedPalette,
    order: minOrder,
    thumbnailPng,
    createdAt: now,
    updatedAt: now,
  }

  await saveProjectFull(
    {
      project: newProject,
      layers: nextLayers,
      timeline: {
        frames: nextFrames,
        cels: nextCels,
        celBuffers: nextCelBuffers,
        activeFrameId: nextActiveFrameId,
        defaultFrameDurationMs: loaded.timeline.defaultFrameDurationMs,
        playbackDirection: loaded.timeline.playbackDirection,
        loopPlayback: loaded.timeline.loopPlayback,
      },
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
    [
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.celBuffers,
      targetDb.histories,
      targetDb.migrationStates,
      targetDb.settings,
    ],
    async () => {
      await targetDb.projects.delete(projectId)
      await targetDb.layerPixels.where('projectId').equals(projectId).delete()
      await targetDb.celBuffers.where('projectId').equals(projectId).delete()
      await targetDb.histories.delete(projectId)
      await targetDb.migrationStates.delete(projectId)

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

export interface SingleProjectSizeEstimate {
  totalBytes: number
  pixelDataBytes: number
  historyBytes: number
  metadataBytes: number
}

function estimateHistoryStackBytes(stack: readonly SerializedHistoryEntry[]): number {
  let bytes = 0
  for (const e of stack) {
    bytes += 96
    if (e.pixelPatches) {
      for (const p of e.pixelPatches) {
        bytes += p.indices.byteLength + p.before.byteLength + p.after.byteLength + 48
      }
    }
    const snapBytes = (s?: SerializedHistoryEntry['beforeStructure']) => {
      if (!s) return 0
      let b = 64
      for (const l of s.layers) b += l.data.byteLength + 48
      if (s.timeline) {
        for (const cb of s.timeline.celBuffers) b += cb.data.byteLength + 32
      }
      return b
    }
    bytes += snapBytes(e.beforeStructure)
    bytes += snapBytes(e.afterStructure)
    if (e.beforeSelection) bytes += e.beforeSelection.byteLength
    if (e.afterSelection) bytes += e.afterSelection.byteLength
    if (e.beforeWorldSelection) bytes += e.beforeWorldSelection.mask.byteLength + 24
    if (e.afterWorldSelection) bytes += e.afterWorldSelection.mask.byteLength + 24
  }
  return bytes
}

export async function estimateSingleProjectStorageBytes(
  projectId: string,
  targetDb: DotDotDatabase = db
): Promise<SingleProjectSizeEstimate | null> {
  const project = await targetDb.projects.get(projectId)
  if (!project) return null

  const { thumbnailPng, migrationReport, ...restMeta } = project
  let metadataBytes = thumbnailPng ? thumbnailPng.byteLength : 0
  if (migrationReport?.beforePreviewPng) {
    metadataBytes += migrationReport.beforePreviewPng.byteLength
  }
  if (migrationReport?.afterPreviewPng) {
    metadataBytes += migrationReport.afterPreviewPng.byteLength
  }
  try {
    metadataBytes += new TextEncoder().encode(JSON.stringify(restMeta)).byteLength
  } catch {
    metadataBytes += 512
  }

  const celRows = await targetDb.celBuffers.where('projectId').equals(projectId).toArray()
  let pixelDataBytes = 0
  if (celRows.length > 0) {
    for (const row of celRows) {
      pixelDataBytes += row.data.byteLength + 48
    }
  } else {
    const layerRows = await targetDb.layerPixels
      .where('projectId')
      .equals(projectId)
      .toArray()
    for (const row of layerRows) {
      pixelDataBytes += row.data.byteLength + 48
    }
  }

  const hist = await targetDb.histories.get(projectId)
  const historyBytes = hist
    ? estimateHistoryStackBytes(hist.undoStack) +
      estimateHistoryStackBytes(hist.redoStack)
    : 0

  return {
    totalBytes: metadataBytes + pixelDataBytes + historyBytes,
    pixelDataBytes,
    historyBytes,
    metadataBytes,
  }
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

export interface ImportedProjectPayload {
  name: string
  width: number
  height: number
  layers: LayerRuntime[]
  activeLayerId?: string
  timeline?: {
    frames: FrameMeta[]
    cels: CelMap
    celBuffers: Record<string, CelBufferRuntime>
    activeFrameId?: string
    defaultFrameDurationMs?: number
    playbackDirection?: ProjectRecord['playbackDirection']
    loopPlayback?: boolean
  }
  palette: ProjectPalette
}

export async function createImportedProject(
  payload: ImportedProjectPayload,
  targetDb: DotDotDatabase = db
): Promise<ProjectRecord> {
  const width = Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(payload.width))
  )
  const height = Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(payload.height))
  )
  const now = Date.now()
  const projectId = generateId('proj')

  const existingProjects = await targetDb.projects.toArray()
  const minOrder =
    existingProjects.length > 0
      ? Math.min(...existingProjects.map((p) => p.order)) - 1
      : 0

  const safeLayers: LayerRuntime[] =
    payload.layers.length > 0
      ? payload.layers
      : [
          {
            id: generateId('layer'),
            name: 'Layer 1',
            visible: true,
            locked: false,
            opacity: 100,
            blendMode: 'normal',
            clipping: false,
            offsetX: 0,
            offsetY: 0,
            dataWidth: width,
            dataHeight: height,
            data: createPixelBuffer(width, height),
          },
        ]

  const normalizedPalette = normalizeProjectPalette({
    name: payload.palette.name || 'Imported Palette',
    colors:
      payload.palette.colors.length > 0
        ? payload.palette.colors.slice(0, MAX_OPAQUE_PALETTE_COLORS)
        : ['#000000', '#FFFFFF'],
    colorTable: payload.palette.colorTable,
    displayOrder: payload.palette.displayOrder,
    sourcePaletteId: payload.palette.sourcePaletteId,
    author: payload.palette.author,
    sourceUrl: payload.palette.sourceUrl,
  })

  const activeLayerId =
    payload.activeLayerId && safeLayers.some((l) => l.id === payload.activeLayerId)
      ? payload.activeLayerId
      : safeLayers[safeLayers.length - 1]!.id

  const initialProject: ProjectRecord = {
    id: projectId,
    name: payload.name.trim() || 'Imported',
    width,
    height,
    pixelFormat: 'indexed-v1',
    layers: safeLayers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: Boolean(l.locked),
      opacity: l.opacity,
      blendMode: l.blendMode,
      clipping: l.clipping,
      offsetX: l.offsetX,
      offsetY: l.offsetY,
      dataWidth: l.dataWidth,
      dataHeight: l.dataHeight,
    })),
    activeLayerId,
    palette: normalizedPalette,
    selectedColorIndex: 0,
    order: minOrder,
    createdAt: now,
    updatedAt: now,
  }

  await saveProjectFull(
    {
      project: initialProject,
      layers: safeLayers,
      timeline: payload.timeline
        ? {
            frames: payload.timeline.frames,
            cels: payload.timeline.cels,
            celBuffers: payload.timeline.celBuffers,
            activeFrameId:
              payload.timeline.activeFrameId ?? payload.timeline.frames[0]?.id ?? 'frame-1',
            defaultFrameDurationMs: payload.timeline.defaultFrameDurationMs,
            playbackDirection: payload.timeline.playbackDirection,
            loopPlayback: payload.timeline.loopPlayback,
          }
        : undefined,
      history: { undoStack: [], redoStack: [] },
    },
    targetDb
  )

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

  return (await targetDb.projects.get(projectId)) ?? initialProject
}

export async function resetAllAppData(targetDb: DotDotDatabase = db): Promise<void> {
  await targetDb.transaction(
    'rw',
    [
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.celBuffers,
      targetDb.palettes,
      targetDb.stamps,
      targetDb.histories,
      targetDb.migrationStates,
      targetDb.settings,
    ],
    async () => {
      await targetDb.projects.clear()
      await targetDb.layerPixels.clear()
      await targetDb.celBuffers.clear()
      await targetDb.palettes.clear()
      await targetDb.stamps.clear()
      await targetDb.histories.clear()
      await targetDb.migrationStates.clear()
      await targetDb.settings.clear()
    }
  )
  await initializeDatabase(targetDb)
}
