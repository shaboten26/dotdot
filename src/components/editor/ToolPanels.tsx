import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  TRANSPARENT_COLOR_INDEX,
  type ActiveMoveSession,
  type DitherPatternId,
  type FloatingShapeState,
  type GradientSteps,
  type ToolId,
  type ToolSettings,
} from '../../types'
import { ALL_DITHER_PATTERN_IDS } from '../../engine/dithering'
import { resolveToolIconName } from '../../utils/toolIcon'
import { useLongPressReorder } from '../../utils/useLongPressReorder'
import { PixelIcon, type PixelIconName } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { PixelSlider } from '../common/PixelSlider'
import { PixelSelect } from '../common/PixelSelect'
import { DitherSwatch, getCheckerboardStyle } from '../common/PixelThumbnail'
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

const BRUSH_SIZE_PRESET_VALUES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const

interface PaletteBarProps {
  colors: string[]
  selectedIndex: number
  checkerDark?: boolean
  onSelectColor: (index: number) => void
  onReorderColors?: (nextColors: string[], nextSelectedIndex: number) => void
  onOpenPaletteSheet: () => void
}

/**
 * Flat Dotpict-inspired Single-Row Palette Swatch Bar (Sections 3-1 & 4-3):
 * - Strictly 1-row horizontal display (`flex-nowrap overflow-x-auto`)
 * - Fixed leftmost Transparent Color Slot (`TRANSPARENT_COLOR_INDEX = -1`) outside normal 256-color cap & scroll
 * - Normal colors support horizontal scrolling AND drag reordering on both PC mouse and Smartphone touch!
 */
