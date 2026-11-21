import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  DitherPatternId,
  FloatingShapeState,
  ToolId,
  ToolSettings,
} from '../../types'
import { ALL_DITHER_PATTERN_IDS } from '../../engine/dithering'
import { PixelIcon, type PixelIconName } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { DitherSwatch } from '../common/PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'
import { useApp } from '../../state/AppContext'
import type { TranslationKey } from '../../i18n/translations'

const DITHER_LABEL_KEYS: Record<DitherPatternId, TranslationKey> = {
  1: 'dither1',
  2: 'dither2',
  3: 'dither3',
  4: 'dither4',
  5: 'dither5',
  6: 'dither6',
  7: 'dither7',
  8: 'dither8',
}

interface PaletteBarProps {
  colors: string[]
  selectedIndex: number
  onSelectColor: (index: number) => void
  onOpenPaletteSheet: () => void
}

/**
 * Spec v2 Section 4-4:
 * Dotpict-inspired Palette Swatch Bar:
 * - Active color is marked NOT by color alone, but by a crisp double pixel border + top pixel pointer mark!
 * - Large Palette Edit button (>= 44x44px) at left.
 */
export function PaletteBar({
  colors,
  selectedIndex,
  onSelectColor,
  onOpenPaletteSheet,
}: PaletteBarProps) {
  const { t } = useI18n()
  return (
    <div
      style={{ gap: 'var(--ui-gap, 6px)' }}
      className="flex items-center px-2.5 py-1.5 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
    >
      <button
        type="button"
        onClick={onOpenPaletteSheet}
        title={t('toolPalette')}
        style={{
          minWidth: 'max(44px, var(--swatch-size, 34px))',
          minHeight: 'max(44px, var(--swatch-size, 34px))',
        }}
        className="pixel-btn px-2 flex flex-col items-center justify-center gap-0.5 shrink-0"
        data-testid="open-palette-btn"
      >
        <PixelIcon name="palette" size={18} />
        <span style={{ fontSize: '9px' }} className="leading-none">
          {colors.length}
        </span>
      </button>

      <div
        style={{ gap: 'var(--ui-gap, 6px)' }}
        className="flex items-center overflow-x-auto no-scrollbar py-1 flex-1"
      >
        {colors.map((hex, idx) => {
          const active = idx === selectedIndex
          return (
            <button
              key={`${idx}-${hex}`}
              type="button"
              onClick={() => onSelectColor(idx)}
              style={{
                width: 'var(--swatch-size, 34px)',
                height: 'var(--swatch-size, 34px)',
                minWidth: 'var(--swatch-size, 34px)',
                backgroundColor: hex,
              }}
              className={`relative shrink-0 cursor-pointer ${
                active
                  ? 'border-2 border-[var(--text-primary)] outline-2 outline-offset-1 outline-[var(--accent-primary)] -translate-y-0.5'
                  : 'border-2 border-[var(--border-pixel)] opacity-90 hover:opacity-100'
              }`}
              aria-pressed={active}
              aria-label={`Color ${idx + 1} ${hex}`}
              data-testid={`quick-color-${idx}`}
            >
              {/* Pixel check badge inside top-right corner so selection never relies on color alone */}
              {active && (
                <span
                  className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-[var(--bg-panel)] border border-[var(--border-pixel)] flex items-center justify-center text-[var(--text-primary)]"
                  aria-hidden="true"
                >
                  <PixelIcon name="check" size={10} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface MultiRowToolGridProps {
  tool: ToolId
  optionsOpen: boolean
  canUndo: boolean
  canRedo: boolean
  layerCount: number
  hasSelection: boolean
  onTapTool: (t: ToolId) => void
  onOpenLayers: () => void
  onUndo: () => void
  onRedo: () => void
}

/**
 * Spec v2 Section 4-3, 7, 13:
 * - Organized 2-row grid of tools with pixel-art icon + short label underneath
 * - Minimum 44x44px hit targets
 * - Tap unselected tool -> selects tool (closes previous detail panel)
 * - Tap ALREADY selected tool -> toggles its detail settings panel open/closed!
 */
export function MultiRowToolGrid({
  tool,
  optionsOpen,
  canUndo,
  canRedo,
  layerCount,
  hasSelection,
  onTapTool,
  onOpenLayers,
  onUndo,
  onRedo,
}: MultiRowToolGridProps) {
  const { t } = useI18n()

  const toolItems: Array<{
    id: ToolId
    icon: PixelIconName
    label: string
    hasDetail: boolean
  }> = [
    { id: 'pen', icon: 'pen', label: t('toolPen'), hasDetail: true },
    { id: 'eraser', icon: 'eraser', label: t('toolEraser'), hasDetail: true },
    { id: 'fill', icon: 'fill', label: t('toolFill'), hasDetail: true },
    { id: 'line', icon: 'bezier', label: t('toolLine'), hasDetail: true },
    { id: 'shape', icon: 'rect', label: t('toolShape'), hasDetail: true },
    { id: 'select', icon: 'select', label: t('toolSelect'), hasDetail: true },
    { id: 'eyedropper', icon: 'eyedropper', label: t('toolEyedropper'), hasDetail: false },
  ]

  return (
    <div
      style={{ gap: 'var(--ui-gap, 6px)' }}
      className="grid grid-cols-5 px-2.5 py-1.5 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
      data-testid="multi-row-tool-grid"
    >
      {toolItems.map((item) => {
        const active = tool === item.id
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onTapTool(item.id)}
            aria-pressed={active}
            style={{ minHeight: 'max(44px, var(--tool-btn-height, 48px))' }}
            className={`relative px-1 py-1 flex flex-col items-center justify-center gap-0.5 ${
              active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid={`tool-${item.id}`}
          >
            <PixelIcon name={item.icon} />
            <span
              style={{ fontSize: 'var(--tool-label-size, 11px)' }}
              className="leading-none truncate max-w-full font-bold"
            >
              {item.label}
            </span>

            {/* Visual state marker (not relying on color alone): corner indicator showing re-tap opens/closes options */}
            {active && item.hasDetail && (
              <span
                className="absolute top-0.5 right-0.5 w-3 h-3 flex items-center justify-center opacity-90"
                aria-hidden="true"
              >
                <PixelIcon
                  name={optionsOpen ? 'arrowDown' : 'arrowUp'}
                  size={10}
                />
              </span>
            )}

            {item.id === 'select' && hasSelection && !active && (
              <span
                className="absolute top-0.5 right-0.5 w-2.5 h-2.5 bg-[var(--accent-teal)] border border-[var(--border-pixel)]"
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}

      {/* Undo / Redo / Layers occupy the remaining 3 cells of the 2x5 grid with full >=44px hit areas */}
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        style={{ minHeight: 'max(44px, var(--tool-btn-height, 48px))' }}
        className="pixel-btn px-1 py-1 flex flex-col items-center justify-center gap-0.5"
        data-testid="undo-btn"
      >
        <PixelIcon name="undo" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('undo')}
        </span>
      </button>

      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        style={{ minHeight: 'max(44px, var(--tool-btn-height, 48px))' }}
        className="pixel-btn px-1 py-1 flex flex-col items-center justify-center gap-0.5"
        data-testid="redo-btn"
      >
        <PixelIcon name="redo" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('redo')}
        </span>
      </button>

      <button
        type="button"
        onClick={onOpenLayers}
        style={{ minHeight: 'max(44px, var(--tool-btn-height, 48px))' }}
        className="pixel-btn px-1 py-1 flex flex-col items-center justify-center gap-0.5"
        data-testid="open-layers-btn"
      >
        <div className="flex items-center gap-0.5">
          <PixelIcon name="layers" />
          <span className="text-[10px] font-bold">{layerCount}</span>
        </div>
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('toolLayers')}
        </span>
      </button>
    </div>
  )
}

interface FloatingTransformBarProps {
  floatingShape: FloatingShapeState
  onRotate: (deg: number) => void
  onMove: (dx: number, dy: number) => void
  onCommit: () => void
  onDiscard: () => void
}

export function FloatingTransformBar({
  floatingShape,
  onRotate,
  onMove,
  onCommit,
  onDiscard,
}: FloatingTransformBarProps) {
  const { t } = useI18n()
  return (
    <div
      className="px-2.5 py-2 bg-[var(--bg-panel)] border-t-2 border-[var(--border-pixel)] space-y-2 shrink-0"
      data-testid="transform-panel"
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-bold text-[var(--accent-primary)]">
          {t('transformTitle')} ({((floatingShape.rotationDeg % 360) + 360) % 360}°)
        </span>
        <span className="text-[11px] text-[var(--text-secondary)] truncate max-w-[56%]">
          {t('transformHint')}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onRotate(-90)}
            className="pixel-btn min-h-[38px] px-2 text-xs font-bold flex items-center gap-1"
            data-testid="rot-left-90"
          >
            <PixelIcon name="rotLeft" size={14} />
            {t('rotLeft90')}
          </button>
          <button
            type="button"
            onClick={() => onRotate(-5)}
            className="pixel-btn min-h-[38px] px-2 text-xs font-bold"
            data-testid="rot-left-5"
          >
            {t('rotLeft5')}
          </button>
          <button
            type="button"
            onClick={() => onRotate(5)}
            className="pixel-btn min-h-[38px] px-2 text-xs font-bold"
            data-testid="rot-right-5"
          >
            {t('rotRight5')}
          </button>
          <button
            type="button"
            onClick={() => onRotate(90)}
            className="pixel-btn min-h-[38px] px-2 text-xs font-bold flex items-center gap-1"
            data-testid="rot-right-90"
          >
            <PixelIcon name="rotRight" size={14} />
            {t('rotRight90')}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1, 0)}
            className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
            aria-label="Move Left 1px"
            data-testid="shape-move-left"
          >
            <PixelIcon name="arrowLeft" size={14} />
          </button>
          <button
            type="button"
            onClick={() => onMove(0, -1)}
            className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
            aria-label="Move Up 1px"
            data-testid="shape-move-up"
          >
            <PixelIcon name="arrowUp" size={14} />
          </button>
          <button
            type="button"
            onClick={() => onMove(0, 1)}
            className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
            aria-label="Move Down 1px"
            data-testid="shape-move-down"
          >
            <PixelIcon name="arrowDown" size={14} />
          </button>
          <button
            type="button"
            onClick={() => onMove(1, 0)}
            className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
            aria-label="Move Right 1px"
            data-testid="shape-move-right"
          >
            <PixelIcon name="arrowRight" size={14} />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDiscard}
            className="pixel-btn pixel-btn-danger min-h-[38px] px-2.5 text-xs font-bold"
          >
            {t('discardTransform')}
          </button>
          <button
            type="button"
            onClick={onCommit}
            className="pixel-btn pixel-btn-teal min-h-[38px] px-3 text-xs font-bold flex items-center gap-1"
            data-testid="commit-shape-btn"
          >
            <PixelIcon name="check" size={14} />
            {t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ToolDetailPopoverProps {
  open: boolean
  onClose: () => void
  tool: ToolId
  settings: ToolSettings
  activeHexColor: string
  hasSelection: boolean
  hasClipboard: boolean
  onChange: (patch: Partial<ToolSettings>) => void
  onNudgeSelection: (dx: number, dy: number) => void
  onApplyOutline: () => void
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onFlipSelection: (dir: 'horizontal' | 'vertical') => void
  onInvertSelection: () => void
  onClearSelection: () => void
}

/**
 * Spec v2 Section 7 & 8:
 * Compact floating tool detail popover positioned directly above the tool grid
 * so it NEVER shrinks the canvas layout, NEVER hides the active canvas cursor or Draw button,
 * and allows immediate drawing even while open!
 */
export function ToolDetailPopover({
  open,
  onClose,
  tool,
  settings,
  activeHexColor,
  hasSelection,
  hasClipboard,
  onChange,
  onNudgeSelection,
  onApplyOutline,
  onCut,
  onCopy,
  onPaste,
  onFlipSelection,
  onInvertSelection,
  onClearSelection,
}: ToolDetailPopoverProps) {
  const { t } = useI18n()
  const { reducedMotion } = useApp()
  const [showOutlineConfig, setShowOutlineConfig] = useState(false)

  if (tool === 'eyedropper' && !hasSelection) return null

  const renderDitherPicker = (
    current: DitherPatternId,
    onPick: (id: DitherPatternId) => void
  ) => (
    <div className="space-y-1">
      <div className="text-[11px] text-[var(--text-secondary)]">
        {t('dithering')}: <strong className="text-[var(--text-primary)]">{t(DITHER_LABEL_KEYS[current])}</strong>
      </div>
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
        {ALL_DITHER_PATTERN_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            title={t(DITHER_LABEL_KEYS[id])}
            className="flex flex-col items-center gap-0.5 shrink-0 cursor-pointer"
            data-testid={`dither-opt-${id}`}
          >
            <DitherSwatch
              patternId={id}
              active={current === id}
              color={activeHexColor}
            />
            <span className="text-[10px] font-bold">{id}</span>
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className="absolute bottom-full left-2 right-2 mb-1.5 z-30 pixel-panel p-3 space-y-2.5 max-h-[42dvh] overflow-y-auto"
          data-testid="tool-detail-panel"
        >
          <div className="flex items-center justify-between pb-1 border-b border-[var(--border-subtle)]">
            <span className="text-xs font-bold text-[var(--accent-primary)]">
              {t('toolOptions')}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="pixel-btn min-w-[32px] min-h-[32px] flex items-center justify-center"
              aria-label={t('close')}
            >
              <PixelIcon name="close" size={14} />
            </button>
          </div>

          {/* PEN */}
          {tool === 'pen' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs">
                    {t('size')}: <strong>{settings.penSize}px</strong>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={32}
                    value={settings.penSize}
                    onChange={(e) => onChange({ penSize: Number(e.target.value) })}
                    className="w-28 accent-[var(--accent-primary)]"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onChange({ penShape: 'square' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      settings.penShape === 'square'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="rect" size={14} />
                    {t('shapeSquare')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ penShape: 'circle' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      settings.penShape === 'circle'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="ellipse" size={14} />
                    {t('shapeCircle')}
                  </button>
                </div>
              </div>

              <PixelCheckbox
                checked={settings.pixelPerfect}
                onChange={(next) => onChange({ pixelPerfect: next })}
                label={t('pixelPerfect')}
                testId="toggle-pixel-perfect"
              />

              {renderDitherPicker(settings.penDither, (id) =>
                onChange({ penDither: id })
              )}
            </div>
          )}

          {/* ERASER */}
          {tool === 'eraser' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs">
                  {t('size')}: <strong>{settings.eraserSize}px</strong>
                </span>
                <input
                  type="range"
                  min={1}
                  max={32}
                  value={settings.eraserSize}
                  onChange={(e) => onChange({ eraserSize: Number(e.target.value) })}
                  className="w-32 accent-[var(--accent-primary)]"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onChange({ eraserShape: 'square' })}
                  className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                    settings.eraserShape === 'square'
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                >
                  <PixelIcon name="rect" size={14} />
                  {t('shapeSquare')}
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ eraserShape: 'circle' })}
                  className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                    settings.eraserShape === 'circle'
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                >
                  <PixelIcon name="ellipse" size={14} />
                  {t('shapeCircle')}
                </button>
              </div>
            </div>
          )}

          {/* FILL */}
          {tool === 'fill' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChange({ fillMode: 'normal' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold ${
                      settings.fillMode === 'normal'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {t('fillNormal')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ fillMode: 'gradient' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold ${
                      settings.fillMode === 'gradient'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                    data-testid="fill-mode-gradient"
                  >
                    {t('fillGradient')}
                  </button>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChange({ fillConnectivity: 4 })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold ${
                      settings.fillConnectivity === 4
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {t('conn4')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ fillConnectivity: 8 })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold ${
                      settings.fillConnectivity === 8
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {t('conn8')}
                  </button>
                </div>
              </div>

              {settings.fillMode === 'normal' ? (
                renderDitherPicker(settings.fillDither, (id) =>
                  onChange({ fillDither: id })
                )
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t('gradientSteps')}:
                  </span>
                  <button
                    type="button"
                    onClick={() => onChange({ gradientSteps: 4 })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold ${
                      settings.gradientSteps === 4
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {t('grad4Steps')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ gradientSteps: 8 })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold ${
                      settings.gradientSteps === 8
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {t('grad8Steps')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* LINE & PIXEL-PERFECT BEZIER */}
          {tool === 'line' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChange({ lineType: 'line' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      settings.lineType === 'line'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="line" size={14} />
                    {t('lineStraight')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ lineType: 'bezier' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      settings.lineType === 'bezier'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                    data-testid="line-type-bezier"
                  >
                    <PixelIcon name="bezier" size={14} />
                    {t('lineBezier')}
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onChange({ lineShape: 'square' })}
                    className={`min-h-[36px] px-2 text-xs font-bold flex items-center gap-1 ${
                      settings.lineShape === 'square'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="rect" size={14} />
                    {t('shapeSquare')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ lineShape: 'circle' })}
                    className={`min-h-[36px] px-2 text-xs font-bold flex items-center gap-1 ${
                      settings.lineShape === 'circle'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="ellipse" size={14} />
                    {t('shapeCircle')}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs">
                  {t('size')}: <strong>{settings.lineSize}px</strong>
                </span>
                <input
                  type="range"
                  min={1}
                  max={32}
                  value={settings.lineSize}
                  onChange={(e) => onChange({ lineSize: Number(e.target.value) })}
                  className="flex-1 accent-[var(--accent-primary)]"
                />
              </div>

              {renderDitherPicker(settings.lineDither, (id) =>
                onChange({ lineDither: id })
              )}
            </div>
          )}

          {/* SHAPE (Spec v2 Section 8: Single 'Fill' PixelCheckbox + 'Fixed Ratio' PixelCheckbox) */}
          {tool === 'shape' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChange({ shapeType: 'rect' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      settings.shapeType === 'rect'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="rect" size={14} />
                    {t('shapeRect')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ shapeType: 'ellipse' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      settings.shapeType === 'ellipse'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    <PixelIcon name="ellipse" size={14} />
                    {t('shapeEllipse')}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <PixelCheckbox
                    checked={settings.shapeFilled}
                    onChange={(next) => onChange({ shapeFilled: next })}
                    label={t('filled')}
                    testId="shape-filled-checkbox"
                  />
                  <PixelCheckbox
                    checked={settings.shapeFixedRatio}
                    onChange={(next) => onChange({ shapeFixedRatio: next })}
                    label={t('fixedRatio')}
                    testId="shape-ratio-checkbox"
                  />
                </div>
              </div>

              {!settings.shapeFilled && (
                <div className="flex items-center gap-2">
                  <span className="text-xs">
                    {t('strokeWidth')}: <strong>{settings.shapeSize}px</strong>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={16}
                    value={settings.shapeSize}
                    onChange={(e) => onChange({ shapeSize: Number(e.target.value) })}
                    className="w-28 accent-[var(--accent-primary)]"
                  />
                </div>
              )}

              {renderDitherPicker(settings.shapeDither, (id) =>
                onChange({ shapeDither: id })
              )}
            </div>
          )}

          {/* SELECT & ACTIVE SELECTION ACTIONS */}
          {(tool === 'select' || hasSelection) && (
            <div className="space-y-2">
              {tool === 'select' && (
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onChange({ selectType: 'wand' })}
                      className={`min-h-[36px] px-2 text-xs font-bold flex items-center gap-1 ${
                        settings.selectType === 'wand'
                          ? 'pixel-btn pixel-btn-active'
                          : 'pixel-btn'
                      }`}
                    >
                      <PixelIcon name="wand" size={14} />
                      {t('selectWand')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange({ selectType: 'rect' })}
                      className={`min-h-[36px] px-2 text-xs font-bold flex items-center gap-1 ${
                        settings.selectType === 'rect'
                          ? 'pixel-btn pixel-btn-active'
                          : 'pixel-btn'
                      }`}
                    >
                      <PixelIcon name="rect" size={14} />
                      {t('selectRect')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange({ selectType: 'ellipse' })}
                      className={`min-h-[36px] px-2 text-xs font-bold flex items-center gap-1 ${
                        settings.selectType === 'ellipse'
                          ? 'pixel-btn pixel-btn-active'
                          : 'pixel-btn'
                      }`}
                    >
                      <PixelIcon name="ellipse" size={14} />
                      {t('selectEllipse')}
                    </button>
                  </div>

                  {settings.selectType === 'wand' && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onChange({ selectConnectivity: 4 })}
                        className={`min-h-[34px] px-2 text-xs font-bold ${
                          settings.selectConnectivity === 4
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                      >
                        {t('conn4')}
                      </button>
                      <button
                        type="button"
                        onClick={() => onChange({ selectConnectivity: 8 })}
                        className={`min-h-[34px] px-2 text-xs font-bold ${
                          settings.selectConnectivity === 8
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                      >
                        {t('conn8')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onNudgeSelection(-1, 0)}
                  className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                  title={`${t('move1px')} ←`}
                >
                  <PixelIcon name="arrowLeft" size={14} />
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onNudgeSelection(0, -1)}
                  className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                  title={`${t('move1px')} ↑`}
                >
                  <PixelIcon name="arrowUp" size={14} />
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onNudgeSelection(0, 1)}
                  className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                  title={`${t('move1px')} ↓`}
                >
                  <PixelIcon name="arrowDown" size={14} />
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onNudgeSelection(1, 0)}
                  className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center"
                  title={`${t('move1px')} →`}
                >
                  <PixelIcon name="arrowRight" size={14} />
                </button>

                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={onCut}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="cut" size={14} />
                  {t('cut')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={onCopy}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="copy" size={14} />
                  {t('copy')}
                </button>
                <button
                  type="button"
                  disabled={!hasClipboard}
                  onClick={onPaste}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="paste" size={14} />
                  {t('paste')}
                </button>

                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onFlipSelection('horizontal')}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="flipH" size={14} />
                  {t('flipH')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onFlipSelection('vertical')}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="flipV" size={14} />
                  {t('flipV')}
                </button>

                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => setShowOutlineConfig((v) => !v)}
                  className={`min-h-[36px] px-2.5 text-xs font-bold ${
                    showOutlineConfig ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                  }`}
                >
                  {t('outline')}
                </button>

                <button
                  type="button"
                  onClick={onInvertSelection}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold"
                >
                  {t('invertSelection')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={onClearSelection}
                  className="pixel-btn pixel-btn-danger min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="trash" size={14} />
                  {t('clearSelection')}
                </button>
              </div>

              {showOutlineConfig && hasSelection && (
                <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <PixelCheckbox
                      checked={settings.outlineMode === 'pixelPerfect'}
                      onChange={(next) =>
                        onChange({ outlineMode: next ? 'pixelPerfect' : 'normal' })
                      }
                      label={t('outlinePP')}
                    />

                    <div className="flex items-center gap-2">
                      <span className="text-xs">
                        {t('size')}: <strong>{settings.outlineSize}px</strong>
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={8}
                        value={settings.outlineSize}
                        onChange={(e) =>
                          onChange({ outlineSize: Number(e.target.value) })
                        }
                        className="w-20 accent-[var(--accent-primary)]"
                      />
                      <input
                        type="color"
                        value={settings.outlineColor}
                        onChange={(e) => onChange({ outlineColor: e.target.value })}
                        className="w-7 h-7 border-2 border-[var(--border-pixel)] cursor-pointer bg-transparent"
                      />
                      <button
                        type="button"
                        onClick={onApplyOutline}
                        className="pixel-btn pixel-btn-teal min-h-[34px] px-3 text-xs font-bold"
                      >
                        {t('outlineApply')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
