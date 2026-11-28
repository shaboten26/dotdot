import { useEffect, useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  CursorDisplaySize,
  SeamlessWrapMode,
  SymmetryMode,
  TilePreviewGrid,
} from '../../types'
import { MAX_CURSOR_SPEED, MIN_CURSOR_SPEED } from '../../db/database'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { PixelSlider } from '../common/PixelSlider'

interface GlobalEditorSettingsModalProps {
  open: boolean
  onClose: () => void
  previewFlipX?: boolean
  previewFlipY?: boolean
  onTogglePreviewFlipX?: () => void
  onTogglePreviewFlipY?: () => void
  onResetPreviewFlip?: () => void
  symmetryMode?: SymmetryMode
  onChangeSymmetryMode?: (mode: SymmetryMode) => void
  tilePreviewGrid?: TilePreviewGrid
  onChangeTilePreviewGrid?: (grid: TilePreviewGrid) => void
  seamlessWrapMode?: SeamlessWrapMode
  onChangeSeamlessWrapMode?: (mode: SeamlessWrapMode) => void
}

/**
 * Global Editor, View & Input Settings Modal opened from the Tool Tab's 10th slot (`設定`).
 * Strictly contains workspace-wide / view-wide / input-wide settings:
 * - Non-Destructive View Flip Preview (Horizontal / Vertical mirror display without mutating pixel buffers)
 * - Cursor Speed (slider + presets + live readout, pixel-accurate sub-pixel accumulation)
 * - Cursor Display Size (Small / Standard / Large for touch virtual cursor)
 * - Double-Tap Eyedropper ON/OFF (shared directly with `AppSettings.eyedropperDoubleTap`)
 * Custom cursor / mouse cursor design replacement has been intentionally removed.
 */
