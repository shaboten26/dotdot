import { useState } from 'react'
import { BUILT_IN_CANVAS_PRESETS } from '../../db/database'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../../engine/pixelBuffer'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import { PixelIcon } from './PixelIcon'

interface CanvasSizePresetsPickerProps {
  selectedWidth: number
  selectedHeight: number
  onSelectDimensions: (w: number, h: number) => void
}

/**
 * Section 4: Unified Standard 5 Presets + User-Created Custom Canvas Size Presets
 * - Standard 5 presets (`16×16`, `32×32`, `64×64`, `96×96`, `128×128`) are identical across New Canvas & Resize Canvas, and cannot be deleted.
 * - Custom presets support independent Width × Height (`1..256px`), custom name, duplicate-dimension prevention, and deletion.
 * - Persists automatically to IndexedDB (`AppSettings.customCanvasPresets`) and Environment Pack ZIP!
 */
export function CanvasSizePresetsPicker({
  selectedWidth,
  selectedHeight,
  onSelectDimensions,
}: CanvasSizePresetsPickerProps) {
  const {
    settings,
    addCustomCanvasPreset,
    updateCustomCanvasPreset,
    deleteCustomCanvasPreset,
    reorderCustomCanvasPresets,
    showToast,
  } = useApp()
  const { t } = useI18n()

  const [newPresetName, setNewPresetName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editW, setEditW] = useState(32)
  const [editH, setEditH] = useState(32)

  const customPresets = settings.customCanvasPresets ?? []

  const clampedCurrentW = Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(selectedWidth || 32))
  )
  const clampedCurrentH = Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(selectedHeight || 32))
  )

  const isDuplicateCurrent =
    BUILT_IN_CANVAS_PRESETS.some(
      (b) => b.width === clampedCurrentW && b.height === clampedCurrentH
    ) ||
    customPresets.some(
      (c) => c.width === clampedCurrentW && c.height === clampedCurrentH
    )

  const handleAddCurrent = async () => {
    const created = await addCustomCanvasPreset(
      newPresetName,
      clampedCurrentW,
      clampedCurrentH
    )
    if (!created) {
      showToast(t('presetDuplicateWarning'), 'warning')
      return
    }
    setNewPresetName('')
  }

  const moveCustomStep = async (id: string, delta: -1 | 1) => {
    const idx = customPresets.findIndex((p) => p.id === id)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= customPresets.length) return
    const ids = customPresets.map((p) => p.id)
    const [moved] = ids.splice(idx, 1)
    ids.splice(target, 0, moved)
    await reorderCustomCanvasPresets(ids)
  }

  return (
    <div className="space-y-3" data-testid="canvas-size-presets-picker">
      {/* 1. Unified Standard 5 Presets (non-deletable) */}
      <div className="space-y-1.5">
        <span className="text-[11px] font-bold text-[var(--text-secondary)] block">
          {t('builtInPresetsLabel')}
        </span>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5" data-testid="builtin-presets-grid">
          {BUILT_IN_CANVAS_PRESETS.map((preset) => {
            const active =
              selectedWidth === preset.width && selectedHeight === preset.height
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onSelectDimensions(preset.width, preset.height)}
                aria-pressed={active}
                className={`min-h-[38px] px-2 text-xs font-bold flex items-center justify-center gap-1 ${
                  active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                }`}
                data-testid={`builtin-preset-${preset.width}x${preset.height}`}
              >
                {active && <PixelIcon name="check" size={11} />}
                <span>{preset.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 2. User Custom Presets (Saved in IndexedDB & Environment Pack) */}
      <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold text-[var(--accent-primary)]">
            {t('customPresetsLabel')} ({customPresets.length})
          </span>
        </div>

        {/* Add Current W x H as Custom Preset */}
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            placeholder={t('presetNamePlaceholder')}
            className="flex-1 min-w-[130px] min-h-[36px] px-2.5 text-xs pixel-input"
            data-testid="custom-preset-name-input"
          />
          <button
            type="button"
            disabled={isDuplicateCurrent}
            onClick={() => void handleAddCurrent()}
            className="pixel-btn pixel-btn-teal min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 shrink-0"
            title={isDuplicateCurrent ? t('presetDuplicateWarning') : undefined}
            data-testid="add-custom-preset-btn"
          >
            <PixelIcon name="plus" size={12} />
            <span>
              {t('addCustomPresetBtn')} ({clampedCurrentW}×{clampedCurrentH})
            </span>
          </button>
        </div>

        {isDuplicateCurrent && (
          <p
            className="text-[10px] text-[var(--text-secondary)]"
            data-testid="duplicate-preset-note"
          >
            {t('presetDuplicateWarning')}
          </p>
        )}

        {customPresets.length === 0 ? (
          <p className="text-[11px] text-[var(--text-secondary)]">
            {t('noCustomPresets')}
          </p>
        ) : (
          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
            {customPresets.map((cp, idx) => {
              const active =
                selectedWidth === cp.width && selectedHeight === cp.height
              const isEditing = editingId === cp.id

              if (isEditing) {
                return (
                  <div
                    key={cp.id}
                    className="p-2 bg-[var(--bg-surface)] border-2 border-[var(--accent-primary)] space-y-1.5"
                    data-testid={`custom-preset-edit-row-${cp.id}`}
                  >
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full min-h-[32px] px-2 text-xs font-bold pixel-input"
                      data-testid="edit-custom-preset-name"
                    />
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={MIN_CANVAS_SIZE}
                        max={MAX_CANVAS_SIZE}
                        value={editW}
                        onChange={(e) => setEditW(Number(e.target.value))}
                        className="w-16 min-h-[32px] px-2 text-xs pixel-input"
                        data-testid="edit-custom-preset-w"
                      />
                      <span className="text-xs">×</span>
                      <input
                        type="number"
                        min={MIN_CANVAS_SIZE}
                        max={MAX_CANVAS_SIZE}
                        value={editH}
                        onChange={(e) => setEditH(Number(e.target.value))}
                        className="w-16 min-h-[32px] px-2 text-xs pixel-input"
                        data-testid="edit-custom-preset-h"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          const nw = Math.max(
                            MIN_CANVAS_SIZE,
                            Math.min(MAX_CANVAS_SIZE, Math.round(editW || 1))
                          )
                          const nh = Math.max(
                            MIN_CANVAS_SIZE,
                            Math.min(MAX_CANVAS_SIZE, Math.round(editH || 1))
                          )
                          const ok = await updateCustomCanvasPreset(cp.id, {
                            name: editName,
                            width: nw,
                            height: nh,
                          })
                          if (!ok) {
                            showToast(t('presetDuplicateWarning'), 'warning')
                            return
                          }
                          onSelectDimensions(nw, nh)
                          setEditingId(null)
                        }}
                        className="pixel-btn pixel-btn-teal min-h-[32px] px-2.5 text-xs font-bold ml-auto"
                        data-testid="save-custom-preset-btn"
                      >
                        {t('save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="pixel-btn min-h-[32px] px-2 text-xs font-bold"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={cp.id}
                  className={`flex items-center justify-between gap-1.5 px-2 py-1 border-2 ${
                    active
                      ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)]'
                      : 'bg-[var(--bg-surface)] border-[var(--border-pixel)]'
                  }`}
                  data-testid={`custom-preset-item-${cp.id}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectDimensions(cp.width, cp.height)}
                    className="flex-1 min-w-0 flex items-center gap-1.5 text-left py-1 cursor-pointer"
                    data-testid={`select-custom-preset-${cp.id}`}
                  >
                    {active && <PixelIcon name="check" size={12} />}
                    <span className="text-xs font-bold truncate">{cp.name}</span>
                    <span className="text-[10px] text-[var(--text-secondary)] shrink-0">
                      ({cp.width}×{cp.height})
                    </span>
                  </button>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => void moveCustomStep(cp.id, -1)}
                      className="pixel-btn min-w-[28px] min-h-[28px] flex items-center justify-center"
                      title={t('moveUp')}
                    >
                      <PixelIcon name="arrowUp" size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={idx === customPresets.length - 1}
                      onClick={() => void moveCustomStep(cp.id, 1)}
                      className="pixel-btn min-w-[28px] min-h-[28px] flex items-center justify-center"
                      title={t('moveDown')}
                    >
                      <PixelIcon name="arrowDown" size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(cp.id)
                        setEditName(cp.name)
                        setEditW(cp.width)
                        setEditH(cp.height)
                      }}
                      className="pixel-btn min-w-[28px] min-h-[28px] flex items-center justify-center"
                      title={t('edit')}
                      data-testid={`edit-custom-preset-btn-${cp.id}`}
                    >
                      <PixelIcon name="edit" size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteCustomCanvasPreset(cp.id)}
                      className="pixel-btn pixel-btn-danger min-w-[28px] min-h-[28px] flex items-center justify-center"
                      title={t('delete')}
                      data-testid={`delete-custom-preset-btn-${cp.id}`}
                    >
                      <PixelIcon name="trash" size={12} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
