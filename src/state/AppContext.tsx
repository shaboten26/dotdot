import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  MAX_OPAQUE_PALETTE_COLORS,
  type AppSettings,
  type CanvasSizePreset,
  type ClipboardBuffer,
  type PaletteData,
  type ProjectRecord,
  type UiSizeConfig,
} from '../types'
import {
  BACKUP_SNOOZE_INTERVAL_MS,
  DEFAULT_APP_SETTINGS,
  db,
  deleteLibraryPalette,
  evaluateOriginLowStorage,
  generateId,
  getStorageStatus,
  hasCanvasPresetDimensions,
  initializeDatabase,
  LOW_STORAGE_SNOOZE_INTERVAL_MS,
  normalizeAppSettings,
  shouldShowBackupReminder,
  type OriginLowStorageStatus,
} from '../db/database'
import type {
  DatabaseMigrationSummary,
  MigrationProgressInfo,
} from '../db/indexedMigration'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../engine/pixelBuffer'
import { resolveActiveThemeTokens } from '../theme/themes'
import { I18nContext } from '../i18n/I18nContext'
import { translate, type TranslationKey } from '../i18n/translations'

export interface ToastMessage {
  id: string
  text: string
  type: 'info' | 'success' | 'warning' | 'error'
}

export interface AppContextValue {
  ready: boolean
  settings: AppSettings
  isDark: boolean
  activeThemeVariant: string
  reducedMotion: boolean
  palettes: PaletteData[]
  projects: ProjectRecord[]
  migrationProgress: MigrationProgressInfo | null
  migrationSummary: DatabaseMigrationSummary | null
  sharedClipboard: ClipboardBuffer | null
  setSharedClipboard: (clip: ClipboardBuffer | null) => void
  toasts: ToastMessage[]
  backupReminderDue: boolean
  originStorageStatus: OriginLowStorageStatus
  lowStorageWarningDue: boolean
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  updateUiSize: (patch: Partial<UiSizeConfig>) => Promise<void>
  addCustomCanvasPreset: (
    name: string,
    width: number,
    height: number
  ) => Promise<CanvasSizePreset | null>
  updateCustomCanvasPreset: (
    id: string,
    patch: Partial<Pick<CanvasSizePreset, 'name' | 'width' | 'height'>>
  ) => Promise<boolean>
  deleteCustomCanvasPreset: (id: string) => Promise<void>
  reorderCustomCanvasPresets: (orderedIds: string[]) => Promise<void>
  markEnvPackExported: (exportedAt?: number) => Promise<void>
  snoozeBackupReminder: (now?: number) => Promise<void>
  snoozeLowStorageWarning: (now?: number) => Promise<void>
  refreshOriginStorage: () => Promise<OriginLowStorageStatus>
  refreshProjects: () => Promise<void>
  refreshPalettes: () => Promise<void>
  addLibraryPalette: (
    name: string,
    colors: string[],
    meta?: Partial<Pick<PaletteData, 'author' | 'sourceUrl' | 'lospecSlug' | 'licenseNote'>>
  ) => Promise<PaletteData>
  updateLibraryPalette: (
    id: string,
    patch: Partial<Pick<PaletteData, 'name' | 'colors'>>
  ) => Promise<void>
  duplicateLibraryPalette: (id: string) => Promise<void>
  removeLibraryPalette: (id: string) => Promise<boolean>
  reorderLibraryPalettes: (orderedIds: string[]) => Promise<void>
  reorderProjectsManual: (orderedIds: string[]) => Promise<void>
  showToast: (text: string, type?: ToastMessage['type']) => void
  dismissToast: (id: string) => void
  reloadWorkspaceState: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [palettes, setPalettes] = useState<PaletteData[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [migrationProgress, setMigrationProgress] =
    useState<MigrationProgressInfo | null>(null)
  const [migrationSummary, setMigrationSummary] =
    useState<DatabaseMigrationSummary | null>(null)
  const [sharedClipboardState, setSharedClipboardState] =
    useState<ClipboardBuffer | null>(null)

  const setSharedClipboard = useCallback((clip: ClipboardBuffer | null) => {
    if (!clip) {
      setSharedClipboardState(null)
      return
    }
    setSharedClipboardState({
      width: clip.width,
      height: clip.height,
      offsetX: clip.offsetX,
      offsetY: clip.offsetY,
      data: new Uint8Array(clip.data),
      ...(clip.sourceColorMap ? { sourceColorMap: { ...clip.sourceColorMap } } : {}),
    })
  }, [])

  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [backupCheckTick, setBackupCheckTick] = useState<number>(() => Date.now())
  const [originStorageStatus, setOriginStorageStatus] = useState<OriginLowStorageStatus>(() =>
    evaluateOriginLowStorage(null, null)
  )
  const mountedRef = useRef<boolean>(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const darkMq = window.matchMedia('(prefers-color-scheme: dark)')
    const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)')

    const onDarkChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    const onMotionChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)

