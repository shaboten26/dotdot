import { useMemo, useState } from 'react'
import type { LayerRuntime, PlaybackDirection } from '../../types'
import {
  getCellStateKind,
  getCelReferenceCountMap,
  makeCellKey,
  type TimelineState,
} from '../../engine/animation'
import type {
  CelClipboardItem,
  OnionSkinConfig,
} from '../../state/useEditorController'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { PixelSlider } from '../common/PixelSlider'
import { LayerBufferThumbnail } from '../common/PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

interface TimelinePanelProps {
  canvasWidth: number
  canvasHeight: number
  checkerDark?: boolean
  layers: readonly LayerRuntime[]
  activeLayerId: string
  timeline: TimelineState
  selectedCellKeys: readonly string[]
  celClipboard: CelClipboardItem | null
  isPlaying: boolean
  playbackSpeed: number
  onionSkin: OnionSkinConfig
  onSelectLayer: (layerId: string) => void
  onUpdateLayer: (
    layerId: string,
    patch: Partial<
      Pick<
        LayerRuntime,
        'name' | 'visible' | 'locked' | 'opacity' | 'blendMode' | 'clipping'
      >
    >
  ) => void
  onAddLayer: () => void
  onOpenLayerSheet: () => void
  onSelectFrame: (frameId: string) => void
  onStepFrame: (delta: -1 | 1) => void
  onAddEmptyFrame: () => void
  onDuplicateFrame: (mode: 'independent' | 'linked') => void
  onDeleteFrame: (frameId?: string) => void
  onSetFrameDuration: (frameId: string, durationMs: number) => void
  onApplyBatchDuration: (
    scope:
      | { mode: 'selected'; selectedFrameIds: readonly string[] }
      | { mode: 'all' },
    durationMs: number
  ) => void
  onClearCell: (layerId?: string, frameId?: string) => void
  onUnlinkCell: (layerId?: string, frameId?: string) => void
  onLinkCellTo: (
    layerId: string,
    sourceFrameId: string,
    targetFrameId: string
  ) => void
  onMoveCellTo: (
    layerId: string,
    sourceFrameId: string,
    targetFrameId: string
  ) => void
  onToggleCellSelected: (cellKey: string) => void
  onClearCellSelection: () => void
  onBatchClearCells: () => void
  onBatchUnlinkCells: () => void
  onBatchLinkCells: () => void
  onCopyActiveCell: () => void
  onPasteToActiveCell: (asLinked?: boolean) => void
  onTogglePlay: () => void
  onSetPlaybackSpeed: (speed: number) => void
  onSetPlaybackDirection: (dir: PlaybackDirection) => void
  onSetLoopPlayback: (loop: boolean) => void
  onUpdateOnionSkin: (patch: Partial<OnionSkinConfig>) => void
  onOpenExportGif: () => void
}

const SPEED_OPTIONS = [0.5, 1, 1.5, 2] as const

