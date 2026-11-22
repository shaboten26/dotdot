import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  AppSettings,
  CanvasSizePreset,
  PaletteData,
  ProjectRecord,
  UiSizeConfig,
} from '../types'
import {
  BACKUP_SNOOZE_INTERVAL_MS,
  DEFAULT_APP_SETTINGS,
  db,
  deleteLibraryPalette,
  generateId,
  hasCanvasPresetDimensions,
  initializeDatabase,
  normalizeAppSettings,
  shouldShowBackupReminder,
} from '../db/database'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../engine/pixelBuffer'
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
  reducedMotion: boolean
  palettes: PaletteData[]
  projects: ProjectRecord[]
  toasts: ToastMessage[]
  backupReminderDue: boolean
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
  refreshProjects: () => Promise<void>
  refreshPalettes: () => Promise<void>
  addLibraryPalette: (name: string, colors: string[]) => Promise<PaletteData>
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
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [backupCheckTick, setBackupCheckTick] = useState<number>(() => Date.now())

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

  // Re-evaluate backup reminder upon window focus or visibility return (Section 11-2)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const checkNow = () => {
      if (document.visibilityState === 'visible') {
        setBackupCheckTick(Date.now())
      }
    }
    window.addEventListener('focus', checkNow)
    document.addEventListener('visibilitychange', checkNow)
    return () => {
      window.removeEventListener('focus', checkNow)
      document.removeEventListener('visibilitychange', checkNow)
    }
  }, [])

  const isDark =
    settings.theme === 'dark' || (settings.theme === 'system' && systemDark)

  // Apply theme class, language attribute, theme-color meta (matches top header --bg-surface), and UI Size CSS variables
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    root.classList.toggle('dark', isDark)
    root.style.colorScheme = isDark ? 'dark' : 'light'
    root.lang = settings.language

    const metaTheme = document.querySelector('meta[name="theme-color"]')
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#221e2e' : '#f4f1ea')
    }

    const u = settings.uiSize
    root.style.setProperty('--ui-scale', String((u.overallScale || 100) / 100))
    root.style.setProperty('--tool-icon-size', `${u.toolIconSize}px`)
    root.style.setProperty('--tool-btn-height', `${u.toolButtonHeight}px`)
    root.style.setProperty('--tool-label-size', `${u.toolLabelSize}px`)
    root.style.setProperty('--swatch-size', `${u.swatchSize}px`)
    root.style.setProperty('--checkbox-size', `${u.checkboxSize}px`)
    root.style.setProperty('--ui-gap', `${u.uiGap}px`)
    root.style.setProperty('--draw-btn-vh', `${u.drawButtonVh}dvh`)
  }, [isDark, settings.language, settings.uiSize])

  const refreshPalettes = useCallback(async () => {
    const list = await db.palettes.orderBy('order').toArray()
    setPalettes(list)
  }, [])

  const refreshProjects = useCallback(async () => {
    const list = await db.projects.orderBy('order').toArray()
    setProjects(list)
    // Also sync settings if firstProjectCreatedAt was set by createNewProject
    const latestSettings = await db.settings.get('app-settings')
    if (latestSettings) {
      setSettings(normalizeAppSettings(latestSettings))
    }
    setBackupCheckTick(Date.now())
  }, [])

  const reloadWorkspaceState = useCallback(async () => {
    const init = await initializeDatabase(db)
    setSettings(init.settings)
    setPalettes(init.palettes)
    const projs = await db.projects.orderBy('order').toArray()
    setProjects(projs)
    setBackupCheckTick(Date.now())
    setReady(true)
  }, [])

  useEffect(() => {
    void reloadWorkspaceState()
  }, [reloadWorkspaceState])

  const showToast = useCallback(
    (text: string, type: ToastMessage['type'] = 'info') => {
      const id = generateId('toast')
      setToasts((prev) => [...prev.slice(-3), { id, text, type }])
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id))
      }, 2800)
    },
    []
  )

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const stored = await db.settings.get('app-settings')
    const base = normalizeAppSettings(stored)
    const next = normalizeAppSettings({ ...base, ...patch, id: 'app-settings' })
    await db.settings.put(next)
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

  /**
   * Section 11: Update `lastExportAt` ONLY when an Environment Pack ZIP has been successfully generated.
   */
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

  /**
   * Section 11: "後で通知 / Remind Later" schedules next notification 7 days from `now`.
   */
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
    setSettings(next)
    setBackupCheckTick(Date.now())
  }, [])

  const backupReminderDue = useMemo(() => {
    if (!ready || projects.length === 0) return false
    return shouldShowBackupReminder(settings.backupMeta, backupCheckTick)
  }, [ready, projects.length, settings.backupMeta, backupCheckTick])

  const addLibraryPalette = useCallback(
    async (name: string, colors: string[]): Promise<PaletteData> => {
      const now = Date.now()
      const current = await db.palettes.orderBy('order').toArray()
      const nextOrder =
        current.length > 0 ? Math.max(...current.map((p) => p.order)) + 1 : 0
      const record: PaletteData = {
        id: generateId('pal'),
        name: name.trim() || 'Palette',
        colors: colors.length > 0 ? colors.slice(0, 256) : ['#000000', '#FFFFFF'],
        order: nextOrder,
        createdAt: now,
        updatedAt: now,
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
          ? { colors: patch.colors.slice(0, 256) }
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
          await db.palettes.update(orderedIds[i], { order: i })
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
          await db.projects.update(orderedIds[i], { order: i })
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
      reducedMotion,
      palettes,
      projects,
      toasts,
      backupReminderDue,
      updateSettings,
      updateUiSize,
      addCustomCanvasPreset,
      updateCustomCanvasPreset,
      deleteCustomCanvasPreset,
      reorderCustomCanvasPresets,
      markEnvPackExported,
      snoozeBackupReminder,
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
      reducedMotion,
      palettes,
      projects,
      toasts,
      backupReminderDue,
      updateSettings,
      updateUiSize,
      addCustomCanvasPreset,
      updateCustomCanvasPreset,
      deleteCustomCanvasPreset,
      reorderCustomCanvasPresets,
      markEnvPackExported,
      snoozeBackupReminder,
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
    <AppContext.Provider value={appValue}>
      <I18nContext.Provider value={i18nValue}>{children}</I18nContext.Provider>
    </AppContext.Provider>
  )
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
