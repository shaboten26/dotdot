import React, { ViewTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type {
  CursorDisplaySize,
  DarkThemeVariantId,
  LanguageCode,
  LightThemeVariantId,
  PaletteData,
  ProjectRecord,
  SeamlessWrapMode,
  SymmetryMode,
  ThemeMode,
  TilePreviewGrid,
  UiSizePreset,
} from '../types'
import {
  DEFAULT_UI_SIZE_CONFIG,
  getStorageStatus,
  MAX_CURSOR_SPEED,
  MIN_CURSOR_SPEED,
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
import {
  DARK_THEME_VARIANTS,
  LIGHT_THEME_VARIANTS,
} from '../theme/themes'
import { normalizeProjectPalette } from '../engine/indexedPalette'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { LANGUAGE_OPTIONS } from '../i18n/extraLocales'
import { ConfirmDialog, Modal } from '../components/common/Modal'
import {
  DotDotAppIcon,
  DotDotWordmark,
} from '../components/common/DotDotBrand'
import { PixelIcon } from '../components/common/PixelIcon'
import { PixelCheckbox } from '../components/common/PixelCheckbox'
import { PixelSelect } from '../components/common/PixelSelect'
import { PixelSlider } from '../components/common/PixelSlider'
import { PixelThumbnail } from '../components/common/PixelThumbnail'
import { PaletteSheet } from '../components/editor/PaletteSheet'
import { LospecImportModal } from '../components/common/LospecImportModal'
import {
  LegalDocsModal,
  type LegalDocTab,
} from '../components/common/LegalDocsModal'
import { useLongPressReorder } from '../utils/useLongPressReorder'
import { VTButtonLink } from '../components/common/ViewTransitionNav'

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes)) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const LIGHT_VARIANT_LABEL_KEYS: Record<LightThemeVariantId, TranslationKey> = {
  'lavender-cream': 'themeVarLavenderCream',
  'peach-cotton': 'themeVarPeachCotton',
  'mint-pocket': 'themeVarMintPocket',
  'antique-brass': 'themeVarAntiqueBrass',
  'urban-concrete': 'themeVarUrbanConcrete',
  'retro-kissaten': 'themeVarRetroKissaten',
}

const DARK_VARIANT_LABEL_KEYS: Record<DarkThemeVariantId, TranslationKey> = {
  'dusk-plum': 'themeVarDuskPlum',
  'royal-velvet': 'themeVarRoyalVelvet',
  'tokyo-neon': 'themeVarTokyoNeon',
  'urban-graphite': 'themeVarUrbanGraphite',
  'forest-apothecary': 'themeVarForestApothecary',
  'amber-crt': 'themeVarAmberCrt',
}