export function GlobalEditorSettingsModal({
  open,
  onClose,
  previewFlipX = false,
  previewFlipY = false,
  onTogglePreviewFlipX,
  onTogglePreviewFlipY,
  onResetPreviewFlip,
  symmetryMode = 'none',
  onChangeSymmetryMode,
  tilePreviewGrid = 'off',
  onChangeTilePreviewGrid,
  seamlessWrapMode = 'none',
  onChangeSeamlessWrapMode,
}: GlobalEditorSettingsModalProps) {
  const { settings, updateSettings, reducedMotion } = useApp()
  const { t } = useI18n()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const speedPresets = useMemo(
    () => [
      { value: 0.6, label: t('cursorSpeedSlow') },
      { value: 1.0, label: t('cursorSpeedStandard') },
      { value: 1.8, label: t('cursorSpeedFast') },
    ],
    [t]
  )

  const sizeOptions: ReadonlyArray<{
    value: CursorDisplaySize
    label: string
  }> = useMemo(
    () => [
      { value: 'small', label: t('cursorSizeSmall') },
      { value: 'standard', label: t('cursorSizeStandard') },
      { value: 'large', label: t('cursorSizeLarge') },
    ],
    [t]
  )

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t('editorGlobalSettingsTitle')}
          data-testid="global-editor-settings-modal"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/55"
          />
          <motion.div
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 480, damping: 36, mass: 0.85 }
            }
            className="relative z-10 w-full sm:max-w-lg max-h-[88dvh] flex flex-col pixel-panel overflow-hidden"
          >
            {/* Sticky Header */}
            <div className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b-2 border-[var(--border-pixel)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <PixelIcon
                  name="settings"
                  size={15}
                  className="text-[var(--accent-primary)] shrink-0"
                />
                <h2 className="text-sm font-bold tracking-wide truncate text-[var(--text-primary)]">
                  {t('editorGlobalSettingsTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
                data-testid="close-global-editor-settings-btn"
              >
                <PixelIcon name="close" size={16} />
              </button>
            </div>

            {/* Scrollable Body (Safe-area aware, overscroll-contain) */}
            <div
              className="p-3.5 space-y-4 overflow-y-auto overscroll-contain flex-1 min-h-0"
              style={{
                paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
              }}
              data-testid="global-editor-settings-scroll"
            >
              {/* 1. Symmetry Editing + Axis Guide */}
              {onChangeSymmetryMode && (
                <section
                  className="pixel-card p-3 space-y-2.5"
                  data-testid="global-symmetry-section"
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-primary)]">
                    <PixelIcon
                      name="symmetry"
                      size={13}
                      className="text-[var(--accent-teal)]"
                    />
                    <span>{t('symmetryLabel')}</span>
                  </div>

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
                        onClick={() => onChangeSymmetryMode(opt.id)}
                        aria-pressed={symmetryMode === opt.id}
                        className={`min-h-[36px] px-2 text-xs font-bold ${
                          symmetryMode === opt.id
                            ? 'pixel-btn pixel-btn-teal'
                            : 'pixel-btn'
                        }`}
                        data-testid={`global-symmetry-${opt.id}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <PixelCheckbox
                    checked={settings.showSymmetryGuide ?? true}
                    onChange={(next) =>
                      void updateSettings({ showSymmetryGuide: next })
                    }
                    label={t('symmetryAxisGuide')}
                    testId="global-symmetry-guide-checkbox"
                  />
                </section>
              )}

              {/* 1b. Tile Repeat Preview & Seamless Edge Wrap */}
              {(onChangeTilePreviewGrid || onChangeSeamlessWrapMode) && (
                <section
                  className="pixel-card p-3 space-y-2.5"
                  data-testid="global-tile-seamless-section"
                >
                  {onChangeTilePreviewGrid && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-primary)]">
                        <PixelIcon
                          name="tile"
                          size={13}
                          className="text-[var(--accent-teal)]"
                        />
                        <span>{t('tilePreviewLabel')}</span>
                      </div>
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
                            onClick={() => onChangeTilePreviewGrid(opt.id)}
                            aria-pressed={tilePreviewGrid === opt.id}
                            className={`min-h-[34px] px-2 text-xs font-bold ${
                              tilePreviewGrid === opt.id
                                ? 'pixel-btn pixel-btn-teal'
                                : 'pixel-btn'
                            }`}
                            data-testid={`global-tile-preview-${opt.id}`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {onChangeSeamlessWrapMode && (
                    <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
                      <div className="text-xs font-bold text-[var(--text-primary)]">
                        {t('seamlessWrapLabel')}
                      </div>
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
                            onClick={() => onChangeSeamlessWrapMode(opt.id)}
                            aria-pressed={seamlessWrapMode === opt.id}
                            className={`min-h-[34px] px-2 text-xs font-bold ${
                              seamlessWrapMode === opt.id
                                ? 'pixel-btn pixel-btn-active'
                                : 'pixel-btn'
                            }`}
                            data-testid={`global-seamless-${opt.id}`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {t('tileSeamlessNote')}
                  </p>
                </section>
              )}

              {/* 1c. Non-Destructive View Flip Preview (Horizontal / Vertical) */}
              {(onTogglePreviewFlipX || onTogglePreviewFlipY) && (
                <section
                  className="pixel-card p-3 space-y-2.5"
                  data-testid="global-flip-preview-section"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-primary)]">
                      <PixelIcon
                        name="flipH"
                        size={13}
                        className="text-[var(--accent-teal)]"
                      />
                      <span>{t('flipPreviewSection')}</span>
                    </div>
                    {(previewFlipX || previewFlipY) && onResetPreviewFlip && (
                      <button
                        type="button"
                        onClick={onResetPreviewFlip}
                        className="pixel-btn min-h-[28px] px-2 text-[11px] font-bold flex items-center gap-1"
                        data-testid="global-flip-preview-reset-btn"
                      >
                        <PixelIcon name="undo" size={11} />
                        <span>{t('flipPreviewResetBtn')}</span>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={onTogglePreviewFlipX}
                      aria-pressed={previewFlipX}
                      className={`min-h-[38px] px-2.5 text-xs font-bold flex items-center justify-center gap-1.5 ${
                        previewFlipX ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
                      }`}
                      data-testid="global-flip-preview-h-btn"
                    >
                      <PixelIcon name="flipH" size={14} />
                      <span>{t('flipPreviewHorizontal')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={onTogglePreviewFlipY}
                      aria-pressed={previewFlipY}
                      className={`min-h-[38px] px-2.5 text-xs font-bold flex items-center justify-center gap-1.5 ${
                        previewFlipY ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
                      }`}
                      data-testid="global-flip-preview-v-btn"
                    >
                      <PixelIcon name="flipV" size={14} />
                      <span>{t('flipPreviewVertical')}</span>
                    </button>
                  </div>

                  <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {t('flipPreviewHint')}
                  </p>
                </section>
              )}

              {/* 1d. Non-Destructive Grayscale / Monochrome Luminance Preview */}
              <section
                className="pixel-card p-3 space-y-2"
                data-testid="global-grayscale-preview-section"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-primary)]">
                    <PixelIcon
                      name="eye"
                      size={13}
                      className="text-[var(--accent-teal)]"
                    />
                    <span>{t('grayscalePreviewSection')}</span>
                  </div>
                  {settings.grayscalePreview && (
                    <button
                      type="button"
                      onClick={() =>
                        void updateSettings({ grayscalePreview: false })
                      }
                      className="pixel-btn min-h-[28px] px-2 text-[11px] font-bold flex items-center gap-1"
                      data-testid="global-grayscale-preview-reset-btn"
                    >
                      <PixelIcon name="undo" size={11} />
                      <span>{t('grayscalePreviewResetBtn')}</span>
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    void updateSettings({
                      grayscalePreview: !settings.grayscalePreview,
                    })
                  }
                  aria-pressed={Boolean(settings.grayscalePreview)}
                  className={`w-full min-h-[38px] px-3 text-xs font-bold flex items-center justify-center gap-2 ${
                    settings.grayscalePreview
                      ? 'pixel-btn pixel-btn-teal'
                      : 'pixel-btn'
                  }`}
                  data-testid="global-grayscale-preview-btn"
                >
                  <span className="inline-flex shrink-0">
                    <span className="w-3 h-3.5 bg-[#1e1b29] border border-[var(--border-strong)]" />
                    <span className="w-3 h-3.5 bg-[#e6e2ee] border-y border-r border-[var(--border-strong)]" />
                  </span>
                  <span>{t('grayscalePreviewToggleBtn')}</span>
                  {settings.grayscalePreview && (
                    <PixelIcon name="check" size={12} />
                  )}
                </button>

                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {t('grayscalePreviewHint')}
                </p>
              </section>

              {/* 2. Cursor Speed */}
              <section className="pixel-card p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--text-primary)]">
                    {t('cursorSpeedSection')}
                  </span>
                  <span
                    className="text-xs font-mono font-bold px-2 py-0.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--accent-primary)]"
                    data-testid="cursor-speed-value"
                  >
                    {settings.cursorSpeed.toFixed(2)}x (
                    {Math.round(settings.cursorSpeed * 100)}%)
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
                  testId="cursor-speed-slider"
                />

                <div className="grid grid-cols-3 gap-1.5">
                  {speedPresets.map((preset) => {
                    const active = Math.abs(settings.cursorSpeed - preset.value) < 0.03
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() =>
                          void updateSettings({ cursorSpeed: preset.value })
                        }
                        className={`min-h-[34px] px-2 text-xs font-bold ${
                          active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                        }`}
                        data-testid={`cursor-speed-preset-${preset.value}`}
                      >
                        {preset.label} ({preset.value.toFixed(1)}x)
                      </button>
                    )
                  })}
                </div>
              </section>

              {/* 3. Cursor Display Size */}
              <section className="pixel-card p-3 space-y-2">
                <div className="text-xs font-bold text-[var(--text-primary)]">
                  {t('cursorSizeSection')}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {sizeOptions.map((opt) => {
                    const active = settings.cursorSize === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          void updateSettings({ cursorSize: opt.value })
                        }
                        className={`min-h-[36px] px-2 text-xs font-bold ${
                          active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                        }`}
                        data-testid={`cursor-size-${opt.value}`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  {t('cursorSizeHint')}
                </p>
              </section>

              {/* 4. Shared Double-Tap Eyedropper Setting */}
              <section className="pixel-card p-3 space-y-1.5">
                <div className="text-xs font-bold text-[var(--text-primary)]">
                  {t('inputSectionTitle')}
                </div>
                <PixelCheckbox
                  checked={settings.eyedropperDoubleTap}
                  onChange={(next) =>
                    void updateSettings({ eyedropperDoubleTap: next })
                  }
                  label={t('eyedropperDoubleTapLabel')}
                  testId="global-toggle-eyedropper-doubletap"
                />
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  {t('eyedropperDoubleTapDesc')}
                </p>
              </section>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