export function PaletteBar({
  colors,
  selectedIndex,
  checkerDark = false,
  onSelectColor,
  onReorderColors,
  onOpenPaletteSheet,
}: PaletteBarProps) {
  const { t } = useI18n()
  const scrollStripRef = useRef<HTMLDivElement | null>(null)
  const isTransparentSelected = selectedIndex === TRANSPARENT_COLOR_INDEX

  const colorIds = colors.map((_, idx) => `c-${idx}`)
  const { dragState, getItemProps, shouldSuppressClick } = useLongPressReorder({
    ids: colorIds,
    enabled: Boolean(onReorderColors) && colors.length > 1,
    axis: 'horizontal',
    longPressMs: 170,
    scopeId: 'palette-bar-colors',
    scrollContainerRef: scrollStripRef,
    onReorder: (nextIds) => {
      if (!onReorderColors) return
      const nextIndices = nextIds.map((id) => Number(id.slice(2)))
      const nextColors = nextIndices.map((i) => colors[i]!)
      let nextSel = selectedIndex
      if (selectedIndex >= 0) {
        const movedTo = nextIndices.indexOf(selectedIndex)
        if (movedTo >= 0) nextSel = movedTo
      }
      onReorderColors(nextColors, nextSel)
    },
  })

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

      {/* Fixed Leftmost Transparent Color Slot (excluded from 256-color cap & horizontal scroll) */}
      <button
        type="button"
        onClick={() => onSelectColor(TRANSPARENT_COLOR_INDEX)}
        title={`${t('transparentSlotLabel')} — ${t('transparentSlotHint')}`}
        aria-label={t('transparentSlotLabel')}
        aria-pressed={isTransparentSelected}
        style={{
          width: 'var(--swatch-size, 34px)',
          height: 'var(--swatch-size, 34px)',
          minWidth: 'var(--swatch-size, 34px)',
          ...getCheckerboardStyle(checkerDark, 8),
        }}
        className={`relative shrink-0 cursor-pointer flex items-center justify-center transition-transform duration-75 ${
          isTransparentSelected
            ? 'border-2 border-[var(--border-strong)] outline-2 outline-offset-1 outline-[var(--accent-primary)] -translate-y-0.5'
            : 'border-2 border-[var(--border-pixel)] opacity-90 hover:opacity-100'
        }`}
        data-testid="quick-color-transparent"
      >
        <PixelIcon
          name="transparent"
          size={16}
          className="text-[var(--accent-rose)]"
        />
        {isTransparentSelected && (
          <span
            className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-[var(--bg-panel)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-primary)]"
            aria-hidden="true"
          >
            <PixelIcon name="check" size={10} />
          </span>
        )}
      </button>

      <div
        ref={scrollStripRef}
        style={{ gap: 'var(--ui-gap, 6px)' }}
        className="flex flex-nowrap items-center overflow-x-auto no-scrollbar py-1 flex-1 min-w-0"
        data-testid="palette-bar-scroll-strip"
      >
        {colors.map((hex, idx) => {
          const active = idx === selectedIndex
          const itemId = `c-${idx}`
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
              style={{
                width: 'var(--swatch-size, 34px)',
                height: 'var(--swatch-size, 34px)',
                minWidth: 'var(--swatch-size, 34px)',
                backgroundColor: hex,
              }}
              className={`relative shrink-0 cursor-pointer transition-transform duration-75 ${
                isDropTarget
                  ? 'border-2 border-[var(--accent-teal)] outline-2 outline-dashed outline-[var(--accent-teal)] scale-105 z-10'
                  : active
                    ? 'border-2 border-[var(--border-strong)] outline-2 outline-offset-1 outline-[var(--accent-primary)] -translate-y-0.5'
                    : 'border-2 border-[var(--border-pixel)] opacity-90 hover:opacity-100'
              } ${isDragging ? 'opacity-60' : ''}`}
              aria-pressed={active}
              aria-label={`Color ${idx + 1} ${hex}`}
              data-testid={`quick-color-${idx}`}
            >
              {active && (
                <span
                  className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-[var(--bg-panel)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-primary)]"
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
  toolSettings: ToolSettings
  optionsOpen: boolean
  globalSettingsOpen?: boolean
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
  onTapTool: (t: ToolId) => void
  onUndo: () => void
  onRedo: () => void
  onOpenGlobalSettings?: () => void
}

/**
 * Multi-row Tool Grid dynamically reflects active sub-modes/shapes via `resolveToolIconName`:
 * - Straight Line -> `line` icon; Bezier -> `bezier` icon
 * - Rectangle -> `rect` icon; Circle/Ellipse -> `ellipse` icon
 * - Select Wand / Rect / Ellipse -> `wand` / `rect` / `ellipse` icon
 * - Layer management UI is strictly separated into the dedicated `レイヤー` / `タイムライン` workspace tab.
 */
export function MultiRowToolGrid({
  tool,
  toolSettings,
  optionsOpen,
  globalSettingsOpen = false,
  canUndo,
  canRedo,
  hasSelection,
  onTapTool,
  onUndo,
  onRedo,
  onOpenGlobalSettings,
}: MultiRowToolGridProps) {
  const { t } = useI18n()

  const toolItems: Array<{
    id: ToolId
    icon: PixelIconName
    label: string
    hasDetail: boolean
  }> = [
    {
      id: 'pen',
      icon: resolveToolIconName('pen', toolSettings),
      label: t('toolPen'),
      hasDetail: true,
    },
    {
      id: 'eraser',
      icon: resolveToolIconName('eraser', toolSettings),
      label: t('toolEraser'),
      hasDetail: true,
    },
    {
      id: 'fill',
      icon: resolveToolIconName('fill', toolSettings),
      label:
        toolSettings.fillMode === 'gradient' ? t('fillGradient') : t('toolFill'),
      hasDetail: true,
    },
    {
      id: 'line',
      icon: resolveToolIconName('line', toolSettings),
      label:
        toolSettings.lineType === 'bezier' ? t('lineBezier') : t('lineStraight'),
      hasDetail: true,
    },
    {
      id: 'shape',
      icon: resolveToolIconName('shape', toolSettings),
      label:
        toolSettings.shapeType === 'ellipse' ? t('shapeEllipse') : t('shapeRect'),
      hasDetail: true,
    },
    {
      id: 'select',
      icon: resolveToolIconName('select', toolSettings),
      label: t('toolSelect'),
      hasDetail: true,
    },
    {
      id: 'eyedropper',
      icon: resolveToolIconName('eyedropper', toolSettings),
      label: t('toolEyedropper'),
      hasDetail: true,
    },
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
                className="absolute top-0.5 right-0.5 w-2.5 h-2.5 bg-[var(--accent-teal)] border border-[var(--border-strong)]"
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}

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

      {/* Vacated 10th slot (formerly duplicate Layer button) repurposed for Global Workspace/Input Settings (`設定`) */}
      <button
        type="button"
        onClick={onOpenGlobalSettings}
        aria-pressed={globalSettingsOpen}
        style={{ minHeight: 'max(44px, var(--tool-btn-height, 48px))' }}
        className={`px-1 py-1 flex flex-col items-center justify-center gap-0.5 ${
          globalSettingsOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
        }`}
        data-testid="open-global-editor-settings-btn"
      >
        <PixelIcon name="settings" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('editorGlobalSettingsBtn')}
        </span>
      </button>
    </div>
  )
}

interface TimelineTransportDockProps {
  isPlaying: boolean
  activeFrameIndex: number
  totalFrames: number
  globalSettingsOpen?: boolean
  onStepFrame: (delta: -1 | 1) => void
  onTogglePlay: () => void
  onStopPlay: () => void
  onOpenGlobalSettings?: () => void
}

/**
 * Contextual Frame Transport Dock shown in the Tool Operation Area when the `タイムライン` tab (`>=2` frames) is active.
 * Keeps playback & frame-stepping controls in the exact thumb-friendly dock slot occupied by drawing tools in `ツール` mode,
 * eliminating duplicate play/prev/next buttons inside `TimelinePanel` without shrinking the canvas!
 */
export function TimelineTransportDock({
  isPlaying,
  activeFrameIndex,
  totalFrames,
  globalSettingsOpen = false,
  onStepFrame,
  onTogglePlay,
  onStopPlay,
  onOpenGlobalSettings,
}: TimelineTransportDockProps) {
  const { t } = useI18n()

  return (
    <div
      style={{ gap: 'var(--ui-gap, 6px)' }}
      className="grid grid-cols-5 px-2.5 py-1.5 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
      data-testid="timeline-transport-dock"
    >
      <button
        type="button"
        onClick={() => onStepFrame(-1)}
        title={t('prevFrameBtn')}
        aria-label={t('prevFrameBtn')}
        style={{ minHeight: 'max(42px, calc(var(--tool-btn-height, 48px) - 4px))' }}
        className="pixel-btn px-1 py-1 flex flex-col items-center justify-center gap-0.5"
        data-testid="dock-prev-frame-btn"
      >
        <PixelIcon name="arrowLeft" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('prevShortBtn')}
        </span>
      </button>

      <button
        type="button"
        onClick={onTogglePlay}
        aria-pressed={isPlaying}
        style={{ minHeight: 'max(42px, calc(var(--tool-btn-height, 48px) - 4px))' }}
        className={`px-1 py-1 flex flex-col items-center justify-center gap-0.5 ${
          isPlaying ? 'pixel-btn pixel-btn-teal' : 'pixel-btn pixel-btn-active'
        }`}
        data-testid="dock-play-toggle-btn"
      >
        <PixelIcon name={isPlaying ? 'pause' : 'play'} />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold pixel-num"
        >
          {isPlaying ? t('pauseActionBtn') : t('playBtn')} {activeFrameIndex + 1}/{totalFrames}
        </span>
      </button>

      <button
        type="button"
        onClick={onStopPlay}
        title={t('stopActionBtn')}
        aria-label={t('stopActionBtn')}
        style={{ minHeight: 'max(42px, calc(var(--tool-btn-height, 48px) - 4px))' }}
        className="pixel-btn px-1 py-1 flex flex-col items-center justify-center gap-0.5"
        data-testid="dock-stop-btn"
      >
        <PixelIcon name="stop" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('stopActionBtn')}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onStepFrame(1)}
        title={t('nextFrameBtn')}
        aria-label={t('nextFrameBtn')}
        style={{ minHeight: 'max(42px, calc(var(--tool-btn-height, 48px) - 4px))' }}
        className="pixel-btn px-1 py-1 flex flex-col items-center justify-center gap-0.5"
        data-testid="dock-next-frame-btn"
      >
        <PixelIcon name="arrowRight" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('nextShortBtn')}
        </span>
      </button>

      <button
        type="button"
        onClick={onOpenGlobalSettings}
        aria-pressed={globalSettingsOpen}
        style={{ minHeight: 'max(42px, calc(var(--tool-btn-height, 48px) - 4px))' }}
        className={`px-1 py-1 flex flex-col items-center justify-center gap-0.5 ${
          globalSettingsOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
        }`}
        data-testid="open-global-editor-settings-btn"
      >
        <PixelIcon name="settings" />
        <span
          style={{ fontSize: 'var(--tool-label-size, 11px)' }}
          className="leading-none truncate max-w-full font-bold"
        >
          {t('editorGlobalSettingsBtn')}
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
      <div className="flex items-center justify-between text-xs gap-2">
        <span className="font-bold text-[var(--accent-primary)]">
          {t('transformTitle')} ({((floatingShape.rotationDeg % 360) + 360) % 360}°)
        </span>
        <span className="text-[11px] text-[var(--text-secondary)] truncate">
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

        {/* Commit + Rightmost Discard */}
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={onCommit}
            className="pixel-btn pixel-btn-teal min-h-[38px] px-3 text-xs font-bold flex items-center gap-1"
            data-testid="commit-shape-btn"
          >
            <PixelIcon name="check" size={14} />
            {t('confirm')}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="pixel-btn pixel-btn-danger min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1"
            data-testid="discard-shape-btn"
          >
            <PixelIcon name="close" size={14} />
            {t('discardTransform')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface SelectionReadyBarProps {
  onStartMove: () => void
  onClearSelection: () => void
}

/**
 * Compact 1-line Selection Ready Bar shown when a selection exists before entering Move mode
 * (and when ToolDetailPopover is closed), giving immediate access to "Start Move" without hiding the canvas.
 */
export function SelectionReadyBar({
  onStartMove,
  onClearSelection,
}: SelectionReadyBarProps) {
  const { t } = useI18n()
  return (
    <div
      className="px-2.5 py-1 bg-[var(--bg-panel)] border-t-2 border-[var(--border-pixel)] flex items-center justify-between gap-2 text-xs shrink-0"
      data-testid="selection-ready-bar"
    >
      <span className="font-bold text-[var(--accent-teal)] flex items-center gap-1.5 truncate">
        <PixelIcon name="wand" size={13} />
        <span className="truncate">{t('toolSelect')}</span>
      </span>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onStartMove}
          className="pixel-btn pixel-btn-teal min-h-[34px] px-3 text-xs font-bold flex items-center gap-1.5"
          data-testid="quick-start-selection-move-btn"
        >
          <PixelIcon name="move" size={13} />
          <span>{t('startMoveBtn')}</span>
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          className="pixel-btn min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
          data-testid="quick-clear-selection-btn"
        >
          <PixelIcon name="close" size={12} />
          <span>{t('clearSelection')}</span>
        </button>
      </div>
    </div>
  )
}

