import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { LayerRuntime, PlaybackDirection } from '../../types'
import {
  getCellStateKind,
  getCelReferenceCountMap,
  type TimelineState,
} from '../../engine/animation'
import type { OnionSkinConfig } from '../../state/useEditorController'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { PixelSlider } from '../common/PixelSlider'

const SPEED_OPTIONS = [0.5, 1, 1.5, 2] as const

interface AnimationSettingsModalProps {
  open: boolean
  onClose: () => void
  layers: readonly LayerRuntime[]
  activeLayerId: string
  timeline: TimelineState
  selectedFrameIds: readonly string[]
  playbackSpeed: number
  onionSkin: OnionSkinConfig
  onSetPlaybackDirection: (dir: PlaybackDirection) => void
  onSetLoopPlayback: (loop: boolean) => void
  onSetPlaybackSpeed: (speed: number) => void
  onSetFrameDuration: (frameId: string, durationMs: number) => void
  onSetDefaultFrameDuration: (durationMs: number) => void
  onApplyBatchDuration: (
    scope:
      | { mode: 'selected'; selectedFrameIds: readonly string[] }
      | { mode: 'all' },
    durationMs: number
  ) => void
  onUpdateOnionSkin: (patch: Partial<OnionSkinConfig>) => void
  onOpenLinkCelModal?: () => void
}

/**
 * Scrollable Animation Settings Modal / Mobile Bottom-Sheet (Section 3):
 * - On smartphones: opens from the bottom as a large bottom-sheet (`max-h-[88dvh]`, safe-area aware, `overscroll-contain`)
 *   so every item down to the bottom is comfortably scrollable and operable without shrinking or shifting the canvas.
 * - On PC: centered dialog (`sm:max-w-lg max-h-[88dvh]`) with sticky header, Close button, and Escape/backdrop support.
 * - Organizes animation settings into clear groups:
 *   1. Playback Mode
 *   2. Frame Durations
 *   3. Onion Skin
 *   4. Linked Cels & Timeline Info
 */
