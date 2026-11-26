import { useEffect, useMemo, useState } from 'react'
import {
  TRANSPARENT_COLOR_INDEX,
  type LayerRuntime,
  type ProjectPalette,
} from '../../types'
import {
  analyzeArtworkColors,
  restorePaletteOriginalOrder,
  sortProjectPalette,
  type PaletteSortMode,
} from '../../engine/paletteTools'
import { normalizeHex } from '../../engine/color'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

interface PaletteToolsModalProps {
  open: boolean
  onClose: () => void
  palette: ProjectPalette
  selectedIndex: number
  checkerDark?: boolean
  onUpdatePalette: (next: ProjectPalette, nextSelectedIdx?: number) => void
  onSelectColor?: (index: number) => void
  /** Optional artwork context (when opened inside Editor vs standalone Palette Library) */
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
  onToast?: (msg: string) => void
}

type ToolTab = 'sort' | 'analyze' | 'replace'
type ReplaceScopePreset = 'project' | 'frame' | 'layer'

export function PaletteToolsModal({
  open,
  onClose,
  palette,
  selectedIndex,
  checkerDark = false,
  onUpdatePalette,
  onSelectColor,
  canvasWidth = 0,
  canvasHeight = 0,
  layers,
  activeLayerId,
  onReplaceColor,
  onToast,
}: PaletteToolsModalProps) {
  const { t } = useI18n()
  const hasArtworkContext = Boolean(
    layers && layers.length > 0 && canvasWidth > 0 && canvasHeight > 0
  )

  const [tab, setTab] = useState<ToolTab>('sort')
  const [analyzeScope, setAnalyzeScope] = useState<'composite' | 'layer'>(
    'composite'
  )
  const [replaceScope, setReplaceScope] = useState<ReplaceScopePreset>('project')
  const [sourceHex, setSourceHex] = useState<string>(
    () => palette.colors[Math.max(0, selectedIndex)] ?? palette.colors[0] ?? '#000000'
  )
  const [targetHex, setTargetHex] = useState<string | 'transparent'>(
    () => palette.colors[0] ?? '#FFFFFF'
  )
  const [customTargetHex, setCustomTargetHex] = useState<string>('#FFFFFF')
  const [syncSwatchOnReplace, setSyncSwatchOnReplace] = useState<boolean>(false)

  useEffect(() => {
    if (!open) return
    if (!hasArtworkContext && tab !== 'sort') {
      setTab('sort')
    }
    const initialSrc =
      selectedIndex >= 0 && palette.colors[selectedIndex]
        ? palette.colors[selectedIndex]!
        : palette.colors[0] ?? '#000000'
    setSourceHex(initialSrc.toUpperCase())
    const altTarget =
      palette.colors.find((c) => c.toUpperCase() !== initialSrc.toUpperCase()) ??
      initialSrc
    setTargetHex(altTarget.toUpperCase())
    setCustomTargetHex(altTarget.toUpperCase())
  }, [open, hasArtworkContext])

  const analysis = useMemo(() => {
    if (!open || !hasArtworkContext || !layers) return null
    return analyzeArtworkColors({
      width: canvasWidth,
      height: canvasHeight,
      layers,
      palette,
      paletteColors: palette.colors,
      targetLayerId:
        analyzeScope === 'layer' && activeLayerId ? activeLayerId : 'composite',
    })
  }, [
    open,
    hasArtworkContext,
    layers,
    canvasWidth,
    canvasHeight,
    palette,
    analyzeScope,
    activeLayerId,
  ])

  const compositeAnalysisForReplace = useMemo(() => {
    if (!open || !hasArtworkContext || !layers || tab !== 'replace') return null
    return analyzeArtworkColors({
      width: canvasWidth,
      height: canvasHeight,
      layers,
      palette,
      paletteColors: palette.colors,
      targetLayerId:
        replaceScope === 'layer' && activeLayerId ? activeLayerId : 'composite',
    })
  }, [
    open,
    hasArtworkContext,
    layers,
    tab,
    canvasWidth,
    canvasHeight,
    palette,
    replaceScope,
    activeLayerId,
  ])

  const handleSort = (mode: PaletteSortMode) => {
    const res = sortProjectPalette(palette, selectedIndex, mode)
    onUpdatePalette(res.palette, res.nextSelectedIndex)
    onToast?.(t('paletteSortedMsg'))
  }

  const handleRestoreOrder = () => {
    const res = restorePaletteOriginalOrder(palette, selectedIndex)
    if (!res) return
    onUpdatePalette(res.palette, res.nextSelectedIndex)
    onToast?.(t('paletteRestoredMsg'))
  }

  // Candidate source colors combine used artwork colors + palette colors (deduplicated)
  const sourceCandidates = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    if (compositeAnalysisForReplace) {
      for (const entry of compositeAnalysisForReplace.entries) {
        const up = entry.hex.toUpperCase()
        if (!seen.has(up)) {
          seen.add(up)
          list.push(up)
        }
      }
    }
    for (const hex of palette.colors) {
      const up = hex.toUpperCase()
      if (!seen.has(up)) {
        seen.add(up)
        list.push(up)
      }
    }
    return list
  }, [compositeAnalysisForReplace, palette.colors])

  const executeReplace = () => {
    if (!onReplaceColor) return
    const resolvedTarget =
      targetHex === 'transparent'
        ? 'transparent'
        : normalizeHex(targetHex) ?? null
    const resolvedSource = normalizeHex(sourceHex)
    if (!resolvedSource || !resolvedTarget) return
    if (resolvedTarget !== 'transparent' && resolvedSource === resolvedTarget) {
      return
    }

    const count = onReplaceColor({
      sourceHex: resolvedSource,
      targetHexOrTransparent: resolvedTarget,
      layerScope: replaceScope === 'layer' ? 'active-layer' : 'all',
      frameScope: replaceScope === 'project' ? 'all-frames' : 'active-frame',
      updatePaletteSwatch: syncSwatchOnReplace && replaceScope === 'project',
    })
    if (count > 0 || syncSwatchOnReplace) {
      onToast?.(t('paletteReplacedMsg'))
    }
  }

  const canRestoreOriginal = Boolean(
    palette.originalColors && palette.originalColors.length > 0
  )

  return (
    <Modal
      open={open}
      title={t('paletteToolsTitle')}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3" data-testid="palette-tools-modal">
        {/* Top Mode Tabs */}
        {hasArtworkContext && (
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => setTab('sort')}
              className={`min-h-[38px] px-2 text-xs font-bold flex items-center justify-center gap-1 ${
                tab === 'sort' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="palette-tools-tab-sort"
            >
              <PixelIcon name="palette" size={13} />
              <span>{t('paletteTabSort')}</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('analyze')}
              className={`min-h-[38px] px-2 text-xs font-bold flex items-center justify-center gap-1 ${
                tab === 'analyze' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="palette-tools-tab-analyze"
            >
              <PixelIcon name="sparkle" size={13} />
              <span>{t('paletteTabAnalyze')}</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('replace')}
              disabled={!onReplaceColor}
              className={`min-h-[38px] px-2 text-xs font-bold flex items-center justify-center gap-1 ${
                tab === 'replace' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="palette-tools-tab-replace"
            >
              <PixelIcon name="replace" size={13} />
              <span>{t('paletteTabReplace')}</span>
            </button>
          </div>
        )}

        {/* TAB 1: SORT & RESTORE */}
        {tab === 'sort' && (
          <div className="space-y-3" data-testid="palette-sort-panel">
            {/* Live Swatch Preview Strip (Leftmost Transparent Slot fixed!) */}
            <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
              <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                <span
                  style={getCheckerboardStyle(checkerDark, 6)}
                  className={`w-6 h-6 border flex items-center justify-center shrink-0 ${
                    selectedIndex === TRANSPARENT_COLOR_INDEX
                      ? 'border-[var(--accent-primary)]'
                      : 'border-[var(--border-pixel)]'
                  }`}
                  title={t('transparentSlotLabel')}
                >
                  <PixelIcon
                    name="transparent"
                    size={11}
                    className="text-[var(--accent-rose)]"
                  />
                </span>
                {palette.colors.map((hex, i) => (
                  <span
                    key={`sort-prev-${i}-${hex}`}
                    style={{ backgroundColor: hex }}
                    className={`w-6 h-6 border shrink-0 ${
                      i === selectedIndex
                        ? 'border-2 border-[var(--accent-primary)]'
                        : 'border-[var(--border-pixel)]'
                    }`}
                    title={`${i + 1}: ${hex}`}
                  />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleSort('lightness-asc')}
                className="pixel-btn min-h-[40px] px-3 text-xs font-bold flex items-center justify-center gap-1.5"
                data-testid="palette-sort-light-asc"
              >
                <span>{t('paletteSortLightAsc')}</span>
              </button>
              <button
                type="button"
                onClick={() => handleSort('lightness-desc')}
                className="pixel-btn min-h-[40px] px-3 text-xs font-bold flex items-center justify-center gap-1.5"
                data-testid="palette-sort-light-desc"
              >
                <span>{t('paletteSortLightDesc')}</span>
              </button>
              <button
                type="button"
                onClick={() => handleSort('hue')}
                className="pixel-btn min-h-[40px] px-3 text-xs font-bold flex items-center justify-center gap-1.5"
                data-testid="palette-sort-hue"
              >
                <span>{t('paletteSortHue')}</span>
              </button>
              <button
                type="button"
                onClick={() => handleSort('saturation-desc')}
                className="pixel-btn min-h-[40px] px-3 text-xs font-bold flex items-center justify-center gap-1.5"
                data-testid="palette-sort-chroma"
              >
                <span>{t('paletteSortChroma')}</span>
              </button>
            </div>

            {canRestoreOriginal && (
              <button
                type="button"
                onClick={handleRestoreOrder}
                className="w-full pixel-btn pixel-btn-teal min-h-[40px] px-3 text-xs font-bold flex items-center justify-center gap-1.5"
                data-testid="palette-restore-original-btn"
              >
                <PixelIcon name="undo" size={13} />
                <span>{t('paletteRestoreOrder')}</span>
              </button>
            )}

            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {t('paletteSortNote')}
            </p>
          </div>
        )}

        {/* TAB 2: READ-ONLY COLOR USAGE ANALYSIS */}
        {tab === 'analyze' && analysis && (
          <div className="space-y-3" data-testid="palette-analyze-panel">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setAnalyzeScope('composite')}
                className={`min-h-[34px] px-2 text-xs font-bold ${
                  analyzeScope === 'composite'
                    ? 'pixel-btn pixel-btn-teal'
                    : 'pixel-btn'
                }`}
                data-testid="analyze-scope-composite"
              >
                {t('paletteAnalyzeScopeComposite')}
              </button>
              <button
                type="button"
                onClick={() => setAnalyzeScope('layer')}
                className={`min-h-[34px] px-2 text-xs font-bold ${
                  analyzeScope === 'layer'
                    ? 'pixel-btn pixel-btn-teal'
                    : 'pixel-btn'
                }`}
                data-testid="analyze-scope-layer"
              >
                {t('paletteAnalyzeScopeLayer')}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('paletteUsedColorsCount')}
                </div>
                <div
                  className="font-bold text-sm mt-0.5 text-[var(--accent-teal)]"
                  data-testid="analyze-used-colors-count"
                >
                  {analysis.usedColorCount}
                </div>
              </div>
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('paletteOpaquePixelsCount')}
                </div>
                <div className="font-bold text-sm mt-0.5">
                  {analysis.opaquePixels} / {analysis.totalCanvasPixels} px
                </div>
              </div>
            </div>

            {analysis.entries.length === 0 ? (
              <div className="p-3 text-center text-xs text-[var(--text-secondary)] bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                {t('paletteNoOpaquePixels')}
              </div>
            ) : (
              <div
                className="max-h-44 overflow-y-auto space-y-1 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]"
                data-testid="analyze-entries-list"
              >
                {analysis.entries.map((entry) => (
                  <button
                    key={entry.hex}
                    type="button"
                    onClick={() => {
                      if (entry.paletteIndex >= 0 && onSelectColor) {
                        onSelectColor(entry.paletteIndex)
                      }
                    }}
                    className="w-full flex items-center gap-2 text-xs py-1 px-1.5 hover:bg-[var(--bg-panel)] text-left cursor-pointer"
                  >
                    <span
                      style={{ backgroundColor: entry.hex }}
                      className="w-5 h-5 border-2 border-[var(--border-pixel)] shrink-0"
                    />
                    <span className="font-mono font-bold w-16 shrink-0">
                      {entry.hex}
                    </span>
                    <div className="flex-1 h-2.5 bg-[var(--bg-panel)] border border-[var(--border-subtle)] overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent-teal)]"
                        style={{
                          width: `${Math.max(3, entry.opaqueRatioPercent)}%`,
                        }}
                      />
                    </div>
                    <span className="font-mono text-[11px] text-[var(--text-secondary)] shrink-0">
                      {entry.pixelCount}px ({entry.opaqueRatioPercent}%)
                    </span>
                  </button>
                ))}
              </div>
            )}

            {analysis.unusedPaletteColors.length > 0 && (
              <div className="space-y-1">
                <div className="text-[11px] font-bold text-[var(--text-secondary)]">
                  {t('paletteUnusedPaletteColors')} (
                  {analysis.unusedPaletteColors.length})
                </div>
                <div
                  className="flex flex-wrap gap-1 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] max-h-20 overflow-y-auto"
                  data-testid="analyze-unused-swatches"
                >
                  {analysis.unusedPaletteColors.map((u) => (
                    <button
                      key={`unused-${u.index}-${u.hex}`}
                      type="button"
                      onClick={() => onSelectColor?.(u.index)}
                      style={{ backgroundColor: u.hex }}
                      title={`#${u.index + 1} ${u.hex}`}
                      className="w-6 h-6 border border-[var(--border-pixel)] cursor-pointer"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: COLOR REPLACEMENT */}
        {tab === 'replace' && onReplaceColor && (
          <div className="space-y-3" data-testid="palette-replace-panel">
            {/* Scope Selector */}
            <div className="grid grid-cols-1 gap-1">
              {(
                [
                  { id: 'project', label: t('paletteReplaceScopeProject') },
                  { id: 'frame', label: t('paletteReplaceScopeFrame') },
                  { id: 'layer', label: t('paletteReplaceScopeLayer') },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setReplaceScope(opt.id)}
                  className={`min-h-[34px] px-2.5 text-xs font-bold text-left ${
                    replaceScope === opt.id
                      ? 'pixel-btn pixel-btn-teal'
                      : 'pixel-btn'
                  }`}
                  data-testid={`replace-scope-${opt.id}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Source Color Picker */}
            <div className="space-y-1">
              <div className="text-xs font-bold text-[var(--text-secondary)] flex items-center justify-between">
                <span>{t('paletteReplaceSource')}</span>
                <span className="font-mono text-[var(--text-primary)]">
                  {sourceHex}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] max-h-24 overflow-y-auto">
                {sourceCandidates.map((hex) => {
                  const active = sourceHex.toUpperCase() === hex.toUpperCase()
                  return (
                    <button
                      key={`src-${hex}`}
                      type="button"
                      onClick={() => setSourceHex(hex)}
                      style={{ backgroundColor: hex }}
                      aria-label={`Source ${hex}`}
                      className={`w-7 h-7 cursor-pointer ${
                        active
                          ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                          : 'border border-[var(--border-pixel)]'
                      }`}
                      data-testid={`replace-src-${hex.slice(1)}`}
                    />
                  )
                })}
              </div>
            </div>

            {/* Target Color Picker */}
            <div className="space-y-1.5">
              <div className="text-xs font-bold text-[var(--text-secondary)] flex items-center justify-between">
                <span>{t('paletteReplaceTarget')}</span>
                <span className="font-mono text-[var(--text-primary)]">
                  {targetHex === 'transparent'
                    ? t('paletteReplaceTransparentSlot')
                    : targetHex}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] max-h-24 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setTargetHex('transparent')}
                  style={getCheckerboardStyle(checkerDark, 6)}
                  title={t('paletteReplaceTransparentSlot')}
                  className={`w-7 h-7 flex items-center justify-center cursor-pointer ${
                    targetHex === 'transparent'
                      ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                      : 'border border-[var(--border-pixel)]'
                  }`}
                  data-testid="replace-dst-transparent"
                >
                  <PixelIcon
                    name="transparent"
                    size={13}
                    className="text-[var(--accent-rose)]"
                  />
                </button>
                {palette.colors.map((hex, i) => {
                  const up = hex.toUpperCase()
                  const active =
                    targetHex !== 'transparent' && targetHex.toUpperCase() === up
                  return (
                    <button
                      key={`dst-${i}-${up}`}
                      type="button"
                      onClick={() => {
                        setTargetHex(up)
                        setCustomTargetHex(up)
                      }}
                      style={{ backgroundColor: up }}
                      aria-label={`Target ${up}`}
                      className={`w-7 h-7 cursor-pointer ${
                        active
                          ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                          : 'border border-[var(--border-pixel)]'
                      }`}
                      data-testid={`replace-dst-${up.slice(1)}`}
                    />
                  )
                })}
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={customTargetHex}
                  onChange={(e) => {
                    const v = e.target.value
                    setCustomTargetHex(v)
                    const norm = normalizeHex(v)
                    if (norm) setTargetHex(norm)
                  }}
                  maxLength={7}
                  placeholder="#RRGGBB"
                  className="w-28 min-h-[34px] px-2 text-xs font-mono font-bold pixel-input select-text"
                  data-testid="replace-custom-hex-input"
                />
                {replaceScope === 'project' && targetHex !== 'transparent' && (
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={syncSwatchOnReplace}
                      onChange={(e) => setSyncSwatchOnReplace(e.target.checked)}
                    />
                    <span>パレット枠の色も同時更新</span>
                  </label>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={executeReplace}
              disabled={
                targetHex !== 'transparent' &&
                normalizeHex(sourceHex) === normalizeHex(targetHex)
              }
              className="w-full pixel-btn pixel-btn-active min-h-[44px] px-4 text-xs font-bold flex items-center justify-center gap-2"
              data-testid="execute-color-replace-btn"
            >
              <PixelIcon name="replace" size={14} />
              <span>{t('paletteReplaceExecBtn')}</span>
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