interface ActiveMoveBarProps {
  moveSession: ActiveMoveSession
  onMoveStep: (dx: number, dy: number) => void
  onCommit: () => void
  onCancel: () => void
}

/**
 * Compact Unified Move Bar for Selection Move, Single-Layer Move, and Multi-Layer Batch Move:
 * - Single compact row so the canvas & selected pixels remain maximally visible.
 * - Explicit Up / Down / Left / Right buttons move strictly 1 canvas pixel per click/tap
 *   regardless of zoom level, with optional smooth hold-repeat after 340ms.
 */
export function ActiveMoveBar({
  moveSession,
  onMoveStep,
  onCommit,
  onCancel,
}: ActiveMoveBarProps) {
  const { t } = useI18n()
  const holdTimeoutRef = useRef<number | null>(null)
  const holdIntervalRef = useRef<number | null>(null)

  const stopHoldRepeat = () => {
    if (holdTimeoutRef.current !== null) {
      window.clearTimeout(holdTimeoutRef.current)
      holdTimeoutRef.current = null
    }
    if (holdIntervalRef.current !== null) {
      window.clearInterval(holdIntervalRef.current)
      holdIntervalRef.current = null
    }
  }

  useEffect(() => {
    return () => stopHoldRepeat()
  }, [])

  const startHoldRepeat = (dx: number, dy: number) => {
    stopHoldRepeat()
    holdTimeoutRef.current = window.setTimeout(() => {
      holdIntervalRef.current = window.setInterval(() => {
        onMoveStep(dx, dy)
      }, 95)
    }, 340)
  }

  const labelShort =
    moveSession.mode === 'multi-layer'
      ? `${t('moveMultiLayersTitle')}(${moveSession.layerIds.length})`
      : moveSession.mode === 'layer'
        ? t('moveLayerTitle')
        : t('moveSelectionTitle')

  return (
    <div
      className="px-2 py-1.5 bg-[var(--bg-panel)] border-t-2 border-[var(--border-pixel)] flex flex-wrap items-center justify-between gap-1.5 shrink-0"
      data-testid="active-move-bar"
    >
      {/* Compact Offset Readout */}
      <div
        className="flex items-center gap-1 text-xs font-bold text-[var(--accent-teal)] shrink-0"
        data-testid="active-move-offset-badge"
      >
        <PixelIcon name="move" size={13} />
        <span className="hidden sm:inline truncate max-w-[110px]">{labelShort}</span>
        <span className="font-mono text-[11px] px-1.5 py-0.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
          {moveSession.dx >= 0 ? '+' : ''}
          {moveSession.dx},{moveSession.dy >= 0 ? '+' : ''}
          {moveSession.dy}px
        </span>
      </div>

      {/* Explicit 1px Directional Arrow Buttons (Left / Up / Down / Right) */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onMoveStep(-1, 0)}
          onPointerDown={(e) => {
            if (e.button === 0 || e.pointerType !== 'mouse') startHoldRepeat(-1, 0)
          }}
          onPointerUp={stopHoldRepeat}
          onPointerLeave={stopHoldRepeat}
          onPointerCancel={stopHoldRepeat}
          className="pixel-btn min-w-[38px] min-h-[36px] flex items-center justify-center"
          aria-label="Move Left 1px"
          data-testid="move-step-left"
        >
          <PixelIcon name="arrowLeft" size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMoveStep(0, -1)}
          onPointerDown={(e) => {
            if (e.button === 0 || e.pointerType !== 'mouse') startHoldRepeat(0, -1)
          }}
          onPointerUp={stopHoldRepeat}
          onPointerLeave={stopHoldRepeat}
          onPointerCancel={stopHoldRepeat}
          className="pixel-btn min-w-[38px] min-h-[36px] flex items-center justify-center"
          aria-label="Move Up 1px"
          data-testid="move-step-up"
        >
          <PixelIcon name="arrowUp" size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMoveStep(0, 1)}
          onPointerDown={(e) => {
            if (e.button === 0 || e.pointerType !== 'mouse') startHoldRepeat(0, 1)
          }}
          onPointerUp={stopHoldRepeat}
          onPointerLeave={stopHoldRepeat}
          onPointerCancel={stopHoldRepeat}
          className="pixel-btn min-w-[38px] min-h-[36px] flex items-center justify-center"
          aria-label="Move Down 1px"
          data-testid="move-step-down"
        >
          <PixelIcon name="arrowDown" size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMoveStep(1, 0)}
          onPointerDown={(e) => {
            if (e.button === 0 || e.pointerType !== 'mouse') startHoldRepeat(1, 0)
          }}
          onPointerUp={stopHoldRepeat}
          onPointerLeave={stopHoldRepeat}
          onPointerCancel={stopHoldRepeat}
          className="pixel-btn min-w-[38px] min-h-[36px] flex items-center justify-center"
          aria-label="Move Right 1px"
          data-testid="move-step-right"
        >
          <PixelIcon name="arrowRight" size={14} />
        </button>
      </div>

      {/* Commit + Rightmost Cancel */}
      <div className="flex items-center gap-1 ml-auto">
        <button
          type="button"
          onClick={onCommit}
          className="pixel-btn pixel-btn-teal min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1"
          data-testid="commit-move-btn"
        >
          <PixelIcon name="check" size={13} />
          <span>{t('commitMoveBtn')}</span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="pixel-btn pixel-btn-danger min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
          data-testid="cancel-move-btn"
        >
          <PixelIcon name="close" size={13} />
          <span>{t('cancelMoveBtn')}</span>
        </button>
      </div>
    </div>
  )
}

