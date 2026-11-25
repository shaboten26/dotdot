import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { LayerRuntime, PlaybackDirection } from '../../types'
import {
  getCellStateKind,
  getCelReferenceCountMap,
  getCellsSharingCelId,
  makeCellKey,
  type TimelineState,
} from '../../engine/animation'
import type {
  CelClipboardItem,
  OnionSkinConfig,
} from '../../state/useEditorController'
import { PixelIcon } from '../common/PixelIcon'
import { AnimationSettingsModal } from './AnimationSettingsModal'
import { LinkCelModal } from './LinkCelModal'
import { useI18n } from '../../i18n/I18nContext'
import { useApp } from '../../state/AppContext'

interface TimelinePanelProps {
  canvasWidth?: number
  canvasHeight?: number
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
  onAddEmptyFrame: () => void
  onDuplicateFrame: (mode: 'independent' | 'linked') => void
  onDeleteFrame: (frameId?: string) => void
  onSetFrameDuration: (frameId: string, durationMs: number) => void
  onSetDefaultFrameDuration: (durationMs: number) => void
  onApplyBatchDuration: (
    scope:
      | { mode: 'selected'; selectedFrameIds: readonly string[] }
      | { mode: 'all' },
    durationMs: number
  ) => void
  onClearCell: (layerId?: string, frameId?: string) => void
  onUnlinkCell: (layerId?: string, frameId?: string) => void
  onLinkCellToAny?: (
    sourceLayerId: string,
    sourceFrameId: string,
    targetLayerId: string,
    targetFrameId: string
  ) => void
  onToggleCellSelected: (cellKey: string) => void
  onClearCellSelection: () => void
  onBatchClearCells: () => void
  onBatchUnlinkCells: () => void
  onBatchLinkCells: () => void
  onCopyActiveCell: () => void
  onPasteToActiveCell: (asLinked?: boolean) => void
  onSetPlaybackSpeed: (speed: number) => void
  onSetPlaybackDirection: (dir: PlaybackDirection) => void
  onSetLoopPlayback: (loop: boolean) => void
  onUpdateOnionSkin: (patch: Partial<OnionSkinConfig>) => void
}

/**
 * Streamlined Animation Timeline (`>= 2` frames):
 * - Keeps the main workspace clean and approachable: only core frame & playback controls are visible by default.
 * - Consolidates advanced settings (direction, loop/once, speed, per-frame/default/batch ms, onion skin, cel summary)
 *   into a scrollable responsive modal / mobile bottom-sheet (`AnimationSettingsModal`) without shrinking the canvas.
 * - Places linked/independent/empty cel operations inside a focused Cel Actions popover (`timeline-cel-menu-btn`
 *   or re-tapping the currently active cell).
 * - GIF Export button is intentionally omitted from the timeline (available in Viewer & Export menu when >=2 frames).
 */