    darkMq.addEventListener('change', onDarkChange)
    motionMq.addEventListener('change', onMotionChange)
    return () => {
      darkMq.removeEventListener('change', onDarkChange)
      motionMq.removeEventListener('change', onMotionChange)
    }
  }, [])

  const refreshOriginStorage = useCallback(async (): Promise<OriginLowStorageStatus> => {
    const info = await getStorageStatus()
    const status = evaluateOriginLowStorage(info.usageBytes, info.quotaBytes)
    if (mountedRef.current) {
      setOriginStorageStatus(status)
    }
    return status
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const checkNow = () => {
      if (document.visibilityState === 'visible') {
        setBackupCheckTick(Date.now())
        void refreshOriginStorage()
      }
    }
    window.addEventListener('focus', checkNow)
    document.addEventListener('visibilitychange', checkNow)
    return () => {
      window.removeEventListener('focus', checkNow)
      document.removeEventListener('visibilitychange', checkNow)
    }
  }, [refreshOriginStorage])

  const isDark =
    settings.theme === 'dark' || (settings.theme === 'system' && systemDark)

  const activeThemeVariant = isDark
    ? settings.darkThemeVariant ?? 'dusk-plum'
    : settings.lightThemeVariant ?? 'lavender-cream'

  // Apply theme class, active sub-theme CSS tokens, language attribute, theme-color meta, and UI Size CSS variables
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.toggle('dark', isDark)
    root.setAttribute('data-theme-variant', activeThemeVariant)
    root.style.colorScheme = isDark ? 'dark' : 'light'
    root.lang = settings.language

    const tokens = resolveActiveThemeTokens(
      isDark,
      settings.lightThemeVariant ?? 'lavender-cream',
      settings.darkThemeVariant ?? 'dusk-plum'
    )
    for (const [varName, hexVal] of Object.entries(tokens)) {
      root.style.setProperty(varName, hexVal)
    }

    const metaThemes = document.querySelectorAll('meta[name="theme-color"]')
    const headerHex = tokens['--bg-surface']
    metaThemes.forEach((meta) => {
      meta.setAttribute('content', headerHex)
    })

    const u = settings.uiSize
    root.style.setProperty('--ui-scale', String((u.overallScale || 100) / 100))
    root.style.setProperty('--tool-icon-size', `${u.toolIconSize}px`)
    root.style.setProperty('--tool-btn-height', `${u.toolButtonHeight}px`)
    root.style.setProperty('--tool-label-size', `${u.toolLabelSize}px`)
    root.style.setProperty('--swatch-size', `${u.swatchSize}px`)
    root.style.setProperty('--checkbox-size', `${u.checkboxSize}px`)
    root.style.setProperty('--ui-gap', `${u.uiGap}px`)
    root.style.setProperty('--draw-btn-vh', `${u.drawButtonVh}dvh`)
  }, [
    isDark,
    activeThemeVariant,
    settings.lightThemeVariant,
    settings.darkThemeVariant,
    settings.language,
    settings.uiSize,
  ])

  const refreshPalettes = useCallback(async () => {
    const list = await db.palettes.orderBy('order').toArray()
    if (!mountedRef.current) return
    setPalettes(list)
  }, [])

  const refreshProjects = useCallback(async () => {
    const list = await db.projects.orderBy('order').toArray()
    if (!mountedRef.current) return
    setProjects(list)
    const latestSettings = await db.settings.get('app-settings')
    if (!mountedRef.current) return
    if (latestSettings) {
      setSettings(normalizeAppSettings(latestSettings))
    }
    setBackupCheckTick(Date.now())
    void refreshOriginStorage()
  }, [refreshOriginStorage])

  const reloadWorkspaceState = useCallback(async () => {
    const init = await initializeDatabase(db, {
      onMigrationProgress: (info) => {
        if (mountedRef.current) {
          setMigrationProgress(info)
        }
      },
      yieldBetweenProjects: true,
    })
    if (!mountedRef.current) return
    setMigrationProgress(null)
    setMigrationSummary(init.migrationSummary)
    setSettings(init.settings)
    setPalettes(init.palettes)
    const projs = await db.projects.orderBy('order').toArray()
    if (!mountedRef.current) return
    setProjects(projs)
    setBackupCheckTick(Date.now())
    void refreshOriginStorage()
    setReady(true)
  }, [refreshOriginStorage])

  useEffect(() => {
    void reloadWorkspaceState()
  }, [reloadWorkspaceState])

  const showToast = useCallback(
    (text: string, type: ToastMessage['type'] = 'info') => {
      const id = generateId('toast')
      setToasts((prev) => [...prev.slice(-3), { id, text, type }])
      window.setTimeout(() => {
        if (!mountedRef.current) return
        setToasts((prev) => prev.filter((item) => item.id !== id))
      }, 2800)
    },
    []
  )

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((prev) => normalizeAppSettings({ ...prev, ...patch, id: 'app-settings' }))
    const stored = await db.settings.get('app-settings')
    const base = normalizeAppSettings(stored)
    const next = normalizeAppSettings({ ...base, ...patch, id: 'app-settings' })
    await db.settings.put(next)
    if (!mountedRef.current) return
    setSettings(next)
  }, [])

  const updateUiSize = useCallback(async (patch: Partial<UiSizeConfig>) => {
    setSettings((prev) => {
      const nextUi: UiSizeConfig = {
        ...prev.uiSize,
        ...patch,
      }
      const next = normalizeAppSettings({
        ...prev,
        uiSize: nextUi,
        id: 'app-settings',
      })
      void db.settings.put(next)
      return next
    })
  }, [])

  const addCustomCanvasPreset = useCallback(
    async (name: string, width: number, height: number): Promise<CanvasSizePreset | null> => {
      const clampedW = Math.max(
        MIN_CANVAS_SIZE,
        Math.min(MAX_CANVAS_SIZE, Math.round(width || 32))
      )
      const clampedH = Math.max(
        MIN_CANVAS_SIZE,
        Math.min(MAX_CANVAS_SIZE, Math.round(height || 32))
      )
      const stored = normalizeAppSettings(await db.settings.get('app-settings'))
      if (hasCanvasPresetDimensions(stored.customCanvasPresets, clampedW, clampedH)) {
        return null
      }
      const created: CanvasSizePreset = {
        id: generateId('size'),
        name: name.trim() || `${clampedW} × ${clampedH}`,
        width: clampedW,
        height: clampedH,
        builtIn: false,
      }
      const next = normalizeAppSettings({
        ...stored,
        customCanvasPresets: [...stored.customCanvasPresets, created],
        id: 'app-settings',
      })
      await db.settings.put(next)
      setSettings(next)
      return created
    },
    []
  )

  const updateCustomCanvasPreset = useCallback(
    async (
      id: string,
      patch: Partial<Pick<CanvasSizePreset, 'name' | 'width' | 'height'>>
    ): Promise<boolean> => {
      const stored = normalizeAppSettings(await db.settings.get('app-settings'))
      const target = stored.customCanvasPresets.find((p) => p.id === id)
      if (!target) return false
      const nextW =
        patch.width !== undefined
          ? Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(patch.width)))
          : target.width
      const nextH =
        patch.height !== undefined
          ? Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(patch.height)))
          : target.height
      if (hasCanvasPresetDimensions(stored.customCanvasPresets, nextW, nextH, id)) {
        return false
      }
      const nextName =
        patch.name !== undefined
          ? patch.name.trim() || `${nextW} × ${nextH}`
          : target.name

      const nextPresets = stored.customCanvasPresets.map((item) =>
        item.id === id ? { ...item, name: nextName, width: nextW, height: nextH } : item
      )
      const next = normalizeAppSettings({
        ...stored,
        customCanvasPresets: nextPresets,
        id: 'app-settings',
      })
      await db.settings.put(next)
      setSettings(next)
      return true
    },
    []
  )

  const deleteCustomCanvasPreset = useCallback(async (id: string) => {
    const stored = normalizeAppSettings(await db.settings.get('app-settings'))
    const next = normalizeAppSettings({
      ...stored,
      customCanvasPresets: stored.customCanvasPresets.filter((p) => p.id !== id),
      id: 'app-settings',
    })
    await db.settings.put(next)
    setSettings(next)
  }, [])

  const reorderCustomCanvasPresets = useCallback(async (orderedIds: string[]) => {
    const stored = normalizeAppSettings(await db.settings.get('app-settings'))
    const map = new Map(stored.customCanvasPresets.map((p) => [p.id, p]))
    const ordered: CanvasSizePreset[] = []
    for (const id of orderedIds) {
      const item = map.get(id)
      if (item) ordered.push(item)
    }
    if (ordered.length !== stored.customCanvasPresets.length) return
    const next = normalizeAppSettings({
      ...stored,
      customCanvasPresets: ordered,
      id: 'app-settings',
    })
    await db.settings.put(next)
    setSettings(next)
  }, [])

  const markEnvPackExported = useCallback(async (exportedAt = Date.now()) => {
    const stored = normalizeAppSettings(await db.settings.get('app-settings'))
    const next = normalizeAppSettings({
      ...stored,
      backupMeta: {
        ...stored.backupMeta,
        lastExportAt: exportedAt,
        nextNotifyAt: null,
      },
      id: 'app-settings',
    })
    await db.settings.put(next)
    setSettings(next)
    setBackupCheckTick(Date.now())
  }, [])

  const snoozeBackupReminder = useCallback(async (now = Date.now()) => {
    const stored = normalizeAppSettings(await db.settings.get('app-settings'))
    const next = normalizeAppSettings({
      ...stored,
      backupMeta: {
        ...stored.backupMeta,
        lastNotifiedAt: now,
        nextNotifyAt: now + BACKUP_SNOOZE_INTERVAL_MS,
      },
      id: 'app-settings',
    })
    await db.settings.put(next)
    if (!mountedRef.current) return
    setSettings(next)
    setBackupCheckTick(Date.now())
  }, [])

  const snoozeLowStorageWarning = useCallback(async (now = Date.now()) => {
    const stored = normalizeAppSettings(await db.settings.get('app-settings'))
    const next = normalizeAppSettings({
      ...stored,
      lowStorageSnoozedUntil: now + LOW_STORAGE_SNOOZE_INTERVAL_MS,
      id: 'app-settings',
    })
    await db.settings.put(next)
    if (!mountedRef.current) return
    setSettings(next)
    setBackupCheckTick(Date.now())
  }, [])

  const backupReminderDue = useMemo(() => {
    if (!ready || projects.length === 0) return false
    return shouldShowBackupReminder(settings.backupMeta, backupCheckTick)
  }, [ready, projects.length, settings.backupMeta, backupCheckTick])

  const lowStorageWarningDue = useMemo(() => {
    if (!ready || originStorageStatus.level === 'ok') return false
    if (
      typeof settings.lowStorageSnoozedUntil === 'number' &&
      backupCheckTick < settings.lowStorageSnoozedUntil
    ) {
      return false
    }
    return true
  }, [ready, originStorageStatus.level, settings.lowStorageSnoozedUntil, backupCheckTick])

  const addLibraryPalette = useCallback(
    async (
      name: string,
      colors: string[],
      meta?: Partial<Pick<PaletteData, 'author' | 'sourceUrl' | 'lospecSlug' | 'licenseNote'>>
    ): Promise<PaletteData> => {
      const now = Date.now()
      const current = await db.palettes.orderBy('order').toArray()
      const nextOrder =
        current.length > 0 ? Math.max(...current.map((p) => p.order)) + 1 : 0
      const record: PaletteData = {
        id: generateId('pal'),
        name: name.trim() || 'Palette',
        colors:
          colors.length > 0
            ? colors.slice(0, MAX_OPAQUE_PALETTE_COLORS)
            : ['#000000', '#FFFFFF'],
        order: nextOrder,
        createdAt: now,
        updatedAt: now,
        ...(meta?.author ? { author: meta.author } : {}),
        ...(meta?.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        ...(meta?.lospecSlug ? { lospecSlug: meta.lospecSlug } : {}),
        ...(meta?.licenseNote ? { licenseNote: meta.licenseNote } : {}),
      }
      await db.palettes.put(record)
      await refreshPalettes()
      return record
    },
    [refreshPalettes]
  )

  const updateLibraryPalette = useCallback(
    async (id: string, patch: Partial<Pick<PaletteData, 'name' | 'colors'>>) => {
      const existing = await db.palettes.get(id)
      if (!existing) return
      const updated: PaletteData = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.colors !== undefined
          ? { colors: patch.colors.slice(0, MAX_OPAQUE_PALETTE_COLORS) }
          : {}),
        updatedAt: Date.now(),
      }
      if (updated.colors.length === 0) updated.colors = ['#000000']
      await db.palettes.put(updated)
      await refreshPalettes()
    },
    [refreshPalettes]
  )

  const duplicateLibraryPalette = useCallback(
    async (id: string) => {
      const existing = await db.palettes.get(id)
      if (!existing) return
      await addLibraryPalette(`${existing.name} Copy`, [...existing.colors])
    },
    [addLibraryPalette]
  )

  const removeLibraryPalette = useCallback(
    async (id: string): Promise<boolean> => {
      const ok = await deleteLibraryPalette(id, db)
      if (ok) {
        await refreshPalettes()
      }
      return ok
    },
    [refreshPalettes]
  )

  const reorderLibraryPalettes = useCallback(
    async (orderedIds: string[]) => {
      await db.transaction('rw', db.palettes, async () => {
        for (let i = 0; i < orderedIds.length; i++) {
          await db.palettes.update(orderedIds[i]!, { order: i })
        }
      })
      await refreshPalettes()
    },
    [refreshPalettes]
  )

  const reorderProjectsManual = useCallback(
    async (orderedIds: string[]) => {
      await db.transaction('rw', db.projects, async () => {
        for (let i = 0; i < orderedIds.length; i++) {
          await db.projects.update(orderedIds[i]!, { order: i })
        }
      })
      await refreshProjects()
    },
    [refreshProjects]
  )

  const t = useCallback(
    (key: TranslationKey) => translate(settings.language, key),
    [settings.language]
  )

  const i18nValue = useMemo(
    () => ({ language: settings.language, t }),
    [settings.language, t]
  )

  const appValue: AppContextValue = useMemo(
    () => ({
      ready,
      settings,
      isDark,
      activeThemeVariant,
      reducedMotion,
      palettes,
      projects,
      migrationProgress,
      migrationSummary,
      sharedClipboard: sharedClipboardState,
      setSharedClipboard,
      toasts,
      backupReminderDue,
      originStorageStatus,
      lowStorageWarningDue,
      updateSettings,
      updateUiSize,
      addCustomCanvasPreset,
      updateCustomCanvasPreset,
      deleteCustomCanvasPreset,
      reorderCustomCanvasPresets,
      markEnvPackExported,
      snoozeBackupReminder,
      snoozeLowStorageWarning,
      refreshOriginStorage,
      refreshProjects,
      refreshPalettes,
      addLibraryPalette,
      updateLibraryPalette,
      duplicateLibraryPalette,
      removeLibraryPalette,
      reorderLibraryPalettes,
      reorderProjectsManual,
      showToast,
      dismissToast,
      reloadWorkspaceState,
    }),
    [
      ready,
      settings,
      isDark,
      activeThemeVariant,
      reducedMotion,
      palettes,
      projects,
      migrationProgress,
      migrationSummary,
      sharedClipboardState,
      setSharedClipboard,
      toasts,
      backupReminderDue,
      originStorageStatus,
      lowStorageWarningDue,
      updateSettings,
      updateUiSize,
      addCustomCanvasPreset,
      updateCustomCanvasPreset,
      deleteCustomCanvasPreset,
      reorderCustomCanvasPresets,
      markEnvPackExported,
      snoozeBackupReminder,
      snoozeLowStorageWarning,
      refreshOriginStorage,
      refreshProjects,
      refreshPalettes,
      addLibraryPalette,
      updateLibraryPalette,
      duplicateLibraryPalette,
      removeLibraryPalette,
      reorderLibraryPalettes,
      reorderProjectsManual,
      showToast,
      dismissToast,
      reloadWorkspaceState,
    ]
  )

  return (
    <I18nContext.Provider value={i18nValue}>
      <AppContext.Provider value={appValue}>{children}</AppContext.Provider>
    </I18nContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error('useApp must be used inside <AppProvider>')
  }
  return ctx
}