interface ToolDetailPopoverProps {
  open: boolean
  onClose: () => void
  tool: ToolId
  settings: ToolSettings
  paletteColors: string[]
  eyedropperDoubleTap: boolean
  onToggleEyedropperDoubleTap: (next: boolean) => void
  hasSelection: boolean
  hasClipboard: boolean
  onChange: (patch: Partial<ToolSettings>) => void
  onStartSelectionMove: () => void
  onNudgeSelection: (dx: number, dy: number) => void
  onApplyOutline: () => void
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onFlipSelection: (dir: 'horizontal' | 'vertical') => void
  onInvertSelection: () => void
  onClearSelection: () => void
}

export function ToolDetailPopover({
  open,
  onClose,
  tool,
  settings,
  paletteColors,
  eyedropperDoubleTap,
  onToggleEyedropperDoubleTap,
  hasSelection,
  hasClipboard,
  onChange,
  onStartSelectionMove,
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

  const sizePresetOptions = BRUSH_SIZE_PRESET_VALUES.map((sz) => ({
    value: sz,
    label: `${sz}px`,
  }))

  const renderDitherPicker = (
    current: DitherPatternId,
    onPick: (id: DitherPatternId) => void
  ) => (
    <div className="space-y-1">
      <div className="text-[11px] text-[var(--text-secondary)]">
        {t('dithering')}:{' '}
        <strong className="text-[var(--text-primary)]">
          {t(DITHER_LABEL_KEYS[current])}
        </strong>
      </div>
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
        {ALL_DITHER_PATTERN_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            title={t(DITHER_LABEL_KEYS[id])}
            className="flex flex-col items-center gap-0.5 shrink-0 cursor-pointer"
            data-testid={`dither-opt-${id}`}
          >
            <DitherSwatch patternId={id} active={current === id} />
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
          initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className="absolute bottom-full left-2 right-2 sm:left-auto sm:right-2.5 sm:w-[360px] mb-1.5 z-30 pixel-popover-translucent p-2.5 space-y-2 max-h-[42dvh] overflow-y-auto"
          data-testid="tool-detail-panel"
        >
          <div className="flex items-center justify-between pb-1 border-b border-[var(--border-subtle)]">
            <span className="text-xs font-bold text-[var(--accent-primary)] flex items-center gap-1.5">
              <PixelIcon name={resolveToolIconName(tool, settings)} size={14} />
              <span>{t('toolOptions')}</span>
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
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs shrink-0">
                  {t('size')}: <strong>{settings.penSize}px</strong>
                </span>
                <PixelSlider
                  min={1}
                  max={32}
                  value={settings.penSize}
                  unit="px"
                  ariaLabel={t('size')}
                  onChange={(v) => onChange({ penSize: v })}
                  className="flex-1 min-w-[140px]"
                  testId="pen-size-slider"
                />
                <PixelSelect<number>
                  value={settings.penSize}
                  options={sizePresetOptions}
                  onChange={(v) => onChange({ penSize: v })}
                  ariaLabel={t('sizePresets')}
                  align="right"
                  className="w-20"
                  testId="pen-size-preset-select"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
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

                <PixelCheckbox
                  checked={settings.pixelPerfect}
                  onChange={(next) => onChange({ pixelPerfect: next })}
                  label={t('pixelPerfect')}
                  testId="toggle-pixel-perfect"
                />
              </div>

              {renderDitherPicker(settings.penDither, (id) =>
                onChange({ penDither: id })
              )}
            </div>
          )}

          {/* ERASER */}
          {tool === 'eraser' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs shrink-0">
                  {t('size')}: <strong>{settings.eraserSize}px</strong>
                </span>
                <PixelSlider
                  min={1}
                  max={32}
                  value={settings.eraserSize}
                  unit="px"
                  ariaLabel={t('size')}
                  onChange={(v) => onChange({ eraserSize: v })}
                  className="flex-1 min-w-[140px]"
                  testId="eraser-size-slider"
                />
                <PixelSelect<number>
                  value={settings.eraserSize}
                  options={sizePresetOptions}
                  onChange={(v) => onChange({ eraserSize: v })}
                  ariaLabel={t('sizePresets')}
                  align="right"
                  className="w-20"
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

          {/* EYEDROPPER (Section 9: Double-tap activation toggle) */}
          {tool === 'eyedropper' && (
            <div className="space-y-1.5">
              <PixelCheckbox
                checked={eyedropperDoubleTap}
                onChange={onToggleEyedropperDoubleTap}
                label={t('eyedropperDoubleTapLabel')}
                testId="toggle-eyedropper-doubletap"
              />
              <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                {t('eyedropperDoubleTapDesc')}
              </p>
            </div>
          )}

          {/* FILL */}
          {tool === 'fill' && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChange({ fillMode: 'normal' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1.5 ${
                      settings.fillMode === 'normal'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                    data-testid="fill-mode-normal"
                  >
                    <PixelIcon name="fill" size={14} />
                    <span>{t('fillNormal')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ fillMode: 'gradient' })}
                    className={`min-h-[36px] px-2.5 text-xs font-bold flex items-center gap-1.5 ${
                      settings.fillMode === 'gradient'
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                    data-testid="fill-mode-gradient"
                  >
                    <PixelIcon name="gradient" size={14} />
                    <span>{t('fillGradient')}</span>
                  </button>
                </div>

                {settings.fillMode === 'normal' && (
                  <div className="flex items-center gap-1" data-testid="fill-connectivity-group">
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
                )}
              </div>

              {settings.fillMode === 'normal' ? (
                renderDitherPicker(settings.fillDither, (id) =>
                  onChange({ fillDither: id })
                )
              ) : (
                <div className="space-y-2">
                  {/* Section 4-5: Linear Gradient vs Circular/Radial Gradient + 1:1 Aspect Ratio Lock */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onChange({ gradientType: 'linear' })}
                        className={`min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                          settings.gradientType === 'linear'
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                        data-testid="gradient-type-linear"
                      >
                        <PixelIcon name="line" size={13} />
                        <span>{t('gradientLinear')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onChange({ gradientType: 'radial' })}
                        className={`min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                          settings.gradientType === 'radial'
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                        data-testid="gradient-type-radial"
                      >
                        <PixelIcon name="ellipse" size={13} />
                        <span>{t('gradientRadial')}</span>
                      </button>
                    </div>

                    {settings.gradientType === 'radial' && (
                      <PixelCheckbox
                        checked={settings.gradientFixedRatio}
                        onChange={(next) =>
                          onChange({ gradientFixedRatio: next })
                        }
                        label={t('gradientFixedRatio')}
                        testId="gradient-fixed-ratio-checkbox"
                      />
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[var(--text-secondary)] shrink-0">
                      {t('gradientSteps')}:
                    </span>
                    <PixelSelect<GradientSteps>
                      value={settings.gradientSteps}
                      options={[
                        { value: 4, label: t('grad4Steps') },
                        { value: 8, label: t('grad8Steps') },
                      ]}
                      onChange={(v) => onChange({ gradientSteps: v })}
                      ariaLabel={t('gradientSteps')}
                      className="flex-1 max-w-[220px]"
                      testId="gradient-steps-select"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* LINE & PIXEL-PERFECT BEZIER (Section 2: Line size/shape/dither/pixelPerfect) */}
          {tool === 'line' && (
            <div className="space-y-2.5">
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
                    data-testid="line-type-straight"
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
                    data-testid="line-shape-square"
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
                    data-testid="line-shape-circle"
                  >
                    <PixelIcon name="ellipse" size={14} />
                    {t('shapeCircle')}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs shrink-0">
                  {t('size')}: <strong>{settings.lineSize}px</strong>
                </span>
                <PixelSlider
                  min={1}
                  max={32}
                  value={settings.lineSize}
                  unit="px"
                  ariaLabel={t('size')}
                  onChange={(v) => onChange({ lineSize: v })}
                  className="flex-1 min-w-[140px]"
                  testId="line-size-slider"
                />
                {settings.lineType === 'line' && (
                  <PixelCheckbox
                    checked={settings.linePixelPerfect}
                    onChange={(next) => onChange({ linePixelPerfect: next })}
                    label={t('pixelPerfect')}
                    testId="toggle-line-pixel-perfect"
                  />
                )}
              </div>

              {renderDitherPicker(settings.lineDither, (id) =>
                onChange({ lineDither: id })
              )}
            </div>
          )}

          {/* SHAPE */}
          {tool === 'shape' && (
            <div className="space-y-2.5">
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
                    data-testid="shape-type-rect"
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
                    data-testid="shape-type-ellipse"
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
                  <span className="text-xs shrink-0">
                    {t('strokeWidth')}: <strong>{settings.shapeSize}px</strong>
                  </span>
                  <PixelSlider
                    min={1}
                    max={16}
                    value={settings.shapeSize}
                    unit="px"
                    ariaLabel={t('strokeWidth')}
                    onChange={(v) => onChange({ shapeSize: v })}
                    className="flex-1"
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
            <div className="space-y-2.5">
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
                      data-testid="select-type-rect"
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

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => {
                    onStartSelectionMove()
                    onClose()
                  }}
                  className="pixel-btn pixel-btn-teal min-h-[40px] px-3 text-xs font-bold flex items-center gap-1.5"
                  data-testid="start-selection-move-btn"
                >
                  <PixelIcon name="move" size={14} />
                  <span>{t('startMoveBtn')}</span>
                </button>

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
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={onCut}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="cut" size={13} />
                  {t('cut')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={onCopy}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="copy" size={13} />
                  {t('copy')}
                </button>
                <button
                  type="button"
                  disabled={!hasClipboard}
                  onClick={onPaste}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="paste" size={13} />
                  {t('paste')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onFlipSelection('horizontal')}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="flipH" size={13} />
                  {t('flipH')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => onFlipSelection('vertical')}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
                >
                  <PixelIcon name="flipV" size={13} />
                  {t('flipV')}
                </button>
                <button
                  type="button"
                  disabled={!hasSelection}
                  onClick={() => setShowOutlineConfig((v) => !v)}
                  className={`min-h-[36px] px-2 text-xs font-bold ${
                    showOutlineConfig ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                  }`}
                  data-testid="toggle-outline-config-btn"
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
                  className="pixel-btn pixel-btn-danger min-h-[36px] px-2 text-xs font-bold ml-auto"
                >
                  {t('clearSelection')}
                </button>
              </div>

              {/* Section 3: Selection Outline Color RESTRICTED strictly to current project palette swatches! */}
              {showOutlineConfig && hasSelection && (
                <div
                  className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2"
                  data-testid="outline-config-box"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onChange({ outlineMode: 'normal' })}
                        className={`min-h-[32px] px-2 text-xs font-bold ${
                          settings.outlineMode === 'normal'
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                      >
                        {t('outlineNormal')}
                      </button>
                      <button
                        type="button"
                        onClick={() => onChange({ outlineMode: 'pixelPerfect' })}
                        className={`min-h-[32px] px-2 text-xs font-bold ${
                          settings.outlineMode === 'pixelPerfect'
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                      >
                        {t('outlinePP')}
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={onApplyOutline}
                      className="pixel-btn pixel-btn-teal min-h-[34px] px-3 text-xs font-bold"
                      data-testid="apply-outline-btn"
                    >
                      {t('outlineApply')}
                    </button>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-bold text-[var(--text-secondary)] block">
                      {t('outlineColor')}
                    </span>
                    <div
                      className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1"
                      data-testid="outline-palette-swatches"
                    >
                      {paletteColors.map((hex, idx) => {
                        const active =
                          settings.outlineColor.toUpperCase() === hex.toUpperCase()
                        return (
                          <button
                            key={`outline-${idx}-${hex}`}
                            type="button"
                            onClick={() => onChange({ outlineColor: hex })}
                            style={{ backgroundColor: hex }}
                            aria-pressed={active}
                            aria-label={`${t('outlineColor')} ${idx + 1} ${hex}`}
                            className={`relative w-7 h-7 shrink-0 cursor-pointer ${
                              active
                                ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                                : 'border-2 border-[var(--border-pixel)]'
                            }`}
                            data-testid={`outline-swatch-${idx}`}
                          >
                            {active && (
                              <span
                                className="absolute -top-1 -right-1 w-3 h-3 bg-[var(--bg-panel)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-primary)]"
                                aria-hidden="true"
                              >
                                <PixelIcon name="check" size={8} />
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs shrink-0">
                      {t('size')}: <strong>{settings.outlineSize}px</strong>
                    </span>
                    <PixelSlider
                      min={1}
                      max={8}
                      value={settings.outlineSize}
                      unit="px"
                      ariaLabel={t('size')}
                      onChange={(v) => onChange({ outlineSize: v })}
                      className="flex-1"
                    />
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