export function TimelinePanel({
  canvasWidth = 32,
  canvasHeight = 32,
  checkerDark = false,
  layers,
  activeLayerId,
  timeline,
  selectedCellKeys,
  celClipboard,
  isPlaying: _isPlaying,
  playbackSpeed,
  onionSkin,
  onSelectLayer,
  onUpdateLayer,
  onAddLayer,
  onOpenLayerSheet,
  onSelectFrame,
  onAddEmptyFrame,
  onDuplicateFrame,
  onDeleteFrame,
  onSetFrameDuration,
  onSetDefaultFrameDuration,
  onApplyBatchDuration,
  onClearCell,
  onUnlinkCell,
  onLinkCellToAny,
  onToggleCellSelected,
  onClearCellSelection,
  onBatchClearCells,
  onBatchUnlinkCells,
  onBatchLinkCells,
  onCopyActiveCell,
  onPasteToActiveCell,
  onSetPlaybackSpeed,
  onSetPlaybackDirection,
  onSetLoopPlayback,
  onUpdateOnionSkin,
}: TimelinePanelProps) {
  const { t } = useI18n()
  const { reducedMotion } = useApp()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [celMenuOpen, setCelMenuOpen] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [multiSelectMode, setMultiSelectMode] = useState(false)

  const activeFrame =
    timeline.frames.find((f) => f.id === timeline.activeFrameId) ??
    timeline.frames[0]!
  const activeFrameIdx = Math.max(
    0,
    timeline.frames.findIndex((f) => f.id === activeFrame.id)
  )

  const refCountMap = useMemo(
    () => getCelReferenceCountMap(timeline.cels),
    [timeline.cels]
  )

  const displayLayersTopDown = useMemo(() => [...layers].reverse(), [layers])

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

  const activeCellKey = makeCellKey(activeLayerId, activeFrame.id)
  const activeCelRef = timeline.cels[activeCellKey]
  const activeCelId = activeCelRef?.kind === 'cel' ? activeCelRef.celId : null

  const activeSharedCells = useMemo(() => {
    if (!activeCelId) return []
    return getCellsSharingCelId(timeline.cels, activeCelId)
  }, [timeline.cels, activeCelId])

  const activeSharedCellKeySet = useMemo(
    () => new Set(activeSharedCells.map((c) => c.cellKey)),
    [activeSharedCells]
  )

  const activeSharedFramesSummary = useMemo(() => {
    if (activeSharedCells.length <= 1) return null
    const frameIndexById = new Map<string, number>()
    timeline.frames.forEach((f, idx) => frameIndexById.set(f.id, idx))
    const layerNameById = new Map<string, string>()
    layers.forEach((l) => layerNameById.set(l.id, l.name))
    return activeSharedCells
      .map((s) => {
        const fNo = (frameIndexById.get(s.frameId) ?? 0) + 1
        return s.layerId === activeLayerId
          ? `#${fNo}`
          : `${layerNameById.get(s.layerId) ?? ''}#${fNo}`
      })
      .join(', ')
  }, [activeSharedCells, timeline.frames, layers, activeLayerId])

  const activeCellKindLabel =
    activeCellState === 'empty'
      ? t('celEmptyLabel')
      : activeCellState === 'linked'
        ? t('celLinkedLabel')
        : t('celIndependentLabel')

  return (
    <div
      className="relative px-2.5 py-1.5 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] space-y-1.5 shrink-0"
      data-testid="timeline-workspace-panel"
    >
      {/* Scrollable Animation Settings Modal / Mobile Bottom-Sheet (Safe-area aware, overscroll-contain) */}
      <AnimationSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        layers={layers}
        activeLayerId={activeLayerId}
        timeline={timeline}
        selectedFrameIds={selectedFrameIdsFromCells}
        playbackSpeed={playbackSpeed}
        onionSkin={onionSkin}
        onSetPlaybackDirection={onSetPlaybackDirection}
        onSetLoopPlayback={onSetLoopPlayback}
        onSetPlaybackSpeed={onSetPlaybackSpeed}
        onSetFrameDuration={onSetFrameDuration}
        onSetDefaultFrameDuration={onSetDefaultFrameDuration}
        onApplyBatchDuration={onApplyBatchDuration}
        onUpdateOnionSkin={onUpdateOnionSkin}
        onOpenLinkCelModal={
          onLinkCellToAny ? () => setLinkModalOpen(true) : undefined
        }
      />

      {/* Retroactive Link-Cel Creation & Source Switching Modal */}
      {onLinkCellToAny && (
        <LinkCelModal
          open={linkModalOpen}
          onClose={() => setLinkModalOpen(false)}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          checkerDark={checkerDark}
          layers={layers}
          targetLayerId={activeLayerId}
          targetFrameId={activeFrame.id}
          timeline={timeline}
          onConfirmLink={onLinkCellToAny}
          onUnlinkTarget={onUnlinkCell}
        />
      )}

      {/* Floating Popover 2: Focused Cel & Linked-Cel Detail Menu (opened on demand) */}
      <AnimatePresence>
      {celMenuOpen && (
        <motion.div
          initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
          transition={{ duration: reducedMotion ? 0 : 0.11, ease: 'easeOut' }}
          className="absolute bottom-full right-2 left-2 sm:left-auto sm:w-72 mb-1.5 z-30 pixel-popover-translucent p-2.5 space-y-2 text-xs"
          data-testid="cel-actions-popover"
        >
          <div className="flex items-center justify-between pb-1 border-b border-[var(--border-subtle)]">
            <span
              className="font-bold text-[var(--accent-teal)]"
              data-testid="active-cel-kind-badge"
            >
              {activeCellKindLabel} (#{activeFrameIdx + 1})
            </span>
            <button
              type="button"
              onClick={() => setCelMenuOpen(false)}
              className="pixel-btn min-w-[26px] min-h-[26px] flex items-center justify-center"
              aria-label={t('close')}
            >
              <PixelIcon name="close" size={12} />
            </button>
          </div>

          {activeSharedFramesSummary && (
            <div
              className="px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]"
              data-testid="active-cel-shared-frames"
            >
              {t('linkCelReferencedByLabel')}:{' '}
              <strong className="text-[var(--accent-teal)]">
                {activeSharedFramesSummary}
              </strong>
            </div>
          )}

          <div className="grid grid-cols-1 gap-1.5">
            {onLinkCellToAny && (
              <button
                type="button"
                onClick={() => {
                  setCelMenuOpen(false)
                  setLinkModalOpen(true)
                }}
                className="pixel-btn pixel-btn-primary min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                data-testid="open-link-cel-modal-btn"
              >
                <PixelIcon name="link" size={13} />
                <span>
                  {activeCellState === 'linked'
                    ? t('changeLinkTargetBtn')
                    : t('changeToLinkedCelBtn')}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                onDuplicateFrame('linked')
              }}
              className="pixel-btn pixel-btn-teal min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1.5"
              data-testid="timeline-dup-linked-frame-btn"
            >
              <PixelIcon name="link" size={13} />
              <span>{t('dupLinkedFrameBtn')}</span>
            </button>

            {activeCellState === 'linked' && (
              <button
                type="button"
                onClick={() => {
                  onUnlinkCell(activeLayerId, activeFrame.id)
                }}
                className="pixel-btn min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                data-testid="cel-unlink-active-btn"
              >
                <PixelIcon name="unlink" size={13} />
                <span>{t('celUnlinkBtn')}</span>
              </button>
            )}

            {activeCellState !== 'empty' && (
              <button
                type="button"
                onClick={() => {
                  onClearCell(activeLayerId, activeFrame.id)
                }}
                className="pixel-btn pixel-btn-danger min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                data-testid="cel-clear-active-btn"
              >
                <PixelIcon name="trash" size={13} />
                <span>{t('celClearBtn')}</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={onCopyActiveCell}
              className="pixel-btn min-h-[32px] px-2.5 text-[11px] font-bold flex items-center gap-1"
              data-testid="cel-copy-btn"
            >
              <PixelIcon name="copy" size={12} />
              <span>{t('copy')}</span>
            </button>
            <button
              type="button"
              disabled={!celClipboard}
              onClick={() => onPasteToActiveCell(false)}
              className="pixel-btn min-h-[32px] px-2.5 text-[11px] font-bold"
              data-testid="cel-paste-btn"
            >
              {t('paste')}
            </button>
            {celClipboard &&
              !celClipboard.isEmpty &&
              celClipboard.sourceLayerId === activeLayerId && (
                <button
                  type="button"
                  onClick={() => onPasteToActiveCell(true)}
                  className="pixel-btn min-h-[32px] px-2 text-[11px] font-bold flex items-center gap-1"
                  data-testid="cel-paste-linked-btn"
                >
                  <PixelIcon name="link" size={11} />
                  <span>{t('pasteLinkedBtn')}</span>
                </button>
              )}
          </div>

          {/* Optional Multi-Cel Selection Mode */}
          <div className="pt-1.5 border-t border-[var(--border-subtle)] space-y-1.5">
            <button
              type="button"
              onClick={() => {
                setMultiSelectMode((v) => {
                  if (v) onClearCellSelection()
                  return !v
                })
              }}
              className={`w-full min-h-[30px] px-2 text-[11px] font-bold ${
                multiSelectMode ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="cel-multiselect-toggle-btn"
            >
              {multiSelectMode && selectedCellKeys.length > 0
                ? `${t('selectedLayersCount')}: ${selectedCellKeys.length}`
                : `${t('toolSelect')} (${t('celActionsBtn')})`}
            </button>

            {selectedCellKeys.length >= 2 && (
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={onBatchLinkCells}
                  className="pixel-btn pixel-btn-teal min-h-[30px] px-2 text-[11px] font-bold flex items-center gap-1"
                  data-testid="cel-batch-link-btn"
                >
                  <PixelIcon name="link" size={11} />
                  <span>{t('celLinkBtn')}</span>
                </button>
                <button
                  type="button"
                  onClick={onBatchUnlinkCells}
                  className="pixel-btn min-h-[30px] px-2 text-[11px] font-bold flex items-center gap-1"
                  data-testid="cel-batch-unlink-btn"
                >
                  <PixelIcon name="unlink" size={11} />
                  <span>{t('celUnlinkBtn')}</span>
                </button>
                <button
                  type="button"
                  onClick={onBatchClearCells}
                  className="pixel-btn pixel-btn-danger min-h-[30px] px-2 text-[11px] font-bold"
                  data-testid="cel-batch-clear-btn"
                >
                  {t('celClearBtn')}
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Main Row 1: Frame Add/Dup/Del + Cel Menu + Animation Settings (No #1/3 100ms badge; playback controls stay in the workspace tab bar!) */}
      <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
        <div className="flex flex-wrap items-center gap-1 w-full justify-between">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onAddEmptyFrame}
              className="pixel-btn min-h-[36px] px-2.5 text-[11px] font-bold flex items-center gap-1"
              data-testid="timeline-add-empty-frame-btn"
            >
              <PixelIcon name="plus" size={12} />
              <span>{t('frameAddShort')}</span>
            </button>

            <button
              type="button"
              onClick={() => onDuplicateFrame('independent')}
              className="pixel-btn min-h-[36px] px-2.5 text-[11px] font-bold flex items-center gap-1"
              data-testid="timeline-dup-frame-btn"
            >
              <PixelIcon name="copy" size={12} />
              <span>{t('frameDupShort')}</span>
            </button>

            <button
              type="button"
              disabled={timeline.frames.length <= 1}
              onClick={() => onDeleteFrame(activeFrame.id)}
              className="pixel-btn pixel-btn-danger min-h-[36px] px-2 text-[11px] font-bold flex items-center gap-1"
              data-testid="timeline-del-frame-btn"
            >
              <PixelIcon name="trash" size={12} />
              <span>{t('frameDelShort')}</span>
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(false)
                setCelMenuOpen((v) => !v)
              }}
              className={`min-h-[36px] px-2 text-[11px] font-bold flex items-center gap-1 ${
                celMenuOpen || activeCellState === 'linked'
                  ? 'pixel-btn pixel-btn-teal'
                  : 'pixel-btn'
              }`}
              data-testid="timeline-cel-menu-btn"
            >
              <PixelIcon
                name={activeCellState === 'linked' ? 'link' : 'layers'}
                size={12}
              />
              <span>{activeCellKindLabel}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCelMenuOpen(false)
                setSettingsOpen((v) => !v)
              }}
              title={t('animSettingsTitle')}
              className={`relative min-w-[36px] min-h-[36px] px-2 text-[11px] font-bold flex items-center justify-center gap-1 ${
                settingsOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="timeline-settings-btn"
            >
              <PixelIcon name="settings" size={14} />
              <span className="hidden sm:inline">{t('animSettingsBtn')}</span>
              {onionSkin.enabled && (
                <span
                  className="absolute top-0.5 right-0.5 w-2 h-2 bg-[var(--accent-teal)] border border-[var(--border-strong)]"
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Row 2: Easy-to-Read Layer × Frame Cel Matrix (compact height so canvas area stays generous) */}
      <div className="border-2 border-[var(--border-pixel)] bg-[var(--bg-elevated)] max-h-32 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)]">
            <tr>
              <th className="sticky left-0 z-20 bg-[var(--bg-surface)] border-r-2 border-[var(--border-pixel)] px-2 py-1 text-left min-w-[126px]">
                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={onOpenLayerSheet}
                    className="pixel-btn px-2 py-0.5 text-[11px] font-bold flex items-center gap-1"
                    data-testid="timeline-open-layers-modal-btn"
                  >
                    <PixelIcon name="layers" size={12} />
                    <span>
                      {t('tabLayers')} ({layers.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={onAddLayer}
                    className="pixel-btn min-w-[26px] min-h-[26px] px-1.5 text-[11px] font-bold flex items-center justify-center"
                    title={t('addLayer')}
                    data-testid="timeline-add-layer-btn"
                  >
                    <PixelIcon name="plus" size={11} />
                  </button>
                </div>
              </th>
              {timeline.frames.map((f, fIdx) => {
                const isCurFrame = f.id === activeFrame.id
                return (
                  <th
                    key={f.id}
                    onClick={() => onSelectFrame(f.id)}
                    className={`min-w-[42px] px-1.5 py-1 text-center border-r border-[var(--border-subtle)] cursor-pointer select-none ${
                      isCurFrame
                        ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                        : 'hover:bg-[var(--bg-panel)]'
                    }`}
                    data-testid={`timeline-frame-header-${fIdx}`}
                  >
                    <div className="text-xs font-bold leading-tight">
                      {fIdx + 1}
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
                    className={`sticky left-0 z-10 px-2 py-1 border-r-2 border-[var(--border-pixel)] cursor-pointer ${
                      isCurLayer
                        ? 'bg-[var(--bg-panel)] font-bold'
                        : 'bg-[var(--bg-surface)]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 max-w-[130px]">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onUpdateLayer(layer.id, { visible: !layer.visible })
                        }}
                        className="opacity-85 hover:opacity-100 shrink-0"
                        aria-label={t('layerVisible')}
                      >
                        <PixelIcon
                          name={layer.visible ? 'eye' : 'eyeOff'}
                          size={13}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onUpdateLayer(layer.id, { locked: !layer.locked })
                        }}
                        className="opacity-85 hover:opacity-100 shrink-0"
                      >
                        <PixelIcon
                          name={layer.locked ? 'lock' : 'unlock'}
                          size={13}
                        />
                      </button>
                      <span className="truncate text-xs">{layer.name}</span>
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

                    const isCurFrame = f.id === activeFrame.id
                    const isActiveCell = isCurLayer && isCurFrame
                    const isMultiSelected = selectedCellKeys.includes(ck)
                    const isSharedSiblingWithActive =
                      !isActiveCell &&
                      activeSharedCells.length > 1 &&
                      activeSharedCellKeySet.has(ck)

                    // Check if active link group spans across this cell on the same layer (for non-adjacent visual connector line)
                    let activeSpanBridge = false
                    if (
                      isCurLayer &&
                      activeCelId &&
                      activeSharedCells.length > 1
                    ) {
                      const sameLayerIndices: number[] = []
                      timeline.frames.forEach((fr, idx) => {
                        const r = timeline.cels[makeCellKey(layer.id, fr.id)]
                        if (r?.kind === 'cel' && r.celId === activeCelId) {
                          sameLayerIndices.push(idx)
                        }
                      })
                      if (sameLayerIndices.length >= 2) {
                        const minIdx = sameLayerIndices[0]!
                        const maxIdx =
                          sameLayerIndices[sameLayerIndices.length - 1]!
                        if (fIdx > minIdx && fIdx < maxIdx) {
                          activeSpanBridge = true
                        }
                      }
                    }

                    return (
                      <td
                        key={ck}
                        onClick={(e) => {
                          if (multiSelectMode || e.shiftKey) {
                            onToggleCellSelected(ck)
                          } else if (isActiveCell) {
                            setSettingsOpen(false)
                            setCelMenuOpen((v) => !v)
                          } else {
                            onSelectLayer(layer.id)
                            onSelectFrame(f.id)
                          }
                        }}
                        className={`relative h-8 text-center border-r border-[var(--border-subtle)] cursor-pointer select-none ${
                          isMultiSelected
                            ? 'bg-[var(--accent-teal)] text-[var(--accent-teal-fg)]'
                            : isActiveCell
                              ? 'bg-[var(--bg-panel)] outline-2 -outline-offset-2 outline-[var(--accent-primary)]'
                              : isSharedSiblingWithActive
                                ? 'bg-[var(--bg-panel)]/75 outline-2 -outline-offset-2 outline-dashed outline-[var(--accent-teal)]'
                                : isCurFrame
                                  ? 'bg-[var(--bg-surface)]/80'
                                  : ''
                        }`}
                        data-testid={`cel-${layer.id}-${fIdx}`}
                        data-cel-kind={kind}
                        data-shared-with-active={
                          isSharedSiblingWithActive ? 'true' : undefined
                        }
                      >
                        {activeSpanBridge && !linkedLeft && !linkedRight && (
                          <span
                            className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-[var(--accent-teal)] pointer-events-none"
                            aria-hidden="true"
                          />
                        )}
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
                        <span
                          className={`relative z-10 inline-flex items-center justify-center ${
                            kind === 'linked'
                              ? 'text-[var(--accent-teal)]'
                              : kind === 'empty'
                                ? 'text-[var(--text-secondary)]'
                                : ''
                          }`}
                        >
                          <PixelIcon
                            name={
                              kind === 'empty'
                                ? 'celEmpty'
                                : kind === 'linked'
                                  ? 'celDiamond'
                                  : 'celDot'
                            }
                            size={11}
                          />
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
    </div>
  )
}
