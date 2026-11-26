import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import {
  TRANSPARENT_COLOR_INDEX,
  type LayerRuntime,
  type PaletteData,
  type ProjectPalette,
} from '../../types'
import {
  clampByte,
  hexToHsv,
  hexToRgba,
  hsvToHex,
  normalizeHex,
  rgbaToHex,
} from '../../engine/color'
import {
  mergeLospecPaletteColors,
  type LospecFetchedPalette,
} from '../../db/lospec'
import { Modal } from '../common/Modal'
import { LospecImportModal } from '../common/LospecImportModal'
import { PaletteToolsModal } from './PaletteToolsModal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelSlider } from '../common/PixelSlider'
import { PixelSelect } from '../common/PixelSelect'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useLongPressReorder } from '../../utils/useLongPressReorder'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

interface PaletteSheetProps {
  open: boolean
  onClose: () => void
  palette: ProjectPalette
  selectedIndex: number
  checkerDark?: boolean
  libraryPalettes: PaletteData[]
  onSelectColor: (index: number) => void
  onUpdatePalette: (next: ProjectPalette, nextSelectedIdx?: number) => void
  onSaveToLibrary: (
    name: string,
    colors: string[],
    meta?: Partial<Pick<PaletteData, 'author' | 'sourceUrl' | 'lospecSlug' | 'licenseNote'>>
  ) => Promise<void>
  canvasWidth?: number
  canvasHeight?: number
  layers?: readonly LayerRuntime[]
  activeLayerId?: string
  onReplaceColor?: (params: {
    sourceHex: string
    targetHexOrTransparent: string | 'transparent'
    layerScope: 'all' | 'active-layer'
    frameScope: 'all-frames' | 'active-frame'
    updatePaletteSwatch: boolean
  }) => number
}