export function AnimationSettingsModal({
  open,
  onClose,
  layers,
  activeLayerId,
  timeline,
  selectedFrameIds,
  playbackSpeed,
  onionSkin,
  onSetPlaybackDirection,
  onSetLoopPlayback,
  onSetPlaybackSpeed,
  onSetFrameDuration,
  onSetDefaultFrameDuration,
  onApplyBatchDuration,
  onUpdateOnionSkin,
  onOpenLinkCelModal,
}: AnimationSettingsModalProps) {
  const { reducedMotion } = useApp()
  const { t } = useI18n()

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

  useEffect(() => {
    if (open && activeFrame) {
      setBatchMsInput(activeFrame.durationMs)
    }
  }, [open, activeFrame?.id, activeFrame?.durationMs])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const celStats = useMemo(() => {
    const refMap = getCelReferenceCountMap(timeline.cels)
    let emptyCount = 0
    let independentCount = 0
    let linkedCount = 0
    for (const layer of layers) {
      for (const frame of timeline.frames) {
        const kind = getCellStateKind(
          timeline.cels,
          timeline.celBuffers,
          layer.id,
          frame.id,
          refMap
        )
        if (kind === 'empty') emptyCount++
        else if (kind === 'linked') linkedCount++
        else independentCount++
      }
    }
    const activeKind = getCellStateKind(
      timeline.cels,
      timeline.celBuffers,
      activeLayerId,
      activeFrame.id,
      refMap
    )
    return { emptyCount, independentCount, linkedCount, activeKind }
  }, [timeline.cels, timeline.celBuffers, timeline.frames, layers, activeLayerId, activeFrame.id])

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t('animModalTitle')}
          data-testid="timeline-settings-popover"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.12 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/55"
          />
          <motion.div
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
            transition={{ duration: reducedMotion ? 0 : 0.14, ease: 'easeOut' }}
            className="relative z-10 w-full sm:max-w-lg max-h-[88dvh] flex flex-col pixel-panel overflow-hidden"
            data-testid="animation-settings-modal-panel"
          >
            {/* Sticky Header */}
            <div className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b-2 border-[var(--border-pixel)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <PixelIcon
                  name="film"
                  size={15}
                  className="text-[var(--accent-primary)] shrink-0"
                />
                <h2 className="text-sm font-bold tracking-wide truncate text-[var(--text-primary)]">
                  {t('animModalTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
                data-testid="close-animation-settings-btn"
              >
                <PixelIcon name="close" size={16} />
              </button>
            </div>

            {/* Scrollable Body (`overscroll-contain` + iOS safe-area bottom padding) */}
            <div
              className="p-3.5 space-y-3.5 overflow-y-auto overscroll-contain flex-1 min-h-0 text-xs"
              style={{
                paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))',
              }}
              data-testid="animation-settings-scroll-body"
            >
              {/* Group 1: Playback Mode */}
              <section className="pixel-card p-3 space-y-2.5">
                <div className="font-bold text-[var(--accent-primary)] flex items-center gap-1.5">
                  <PixelIcon name="play" size={12} />
                  <span>{t('animGroupPlayback')}</span>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'forward', label: t('dirForward') },
                      { id: 'reverse', label: t('dirReverse') },
                      { id: 'pingpong', label: t('dirPingpong') },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => onSetPlaybackDirection(opt.id)}
                      className={`min-h-[36px] px-2 text-xs font-bold ${
                        timeline.playbackDirection === opt.id
                          ? 'pixel-btn pixel-btn-active'
                          : 'pixel-btn'
                      }`}
                      data-testid={`timeline-dir-${opt.id}-btn`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSetLoopPlayback(!timeline.loopPlayback)}
                    className={`min-h-[36px] px-3 text-xs font-bold flex-1 min-w-[120px] ${
                      timeline.loopPlayback
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                    data-testid="timeline-loop-btn"
                  >
                    {timeline.loopPlayback
                      ? t('loopPlaybackLabel')
                      : t('oncePlaybackLabel')}
                  </button>

                  <div className="flex items-center gap-1">
                    {SPEED_OPTIONS.map((sp) => (
                      <button
                        key={sp}
                        type="button"
                        onClick={() => onSetPlaybackSpeed(sp)}
                        className={`min-h-[36px] px-2.5 text-xs font-mono font-bold ${
                          playbackSpeed === sp
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                        data-testid={`timeline-speed-${sp}-btn`}
                      >
                        {sp}x
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {/* Group 2: Frame Durations */}
              <section className="pixel-card p-3 space-y-2.5">
                <div className="font-bold text-[var(--accent-primary)] flex items-center gap-1.5">
                  <PixelIcon name="clock" size={12} />
                  <span>{t('animGroupTiming')}</span>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[var(--text-secondary)]">
                    {t('frameDurationLabel')} (#{activeFrameIdx + 1})
                  </span>
                  <div className="flex items-center gap-1">
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
                      className="w-24 min-h-[34px] px-2 text-right text-xs font-bold pixel-input"
                      data-testid="active-frame-ms-input"
                    />
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      ms
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-secondary)]">
                    {t('defaultFrameDurationLabel')}
                  </span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={10}
                      max={60000}
                      step={10}
                      value={timeline.defaultFrameDurationMs}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (!Number.isNaN(v) && v >= 10) {
                          onSetDefaultFrameDuration(v)
                        }
                      }}
                      className="w-24 min-h-[34px] px-2 text-right text-xs font-bold pixel-input"
                      data-testid="default-frame-ms-input"
                    />
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      ms
                    </span>
                  </div>
                </div>

                <div className="p-2.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">{t('batchDurationLabel')}</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={10}
                        max={60000}
                        step={10}
                        value={batchMsInput}
                        onChange={(e) =>
                          setBatchMsInput(
                            Math.max(10, Number(e.target.value) || 100)
                          )
                        }
                        className="w-24 min-h-[32px] px-2 text-right text-xs font-bold pixel-input"
                        data-testid="batch-ms-input"
                      />
                      <span className="text-[11px] text-[var(--text-secondary)]">
                        ms
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        onApplyBatchDuration({ mode: 'all' }, batchMsInput)
                      }}
                      className="pixel-btn pixel-btn-teal min-h-[34px] px-3 text-xs font-bold"
                      data-testid="batch-apply-all-btn"
                    >
                      {t('applyAllFramesBtn')}
                    </button>
                    {selectedFrameIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          onApplyBatchDuration(
                            {
                              mode: 'selected',
                              selectedFrameIds,
                            },
                            batchMsInput
                          )
                        }}
                        className="pixel-btn min-h-[34px] px-3 text-xs font-bold"
                        data-testid="batch-apply-selected-btn"
                      >
                        {t('applySelectedFramesBtn')} ({selectedFrameIds.length})
                      </button>
                    )}
                  </div>
                </div>
              </section>

              {/* Group 3: Onion Skin */}
              <section
                className="pixel-card p-3 space-y-2.5"
                data-testid="onion-skin-popover"
              >
                <div className="font-bold text-[var(--accent-primary)] flex items-center gap-1.5">
                  <PixelIcon name="onion" size={12} />
                  <span>{t('animGroupOnion')}</span>
                </div>

                <PixelCheckbox
                  checked={onionSkin.enabled}
                  onChange={(v) => onUpdateOnionSkin({ enabled: v })}
                  label={t('onionSkinLabel')}
                  testId="onion-enabled-checkbox"
                />

                {onionSkin.enabled && (
                  <div className="space-y-2.5 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                    <div className="flex items-center gap-1.5">
                      <span className="w-14 shrink-0 text-[11px] font-bold">
                        {t('onionCountLabel')}
                      </span>
                      {[1, 2, 3].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() =>
                            onUpdateOnionSkin({ prevCount: n, nextCount: n })
                          }
                          className={`min-h-[32px] px-2.5 text-xs font-bold ${
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
                      <span className="text-[11px]">
                        {t('onionOpacityLabel')}:{' '}
                        <strong>{onionSkin.opacity}%</strong>
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
              </section>

              {/* Group 4: Linked Cels & Timeline Info */}
              <section
                className="pixel-card p-3 space-y-2"
                data-testid="anim-settings-link-timeline-group"
              >
                <div className="font-bold text-[var(--accent-primary)] flex items-center gap-1.5">
                  <PixelIcon name="link" size={12} />
                  <span>{t('animGroupLinkTimeline')}</span>
                </div>

                <div className="grid grid-cols-3 gap-1.5 text-center text-[11px]">
                  <div className="p-1.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                    <div className="text-[var(--text-secondary)]">
                      {t('celIndependentLabel')}
                    </div>
                    <div className="font-mono font-bold text-sm inline-flex items-center justify-center gap-1">
                      <PixelIcon name="celDot" size={11} />
                      <span>{celStats.independentCount}</span>
                    </div>
                  </div>
                  <div className="p-1.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                    <div className="text-[var(--text-secondary)]">
                      {t('celLinkedLabel')}
                    </div>
                    <div className="font-mono font-bold text-sm text-[var(--accent-teal)] inline-flex items-center justify-center gap-1">
                      <PixelIcon name="celDiamond" size={11} />
                      <span>{celStats.linkedCount}</span>
                    </div>
                  </div>
                  <div className="p-1.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
                    <div className="text-[var(--text-secondary)]">
                      {t('celEmptyLabel')}
                    </div>
                    <div className="font-mono font-bold text-sm text-[var(--text-secondary)] inline-flex items-center justify-center gap-1">
                      <PixelIcon name="celEmpty" size={11} />
                      <span>{celStats.emptyCount}</span>
                    </div>
                  </div>
                </div>

                {onOpenLinkCelModal && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose()
                      onOpenLinkCelModal()
                    }}
                    className="pixel-btn pixel-btn-teal w-full min-h-[36px] px-3 text-xs font-bold flex items-center justify-center gap-1.5"
                    data-testid="anim-settings-open-link-cel-btn"
                  >
                    <PixelIcon name="link" size={13} />
                    <span>
                      {celStats.activeKind === 'linked'
                        ? t('changeLinkTargetBtn')
                        : t('changeToLinkedCelBtn')}
                    </span>
                  </button>
                )}
              </section>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
