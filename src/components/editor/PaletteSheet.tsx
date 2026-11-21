import { useEffect, useState } from 'react'
import type { PaletteData, ProjectPalette } from '../../types'
import {
  clampByte,
  hexToHsv,
  hexToRgba,
  hsvToHex,
  normalizeHex,
  rgbaToHex,
} from '../../engine/color'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { useI18n } from '../../i18n/I18nContext'

interface PaletteSheetProps {
  open: boolean
  onClose: () => void
  palette: ProjectPalette
  selectedIndex: number
  libraryPalettes: PaletteData[]
  onSelectColor: (index: number) => void
  onUpdatePalette: (next: ProjectPalette, nextSelectedIdx?: number) => void
  onSaveToLibrary: (name: string, colors: string[]) => Promise<void>
}

export function PaletteSheet({
  open,
  onClose,
  palette,
  selectedIndex,
  libraryPalettes,
  onSelectColor,
  onUpdatePalette,
  onSaveToLibrary,
}: PaletteSheetProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'hsv' | 'rgb' | 'hex'>('hsv')
  const [showLibraryPicker, setShowLibraryPicker] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  const currentHex = palette.colors[selectedIndex] ?? palette.colors[0] ?? '#000000'
  const rgb = hexToRgba(currentHex)
  const [hsv, setHsv] = useState(() => hexToHsv(currentHex))
  const [hexInput, setHexInput] = useState(currentHex)
  const [nameInput, setNameInput] = useState(palette.name)

  useEffect(() => {
    setHsv(hexToHsv(currentHex))
    setHexInput(currentHex)
  }, [currentHex, selectedIndex])

  useEffect(() => {
    setNameInput(palette.name)
  }, [palette.name])

  const commitActiveColorHex = (nextHex: string) => {
    const norm = normalizeHex(nextHex)
    if (!norm) return
    const nextColors = [...palette.colors]
    nextColors[selectedIndex] = norm
    onUpdatePalette({ ...palette, colors: nextColors }, selectedIndex)
  }

  const handleHsvChange = (nextH: number, nextS: number, nextV: number) => {
    const h = Math.max(0, Math.min(360, Math.round(nextH)))
    const s = Math.max(0, Math.min(100, Math.round(nextS)))
    const v = Math.max(0, Math.min(100, Math.round(nextV)))
    setHsv({ h, s, v })
    const hex = hsvToHex(h, s, v)
    setHexInput(hex)
    commitActiveColorHex(hex)
  }

  const handleRgbChange = (r: number, g: number, b: number) => {
    const hex = rgbaToHex({
      r: clampByte(r),
      g: clampByte(g),
      b: clampByte(b),
    })
    setHexInput(hex)
    setHsv(hexToHsv(hex))
    commitActiveColorHex(hex)
  }

  const handleHexInputChange = (raw: string) => {
    setHexInput(raw)
    const norm = normalizeHex(raw)
    if (norm) {
      setHsv(hexToHsv(norm))
      commitActiveColorHex(norm)
    }
  }

  const handleAddColor = () => {
    if (palette.colors.length >= 256) return
    const nextColors = [...palette.colors, currentHex]
    onUpdatePalette({ ...palette, colors: nextColors }, nextColors.length - 1)
  }

  const handleDeleteColor = () => {
    if (palette.colors.length <= 1) return
    const nextColors = palette.colors.filter((_, i) => i !== selectedIndex)
    const nextIdx = Math.min(selectedIndex, nextColors.length - 1)
    onUpdatePalette({ ...palette, colors: nextColors }, nextIdx)
  }

  const moveColor = (delta: -1 | 1) => {
    const target = selectedIndex + delta
    if (target < 0 || target >= palette.colors.length) return
    const nextColors = [...palette.colors]
    const [moved] = nextColors.splice(selectedIndex, 1)
    nextColors.splice(target, 0, moved)
    onUpdatePalette({ ...palette, colors: nextColors }, target)
  }

  return (
    <Modal open={open} title={t('paletteTitle')} onClose={onClose} maxWidthClass="max-w-lg">
      <div className="space-y-3.5">
        {/* Palette Name & Library Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => {
              if (nameInput.trim() && nameInput.trim() !== palette.name) {
                onUpdatePalette({ ...palette, name: nameInput.trim() })
              }
            }}
            placeholder={t('paletteName')}
            className="flex-1 min-w-[130px] min-h-[40px] px-2.5 text-xs font-bold pixel-input"
          />
          <button
            type="button"
            onClick={() => void onSaveToLibrary(nameInput || palette.name, palette.colors)}
            className="pixel-btn pixel-btn-active min-h-[40px] px-2.5 text-xs font-bold flex items-center gap-1"
            data-testid="save-palette-to-lib-btn"
          >
            <PixelIcon name="plus" size={14} />
            {t('saveToLibrary')}
          </button>
          <button
            type="button"
            onClick={() =>
              void onSaveToLibrary(`${nameInput || palette.name} Copy`, palette.colors)
            }
            className="pixel-btn min-h-[40px] px-2.5 text-xs font-bold flex items-center gap-1"
          >
            <PixelIcon name="copy" size={14} />
            {t('duplicatePalette')}
          </button>
          <button
            type="button"
            onClick={() => setShowLibraryPicker((v) => !v)}
            className={`min-h-[40px] px-2.5 text-xs font-bold flex items-center gap-1 ${
              showLibraryPicker ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
          >
            <PixelIcon name="palette" size={14} />
            {t('loadFromLibrary')}
          </button>
        </div>

        {showLibraryPicker && (
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1.5 max-h-44 overflow-y-auto">
            {libraryPalettes.map((lib) => (
              <button
                key={lib.id}
                type="button"
                onClick={() => {
                  onUpdatePalette(
                    {
                      name: lib.name,
                      colors: [...lib.colors],
                      sourcePaletteId: lib.id,
                    },
                    0
                  )
                  setShowLibraryPicker(false)
                }}
                className="w-full p-2 pixel-btn flex items-center justify-between gap-2 text-left"
              >
                <span className="text-xs font-bold truncate">{lib.name}</span>
                <div className="flex items-center gap-0.5 shrink-0">
                  {lib.colors.slice(0, 8).map((c, i) => (
                    <span
                      key={i}
                      style={{ backgroundColor: c }}
                      className="w-3.5 h-3.5 border border-[var(--border-pixel)]"
                    />
                  ))}
                  <span className="text-[10px] text-[var(--text-secondary)] ml-1">
                    ({lib.colors.length})
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Color Swatch Grid */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="text-[var(--text-secondary)]">
              {palette.colors.length} / 256 {t('colorsCount')}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={selectedIndex <= 0}
                onClick={() => moveColor(-1)}
                title={t('reorderLeft')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
              >
                <PixelIcon name="arrowLeft" size={14} />
              </button>
              <button
                type="button"
                disabled={selectedIndex >= palette.colors.length - 1}
                onClick={() => moveColor(1)}
                title={t('reorderRight')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
              >
                <PixelIcon name="arrowRight" size={14} />
              </button>
              <button
                type="button"
                disabled={palette.colors.length >= 256}
                onClick={handleAddColor}
                className="pixel-btn pixel-btn-teal min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="palette-add-color"
              >
                <PixelIcon name="plus" size={14} />
                {t('addColor')}
              </button>
              <button
                type="button"
                disabled={palette.colors.length <= 1}
                onClick={handleDeleteColor}
                className="pixel-btn pixel-btn-danger min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="palette-del-color"
              >
                <PixelIcon name="trash" size={14} />
                {t('deleteColor')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-8 sm:grid-cols-10 gap-1.5 max-h-40 overflow-y-auto p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            {palette.colors.map((hex, idx) => {
              const active = idx === selectedIndex
              return (
                <button
                  key={`${idx}-${hex}`}
                  type="button"
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx === null || dragIdx === idx) return
                    const nextColors = [...palette.colors]
                    const [moved] = nextColors.splice(dragIdx, 1)
                    nextColors.splice(idx, 0, moved)
                    setDragIdx(null)
                    onUpdatePalette({ ...palette, colors: nextColors }, idx)
                  }}
                  onClick={() => onSelectColor(idx)}
                  style={{ backgroundColor: hex }}
                  className={`relative aspect-square cursor-pointer ${
                    active
                      ? 'border-2 border-[var(--text-primary)] outline-2 outline-[var(--accent-primary)] z-10'
                      : 'border-2 border-[var(--border-pixel)]'
                  }`}
                >
                  {active && (
                    <span
                      className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[var(--bg-panel)] border border-[var(--border-pixel)] flex items-center justify-center text-[var(--text-primary)]"
                      aria-hidden="true"
                    >
                      <PixelIcon name="check" size={9} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Live Color Preview + HSV / RGB / HEX Sliders & Inputs */}
        <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span
                className="w-10 h-10 border-2 border-[var(--border-pixel)] shadow-[2px_2px_0px_var(--shadow-pixel)] shrink-0"
                style={{ backgroundColor: currentHex }}
                data-testid="palette-live-preview"
              />
              <div>
                <div className="text-xs font-bold text-[var(--text-primary)]">
                  {currentHex}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)]">
                  R:{rgb.r} G:{rgb.g} B:{rgb.b}
                </div>
              </div>
            </div>

            <div className="flex gap-1">
              {(['hsv', 'rgb', 'hex'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setTab(m)}
                  className={`min-h-[36px] px-2.5 text-xs font-bold uppercase ${
                    tab === m ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                  }`}
                  data-testid={`color-tab-${m}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {tab === 'hsv' && (
            <div className="space-y-2">
              <SliderNumberRow
                label={t('hue')}
                min={0}
                max={360}
                value={hsv.h}
                onChange={(val) => handleHsvChange(val, hsv.s, hsv.v)}
              />
              <SliderNumberRow
                label={t('saturation')}
                min={0}
                max={100}
                value={hsv.s}
                onChange={(val) => handleHsvChange(hsv.h, val, hsv.v)}
              />
              <SliderNumberRow
                label={t('value')}
                min={0}
                max={100}
                value={hsv.v}
                onChange={(val) => handleHsvChange(hsv.h, hsv.s, val)}
              />
            </div>
          )}

          {tab === 'rgb' && (
            <div className="space-y-2">
              <SliderNumberRow
                label={t('red')}
                min={0}
                max={255}
                value={rgb.r}
                onChange={(val) => handleRgbChange(val, rgb.g, rgb.b)}
              />
              <SliderNumberRow
                label={t('green')}
                min={0}
                max={255}
                value={rgb.g}
                onChange={(val) => handleRgbChange(rgb.r, val, rgb.b)}
              />
              <SliderNumberRow
                label={t('blue')}
                min={0}
                max={255}
                value={rgb.b}
                onChange={(val) => handleRgbChange(rgb.r, rgb.g, val)}
              />
            </div>
          )}

          {tab === 'hex' && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-[var(--text-secondary)] shrink-0">
                {t('hexCode')}
              </label>
              <input
                type="text"
                value={hexInput}
                onChange={(e) => handleHexInputChange(e.target.value)}
                placeholder="#RRGGBB"
                maxLength={7}
                className="flex-1 min-h-[38px] px-3 text-sm pixel-input uppercase"
                data-testid="hex-direct-input"
              />
              <input
                type="color"
                value={currentHex}
                onChange={(e) => handleHexInputChange(e.target.value)}
                className="w-9 h-9 border-2 border-[var(--border-pixel)] cursor-pointer bg-transparent"
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function SliderNumberRow({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (next: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-xs font-bold text-[var(--text-secondary)] shrink-0">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[var(--accent-primary)]"
      />
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) {
            onChange(Math.max(min, Math.min(max, v)))
          }
        }}
        className="w-16 min-h-[32px] px-2 text-xs text-right pixel-input"
      />
    </div>
  )
}
