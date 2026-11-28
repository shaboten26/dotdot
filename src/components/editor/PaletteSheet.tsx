import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import {
  MAX_OPAQUE_PALETTE_COLORS,
  TRANSPARENT_COLOR_INDEX,
  type LayerRuntime,
  type PaletteData,
  type ProjectPalette,
} from '../../types'
import { updateIndexedPaletteSlotColor } from '../../engine/indexedPalette'
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
import { PaletteArtworkPreview } from './PaletteArtworkPreview'
import { PixelColorWheel } from '../common/PixelColorWheel'
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
  /** Counts how many pixels across all frames/layers currently reference a display slot */
  onCountColorSlotUsage?: (displayIndex: number) => number
  /** Safely deletes a palette slot while remapping any referencing pixels (Undo-able) */
  onDeleteColorSlot?: (
    displayIndex: number,
    replacement:
      | { kind: 'transparent' }
      | { kind: 'displayIndex'; targetDisplayIndex: number }
  ) => void
  /** Removes all unused palette slots across the project in 1 Undo step */
  onRemoveUnusedColors?: () => number
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
  onCountColorSlotUsage,
  onDeleteColorSlot,
  onRemoveUnusedColors,
}: PaletteSheetProps) {
  const { t } = useI18n()
  const { reducedMotion, showToast } = useApp()
  const [tab, setTab] = useState<'wheel' | 'hsv' | 'rgb' | 'hex'>('wheel')
  const [toolsModalOpen, setToolsModalOpen] = useState(false)
  const swatchGridRef = useRef<HTMLDivElement | null>(null)

  // State for safe deletion dialog when a palette color is used by >=1 pixel
  const [pendingDeleteDialog, setPendingDeleteDialog] = useState<{
    displayIndex: number
    hex: string
    usageCount: number
  } | null>(null)
  const [deleteReplaceTarget, setDeleteReplaceTarget] = useState<
    number | 'transparent'
  >(0)

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
  const currentHex =
    palette.colors[editableColorIndex] ?? palette.colors[0] ?? '#000000'
  const rgb = hexToRgba(currentHex)
  const [hsv, setHsv] = useState(() => hexToHsv(currentHex))
  const [hexInput, setHexInput] = useState(currentHex)
  const [nameInput, setNameInput] = useState(palette.name)
  const [lospecOpen, setLospecOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const selectAllOnMouseUpRef = useRef(false)
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
    if (
      Array.isArray(palette.colorTable) &&
      Array.isArray(palette.displayOrder) &&
      palette.displayOrder.length === palette.colors.length
    ) {
      const updatedPal = updateIndexedPaletteSlotColor(
        palette,
        editableColorIndex,
        norm
      )
      onUpdatePalette(updatedPal, editableColorIndex)
      return
    }
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
    if (palette.colors.length >= MAX_OPAQUE_PALETTE_COLORS) {
      showToast(t('paletteLimitReachedMsg'), 'info')
      return
    }
    const nextColors = [...palette.colors, currentHex]
    onUpdatePalette({ ...palette, colors: nextColors }, nextColors.length - 1)
  }

  const handleDeleteColor = () => {
    if (isTransparentSelected || palette.colors.length <= 1) return

    if (onCountColorSlotUsage && onDeleteColorSlot) {
      const usageCount = onCountColorSlotUsage(editableColorIndex)
      if (usageCount > 0) {
        const defaultReplacement = palette.colors.findIndex(
          (_, idx) => idx !== editableColorIndex
        )
        setDeleteReplaceTarget(
          defaultReplacement >= 0 ? defaultReplacement : 'transparent'
        )
        setPendingDeleteDialog({
          displayIndex: editableColorIndex,
          hex: currentHex,
          usageCount,
        })
        return
      }
      onDeleteColorSlot(editableColorIndex, { kind: 'transparent' })
      return
    }

    const nextColors = palette.colors.filter((_, i) => i !== editableColorIndex)
    const nextIdx = Math.min(editableColorIndex, nextColors.length - 1)
    onUpdatePalette({ ...palette, colors: nextColors }, nextIdx)
  }

  const confirmDeleteUsedColor = () => {
    if (!pendingDeleteDialog || !onDeleteColorSlot) return
    const { displayIndex } = pendingDeleteDialog
    if (deleteReplaceTarget === 'transparent') {
      onDeleteColorSlot(displayIndex, { kind: 'transparent' })
    } else {
      onDeleteColorSlot(displayIndex, {
        kind: 'displayIndex',
        targetDisplayIndex: deleteReplaceTarget,
      })
    }
    setPendingDeleteDialog(null)
    showToast(t('paletteColorDeletedMsg'), 'success')
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
        {/* Top Live Current Artwork Preview (when editing inside an active artwork) */}
        <PaletteArtworkPreview
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          layers={layers}
          palette={palette}
          checkerDark={checkerDark}
          testId="palette-sheet-artwork-preview"
        />

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
                  {t('lospecAuthorLabel')}:{' '}
                  <strong className="text-[var(--text-primary)]">{palette.author}</strong>
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
                      colors: [...lib.colors].slice(0, MAX_OPAQUE_PALETTE_COLORS),
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

        {/* Color Swatch Grid (Transparent Slot fixed at leftmost position, excluded from 255-color cap & reorder) */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
            <span
              className="text-[var(--text-secondary)]"
              data-testid="palette-color-count-label"
            >
              {palette.colors.length} / {MAX_OPAQUE_PALETTE_COLORS} {t('colorsCount')}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setToolsModalOpen(true)}
                className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="palette-open-tools-btn"
              >
                <PixelIcon name="sparkle" size={13} />
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
                disabled={palette.colors.length >= MAX_OPAQUE_PALETTE_COLORS}
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
            {/* Fixed Leftmost Transparent Slot (Index 255 in 1-byte buffer) */}
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
                  key={`slot-${idx}`}
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
                {t('transparentSlotLabel')} (Index 255 / RGBA 0, 0, 0, 0)
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

              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { id: 'wheel', label: t('colorTabWheel') },
                    { id: 'hsv', label: 'HSV' },
                    { id: 'rgb', label: 'RGB' },
                    { id: 'hex', label: 'HEX' },
                  ] as const
                ).map((m) => {
                  const active = tab === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setTab(m.id)}
                      className={`relative min-h-[36px] px-2.5 text-xs font-bold overflow-hidden ${
                        active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                      }`}
                      data-testid={`color-tab-${m.id}`}
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
                      <span className="relative z-10">{m.label}</span>
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
              {tab === 'wheel' && (
                <PixelColorWheel
                  hue={hsv.h}
                  saturation={hsv.s}
                  value={hsv.v}
                  onChange={handleHsvChange}
                  hintText={t('colorWheelHint')}
                  testId="palette-pixel-color-wheel"
                />
              )}

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
                  <label className="relative w-9 h-9 border-2 border-[var(--border-pixel)] hover:border-[var(--border-strong)] cursor-pointer shrink-0 block">
                    <span
                      style={{ backgroundColor: currentHex }}
                      className="block w-full h-full"
                      aria-hidden="true"
                    />
                    <input
                      type="color"
                      value={currentHex}
                      aria-label={t('hexCode')}
                      onChange={(e) => handleHexInputChange(e.target.value)}
                      className="sr-only"
                    />
                  </label>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </div>

      {/* Safe In-Use Color Deletion & Replacement Modal (Section 7) */}
      <Modal
        open={pendingDeleteDialog !== null}
        title={t('deleteUsedColorTitle')}
        onClose={() => setPendingDeleteDialog(null)}
        maxWidthClass="max-w-md"
      >
        {pendingDeleteDialog && (
          <div className="space-y-3 text-xs" data-testid="delete-used-color-modal">
            <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex items-center gap-2.5">
              <span
                className="w-8 h-8 border-2 border-[var(--border-strong)] shrink-0"
                style={{ backgroundColor: pendingDeleteDialog.hex }}
              />
              <div>
                <div className="font-bold text-[var(--text-primary)]">
                  {pendingDeleteDialog.hex}
                </div>
                <div className="text-[11px] text-[var(--accent-rose)] font-bold">
                  {pendingDeleteDialog.usageCount} px
                </div>
              </div>
            </div>

            <p className="leading-relaxed text-[var(--text-secondary)]">
              {t('deleteUsedColorDesc')}
            </p>

            <div className="space-y-1.5">
              <div className="font-bold text-[var(--text-primary)]">
                {t('deleteUsedColorReplaceWithColor')}
              </div>
              <div className="flex flex-wrap gap-1.5 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] max-h-32 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setDeleteReplaceTarget('transparent')}
                  style={getCheckerboardStyle(checkerDark, 6)}
                  title={t('deleteUsedColorReplaceTransparent')}
                  className={`w-8 h-8 flex items-center justify-center cursor-pointer ${
                    deleteReplaceTarget === 'transparent'
                      ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                      : 'border border-[var(--border-pixel)]'
                  }`}
                  data-testid="delete-color-replace-transparent"
                >
                  <PixelIcon
                    name="transparent"
                    size={14}
                    className="text-[var(--accent-rose)]"
                  />
                </button>
                {palette.colors.map((hex, idx) => {
                  if (idx === pendingDeleteDialog.displayIndex) return null
                  const active = deleteReplaceTarget === idx
                  return (
                    <button
                      key={`del-rep-${idx}-${hex}`}
                      type="button"
                      onClick={() => setDeleteReplaceTarget(idx)}
                      style={{ backgroundColor: hex }}
                      title={`#${idx + 1} ${hex}`}
                      className={`w-8 h-8 cursor-pointer ${
                        active
                          ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                          : 'border border-[var(--border-pixel)]'
                      }`}
                      data-testid={`delete-color-replace-slot-${idx}`}
                    />
                  )
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPendingDeleteDialog(null)}
                className="pixel-btn min-h-[38px] px-3 text-xs font-bold"
                data-testid="cancel-delete-used-color-btn"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={confirmDeleteUsedColor}
                className="pixel-btn pixel-btn-danger min-h-[38px] px-3.5 text-xs font-bold flex items-center gap-1.5"
                data-testid="confirm-delete-used-color-btn"
              >
                <PixelIcon name="trash" size={13} />
                <span>{t('deleteUsedColorConfirmBtn')}</span>
              </button>
            </div>
          </div>
        )}
      </Modal>

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
            mode === 'replace'
              ? 0
              : Math.min(palette.colors.length, merged.colors.length - 1)
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
        onRemoveUnusedColors={onRemoveUnusedColors}
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
