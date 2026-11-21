import React, { ViewTransition, useCallback, useEffect, useRef, useState } from 'react'
import type {
  LanguageCode,
  PaletteData,
  ThemeMode,
  UiSizePreset,
} from '../types'
import {
  DEFAULT_UI_SIZE_CONFIG,
  getStorageStatus,
  requestStoragePersistence,
  resetAllAppData,
  UI_SIZE_PRESETS,
  type StorageStatusInfo,
} from '../db/database'
import {
  applyValidatedEnvPack,
  exportEnvironmentPackZip,
  inspectAndValidateEnvPack,
  type ValidatedEnvPack,
} from '../db/envPack'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { ConfirmDialog } from '../components/common/Modal'
import { PixelIcon } from '../components/common/PixelIcon'
import { PixelCheckbox } from '../components/common/PixelCheckbox'
import { PaletteSheet } from '../components/editor/PaletteSheet'
import { VTButtonLink } from '../components/common/ViewTransitionNav'

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes)) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function SettingsPage() {
  const {
    settings,
    palettes,
    projects,
    updateSettings,
    updateUiSize,
    addLibraryPalette,
    updateLibraryPalette,
    duplicateLibraryPalette,
    removeLibraryPalette,
    reorderLibraryPalettes,
    reloadWorkspaceState,
    showToast,
  } = useApp()
  const { t } = useI18n()

  const [storageInfo, setStorageInfo] = useState<StorageStatusInfo>({
    usageBytes: null,
    quotaBytes: null,
    persisted: null,
    supported: false,
  })
  const [customLimitInput, setCustomLimitInput] = useState<number>(() =>
    typeof settings.historyLimit === 'number' ? settings.historyLimit : 100
  )

  const [editingPalette, setEditingPalette] = useState<PaletteData | null>(null)
  const [editingColorIdx, setEditingColorIdx] = useState(0)
  const [paletteToDelete, setPaletteToDelete] = useState<PaletteData | null>(null)
  const [dragPalId, setDragPalId] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingPack, setPendingPack] = useState<ValidatedEnvPack | null>(null)
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)

  const refreshStorage = useCallback(async () => {
    const info = await getStorageStatus()
    setStorageInfo(info)
  }, [])

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  useEffect(() => {
    if (typeof settings.historyLimit === 'number') {
      setCustomLimitInput(settings.historyLimit)
    }
  }, [settings.historyLimit])

  const handleRequestPersist = async () => {
    const res = await requestStoragePersistence()
    await refreshStorage()
    if (res.granted) {
      showToast(t('persistGrantedMsg'), 'success')
    } else {
      showToast(t('persistDeniedMsg'), 'warning')
    }
  }

  const handleExportEnvPack = async () => {
    const zipBytes = await exportEnvironmentPackZip()
    const blob = new Blob([zipBytes.slice().buffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const dateStr = new Date().toISOString().slice(0, 10)
    const a = document.createElement('a')
    a.href = url
    a.download = `dotdot-environment-pack-${dateStr}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    showToast(t('toastExportedZip'), 'success')
  }

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const validated = inspectAndValidateEnvPack(buf)
      setPendingPack(validated)
    } catch {
      showToast(t('importErrorMsg'), 'error')
    }
  }

  const handleConfirmImportPack = async () => {
    if (!pendingPack) return
    try {
      await applyValidatedEnvPack(pendingPack)
      setPendingPack(null)
      await reloadWorkspaceState()
      await refreshStorage()
      showToast(t('importSuccessMsg'), 'success')
    } catch {
      setPendingPack(null)
      showToast(t('importErrorMsg'), 'error')
    }
  }

  const handleResetAllData = async () => {
    await resetAllAppData()
    setConfirmResetOpen(false)
    await reloadWorkspaceState()
    await refreshStorage()
    showToast(t('resetSuccessMsg'), 'info')
  }

  const movePaletteOrder = async (id: string, delta: -1 | 1) => {
    const idx = palettes.findIndex((p) => p.id === id)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= palettes.length) return
    const ids = palettes.map((p) => p.id)
    const [moved] = ids.splice(idx, 1)
    ids.splice(target, 0, moved)
    await reorderLibraryPalettes(ids)
  }

  const applyUiPreset = (preset: Exclude<UiSizePreset, 'custom'>) => {
    void updateUiSize({ ...UI_SIZE_PRESETS[preset] })
  }

  const usageFormatted = formatBytes(storageInfo.usageBytes)
  const quotaFormatted = formatBytes(storageInfo.quotaBytes)
  const ui = settings.uiSize

  return (
    <ViewTransition>
      <div className="min-h-dvh w-full flex flex-col bg-[var(--bg-app)] pl-safe pr-safe">
        {/* Top Bar */}
        <header className="sticky top-0 z-20 px-3.5 py-2.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <VTButtonLink
              to="/"
              className="pixel-btn min-h-[44px] px-3 text-xs font-bold flex items-center gap-1.5"
              data-testid="settings-to-gallery-btn"
            >
              <PixelIcon name="back" size={16} />
              <span>{t('back')}</span>
            </VTButtonLink>
            <h1 className="text-base sm:text-lg font-bold tracking-wide">
              {t('settingsTitle')}
            </h1>
          </div>

          {settings.activeProjectId && projects.length > 0 && (
            <VTButtonLink
              to={`/editor/${settings.activeProjectId}`}
              className="pixel-btn pixel-btn-active min-h-[44px] px-3 text-xs font-bold flex items-center gap-1.5"
              data-testid="settings-to-editor-btn"
            >
              <PixelIcon name="pen" size={16} />
              <span>{t('navEditor')}</span>
            </VTButtonLink>
          )}
        </header>

        <main className="flex-1 max-w-3xl w-full mx-auto p-3.5 sm:p-4 pb-12 pb-safe space-y-5">
          {/* 1. Theme & Language */}
          <section className="pixel-card p-4 space-y-4">
            <SectionTitle icon="sparkle" title={t('sectionAppearance')} />

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--text-secondary)] block">
                {t('themeLabel')}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { id: 'light', label: t('themeLight') },
                    { id: 'dark', label: t('themeDark') },
                    { id: 'system', label: t('themeSystem') },
                  ] as Array<{ id: ThemeMode; label: string }>
                ).map((item) => {
                  const active = settings.theme === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => void updateSettings({ theme: item.id })}
                      aria-pressed={active}
                      className={`min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 ${
                        active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                      }`}
                      data-testid={`theme-btn-${item.id}`}
                    >
                      {active && <PixelIcon name="check" size={12} />}
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--text-secondary)] block">
                {t('languageLabel')}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { id: 'ja', label: t('langJa') },
                    { id: 'en', label: t('langEn') },
                    { id: 'ko', label: t('langKo') },
                  ] as Array<{ id: LanguageCode; label: string }>
                ).map((item) => {
                  const active = settings.language === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => void updateSettings({ language: item.id })}
                      aria-pressed={active}
                      className={`min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 ${
                        active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                      }`}
                      data-testid={`lang-btn-${item.id}`}
                    >
                      {active && <PixelIcon name="check" size={12} />}
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </section>

          {/* 2. Spec v2 Section 12: UI Size Customization (Presets + Individual Controls + Reset) */}
          <section className="pixel-card p-4 space-y-4" data-testid="ui-size-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle icon="resize" title={t('sectionUiSize')} />
              <button
                type="button"
                onClick={() => void updateUiSize({ ...DEFAULT_UI_SIZE_CONFIG })}
                className="pixel-btn min-h-[36px] px-2.5 text-xs font-bold"
                data-testid="ui-size-reset-btn"
              >
                {t('uiResetDefaults')}
              </button>
            </div>

            {/* Presets: Compact / Standard / Large */}
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'compact', label: t('uiPresetCompact') },
                  { id: 'standard', label: t('uiPresetStandard') },
                  { id: 'large', label: t('uiPresetLarge') },
                ] as const
              ).map((p) => {
                const active = ui.preset === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyUiPreset(p.id)}
                    aria-pressed={active}
                    className={`min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 ${
                      active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid={`ui-preset-${p.id}`}
                  >
                    {active && <PixelIcon name="check" size={12} />}
                    <span>{p.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Individual Sliders */}
            <div className="space-y-2.5 pt-1">
              <UiSliderRow
                label={t('uiOverallScale')}
                value={ui.overallScale}
                min={85}
                max={120}
                step={5}
                unit="%"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', overallScale: v })
                }
              />
              <UiSliderRow
                label={t('uiToolIconSize')}
                value={ui.toolIconSize}
                min={16}
                max={32}
                step={4}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', toolIconSize: v })
                }
              />
              <UiSliderRow
                label={t('uiToolButtonHeight')}
                value={ui.toolButtonHeight}
                min={44}
                max={64}
                step={2}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', toolButtonHeight: v })
                }
              />
              <UiSliderRow
                label={t('uiToolLabelSize')}
                value={ui.toolLabelSize}
                min={10}
                max={15}
                step={1}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', toolLabelSize: v })
                }
              />
              <UiSliderRow
                label={t('uiSwatchSize')}
                value={ui.swatchSize}
                min={28}
                max={48}
                step={2}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', swatchSize: v })
                }
              />
              <UiSliderRow
                label={t('uiCheckboxSize')}
                value={ui.checkboxSize}
                min={16}
                max={28}
                step={2}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', checkboxSize: v })
                }
              />
              <UiSliderRow
                label={t('uiGapSize')}
                value={ui.uiGap}
                min={4}
                max={12}
                step={2}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', uiGap: v })
                }
              />
              <UiSliderRow
                label={t('uiDrawButtonVh')}
                value={ui.drawButtonVh}
                min={10}
                max={20}
                step={1}
                unit="%"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', drawButtonVh: v })
                }
              />
            </div>
          </section>

          {/* 3. Editor Preferences & History Limit (PixelCheckbox everywhere) */}
          <section className="pixel-card p-4 space-y-3.5">
            <SectionTitle icon="settings" title={t('sectionEditorPrefs')} />

            <div className="space-y-2">
              <label className="text-xs font-bold text-[var(--text-secondary)] block">
                {t('historyLimitLabel')}
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void updateSettings({ historyLimit: 'unlimited' })}
                  className={`min-h-[38px] px-3 text-xs font-bold ${
                    settings.historyLimit === 'unlimited'
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                  data-testid="history-unlimited-btn"
                >
                  {t('historyUnlimited')}
                </button>
                {[30, 50, 100, 200].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => void updateSettings({ historyLimit: num })}
                    className={`min-h-[38px] px-3 text-xs font-bold ${
                      settings.historyLimit === num
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {num}
                  </button>
                ))}

                <div className="flex items-center gap-1.5 ml-auto">
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t('historyCustomCount')}:
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={2000}
                    value={customLimitInput}
                    onChange={(e) => {
                      const val = Math.max(1, Math.min(2000, Number(e.target.value) || 1))
                      setCustomLimitInput(val)
                      void updateSettings({ historyLimit: val })
                    }}
                    className="w-20 min-h-[36px] px-2 text-xs pixel-input"
                    data-testid="history-custom-input"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1 pt-1">
              <PixelCheckbox
                checked={settings.confirmDestructive}
                onChange={(v) => void updateSettings({ confirmDestructive: v })}
                label={t('confirmDestructiveLabel')}
              />
              <PixelCheckbox
                checked={settings.checkerboardDark}
                onChange={(v) => void updateSettings({ checkerboardDark: v })}
                label={t('checkerboardDarkLabel')}
              />
              <PixelCheckbox
                checked={settings.soundEnabled}
                onChange={(v) => void updateSettings({ soundEnabled: v })}
                label={t('soundEnabledLabel')}
              />
            </div>

            <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs">
              <span className="text-[var(--text-secondary)]">
                {t('autoSaveStatusLabel')}
              </span>
              <span className="font-bold text-[var(--accent-teal)]">
                {t('autoSaveActive')}
              </span>
            </div>
          </section>

          {/* 4. Palette Library Manager */}
          <section className="pixel-card p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle
                icon="palette"
                title={`${t('sectionPaletteLibrary')} (${palettes.length})`}
              />

              <button
                type="button"
                onClick={async () => {
                  const created = await addLibraryPalette(
                    `Palette ${palettes.length + 1}`,
                    ['#181521', '#F4F1EA', '#8476C4', '#579B91', '#C47388', '#E0A96D']
                  )
                  setEditingPalette(created)
                  setEditingColorIdx(0)
                }}
                className="pixel-btn pixel-btn-active min-h-[40px] px-3 text-xs font-bold flex items-center gap-1"
                data-testid="settings-add-palette-btn"
              >
                <PixelIcon name="plus" size={14} />
                <span>{t('newPalette')}</span>
              </button>
            </div>

            <div className="space-y-2">
              {palettes.map((pal, idx) => {
                const isLastRemaining = palettes.length <= 1
                return (
                  <div
                    key={pal.id}
                    draggable
                    onDragStart={() => setDragPalId(pal.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (!dragPalId || dragPalId === pal.id) return
                      const ids = palettes.map((p) => p.id)
                      const from = ids.indexOf(dragPalId)
                      const to = ids.indexOf(pal.id)
                      if (from < 0 || to < 0) return
                      ids.splice(from, 1)
                      ids.splice(to, 0, dragPalId)
                      setDragPalId(null)
                      void reorderLibraryPalettes(ids)
                    }}
                    className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex flex-wrap items-center justify-between gap-2"
                    data-testid={`lib-palette-${pal.id}`}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-xs font-bold truncate">
                        {pal.name}{' '}
                        <span className="font-normal text-[var(--text-secondary)]">
                          ({pal.colors.length})
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-0.5">
                        {pal.colors.slice(0, 16).map((hex, cIdx) => (
                          <span
                            key={cIdx}
                            style={{ backgroundColor: hex }}
                            className="w-3.5 h-3.5 border border-[var(--border-pixel)]"
                          />
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => void movePaletteOrder(pal.id, -1)}
                        className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                        title={t('moveUp')}
                      >
                        <PixelIcon name="arrowUp" size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={idx === palettes.length - 1}
                        onClick={() => void movePaletteOrder(pal.id, 1)}
                        className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                        title={t('moveDown')}
                      >
                        <PixelIcon name="arrowDown" size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingPalette(pal)
                          setEditingColorIdx(0)
                        }}
                        className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                        title={t('edit')}
                      >
                        <PixelIcon name="edit" size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void duplicateLibraryPalette(pal.id)}
                        className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                        title={t('duplicate')}
                      >
                        <PixelIcon name="copy" size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={isLastRemaining}
                        onClick={() => {
                          if (isLastRemaining) {
                            showToast(t('cannotDeleteLastPalette'), 'warning')
                            return
                          }
                          if (settings.confirmDestructive) {
                            setPaletteToDelete(pal)
                          } else {
                            void removeLibraryPalette(pal.id)
                          }
                        }}
                        className="pixel-btn pixel-btn-danger min-w-[36px] min-h-[36px] flex items-center justify-center"
                        title={
                          isLastRemaining ? t('cannotDeleteLastPalette') : t('delete')
                        }
                        data-testid={`del-lib-palette-${pal.id}`}
                      >
                        <PixelIcon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 5. Storage, Persistence & Offline PWA */}
          <section className="pixel-card p-4 space-y-3">
            <SectionTitle icon="storage" title={t('sectionStorage')} />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[var(--text-secondary)]">{t('storageUsage')}</div>
                <div className="text-sm font-bold mt-0.5">
                  {usageFormatted ?? t('storageUnavailable')}
                </div>
              </div>
              <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[var(--text-secondary)]">{t('storageQuota')}</div>
                <div className="text-sm font-bold mt-0.5">
                  {quotaFormatted ?? t('storageUnavailable')}
                </div>
              </div>
              <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[var(--text-secondary)]">
                  {t('persistenceStatus')}
                </div>
                <div className="text-xs font-bold mt-1 flex items-center gap-1">
                  {storageInfo.persisted && <PixelIcon name="check" size={12} />}
                  <span>
                    {storageInfo.persisted ? t('persistedYes') : t('persistedNo')}
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleRequestPersist()}
              className="pixel-btn min-h-[44px] px-4 text-xs font-bold flex items-center gap-2"
              data-testid="request-persist-btn"
            >
              <PixelIcon name="shield" size={16} />
              <span>{t('requestPersistBtn')}</span>
            </button>

            <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex items-start gap-2.5 text-xs">
              <PixelIcon
                name="pwa"
                size={18}
                className="text-[var(--accent-teal)] mt-0.5"
              />
              <div>
                <div className="font-bold">{t('pwaReadyLabel')}</div>
                <p className="text-[var(--text-secondary)] leading-relaxed mt-0.5">
                  {t('pwaReadyDesc')}
                </p>
              </div>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {t('backupRecommendation')}
            </p>
          </section>

          {/* 6. Environment Pack (ZIP Export / Import) */}
          <section className="pixel-card p-4 space-y-3">
            <SectionTitle icon="download" title={t('sectionEnvPack')} />

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {t('envPackDesc')}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => void handleExportEnvPack()}
                className="min-h-[48px] px-4 pixel-btn pixel-btn-active text-xs font-bold flex items-center justify-center gap-2"
                data-testid="export-envpack-btn"
              >
                <PixelIcon name="download" size={16} />
                <span>{t('exportEnvPackBtn')}</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[48px] px-4 pixel-btn text-xs font-bold flex items-center justify-center gap-2"
                data-testid="import-envpack-btn"
              >
                <PixelIcon name="upload" size={16} />
                <span>{t('importEnvPackBtn')}</span>
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => void handleFileChosen(e)}
                className="hidden"
                data-testid="envpack-file-input"
              />
            </div>
          </section>

          {/* 7. App Info & Factory Reset */}
          <section className="pixel-card p-4 space-y-3">
            <h2 className="text-sm font-bold">{t('sectionAppInfo')}</h2>
            <div className="text-xs space-y-1.5 text-[var(--text-secondary)]">
              <div className="flex justify-between">
                <span>{t('appVersionLabel')}</span>
                <span className="font-bold text-[var(--text-primary)]">2.0.0</span>
              </div>
              <div className="flex justify-between">
                <span>{t('storageEngineLabel')}</span>
                <span className="font-bold text-[var(--text-primary)]">
                  {t('storageEngineValue')}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setConfirmResetOpen(true)}
                className="min-h-[44px] px-4 pixel-btn pixel-btn-danger text-xs font-bold flex items-center gap-2"
                data-testid="reset-all-data-btn"
              >
                <PixelIcon name="trash" size={16} />
                <span>{t('resetAllDataBtn')}</span>
              </button>
            </div>
          </section>
        </main>

        {editingPalette && (
          <PaletteSheet
            open={true}
            onClose={() => setEditingPalette(null)}
            palette={{
              name: editingPalette.name,
              colors: editingPalette.colors,
              sourcePaletteId: editingPalette.id,
            }}
            selectedIndex={editingColorIdx}
            libraryPalettes={palettes}
            onSelectColor={setEditingColorIdx}
            onUpdatePalette={(next, nextIdx) => {
              const updated: PaletteData = {
                ...editingPalette,
                name: next.name,
                colors: next.colors,
              }
              setEditingPalette(updated)
              if (nextIdx !== undefined) setEditingColorIdx(nextIdx)
              void updateLibraryPalette(editingPalette.id, {
                name: next.name,
                colors: next.colors,
              })
            }}
            onSaveToLibrary={async (name, colors) => {
              await addLibraryPalette(name, colors)
              showToast(t('toastSavedPalette'), 'success')
            }}
          />
        )}

        <ConfirmDialog
          open={paletteToDelete !== null}
          title={t('delete')}
          message={t('deletePaletteConfirm')}
          confirmLabel={t('delete')}
          destructive
          onConfirm={async () => {
            if (paletteToDelete) {
              const ok = await removeLibraryPalette(paletteToDelete.id)
              if (!ok) {
                showToast(t('cannotDeleteLastPalette'), 'warning')
              }
            }
            setPaletteToDelete(null)
          }}
          onCancel={() => setPaletteToDelete(null)}
        />

        <ConfirmDialog
          open={pendingPack !== null}
          title={t('importConfirmTitle')}
          message={t('importConfirmBody')}
          confirmLabel={t('confirm')}
          destructive
          extraContent={
            pendingPack && (
              <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-xs space-y-1">
                <div className="flex justify-between">
                  <span>{t('importSummaryProjects')}</span>
                  <strong>{pendingPack.manifest.counts.projects}</strong>
                </div>
                <div className="flex justify-between">
                  <span>{t('importSummaryPalettes')}</span>
                  <strong>{pendingPack.manifest.counts.palettes}</strong>
                </div>
                <div className="flex justify-between">
                  <span>{t('importSummaryHistory')}</span>
                  <strong>{pendingPack.manifest.counts.totalHistoryEntries}</strong>
                </div>
              </div>
            )
          }
          onConfirm={() => void handleConfirmImportPack()}
          onCancel={() => setPendingPack(null)}
        />

        <ConfirmDialog
          open={confirmResetOpen}
          title={t('reset')}
          message={t('resetAllConfirm')}
          confirmLabel={t('delete')}
          destructive
          onConfirm={() => void handleResetAllData()}
          onCancel={() => setConfirmResetOpen(false)}
        />
      </div>
    </ViewTransition>
  )
}

function SectionTitle({
  icon,
  title,
}: {
  icon: Parameters<typeof PixelIcon>[0]['name']
  title: string
}) {
  return (
    <div className="flex items-center gap-2 text-sm font-bold">
      <PixelIcon name={icon} size={16} className="text-[var(--accent-primary)]" />
      <h2>{title}</h2>
    </div>
  )
}

function UiSliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (next: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-[var(--text-primary)] min-w-[130px]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 max-w-[180px] accent-[var(--accent-primary)]"
      />
      <span className="w-14 text-right text-xs font-bold shrink-0">
        {value}
        {unit}
      </span>
    </div>
  )
}