export function SettingsPage() {
  const {
    settings,
    reducedMotion,
    palettes,
    projects,
    originStorageStatus,
    migrationSummary,
    updateSettings,
    updateUiSize,
    addLibraryPalette,
    updateLibraryPalette,
    duplicateLibraryPalette,
    removeLibraryPalette,
    reorderLibraryPalettes,
    reloadWorkspaceState,
    markEnvPackExported,
    showToast,
  } = useApp()
  const { t, language } = useI18n()

  const [storageInfo, setStorageInfo] = useState<StorageStatusInfo>({
    usageBytes: null,
    quotaBytes: null,
    persisted: null,
    supported: false,
  })
  const [customLimitInput, setCustomLimitInput] = useState<number>(() =>
    typeof settings.historyLimit === 'number' ? settings.historyLimit : 100
  )
  const [previewChecked, setPreviewChecked] = useState(true)
  const [themeDetailsOpen, setThemeDetailsOpen] = useState(false)

  const [editingPalette, setEditingPalette] = useState<PaletteData | null>(null)
  const [editingColorIdx, setEditingColorIdx] = useState(0)
  const [paletteToDelete, setPaletteToDelete] = useState<PaletteData | null>(null)
  const paletteListRef = useRef<HTMLDivElement | null>(null)
  const paletteIds = palettes.map((p) => p.id)
  const { dragState: palDragState, getItemProps: getPalItemProps } =
    useLongPressReorder({
      ids: paletteIds,
      enabled: palettes.length > 1,
      axis: 'vertical',
      scopeId: 'settings-palettes',
      scrollContainerRef: paletteListRef,
      onReorder: (nextIds) => {
        void reorderLibraryPalettes(nextIds)
      },
    })

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingPack, setPendingPack] = useState<ValidatedEnvPack | null>(null)
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)
  const [lospecLibOpen, setLospecLibOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [legalTab, setLegalTab] = useState<LegalDocTab | null>(null)
  const [compareProject, setCompareProject] = useState<ProjectRecord | null>(null)

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

  const quantizedProjects = useMemo(
    () =>
      projects.filter(
        (p) =>
          p.migrationReport?.wasQuantized ||
          p.migrationReport?.hadSemiTransparentPixels
      ),
    [projects]
  )

  const formatDateTime = (ms: number | null) => {
    if (!ms) return t('neverExportedLabel')
    try {
      return new Intl.DateTimeFormat(
        language === 'ja' ? 'ja-JP' : language === 'ko' ? 'ko-KR' : 'en-US',
        {
          dateStyle: 'medium',
          timeStyle: 'short',
        }
      ).format(new Date(ms))
    } catch {
      return new Date(ms).toLocaleString()
    }
  }

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
    await markEnvPackExported()
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
  const activeLightVariant = settings.lightThemeVariant ?? 'lavender-cream'
  const activeDarkVariant = settings.darkThemeVariant ?? 'dusk-plum'

  return (
    <ViewTransition>
      <div className="min-h-dvh w-full max-w-[100vw] overflow-x-hidden flex flex-col bg-[var(--bg-app)] pl-safe pr-safe">
        {/* Top Bar */}
        <header className="sticky top-0 z-20 px-3 sm:px-3.5 py-2.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <VTButtonLink
              to="/"
              className="pixel-btn min-h-[44px] px-2.5 sm:px-3 text-xs font-bold flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0"
              data-testid="settings-to-gallery-btn"
            >
              <PixelIcon name="back" size={16} />
              <span className="whitespace-nowrap">{t('back')}</span>
            </VTButtonLink>
            <h1 className="text-sm sm:text-lg font-bold tracking-wide truncate min-w-0">
              {t('settingsTitle')}
            </h1>
          </div>

          {settings.activeProjectId && projects.length > 0 && (
            <VTButtonLink
              to={`/editor/${settings.activeProjectId}`}
              className="pixel-btn pixel-btn-active min-h-[44px] px-2.5 sm:px-3 text-xs font-bold flex items-center gap-1 sm:gap-1.5 whitespace-nowrap shrink-0"
              data-testid="settings-to-editor-btn"
            >
              <PixelIcon name="pen" size={15} />
              <span className="whitespace-nowrap">{t('navEditor')}</span>
            </VTButtonLink>
          )}
        </header>

        <main className="flex-1 max-w-3xl w-full min-w-0 mx-auto p-3.5 sm:p-4 pb-12 pb-safe space-y-5 overflow-x-hidden">
          {/* 1. Theme (Light / Dark / System + Collapsible Sub-Theme Variants) & Language */}
          <section className="pixel-card p-4 space-y-4">
            <SectionTitle icon="sparkle" title={t('sectionAppearance')} />

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-bold text-[var(--text-secondary)] block">
                  {t('themeLabel')}
                </label>

                <button
                  type="button"
                  onClick={() => setThemeDetailsOpen((v) => !v)}
                  aria-expanded={themeDetailsOpen}
                  className={`min-h-[32px] px-2.5 text-[11px] font-bold flex items-center gap-1 ${
                    themeDetailsOpen ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
                  }`}
                  data-testid="toggle-theme-details-btn"
                >
                  <PixelIcon
                    name={themeDetailsOpen ? 'arrowUp' : 'arrowDown'}
                    size={11}
                  />
                  <span>
                    {themeDetailsOpen
                      ? t('themeDetailCloseBtn')
                      : t('themeDetailToggleBtn')}
                  </span>
                </button>
              </div>

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
                      className={`relative min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 overflow-hidden ${
                        active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                      }`}
                      data-testid={`theme-btn-${item.id}`}
                    >
                      {active && !reducedMotion && (
                        <motion.span
                          layoutId="settings-theme-pill"
                          transition={{
                            type: 'spring',
                            stiffness: 520,
                            damping: 36,
                          }}
                          className="absolute inset-0 bg-[var(--accent-primary)] pointer-events-none"
                          aria-hidden="true"
                        />
                      )}
                      <span className="relative z-10 flex items-center justify-center gap-1.5">
                        {active && <PixelIcon name="check" size={12} />}
                        <span>{item.label}</span>
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Collapsible Detailed Light & Dark Sub-Theme Selectors (Hidden by default unless opened) */}
              {themeDetailsOpen && (
                <div
                  className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-3 mt-1"
                  data-testid="theme-details-panel"
                >
                  <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                    {t('themeDetailHint')}
                  </p>

                  {/* Light Series Sub-Themes */}
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold text-[var(--text-primary)]">
                      {t('themeLightSeriesLabel')}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {LIGHT_THEME_VARIANTS.map((variant) => {
                        const active = activeLightVariant === variant.id
                        return (
                          <button
                            key={variant.id}
                            type="button"
                            onClick={() =>
                              void updateSettings({
                                lightThemeVariant: variant.id,
                              })
                            }
                            aria-pressed={active}
                            className={`p-2 border-2 text-left flex items-center justify-between gap-2 cursor-pointer ${
                              active
                                ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)]'
                                : 'bg-[var(--bg-surface)] border-[var(--border-pixel)]'
                            }`}
                            data-testid={`light-theme-variant-${variant.id}`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {active && (
                                <PixelIcon
                                  name="check"
                                  size={12}
                                  className="text-[var(--accent-primary)] shrink-0"
                                />
                              )}
                              <span className="text-xs font-bold truncate">
                                {t(LIGHT_VARIANT_LABEL_KEYS[variant.id])}
                              </span>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {variant.previewColors.map((hex, i) => (
                                <span
                                  key={i}
                                  style={{ backgroundColor: hex }}
                                  className="w-3.5 h-3.5 border border-[var(--border-pixel)]"
                                />
                              ))}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Dark Series Sub-Themes */}
                  <div className="space-y-1.5">
                    <div className="text-xs font-bold text-[var(--text-primary)]">
                      {t('themeDarkSeriesLabel')}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {DARK_THEME_VARIANTS.map((variant) => {
                        const active = activeDarkVariant === variant.id
                        return (
                          <button
                            key={variant.id}
                            type="button"
                            onClick={() =>
                              void updateSettings({
                                darkThemeVariant: variant.id,
                              })
                            }
                            aria-pressed={active}
                            className={`p-2 border-2 text-left flex items-center justify-between gap-2 cursor-pointer ${
                              active
                                ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)]'
                                : 'bg-[var(--bg-surface)] border-[var(--border-pixel)]'
                            }`}
                            data-testid={`dark-theme-variant-${variant.id}`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {active && (
                                <PixelIcon
                                  name="check"
                                  size={12}
                                  className="text-[var(--accent-primary)] shrink-0"
                                />
                              )}
                              <span className="text-xs font-bold truncate">
                                {t(DARK_VARIANT_LABEL_KEYS[variant.id])}
                              </span>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {variant.previewColors.map((hex, i) => (
                                <span
                                  key={i}
                                  style={{ backgroundColor: hex }}
                                  className="w-3.5 h-3.5 border border-[var(--border-pixel)]"
                                />
                              ))}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[var(--text-secondary)] block">
                {t('languageLabel')}
              </label>
              <PixelSelect<LanguageCode>
                value={settings.language}
                options={LANGUAGE_OPTIONS.map((item) => ({
                  value: item.code,
                  label: item.label,
                  subLabel: item.subLabel,
                }))}
                onChange={(picked) => void updateSettings({ language: picked })}
                ariaLabel={t('languageLabel')}
                className="w-full"
                testId="settings-language-select"
              />
            </div>
          </section>

          {/* 2. UI Size Customization + Live UI Preview */}
          <section
            className="pixel-card p-4 space-y-4 overflow-hidden"
            data-testid="ui-size-section"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
              <SectionTitle icon="resize" title={t('sectionUiSize')} />
              <button
                type="button"
                onClick={() => void updateUiSize({ ...DEFAULT_UI_SIZE_CONFIG })}
                className="pixel-btn min-h-[36px] px-2.5 text-xs font-bold whitespace-nowrap shrink-0"
                data-testid="ui-size-reset-btn"
              >
                {t('uiResetDefaults')}
              </button>
            </div>

            <div
              className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2.5"
              data-testid="ui-size-live-preview"
            >
              <div className="text-[11px] font-bold text-[var(--text-secondary)]">
                {t('uiLivePreviewTitle')}
              </div>

              <div
                style={{ gap: 'var(--ui-gap, 6px)' }}
                className="grid grid-cols-3"
              >
                {[
                  { icon: 'pen' as const, label: t('toolPen'), active: true },
                  { icon: 'line' as const, label: t('lineStraight'), active: false },
                  { icon: 'layers' as const, label: t('toolLayers'), active: false },
                ].map((sample, i) => (
                  <div
                    key={i}
                    style={{ minHeight: 'max(34px, var(--tool-btn-height, 44px))' }}
                    className={`px-1.5 py-1 flex flex-col items-center justify-center gap-0.5 ${
                      sample.active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name={sample.icon} />
                    <span
                      style={{ fontSize: 'var(--tool-label-size, 10px)' }}
                      className="leading-none font-bold truncate max-w-full"
                    >
                      {sample.label}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  style={{ gap: 'var(--ui-gap, 6px)' }}
                  className="flex items-center"
                >
                  {['#241F31', '#8A6FB8', '#6D9B84', '#C47488'].map((hex, i) => (
                    <span
                      key={hex}
                      style={{
                        width: 'var(--swatch-size, 30px)',
                        height: 'var(--swatch-size, 30px)',
                        backgroundColor: hex,
                      }}
                      className={`inline-block border-2 ${
                        i === 1
                          ? 'border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                          : 'border-[var(--border-pixel)]'
                      }`}
                    />
                  ))}
                </div>

                <PixelCheckbox
                  checked={previewChecked}
                  onChange={setPreviewChecked}
                  label={t('pixelPerfect')}
                />
              </div>

              <div
                style={{
                  height: 'clamp(34px, calc(var(--draw-btn-vh, 12dvh) * 0.45), 76px)',
                }}
                className="w-full pixel-draw-btn flex items-center justify-center gap-2 text-sm font-bold select-none"
              >
                <PixelIcon name="pen" size={16} />
                <span>{t('draw')}</span>
              </div>
            </div>

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
                    className={`relative min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 overflow-hidden ${
                      active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid={`ui-preset-${p.id}`}
                  >
                    {active && !reducedMotion && (
                      <motion.span
                        layoutId="settings-ui-preset-pill"
                        transition={{
                          type: 'spring',
                          stiffness: 520,
                          damping: 36,
                        }}
                        className="absolute inset-0 bg-[var(--accent-primary)] pointer-events-none"
                        aria-hidden="true"
                      />
                    )}
                    <span className="relative z-10 flex items-center justify-center gap-1.5">
                      {active && <PixelIcon name="check" size={12} />}
                      <span>{p.label}</span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="space-y-2.5 pt-1">
              <UiSliderRow
                label={t('uiOverallScale')}
                value={ui.overallScale}
                min={75}
                max={120}
                step={2}
                unit="%"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', overallScale: v })
                }
              />
              <UiSliderRow
                label={t('uiToolIconSize')}
                value={ui.toolIconSize}
                min={12}
                max={32}
                step={2}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', toolIconSize: v })
                }
              />
              <UiSliderRow
                label={t('uiToolButtonHeight')}
                value={ui.toolButtonHeight}
                min={34}
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
                min={8}
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
                min={22}
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
                min={14}
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
                min={2}
                max={12}
                step={1}
                unit="px"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', uiGap: v })
                }
              />
              <UiSliderRow
                label={t('uiDrawButtonVh')}
                value={ui.drawButtonVh}
                min={7}
                max={20}
                step={1}
                unit="%"
                onChange={(v) =>
                  void updateUiSize({ preset: 'custom', drawButtonVh: v })
                }
              />
            </div>
          </section>

          {/* 3. Editor Preferences, Cursor Settings & History Limit */}
          <section className="pixel-card p-4 space-y-3.5">
            <SectionTitle icon="settings" title={t('sectionEditorPrefs')} />

            <div className="space-y-2">
              <label className="text-xs font-bold text-[var(--text-secondary)] block">
                {t('historyLimitLabel')}
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    void updateSettings({
                      historyLimit: 'unlimited',
                      historyLimitCustomized: true,
                    })
                  }
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
                    onClick={() =>
                      void updateSettings({
                        historyLimit: num,
                        historyLimitCustomized: true,
                      })
                    }
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
                      void updateSettings({
                        historyLimit: val,
                        historyLimitCustomized: true,
                      })
                    }}
                    className="w-20 min-h-[36px] px-2 text-xs pixel-input"
                    data-testid="history-custom-input"
                  />
                </div>
              </div>
            </div>

            {/* Consolidated Touch Virtual Cursor Size & Speed */}
            <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-bold text-[var(--text-primary)]">
                  {t('cursorSpeedSection')}
                </span>
                <span className="font-mono font-bold text-[var(--accent-primary)]">
                  {settings.cursorSpeed.toFixed(2)}x ({Math.round(settings.cursorSpeed * 100)}%)
                </span>
              </div>
              <PixelSlider
                min={Math.round(MIN_CURSOR_SPEED * 100)}
                max={Math.round(MAX_CURSOR_SPEED * 100)}
                step={5}
                buttonStep={5}
                value={Math.round(settings.cursorSpeed * 100)}
                unit="%"
                ariaLabel={t('cursorSpeedSection')}
                onChange={(pct) => {
                  const next = pct / 100
                  void updateSettings({ cursorSpeed: next })
                }}
                testId="settings-cursor-speed-slider"
              />
              <div className="space-y-1 pt-1">
                <span className="text-xs font-bold text-[var(--text-secondary)] block">
                  {t('cursorSizeSection')}
                </span>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { value: 'small', label: t('cursorSizeSmall') },
                      { value: 'standard', label: t('cursorSizeStandard') },
                      { value: 'large', label: t('cursorSizeLarge') },
                    ] as Array<{ value: CursorDisplaySize; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => void updateSettings({ cursorSize: opt.value })}
                      className={`min-h-[34px] px-2 text-xs font-bold ${
                        settings.cursorSize === opt.value
                          ? 'pixel-btn pixel-btn-active'
                          : 'pixel-btn'
                      }`}
                      data-testid={`settings-cursor-size-${opt.value}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1 pt-1">
              <PixelCheckbox
                checked={settings.eyedropperDoubleTap}
                onChange={(v) => void updateSettings({ eyedropperDoubleTap: v })}
                label={`${t('toolEyedropper')}: ${t('eyedropperDoubleTapLabel')}`}
                testId="settings-eyedropper-doubletap"
              />
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
                checked={Boolean(settings.grayscalePreview)}
                onChange={(v) => void updateSettings({ grayscalePreview: v })}
                label={t('grayscalePreviewLabel')}
                testId="settings-grayscale-preview"
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

          {/* 3b. Consolidated Tile Preview, Seamless Wrap, Symmetry & Export Defaults */}
          <section
            className="pixel-card p-4 space-y-3"
            data-testid="settings-advanced-section"
          >
            <div className="flex items-center justify-between gap-2">
              <SectionTitle
                icon="symmetry"
                title={t('sectionAdvancedFeatures')}
              />
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
                className={`min-h-[34px] px-3 text-xs font-bold flex items-center gap-1 ${
                  advancedOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                }`}
                data-testid="settings-toggle-advanced-btn"
              >
                <PixelIcon
                  name={advancedOpen ? 'arrowUp' : 'arrowDown'}
                  size={12}
                />
                <span>
                  {advancedOpen ? t('advancedCloseBtn') : t('advancedOpenBtn')}
                </span>
              </button>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {t('sectionAdvancedDesc')}
            </p>

            {advancedOpen && (
              <div className="space-y-3.5 pt-2 border-t border-[var(--border-subtle)]">
                {/* Default Tile Repeat Preview */}
                <div className="space-y-1.5">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {t('tilePreviewLabel')}
                  </span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        { id: 'off', label: t('tilePreviewOff') },
                        { id: '3x3', label: t('tilePreview3x3') },
                        { id: '5x5', label: t('tilePreview5x5') },
                      ] as Array<{ id: TilePreviewGrid; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          void updateSettings({ defaultTilePreviewGrid: opt.id })
                        }
                        className={`min-h-[36px] px-2 text-xs font-bold ${
                          (settings.defaultTilePreviewGrid ?? 'off') === opt.id
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                        data-testid={`settings-tile-preview-${opt.id}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Default Seamless Wrap Mode */}
                <div className="space-y-1.5">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {t('defaultSeamlessLabel')}
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {(
                      [
                        { id: 'none', label: t('seamlessOff') },
                        { id: 'horizontal', label: t('seamlessHorizontal') },
                        { id: 'vertical', label: t('seamlessVertical') },
                        { id: 'both', label: t('seamlessBoth') },
                      ] as Array<{ id: SeamlessWrapMode; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          void updateSettings({
                            defaultSeamlessWrapMode: opt.id,
                          })
                        }
                        className={`min-h-[36px] px-2 text-xs font-bold ${
                          (settings.defaultSeamlessWrapMode ?? 'none') === opt.id
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Default Symmetry Mode */}
                <div className="space-y-1.5">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {t('defaultSymmetryLabel')}
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {(
                      [
                        { id: 'none', label: t('symmetryOff') },
                        { id: 'horizontal', label: t('symmetryHorizontal') },
                        { id: 'vertical', label: t('symmetryVertical') },
                        { id: 'quad', label: t('symmetryQuad') },
                      ] as Array<{ id: SymmetryMode; label: string }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          void updateSettings({ defaultSymmetryMode: opt.id })
                        }
                        className={`min-h-[36px] px-2 text-xs font-bold ${
                          settings.defaultSymmetryMode === opt.id
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Default Sprite Sheet Spacing */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">
                    {t('spriteSheetTitle')} — {t('spriteSheetSpacing')}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={64}
                    value={settings.defaultSpriteSheetPadding ?? 0}
                    onChange={(e) =>
                      void updateSettings({
                        defaultSpriteSheetPadding: Math.max(
                          0,
                          Math.min(64, Number(e.target.value) || 0)
                        ),
                      })
                    }
                    className="w-20 min-h-[34px] px-2 text-xs font-mono font-bold text-right pixel-input"
                    data-testid="settings-default-sprite-padding"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <PixelCheckbox
                    checked={settings.showSymmetryGuide ?? true}
                    onChange={(v) =>
                      void updateSettings({ showSymmetryGuide: v })
                    }
                    label={t('symmetryAxisGuide')}
                  />
                  <PixelCheckbox
                    checked={settings.embedPngMetadata ?? true}
                    onChange={(v) =>
                      void updateSettings({ embedPngMetadata: v })
                    }
                    label={t('exportEmbedMetaLabel')}
                    testId="settings-embed-png-meta-checkbox"
                  />
                </div>
              </div>
            )}
          </section>

          {/* 3c. Indexed Color Migration Report & Before/After Quantization Comparison (shown when quantized artworks exist) */}
          {(quantizedProjects.length > 0 ||
            (migrationSummary && migrationSummary.quantizedProjectIds.length > 0)) && (
            <section
              className="pixel-card p-4 space-y-3"
              data-testid="settings-migration-report-section"
            >
              <SectionTitle
                icon="palette"
                title={t('migrationSummaryTitle')}
              />
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {t('migrationSummaryDesc')}
              </p>

              <div className="space-y-2">
                {quantizedProjects.map((proj) => {
                  const rep = proj.migrationReport
                  return (
                    <div
                      key={proj.id}
                      className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex flex-wrap items-center justify-between gap-2 text-xs"
                      data-testid={`migration-quantized-item-${proj.id}`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-bold truncate">{proj.name}</div>
                        {rep && (
                          <div className="text-[11px] text-[var(--text-secondary)]">
                            {t('migrationOriginalColors')}: {rep.originalOpaqueColorCount} → {rep.finalOpaqueColorCount}
                            {rep.hadSemiTransparentPixels
                              ? ` · ${t('migrationSemiTransparentNote')}`
                              : ''}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setCompareProject(proj)}
                        className="pixel-btn pixel-btn-teal min-h-[34px] px-2.5 text-xs font-bold"
                        data-testid={`migration-compare-btn-${proj.id}`}
                      >
                        {t('migrationCompareBtn')}
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* 4. Palette Library Manager (Max 255 Opaque Colors) */}
          <section className="pixel-card p-4 space-y-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
              <SectionTitle
                icon="palette"
                title={`${t('sectionPaletteLibrary')} (${palettes.length})`}
              />

              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <button
                  type="button"
                  onClick={() => setLospecLibOpen(true)}
                  className="pixel-btn pixel-btn-teal min-h-[40px] px-2.5 sm:px-3 text-xs font-bold flex items-center gap-1 min-w-0"
                  data-testid="settings-lospec-import-btn"
                >
                  <PixelIcon name="download" size={14} />
                  <span className="truncate">{t('lospecImportBtn')}</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    const created = await addLibraryPalette(
                      `Palette ${palettes.length + 1}`,
                      ['#241F31', '#F7F4FA', '#8A6FB8', '#6D9B84', '#C47488', '#D9A06B']
                    )
                    setEditingPalette(created)
                    setEditingColorIdx(0)
                  }}
                  className="pixel-btn pixel-btn-active min-h-[40px] px-2.5 sm:px-3 text-xs font-bold flex items-center gap-1 min-w-0"
                  data-testid="settings-add-palette-btn"
                >
                  <PixelIcon name="plus" size={14} />
                  <span className="truncate">{t('newPalette')}</span>
                </button>
              </div>
            </div>

            <div ref={paletteListRef} className="space-y-2">
              {palettes.map((pal, idx) => {
                const isLastRemaining = palettes.length <= 1
                const isDragging = palDragState?.draggingId === pal.id
                const isDropTarget =
                  palDragState !== null &&
                  palDragState.overId === pal.id &&
                  palDragState.draggingId !== pal.id
                return (
                  <div
                    key={pal.id}
                    {...getPalItemProps(pal.id)}
                    className={`p-3 bg-[var(--bg-elevated)] border-2 flex flex-wrap items-center justify-between gap-2 select-none ${
                      isDropTarget
                        ? 'border-[var(--accent-teal)] outline-2 outline-dashed outline-[var(--accent-teal)]'
                        : 'border-[var(--border-pixel)]'
                    } ${isDragging ? 'opacity-60' : ''}`}
                    data-testid={`lib-palette-${pal.id}`}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-xs font-bold truncate">
                        {pal.name}{' '}
                        <span className="font-normal text-[var(--text-secondary)]">
                          ({pal.colors.length})
                        </span>
                        {pal.author && (
                          <span className="ml-1.5 text-[10px] font-normal text-[var(--text-secondary)]">
                            by {pal.author}
                          </span>
                        )}
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

            {originStorageStatus.level !== 'ok' && (
              <div
                className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-xs space-y-1"
                data-testid="settings-origin-low-storage-alert"
              >
                <div className="font-bold text-[var(--accent-amber)]">
                  {originStorageStatus.level === 'critical'
                    ? t('originLowStorageCriticalTitle')
                    : t('originLowStorageTitle')}
                </div>
                <p className="text-[var(--text-secondary)] leading-relaxed">
                  {t('originLowStorageDesc')}
                </p>
              </div>
            )}

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

          {/* 6. Environment Pack (ZIP Export / Import + Last Export Timestamp) */}
          <section className="pixel-card p-4 space-y-3">
            <SectionTitle icon="download" title={t('sectionEnvPack')} />

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {t('envPackDesc')}
            </p>

            <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex items-center justify-between text-xs">
              <span className="text-[var(--text-secondary)]">
                {t('lastExportAtLabel')}
              </span>
              <span
                className="font-bold text-[var(--text-primary)]"
                data-testid="last-export-at-value"
              >
                {formatDateTime(settings.backupMeta?.lastExportAt ?? null)}
              </span>
            </div>

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
            <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-[var(--border-subtle)]">
              <div className="flex items-center gap-3">
                <DotDotAppIcon
                  size={40}
                  className="border-2 border-[var(--border-pixel)]"
                  testId="settings-app-icon"
                />
                <div className="space-y-1">
                  <DotDotWordmark
                    height={16}
                    color="var(--accent-rose)"
                    testId="settings-app-wordmark"
                  />
                  <h2 className="text-xs font-bold text-[var(--text-secondary)]">
                    {t('sectionAppInfo')}
                  </h2>
                </div>
              </div>
              <span className="px-2 py-0.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-xs font-bold">
                v3.0.0
              </span>
            </div>
            <div className="text-xs space-y-1.5 text-[var(--text-secondary)]">
              <div className="flex justify-between">
                <span>{t('appVersionLabel')}</span>
                <span className="font-bold text-[var(--text-primary)]">3.0.0</span>
              </div>
              <div className="flex justify-between">
                <span>{t('storageEngineLabel')}</span>
                <span className="font-bold text-[var(--text-primary)]">
                  {t('storageEngineValue')}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
              <div className="text-xs font-bold text-[var(--text-secondary)]">
                {t('sectionLegal')}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setLegalTab('terms')}
                  className="pixel-btn min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
                  data-testid="open-terms-btn"
                >
                  <PixelIcon name="doc" size={14} />
                  <span>{t('termsTitle')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLegalTab('privacy')}
                  className="pixel-btn min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
                  data-testid="open-privacy-btn"
                >
                  <PixelIcon name="shield" size={14} />
                  <span>{t('privacyTitle')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLegalTab('license')}
                  className="pixel-btn min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
                  data-testid="open-license-btn"
                >
                  <PixelIcon name="doc" size={14} />
                  <span>{t('licenseTitle')}</span>
                </button>
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
            palette={normalizeProjectPalette({
              name: editingPalette.name,
              colors: editingPalette.colors,
              sourcePaletteId: editingPalette.id,
            })}
            selectedIndex={editingColorIdx}
            checkerDark={settings.checkerboardDark}
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
            onSaveToLibrary={async (name, colors, meta) => {
              await addLibraryPalette(name, colors, meta)
              showToast(t('toastSavedPalette'), 'success')
            }}
          />
        )}

        <LospecImportModal
          open={lospecLibOpen}
          onClose={() => setLospecLibOpen(false)}
          allowAppendReplace={false}
          onConfirmImport={async (fetched) => {
            await addLibraryPalette(fetched.name, fetched.colors, {
              author: fetched.author || undefined,
              sourceUrl: fetched.sourceUrl,
              lospecSlug: fetched.slug,
            })
            showToast(t('toastLospecImported'), 'success')
          }}
        />

        {/* Before / After Quantized Artwork Comparison Modal */}
        <Modal
          open={compareProject !== null}
          title={compareProject ? compareProject.name : t('migrationSummaryTitle')}
          onClose={() => setCompareProject(null)}
          maxWidthClass="max-w-md"
        >
          {compareProject && (
            <div className="space-y-3 text-xs" data-testid="migration-compare-modal">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <div className="font-bold text-[var(--text-secondary)] text-center">
                    {t('migrationBeforeLabel')}
                  </div>
                  <div className="aspect-square border-2 border-[var(--border-pixel)]">
                    <PixelThumbnail
                      pngBytes={
                        compareProject.migrationReport?.beforePreviewPng ??
                        compareProject.thumbnailPng
                      }
                      alt={`${compareProject.name} Before`}
                      checkerDark={settings.checkerboardDark}
                      className="w-full h-full p-2"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="font-bold text-[var(--accent-teal)] text-center">
                    {t('migrationAfterLabel')}
                  </div>
                  <div className="aspect-square border-2 border-[var(--border-pixel)]">
                    <PixelThumbnail
                      pngBytes={
                        compareProject.migrationReport?.afterPreviewPng ??
                        compareProject.thumbnailPng
                      }
                      alt={`${compareProject.name} After`}
                      checkerDark={settings.checkerboardDark}
                      className="w-full h-full p-2"
                    />
                  </div>
                </div>
              </div>

              {compareProject.migrationReport && (
                <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1">
                  <div>
                    {t('migrationOriginalColors')}:{' '}
                    <strong>{compareProject.migrationReport.originalOpaqueColorCount}</strong> →{' '}
                    <strong>{compareProject.migrationReport.finalOpaqueColorCount}</strong>
                  </div>
                  {compareProject.migrationReport.hadSemiTransparentPixels && (
                    <div className="text-[var(--text-secondary)]">
                      {t('migrationSemiTransparentNote')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Modal>

        {legalTab !== null && (
          <LegalDocsModal
            open={true}
            initialTab={legalTab}
            onClose={() => setLegalTab(null)}
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
    <div
      className="w-full min-w-0 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3 py-0.5"
      data-testid="ui-size-slider-row"
    >
      <div className="flex items-center justify-between gap-2 min-w-0 sm:w-[150px] sm:shrink-0">
        <span className="text-xs text-[var(--text-primary)] truncate min-w-0">
          {label}
        </span>
        <span className="sm:hidden text-xs font-mono font-bold text-[var(--accent-primary)] whitespace-nowrap shrink-0">
          {value}
          {unit}
        </span>
      </div>
      <PixelSlider
        min={min}
        max={max}
        step={step}
        value={value}
        unit={unit}
        ariaLabel={label}
        onChange={onChange}
        className="w-full min-w-0 sm:flex-1"
      />
      <span className="hidden sm:inline-block w-14 text-right text-xs font-mono font-bold whitespace-nowrap shrink-0">
        {value}
        {unit}
      </span>
    </div>
  )
}