export function TimelinePanel({
  canvasWidth,
  canvasHeight,
  checkerDark = false,
  layers,
  activeLayerId,
  timeline,
  selectedCellKeys,
  celClipboard,
  isPlaying,
  playbackSpeed,
  onionSkin,
  onSelectLayer,
  onUpdateLayer,
  onAddLayer,
  onOpenLayerSheet,
  onSelectFrame,
  onStepFrame,
  onAddEmptyFrame,
  onDuplicateFrame,
  onDeleteFrame,
  onSetFrameDuration,
  onApplyBatchDuration,
  onClearCell,
  onUnlinkCell,
  onLinkCellTo,
  onMoveCellTo,
  onToggleCellSelected,
  onClearCellSelection,
  onBatchClearCells,
  onBatchUnlinkCells,
  onBatchLinkCells,
  onCopyActiveCell,
  onPasteToActiveCell,
  onTogglePlay,
  onSetPlaybackSpeed,
  onSetPlaybackDirection,
  onSetLoopPlayback,
  onUpdateOnionSkin,
  onOpenExportGif,
}: TimelinePanelProps) {
  const { t } = useI18n()
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [onionPopoverOpen, setOnionPopoverOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)

  const activeFrame =
    timeline.frames.find((f) => f.id === timeline.activeFrameId) ??
    timeline.frames[0]!
  const activeFrameIdx = Math.max(
    0,
    timeline.frames.findIndex((f) => f.id === activeFrame.id)
  )
  const [batchMsInput, setBatchMsInput] = useState<number>(
    activeFrame?.durationMs ?? 100
  )

  const refCountMap = useMemo(
    () => getCelReferenceCountMap(timeline.cels),
    [timeline.cels]
  )

  const displayLayersTopDown = useMemo(() => [...layers].reverse(), [layers])
  const isSingleFrameMode = timeline.frames.length <= 1

  const activeCellState = getCellStateKind(
    timeline.cels,
    timeline.celBuffers,
    activeLayerId,
    activeFrame.id,
    refCountMap
  )

  const selectedFrameIdsFromCells = useMemo(() => {
    const s = new Set<string>()
    for (const ck of selectedCellKeys) {
      const sep = ck.indexOf(':')
      if (sep >= 0) s.add(ck.slice(sep + 1))
    }
    return Array.from(s)
  }, [selectedCellKeys])

  // 1-Frame Still Artwork Mode -> Compact Inline Layer Workspace + Quick Add Frame to Convert into Animation!
  if (isSingleFrameMode) {
    return (
      <div
        className="px-2.5 py-2 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] space-y-2 shrink-0"
        data-testid="inline-layers-workspace"
      >
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onAddLayer}
              className="pixel-btn pixel-btn-active min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
              data-testid="inline-add-layer-btn"
            >
              <PixelIcon name="plus" size={13} />
              <span>{t('addLayer')}</span>
            </button>
            <button
              type="button"
              onClick={onOpenLayerSheet}
              className="pixel-btn min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
              data-testid="inline-open-layer-sheet-btn"
            >
              <PixelIcon name="layers" size={13} />
              <span>{t('layersTitle')}</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onDuplicateFrame('independent')}
              className="pixel-btn pixel-btn-teal min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
              data-testid="convert-to-animation-dup-btn"
            >
              <PixelIcon name="film" size={13} />
              <span>+ {t('duplicateFrameBtn')}</span>
            </button>
            <button
              type="button"
              onClick={onAddEmptyFrame}
              className="pixel-btn min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
              data-testid="convert-to-animation-empty-btn"
            >
              <PixelIcon name="plus" size={13} />
              <span>{t('addEmptyFrameBtn')}</span>
            </button>
          </div>
        </div>

        <div className="max-h-36 overflow-y-auto space-y-1 pr-0.5">
          {displayLayersTopDown.map((layer) => {
            const isActive = layer.id === activeLayerId
            return (
              <div
                key={layer.id}
                onClick={() => onSelectLayer(layer.id)}
                className={`px-2 py-1 border-2 flex items-center gap-2 cursor-pointer ${
                  isActive
                    ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)]'
                    : 'bg-[var(--bg-elevated)] border-[var(--border-pixel)]'
                }`}
                data-testid={`inline-layer-row-${layer.id}`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateLayer(layer.id, { visible: !layer.visible })
                  }}
                  className="pixel-btn w-7 h-7 flex items-center justify-center shrink-0"
                  title={layer.visible ? t('layerVisible') : t('layerHidden')}
                >
                  <PixelIcon name={layer.visible ? 'eye' : 'eyeOff'} size={13} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateLayer(layer.id, { locked: !layer.locked })
                  }}
                  className={`pixel-btn w-7 h-7 flex items-center justify-center shrink-0 ${
                    layer.locked ? 'pixel-btn-active' : ''
                  }`}
                  data-testid={`inline-layer-lock-${layer.id}`}
                >
                  <PixelIcon name={layer.locked ? 'lock' : 'unlock'} size={13} />
                </button>
                <LayerBufferThumbnail
                  layer={layer}
                  canvasWidth={canvasWidth}
                  canvasHeight={canvasHeight}
                  size={24}
                  checkerDark={checkerDark}
                />
                <span className="text-xs font-bold truncate flex-1">
                  {layer.name}
                </span>
                <span className="text-[10px] text-[var(--text-secondary)] shrink-0">
                  {layer.opacity}%
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // >= 2 Frames Mode -> Full Compact Layer × Frame Cel Matrix Timeline!
  return (
    <div
      className="relative px-2 py-1.5 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] space-y-1.5 shrink-0"
      data-testid="timeline-workspace-panel"
    >
      {/* Onion Skin Popover */}
      {onionPopoverOpen && (
        <div
          className="absolute bottom-full right-2 mb-1.5 z-30 w-64 pixel-popover-translucent p-2.5 space-y-2 text-xs"
          data-testid="onion-skin-popover"
        >
          <div className="flex items-center justify-between font-bold">
            <span>{t('onionSkinLabel')}</span>
            <button
              type="button"
              onClick={() => setOnionPopoverOpen(false)}
              className="pixel-btn w-6 h-6 flex items-center justify-center"
            >
              <PixelIcon name="close" size={12} />
            </button>
          </div>
          <PixelCheckbox
            checked={onionSkin.enabled}
            onChange={(v) => onUpdateOnionSkin({ enabled: v })}
            label={t('onionSkinLabel')}
            testId="onion-enabled-checkbox"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <PixelCheckbox
              checked={onionSkin.showPrev}
              onChange={(v) => onUpdateOnionSkin({ showPrev: v })}
              label={t('onionPrevLabel')}
            />
            <PixelCheckbox
              checked={onionSkin.showNext}
              onChange={(v) => onUpdateOnionSkin({ showNext: v })}
              label={t('onionNextLabel')}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0">{t('onionCountLabel')}</span>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onUpdateOnionSkin({ prevCount: n, nextCount: n })}
                className={`min-h-[28px] px-2 text-xs font-bold ${
                  onionSkin.prevCount === n
                    ? 'pixel-btn pixel-btn-active'
                    : 'pixel-btn'
                }`}
              >
                ±{n}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <span>
              {t('onionOpacityLabel')}: <strong>{onionSkin.opacity}%</strong>
            </span>
            <PixelSlider
              min={10}
              max={80}
              step={5}
              value={onionSkin.opacity}
              unit="%"
              ariaLabel={t('onionOpacityLabel')}
              onChange={(v) => onUpdateOnionSkin({ opacity: v })}
            />
          </div>
        </div>
      )}

      {/* Batch ms Popover */}
      {batchOpen && (
        <div
          className="absolute bottom-full left-2 mb-1.5 z-30 w-72 pixel-popover-translucent p-2.5 space-y-2 text-xs"
          data-testid="batch-duration-popover"
        >
          <div className="flex items-center justify-between font-bold">
            <span>{t('batchDurationLabel')}</span>
            <button
              type="button"
              onClick={() => setBatchOpen(false)}
              className="pixel-btn w-6 h-6 flex items-center justify-center"
            >
              <PixelIcon name="close" size={12} />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={10}
              max={60000}
              step={10}
              value={batchMsInput}
              onChange={(e) =>
                setBatchMsInput(Math.max(10, Number(e.target.value) || 100))
              }
              className="w-24 min-h-[32px] px-2 text-xs font-bold pixel-input"
              data-testid="batch-ms-input"
            />
            <span>ms</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                onApplyBatchDuration({ mode: 'all' }, batchMsInput)
                setBatchOpen(false)
              }}
              className="pixel-btn pixel-btn-active min-h-[32px] px-2.5 text-xs font-bold"
              data-testid="batch-apply-all-btn"
            >
              {t('applyAllFramesBtn')}
            </button>
            {selectedFrameIdsFromCells.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onApplyBatchDuration(
                    {
                      mode: 'selected',
                      selectedFrameIds: selectedFrameIdsFromCells,
                    },
                    batchMsInput
                  )
                  setBatchOpen(false)
                }}
                className="pixel-btn pixel-btn-teal min-h-[32px] px-2.5 text-xs font-bold"
                data-testid="batch-apply-selected-btn"
              >
                {t('applySelectedFramesBtn')} ({selectedFrameIdsFromCells.length})
              </button>
            )}
          </div>
        </div>
      )}

      {/* Row 1: Transport + Direction/Loop/Speed + Onion + Frame Duration + Frame Add/Dup/Del */}
      <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onStepFrame(-1)}
            title={t('prevFrameBtn')}
            className="pixel-btn min-w-[32px] min-h-[32px] flex items-center justify-center"
            data-testid="timeline-prev-frame-btn"
          >
            <PixelIcon name="arrowLeft" size={13} />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            title={isPlaying ? t('pauseBtn') : t('playBtn')}
            className={`min-w-[36px] min-h-[32px] px-2 flex items-center justify-center gap-1 font-bold ${
              isPlaying ? 'pixel-btn pixel-btn-teal' : 'pixel-btn pixel-btn-active'
            }`}
            data-testid="timeline-play-btn"
          >
            <PixelIcon name={isPlaying ? 'pause' : 'play'} size={13} />
            <span className="text-[11px]">
              {activeFrameIdx + 1}/{timeline.frames.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onStepFrame(1)}
            title={t('nextFrameBtn')}
            className="pixel-btn min-w-[32px] min-h-[32px] flex items-center justify-center"
            data-testid="timeline-next-frame-btn"
          >
            <PixelIcon name="arrowRight" size={13} />
          </button>

          {/* Direction cycle button */}
          <button
            type="button"
            onClick={() => {
              const order: PlaybackDirection[] = ['forward', 'reverse', 'pingpong']
              const next =
                order[(order.indexOf(timeline.playbackDirection) + 1) % order.length]!
              onSetPlaybackDirection(next)
            }}
            className="pixel-btn min-h-[32px] px-2 text-[11px] font-bold"
            data-testid="timeline-direction-btn"
          >
            {timeline.playbackDirection === 'forward'
              ? '→'
              : timeline.playbackDirection === 'reverse'
                ? '←'
                : '↔'}
          </button>

          {/* Loop toggle */}
          <button
            type="button"
            onClick={() => onSetLoopPlayback(!timeline.loopPlayback)}
            className={`min-h-[32px] px-2 text-[11px] font-bold ${
              timeline.loopPlayback ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="timeline-loop-btn"
          >
            {timeline.loopPlayback ? t('loopPlaybackLabel') : t('oncePlaybackLabel')}
          </button>

          {/* Speed cycle */}
          <button
            type="button"
            onClick={() => {
              const idx = SPEED_OPTIONS.indexOf(
                playbackSpeed as (typeof SPEED_OPTIONS)[number]
              )
              const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]!
              onSetPlaybackSpeed(next)
            }}
            className="pixel-btn min-h-[32px] px-1.5 text-[11px] font-mono font-bold"
            data-testid="timeline-speed-btn"
          >
            {playbackSpeed}x
          </button>
        </div>

        {/* Active Frame Duration (ms) + Batch + Onion + GIF + Frame Add/Dup/Del */}
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex items-center gap-0.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] px-1.5 min-h-[32px]">
            <PixelIcon name="clock" size={12} />
            <input
              type="number"
              min={10}
              max={60000}
              step={10}
              value={activeFrame.durationMs}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v) && v >= 10) {
                  onSetFrameDuration(activeFrame.id, v)
                }
              }}
              className="w-14 bg-transparent text-right text-xs font-bold focus:outline-none select-text"
              data-testid="active-frame-ms-input"
            />
            <span className="text-[10px] text-[var(--text-secondary)]">ms</span>
          </div>

          <button
            type="button"
            onClick={() => {
              setBatchMsInput(activeFrame.durationMs)
              setBatchOpen((v) => !v)
              setOnionPopoverOpen(false)
            }}
            className={`min-h-[32px] px-2 text-[11px] font-bold ${
              batchOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="open-batch-ms-btn"
          >
            {t('batchDurationLabel')}
          </button>

          <button
            type="button"
            onClick={() => {
              if (!onionSkin.enabled) {
                onUpdateOnionSkin({ enabled: true })
              }
              setOnionPopoverOpen((v) => !v)
              setBatchOpen(false)
            }}
            className={`min-h-[32px] px-2 text-[11px] font-bold flex items-center gap-1 ${
              onionSkin.enabled ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="timeline-onion-btn"
          >
            <PixelIcon name="onion" size={13} />
          </button>

          <button
            type="button"
            onClick={onAddEmptyFrame}
            title={t('addEmptyFrameBtn')}
            className="pixel-btn min-h-[32px] px-2 text-[11px] font-bold flex items-center gap-0.5"
            data-testid="timeline-add-empty-frame-btn"
          >
            <PixelIcon name="plus" size={12} />
            <span>F</span>
          </button>

          <button
            type="button"
            onClick={() => onDuplicateFrame('independent')}
            title={t('duplicateFrameBtn')}
            className="pixel-btn min-h-[32px] px-2 text-[11px] font-bold flex items-center gap-0.5"
            data-testid="timeline-dup-frame-btn"
          >
            <PixelIcon name="copy" size={12} />
          </button>

          <button
            type="button"
            onClick={() => onDuplicateFrame('linked')}
            title={`${t('duplicateFrameBtn')} (${t('celLinkedLabel')})`}
            className="pixel-btn min-h-[32px] px-2 text-[11px] font-bold flex items-center gap-0.5"
            data-testid="timeline-dup-linked-frame-btn"
          >
            <PixelIcon name="link" size={12} />
          </button>

          <button
            type="button"
            disabled={timeline.frames.length <= 1}
            onClick={() => onDeleteFrame(activeFrame.id)}
            title={t('deleteFrameBtn')}
            className="pixel-btn pixel-btn-danger min-h-[32px] px-2 text-[11px] font-bold flex items-center justify-center"
            data-testid="timeline-del-frame-btn"
          >
            <PixelIcon name="trash" size={12} />
          </button>

          <button
            type="button"
            onClick={onOpenExportGif}
            className="pixel-btn pixel-btn-teal min-h-[32px] px-2 text-[11px] font-bold flex items-center gap-1"
            data-testid="timeline-export-gif-btn"
          >
            <PixelIcon name="film" size={12} />
            <span>GIF</span>
          </button>
        </div>
      </div>

      {/* Row 2: Layer × Frame Cel Matrix */}
      <div className="border-2 border-[var(--border-pixel)] bg-[var(--bg-elevated)] max-h-40 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)]">
            <tr>
              <th className="sticky left-0 z-20 bg-[var(--bg-surface)] border-r-2 border-[var(--border-pixel)] px-1.5 py-1 text-left min-w-[116px]">
                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={onOpenLayerSheet}
                    className="pixel-btn px-1.5 py-0.5 text-[10px] font-bold flex items-center gap-1"
                    data-testid="timeline-open-layers-modal-btn"
                  >
                    <PixelIcon name="layers" size={11} />
                    <span>{layers.length}</span>
                  </button>
                  <button
                    type="button"
                    onClick={onAddLayer}
                    className="pixel-btn px-1.5 py-0.5 text-[10px] font-bold"
                    title={t('addLayer')}
                    data-testid="timeline-add-layer-btn"
                  >
                    +L
                  </button>
                </div>
              </th>
              {timeline.frames.map((f, fIdx) => {
                const isCurFrame = f.id === activeFrame.id
                return (
                  <th
                    key={f.id}
                    onClick={() => onSelectFrame(f.id)}
                    className={`min-w-[38px] px-1 py-0.5 text-center border-r border-[var(--border-subtle)] cursor-pointer select-none ${
                      isCurFrame
                        ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                        : 'hover:bg-[var(--bg-panel)]'
                    }`}
                    data-testid={`timeline-frame-header-${fIdx}`}
                  >
                    <div className="text-[11px] font-bold leading-tight">
                      {fIdx + 1}
                    </div>
                    <div className="text-[9px] opacity-85 leading-none">
                      {f.durationMs}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {displayLayersTopDown.map((layer) => {
              const isCurLayer = layer.id === activeLayerId
              return (
                <tr
                  key={layer.id}
                  className="border-b border-[var(--border-subtle)] last:border-b-0"
                >
                  <td
                    onClick={() => onSelectLayer(layer.id)}
                    className={`sticky left-0 z-10 px-1.5 py-1 border-r-2 border-[var(--border-pixel)] cursor-pointer ${
                      isCurLayer
                        ? 'bg-[var(--bg-panel)] font-bold'
                        : 'bg-[var(--bg-surface)]'
                    }`}
                  >
                    <div className="flex items-center gap-1 max-w-[120px]">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onUpdateLayer(layer.id, { visible: !layer.visible })
                        }}
                        className="opacity-80 hover:opacity-100 shrink-0"
                      >
                        <PixelIcon
                          name={layer.visible ? 'eye' : 'eyeOff'}
                          size={12}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onUpdateLayer(layer.id, { locked: !layer.locked })
                        }}
                        className="opacity-80 hover:opacity-100 shrink-0"
                      >
                        <PixelIcon
                          name={layer.locked ? 'lock' : 'unlock'}
                          size={12}
                        />
                      </button>
                      <span className="truncate text-[11px]">{layer.name}</span>
                    </div>
                  </td>

                  {timeline.frames.map((f, fIdx) => {
                    const ck = makeCellKey(layer.id, f.id)
                    const kind = getCellStateKind(
                      timeline.cels,
                      timeline.celBuffers,
                      layer.id,
                      f.id,
                      refCountMap
                    )
                    const ref = timeline.cels[ck]
                    const prevRef =
                      fIdx > 0
                        ? timeline.cels[
                            makeCellKey(layer.id, timeline.frames[fIdx - 1]!.id)
                          ]
                        : undefined
                    const nextRef =
                      fIdx < timeline.frames.length - 1
                        ? timeline.cels[
                            makeCellKey(layer.id, timeline.frames[fIdx + 1]!.id)
                          ]
                        : undefined

                    const linkedLeft =
                      kind === 'linked' &&
                      ref?.kind === 'cel' &&
                      prevRef?.kind === 'cel' &&
                      prevRef.celId === ref.celId
                    const linkedRight =
                      kind === 'linked' &&
                      ref?.kind === 'cel' &&
                      nextRef?.kind === 'cel' &&
                      nextRef.celId === ref.celId

                    const isActiveCell =
                      isCurLayer && f.id === activeFrame.id
                    const isMultiSelected = selectedCellKeys.includes(ck)

                    return (
                      <td
                        key={ck}
                        onClick={(e) => {
                          if (multiSelectMode || e.shiftKey) {
                            onToggleCellSelected(ck)
                          } else {
                            onSelectLayer(layer.id)
                            onSelectFrame(f.id)
                          }
                        }}
                        className={`relative h-7 text-center border-r border-[var(--border-subtle)] cursor-pointer select-none ${
                          isMultiSelected
                            ? 'bg-[var(--accent-teal)] text-[var(--accent-teal-fg)]'
                            : isActiveCell
                              ? 'bg-[var(--bg-panel)] outline-2 -outline-offset-2 outline-[var(--accent-primary)]'
                              : ''
                        }`}
                        data-testid={`cel-${layer.id}-${fIdx}`}
                        data-cel-kind={kind}
                      >
                        {/* Horizontal connector bar for adjacent linked cels */}
                        {linkedLeft && (
                          <span
                            className="absolute left-0 top-1/2 -translate-y-1/2 w-1/2 h-0.5 bg-[var(--accent-teal)]"
                            aria-hidden="true"
                          />
                        )}
                        {linkedRight && (
                          <span
                            className="absolute right-0 top-1/2 -translate-y-1/2 w-1/2 h-0.5 bg-[var(--accent-teal)]"
                            aria-hidden="true"
                          />
                        )}
                        <span className="relative z-10 text-[11px] font-bold">
                          {kind === 'empty'
                            ? '·'
                            : kind === 'linked'
                              ? '◆'
                              : '●'}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Row 3: Cel Action Strip (Empty / Independent / Linked + Multi-Cel Batch + Copy/Paste/Move) */}
      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setMultiSelectMode((v) => {
                if (v) onClearCellSelection()
                return !v
              })
            }}
            className={`min-h-[28px] px-2 font-bold ${
              multiSelectMode ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="cel-multiselect-toggle-btn"
          >
            {multiSelectMode && selectedCellKeys.length > 0
              ? `${t('selectedLayersCount')}:${selectedCellKeys.length}`
              : t('toolSelect')}
          </button>

          {selectedCellKeys.length >= 2 ? (
            <>
              <button
                type="button"
                onClick={onBatchLinkCells}
                className="pixel-btn pixel-btn-teal min-h-[28px] px-2 font-bold flex items-center gap-1"
                data-testid="cel-batch-link-btn"
              >
                <PixelIcon name="link" size={11} />
                <span>{t('celLinkBtn')}</span>
              </button>
              <button
                type="button"
                onClick={onBatchUnlinkCells}
                className="pixel-btn min-h-[28px] px-2 font-bold flex items-center gap-1"
                data-testid="cel-batch-unlink-btn"
              >
                <PixelIcon name="unlink" size={11} />
                <span>{t('celUnlinkBtn')}</span>
              </button>
              <button
                type="button"
                onClick={onBatchClearCells}
                className="pixel-btn pixel-btn-danger min-h-[28px] px-2 font-bold"
                data-testid="cel-batch-clear-btn"
              >
                {t('celClearBtn')}
              </button>
            </>
          ) : (
            <>
              <span
                className="px-1.5 py-0.5 bg-[var(--bg-elevated)] border border-[var(--border-pixel)] font-bold"
                data-testid="active-cel-kind-badge"
              >
                {activeCellState === 'empty'
                  ? t('celEmptyLabel')
                  : activeCellState === 'linked'
                    ? t('celLinkedLabel')
                    : t('celIndependentLabel')}
              </span>

              {activeCellState === 'linked' && (
                <button
                  type="button"
                  onClick={() => onUnlinkCell(activeLayerId, activeFrame.id)}
                  className="pixel-btn min-h-[28px] px-2 font-bold flex items-center gap-1"
                  data-testid="cel-unlink-active-btn"
                >
                  <PixelIcon name="unlink" size={11} />
                  <span>{t('celUnlinkBtn')}</span>
                </button>
              )}

              {activeFrameIdx > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    onLinkCellTo(
                      activeLayerId,
                      timeline.frames[activeFrameIdx - 1]!.id,
                      activeFrame.id
                    )
                  }
                  className="pixel-btn min-h-[28px] px-2 font-bold flex items-center gap-1"
                  data-testid="cel-link-prev-btn"
                >
                  <PixelIcon name="link" size={11} />
                  <span>{t('celLinkBtn')}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => onClearCell(activeLayerId, activeFrame.id)}
                className="pixel-btn min-h-[28px] px-2 font-bold"
                data-testid="cel-clear-active-btn"
              >
                {t('celClearBtn')}
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCopyActiveCell}
            className="pixel-btn min-h-[28px] px-2 font-bold"
            title={t('celCopyBtn')}
            data-testid="cel-copy-btn"
          >
            <PixelIcon name="copy" size={11} />
          </button>
          <button
            type="button"
            disabled={!celClipboard}
            onClick={() => onPasteToActiveCell(false)}
            className="pixel-btn min-h-[28px] px-2 font-bold"
            title={t('celPasteBtn')}
            data-testid="cel-paste-btn"
          >
            <PixelIcon name="paste" size={11} />
          </button>
          {activeFrameIdx > 0 && (
            <button
              type="button"
              onClick={() =>
                onMoveCellTo(
                  activeLayerId,
                  activeFrame.id,
                  timeline.frames[activeFrameIdx - 1]!.id
                )
              }
              className="pixel-btn min-h-[28px] px-1.5 font-bold"
              title="←"
              data-testid="cel-move-left-btn"
            >
              ←
            </button>
          )}
          {activeFrameIdx < timeline.frames.length - 1 && (
            <button
              type="button"
              onClick={() =>
                onMoveCellTo(
                  activeLayerId,
                  activeFrame.id,
                  timeline.frames[activeFrameIdx + 1]!.id
                )
              }
              className="pixel-btn min-h-[28px] px-1.5 font-bold"
              title="→"
              data-testid="cel-move-right-btn"
            >
              →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