export function PaletteSheet({
  open,
  onClose,
  palette,
  selectedIndex,
  checkerDark = false,
  libraryPalettes,
  onSelectColor,
  onUpdatePalette,
  onSaveToLibrary,
  canvasWidth,
  canvasHeight,
  layers,
  activeLayerId,
  onReplaceColor,
}: PaletteSheetProps) {
  const { t } = useI18n()
  const { reducedMotion, showToast } = useApp()
  const [tab, setTab] = useState<'hsv' | 'rgb' | 'hex'>('hsv')
  const [toolsModalOpen, setToolsModalOpen] = useState(false)
  const swatchGridRef = useRef<HTMLDivElement | null>(null)

  const colorIds = palette.colors.map((_, idx) => `ps-${idx}`)
  const { dragState, getItemProps, shouldSuppressClick } = useLongPressReorder({
    ids: colorIds,
    enabled: palette.colors.length > 1,
    axis: 'both',
    longPressMs: 150,
    scopeId: 'palette-sheet-colors',
    scrollContainerRef: swatchGridRef,
    onReorder: (nextIds) => {
      const nextIndices = nextIds.map((id) => Number(id.slice(3)))
      const nextColors = nextIndices.map((i) => palette.colors[i]!)
      let nextSel = selectedIndex
      if (selectedIndex >= 0) {
        const movedTo = nextIndices.indexOf(selectedIndex)
        if (movedTo >= 0) nextSel = movedTo
      }
      onUpdatePalette({ ...palette, colors: nextColors }, nextSel)
    },
  })

  const isTransparentSelected = selectedIndex === TRANSPARENT_COLOR_INDEX
  const editableColorIndex = isTransparentSelected
    ? 0
    : Math.max(0, Math.min(palette.colors.length - 1, selectedIndex))
  const currentHex = palette.colors[editableColorIndex] ?? palette.colors[0] ?? '#000000'
  const rgb = hexToRgba(currentHex)
  const [hsv, setHsv] = useState(() => hexToHsv(currentHex))
  const [hexInput, setHexInput] = useState(currentHex)
  const [nameInput, setNameInput] = useState(palette.name)
  const [lospecOpen, setLospecOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  /** Preserve selection across initial mouseup/pointerup after focusing the palette name input! */
  const selectAllOnMouseUpRef = useRef(false)
  /** Suppress onBlur commit when user explicitly cancels via Escape */
  const skipNextBlurCommitRef = useRef(false)

  useEffect(() => {
    setHsv(hexToHsv(currentHex))
    setHexInput(currentHex)
  }, [currentHex, editableColorIndex])

  useEffect(() => {
    setNameInput(palette.name)
  }, [palette.name])

  const commitActiveColorHex = (nextHex: string) => {
    if (isTransparentSelected) return
    const norm = normalizeHex(nextHex)
    if (!norm) return
    const nextColors = [...palette.colors]
    nextColors[editableColorIndex] = norm
    onUpdatePalette({ ...palette, colors: nextColors }, editableColorIndex)
  }

  const handleHsvChange = (nextH: number, nextS: number, nextV: number) => {
    if (isTransparentSelected) return
    const h = Math.max(0, Math.min(360, Math.round(nextH)))
    const s = Math.max(0, Math.min(100, Math.round(nextS)))
    const v = Math.max(0, Math.min(100, Math.round(nextV)))
    setHsv({ h, s, v })
    const hex = hsvToHex(h, s, v)
    setHexInput(hex)
    commitActiveColorHex(hex)
  }

  const handleRgbChange = (r: number, g: number, b: number) => {
    if (isTransparentSelected) return
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
    if (isTransparentSelected) return
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
    if (isTransparentSelected || palette.colors.length <= 1) return
    const nextColors = palette.colors.filter((_, i) => i !== editableColorIndex)
    const nextIdx = Math.min(editableColorIndex, nextColors.length - 1)
    onUpdatePalette({ ...palette, colors: nextColors }, nextIdx)
  }

  const moveColor = (delta: -1 | 1) => {
    if (isTransparentSelected) return
    const target = editableColorIndex + delta
    if (target < 0 || target >= palette.colors.length) return
    const nextColors = [...palette.colors]
    const [moved] = nextColors.splice(editableColorIndex, 1)
    nextColors.splice(target, 0, moved)
    onUpdatePalette({ ...palette, colors: nextColors }, target)
  }

  const libraryOptions = libraryPalettes.map((lib) => ({
    value: lib.id,
    label: lib.name,
    subLabel: `(${lib.colors.length})`,
    swatchColors: lib.colors,
  }))

  return (
    <Modal open={open} title={t('paletteTitle')} onClose={onClose} maxWidthClass="max-w-lg">
      <div className="space-y-3.5">
        {/* Palette Name & Library Controls */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={nameInputRef}
              type="text"
              value={nameInput}
              onPointerDown={() => {
                if (document.activeElement !== nameInputRef.current) {
                  selectAllOnMouseUpRef.current = true
                }
              }}
              onFocus={(e) => {
                e.currentTarget.select()
              }}
              onMouseUp={(e) => {
                if (selectAllOnMouseUpRef.current) {
                  selectAllOnMouseUpRef.current = false
                  e.preventDefault()
                  e.currentTarget.select()
                }
              }}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => {
                selectAllOnMouseUpRef.current = false
                if (skipNextBlurCommitRef.current) {
                  skipNextBlurCommitRef.current = false
                  return
                }
                const trimmed = nameInput.trim()
                if (trimmed && trimmed !== palette.name) {
                  onUpdatePalette({ ...palette, name: trimmed })
                } else {
                  setNameInput(palette.name)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const trimmed = nameInput.trim()
                  if (trimmed) {
                    if (trimmed !== palette.name) {
                      onUpdatePalette({ ...palette, name: trimmed })
                    }
                    skipNextBlurCommitRef.current = true
                    e.currentTarget.blur()
                  } else {
                    setNameInput(palette.name)
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  selectAllOnMouseUpRef.current = false
                  skipNextBlurCommitRef.current = true
                  setNameInput(palette.name)
                  e.currentTarget.blur()
                }
              }}
              placeholder={t('paletteName')}
              className="flex-1 min-w-[130px] min-h-[40px] px-2.5 text-xs font-bold pixel-input select-text"
              data-testid="palette-name-input"
            />
            <button
              type="button"
              onClick={() =>
                void onSaveToLibrary(nameInput || palette.name, palette.colors)
              }
              className="pixel-btn pixel-btn-active min-h-[40px] px-2.5 text-xs font-bold flex items-center gap-1"
              data-testid="save-palette-to-lib-btn"
            >
              <PixelIcon name="plus" size={14} />
              {t('saveToLibrary')}
            </button>
            <button
              type="button"
              onClick={() =>
                void onSaveToLibrary(
                  `${nameInput || palette.name} Copy`,
                  palette.colors
                )
              }
              className="pixel-btn min-h-[40px] px-2.5 text-xs font-bold flex items-center gap-1"
            >
              <PixelIcon name="copy" size={14} />
              {t('duplicatePalette')}
            </button>
            <button
              type="button"
              onClick={() => setLospecOpen(true)}
              className="pixel-btn pixel-btn-teal min-h-[40px] px-2.5 text-xs font-bold flex items-center gap-1"
              data-testid="open-lospec-import-btn"
            >
              <PixelIcon name="download" size={14} />
              {t('lospecImportBtn')}
            </button>
          </div>

          {(palette.author || palette.sourceUrl) && (
            <div
              className="text-[11px] text-[var(--text-secondary)] flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1"
              data-testid="palette-attribution-info"
            >
              {palette.author && (
                <span>
                  {t('lospecAuthorLabel')}: <strong className="text-[var(--text-primary)]">{palette.author}</strong>
                </span>
              )}
              {palette.sourceUrl && (
                <a
                  href={palette.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-[var(--accent-teal)] truncate max-w-[240px]"
                >
                  {palette.sourceUrl}
                </a>
              )}
            </div>
          )}

          {libraryOptions.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[var(--text-secondary)] shrink-0">
                {t('loadFromLibrary')}:
              </span>
              <PixelSelect<string>
                value={palette.sourcePaletteId ?? libraryOptions[0].value}
                options={libraryOptions}
                onChange={(pickedId) => {
                  const lib = libraryPalettes.find((p) => p.id === pickedId)
                  if (!lib) return
                  onUpdatePalette(
                    {
                      name: lib.name,
                      colors: [...lib.colors],
                      sourcePaletteId: lib.id,
                      author: lib.author,
                      sourceUrl: lib.sourceUrl,
                    },
                    0
                  )
                }}
                ariaLabel={t('loadFromLibrary')}
                className="flex-1 min-w-0"
                testId="palette-library-select"
              />
            </div>
          )}
        </div>

        {/* Color Swatch Grid (Transparent Slot fixed at leftmost position, excluded from 256-color cap & reorder) */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="text-[var(--text-secondary)]">
              {palette.colors.length} / 256 {t('colorsCount')}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setToolsModalOpen(true)}
                className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="palette-open-tools-btn"
              >
                <PixelIcon name="replace" size={13} />
                <span>{t('paletteOrganizeBtn')}</span>
              </button>
              <button
                type="button"
                disabled={isTransparentSelected || editableColorIndex <= 0}
                onClick={() => moveColor(-1)}
                title={t('reorderLeft')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
              >
                <PixelIcon name="arrowLeft" size={14} />
              </button>
              <button
                type="button"
                disabled={
                  isTransparentSelected ||
                  editableColorIndex >= palette.colors.length - 1
                }
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
                disabled={isTransparentSelected || palette.colors.length <= 1}
                onClick={handleDeleteColor}
                className="pixel-btn pixel-btn-danger min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="palette-del-color"
              >
                <PixelIcon name="trash" size={14} />
                {t('deleteColor')}
              </button>
            </div>
          </div>

          <div
            ref={swatchGridRef}
            className="grid grid-cols-8 sm:grid-cols-10 gap-1.5 max-h-40 overflow-y-auto p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]"
          >
            {/* Fixed Leftmost Transparent Slot */}
            <button
              type="button"
              onClick={() => onSelectColor(TRANSPARENT_COLOR_INDEX)}
              title={t('transparentSlotLabel')}
              aria-label={t('transparentSlotLabel')}
              aria-pressed={isTransparentSelected}
              style={getCheckerboardStyle(checkerDark, 8)}
              className={`relative aspect-square cursor-pointer flex items-center justify-center ${
                isTransparentSelected
                  ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)] z-10'
                  : 'border-2 border-[var(--border-pixel)]'
              }`}
              data-testid="sheet-color-transparent"
            >
              <PixelIcon
                name="transparent"
                size={15}
                className="text-[var(--accent-rose)]"
              />
              {isTransparentSelected && (
                <span
                  className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[var(--bg-panel)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-primary)]"
                  aria-hidden="true"
                >
                  <PixelIcon name="check" size={9} />
                </span>
              )}
            </button>

            {palette.colors.map((hex, idx) => {
              const active = idx === selectedIndex
              const itemId = `ps-${idx}`
              const isDragging = dragState?.draggingId === itemId
              const isDropTarget =
                dragState !== null &&
                dragState.overId === itemId &&
                dragState.draggingId !== itemId
              return (
                <button
                  key={`${idx}-${hex}`}
                  type="button"
                  {...getItemProps(itemId)}
                  onClick={() => {
                    if (shouldSuppressClick()) return
                    onSelectColor(idx)
                  }}
                  style={{ backgroundColor: hex }}
                  className={`relative aspect-square cursor-pointer ${
                    isDropTarget
                      ? 'border-2 border-[var(--accent-teal)] outline-2 outline-dashed outline-[var(--accent-teal)] z-20'
                      : active
                        ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)] z-10'
                        : 'border-2 border-[var(--border-pixel)]'
                  } ${isDragging ? 'opacity-60' : ''}`}
                  data-testid={`sheet-color-${idx}`}
                >
                  {active && (
                    <span
                      className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-[var(--bg-panel)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-primary)]"
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

        {/* Live Color Preview + HSV / RGB / HEX PixelSliders & Inputs */}
        {isTransparentSelected ? (
          <div
            className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex items-center gap-3"
            data-testid="palette-transparent-info"
          >
            <span
              className="w-10 h-10 border-2 border-[var(--border-strong)] shrink-0 flex items-center justify-center"
              style={getCheckerboardStyle(checkerDark, 8)}
            >
              <PixelIcon
                name="transparent"
                size={18}
                className="text-[var(--accent-rose)]"
              />
            </span>
            <div className="space-y-0.5">
              <div className="text-xs font-bold text-[var(--text-primary)]">
                {t('transparentSlotLabel')} (RGBA 0, 0, 0, 0)
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                {t('transparentSlotHint')}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className="w-10 h-10 border-2 border-[var(--border-strong)] shrink-0"
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
                {(['hsv', 'rgb', 'hex'] as const).map((m) => {
                  const active = tab === m
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setTab(m)}
                      className={`relative min-h-[36px] px-2.5 text-xs font-bold uppercase overflow-hidden ${
                        active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                      }`}
                      data-testid={`color-tab-${m}`}
                    >
                      {active && !reducedMotion && (
                        <motion.span
                          layoutId="palette-color-mode-pill"
                          transition={{
                            type: 'spring',
                            stiffness: 520,
                            damping: 36,
                          }}
                          className="absolute inset-0 bg-[var(--accent-primary)] pointer-events-none"
                          aria-hidden="true"
                        />
                      )}
                      <span className="relative z-10">{m}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <motion.div
              key={tab}
              initial={reducedMotion ? false : { opacity: 0.72, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.12, ease: 'easeOut' }}
            >
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
            </motion.div>
          </div>
        )}
      </div>

      <LospecImportModal
        open={lospecOpen}
        onClose={() => setLospecOpen(false)}
        allowAppendReplace={true}
        onConfirmImport={async (
          fetched: LospecFetchedPalette,
          mode,
          alsoSaveToLib
        ) => {
          const merged = mergeLospecPaletteColors(
            palette.colors,
            fetched.colors,
            mode
          )
          const nextName = mode === 'replace' ? fetched.name : palette.name
          onUpdatePalette(
            {
              name: nextName,
              colors: merged.colors,
              author: mode === 'replace' ? fetched.author || undefined : palette.author,
              sourceUrl:
                mode === 'replace' ? fetched.sourceUrl : palette.sourceUrl,
            },
            mode === 'replace' ? 0 : Math.min(palette.colors.length, merged.colors.length - 1)
          )
          if (alsoSaveToLib) {
            await onSaveToLibrary(fetched.name, fetched.colors, {
              author: fetched.author || undefined,
              sourceUrl: fetched.sourceUrl,
              lospecSlug: fetched.slug,
            })
          }
        }}
      />

      <PaletteToolsModal
        open={toolsModalOpen}
        onClose={() => setToolsModalOpen(false)}
        palette={palette}
        selectedIndex={selectedIndex}
        checkerDark={checkerDark}
        onUpdatePalette={onUpdatePalette}
        onSelectColor={onSelectColor}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        layers={layers}
        activeLayerId={activeLayerId}
        onReplaceColor={onReplaceColor}
        onToast={(msg) => showToast(msg, 'success')}
      />
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
    <div className="flex items-center gap-2.5">
      <span className="w-20 text-xs font-bold text-[var(--text-secondary)] shrink-0">
        {label}
      </span>
      <PixelSlider
        min={min}
        max={max}
        value={value}
        ariaLabel={label}
        onChange={onChange}
        className="flex-1"
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
