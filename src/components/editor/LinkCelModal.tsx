import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CelBufferRuntime, LayerRuntime } from '../../types'
import {
  getCellStateKind,
  getCelReferenceCountMap,
  getCellsSharingCelId,
  makeCellKey,
  willLinkingOverwriteDistinctPixels,
  type TimelineState,
} from '../../engine/animation'
import { extractLayerCanvasView } from '../../engine/pixelBuffer'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { getCheckerboardStyle } from '../common/PixelThumbnail'

function CelBufferThumbCanvas({
  celBuffer,
  canvasWidth,
  canvasHeight,
  checkerDark = false,
  sizePx = 44,
}: {
  celBuffer: CelBufferRuntime | null
  canvasWidth: number
  canvasHeight: number
  checkerDark?: boolean
  sizePx?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    cvs.width = canvasWidth
    cvs.height = canvasHeight
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    if (!celBuffer) return

    const visibleSlice = extractLayerCanvasView(
      {
        offsetX: celBuffer.offsetX,
        offsetY: celBuffer.offsetY,
        dataWidth: celBuffer.dataWidth,
        dataHeight: celBuffer.dataHeight,
        data: celBuffer.data,
      },
      canvasWidth,
      canvasHeight
    )
    ctx.imageSmoothingEnabled = false
    const img = new ImageData(
      new Uint8ClampedArray(visibleSlice),
      canvasWidth,
      canvasHeight
    )
    ctx.putImageData(img, 0, 0)
  }, [celBuffer, canvasWidth, canvasHeight])

  return (
    <div
      style={{
        width: `${sizePx}px`,
        height: `${sizePx}px`,
        ...getCheckerboardStyle(checkerDark, 6),
      }}
      className="border border-[var(--border-pixel)] flex items-center justify-center shrink-0 overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          imageRendering: 'pixelated',
        }}
      />
    </div>
  )
}

interface LinkCelCandidate {
  cellKey: string
  layerId: string
  layerName: string
  frameId: string
  frameIndex: number
  celId: string
  kind: 'independent' | 'linked'
  sharedCount: number
  sharedFrameLabels: string[]
  isSameLayer: boolean
  isAlreadySharedWithTarget: boolean
  celBuffer: CelBufferRuntime
}

interface LinkCelModalProps {
  open: boolean
  onClose: () => void
  canvasWidth: number
  canvasHeight: number
  checkerDark?: boolean
  layers: readonly LayerRuntime[]
  targetLayerId: string
  targetFrameId: string
  timeline: TimelineState
  onConfirmLink: (
    sourceLayerId: string,
    sourceFrameId: string,
    targetLayerId: string,
    targetFrameId: string
  ) => void
  onUnlinkTarget?: (layerId: string, frameId: string) => void
}

/**
 * Retroactive Link-Cel Creation & Source Switching Modal (Section 4):
 * - Allows turning any existing Independent (or Empty) cel into a Linked cel referencing a chosen source cel,
 *   or changing the link source of an already Linked cel.
 * - Shows candidate source cels with frame #, layer name, cel kind, current link count/frames, and pixel thumbnail.
 * - Displays side-by-side Target vs Source preview before applying.
 * - Explicitly warns and requires confirmation before overwriting distinct pixel data on the target cel!
 */
export function LinkCelModal({
  open,
  onClose,
  canvasWidth,
  canvasHeight,
  checkerDark = false,
  layers,
  targetLayerId,
  targetFrameId,
  timeline,
  onConfirmLink,
  onUnlinkTarget,
}: LinkCelModalProps) {
  const { reducedMotion } = useApp()
  const { t } = useI18n()

  const [showOtherLayers, setShowOtherLayers] = useState(false)
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  const [confirmOverwriteOpen, setConfirmOverwriteOpen] = useState(false)

  const refCountMap = useMemo(
    () => getCelReferenceCountMap(timeline.cels),
    [timeline.cels]
  )

  const frameIndexMap = useMemo(() => {
    const m = new Map<string, number>()
    timeline.frames.forEach((f, idx) => m.set(f.id, idx))
    return m
  }, [timeline.frames])

  const layerNameMap = useMemo(() => {
    const m = new Map<string, string>()
    layers.forEach((l) => m.set(l.id, l.name))
    return m
  }, [layers])

  const targetKey = makeCellKey(targetLayerId, targetFrameId)
  const targetRef = timeline.cels[targetKey]
  const targetCelId = targetRef?.kind === 'cel' ? targetRef.celId : null
  const targetBuffer = targetCelId ? timeline.celBuffers[targetCelId] ?? null : null
  const targetKind = getCellStateKind(
    timeline.cels,
    timeline.celBuffers,
    targetLayerId,
    targetFrameId,
    refCountMap
  )
  const targetFrameIdx = frameIndexMap.get(targetFrameId) ?? 0
  const targetLayerName = layerNameMap.get(targetLayerId) ?? ''

  const candidates = useMemo((): LinkCelCandidate[] => {
    const list: LinkCelCandidate[] = []
    const orderedLayers = [
      ...layers.filter((l) => l.id === targetLayerId),
      ...(showOtherLayers ? layers.filter((l) => l.id !== targetLayerId) : []),
    ]

    for (const layer of orderedLayers) {
      timeline.frames.forEach((frame, fIdx) => {
        if (layer.id === targetLayerId && frame.id === targetFrameId) {
          // Never allow self-reference
          return
        }
        const ck = makeCellKey(layer.id, frame.id)
        const ref = timeline.cels[ck]
        if (!ref || ref.kind === 'empty') return
        const buf = timeline.celBuffers[ref.celId]
        if (!buf) return

        const kind = getCellStateKind(
          timeline.cels,
          timeline.celBuffers,
          layer.id,
          frame.id,
          refCountMap
        )
        if (kind === 'empty') return

        const sharers = getCellsSharingCelId(timeline.cels, ref.celId)
        const sharedFrameLabels = sharers.map((s) => {
          const idx = (frameIndexMap.get(s.frameId) ?? 0) + 1
          return s.layerId === layer.id
            ? `#${idx}`
            : `${layerNameMap.get(s.layerId) ?? ''}#${idx}`
        })

        list.push({
          cellKey: ck,
          layerId: layer.id,
          layerName: layer.name,
          frameId: frame.id,
          frameIndex: fIdx,
          celId: ref.celId,
          kind,
          sharedCount: sharers.length,
          sharedFrameLabels,
          isSameLayer: layer.id === targetLayerId,
          isAlreadySharedWithTarget:
            targetCelId !== null && ref.celId === targetCelId,
          celBuffer: buf,
        })
      })
    }
    return list
  }, [
    layers,
    targetLayerId,
    targetFrameId,
    showOtherLayers,
    timeline.frames,
    timeline.cels,
    timeline.celBuffers,
    refCountMap,
    frameIndexMap,
    layerNameMap,
    targetCelId,
  ])

  useEffect(() => {
    if (!open) {
      setConfirmOverwriteOpen(false)
      return
    }
    const firstSwitchable =
      candidates.find((c) => !c.isAlreadySharedWithTarget) ??
      candidates[0] ??
      null
    setSelectedSourceKey(firstSwitchable?.cellKey ?? null)
    setConfirmOverwriteOpen(false)
  }, [open, targetLayerId, targetFrameId, showOtherLayers, candidates.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmOverwriteOpen) {
          setConfirmOverwriteOpen(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, confirmOverwriteOpen, onClose])

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.cellKey === selectedSourceKey) ?? null,
    [candidates, selectedSourceKey]
  )

  const willOverwriteDistinct = useMemo(() => {
    if (!selectedCandidate) return false
    return willLinkingOverwriteDistinctPixels(
      timeline.cels,
      timeline.celBuffers,
      selectedCandidate.layerId,
      selectedCandidate.frameId,
      targetLayerId,
      targetFrameId
    )
  }, [
    selectedCandidate,
    timeline.cels,
    timeline.celBuffers,
    targetLayerId,
    targetFrameId,
  ])

  const handleRequestApply = () => {
    if (!selectedCandidate || selectedCandidate.isAlreadySharedWithTarget) return
    if (willOverwriteDistinct) {
      setConfirmOverwriteOpen(true)
      return
    }
    onConfirmLink(
      selectedCandidate.layerId,
      selectedCandidate.frameId,
      targetLayerId,
      targetFrameId
    )
    onClose()
  }

  const handleConfirmOverwrite = () => {
    if (!selectedCandidate) return
    onConfirmLink(
      selectedCandidate.layerId,
      selectedCandidate.frameId,
      targetLayerId,
      targetFrameId
    )
    setConfirmOverwriteOpen(false)
    onClose()
  }

  const kindLabel = (k: 'empty' | 'independent' | 'linked') =>
    k === 'empty'
      ? t('celEmptyLabel')
      : k === 'linked'
        ? t('celLinkedLabel')
        : t('celIndependentLabel')

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t('linkCelModalTitle')}
          data-testid="link-cel-modal"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.16, ease: 'easeOut' }}
            onClick={() => {
              if (confirmOverwriteOpen) {
                setConfirmOverwriteOpen(false)
              } else {
                onClose()
              }
            }}
            className="fixed inset-0 bg-black/55"
          />
          <motion.div
            initial={
              reducedMotion
                ? { opacity: 1 }
                : { opacity: 0, y: 28, scale: 0.97 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, y: 18, scale: 0.98 }
            }
            transition={
              reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 460, damping: 34, mass: 0.85 }
            }
            className="relative z-10 w-full sm:max-w-lg max-h-[88dvh] flex flex-col pixel-panel overflow-hidden"
          >
            {/* Sticky Header */}
            <div className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b-2 border-[var(--border-pixel)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <PixelIcon
                  name="link"
                  size={15}
                  className="text-[var(--accent-teal)] shrink-0"
                />
                <h2 className="text-sm font-bold tracking-wide truncate text-[var(--text-primary)]">
                  {t('linkCelModalTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
                data-testid="close-link-cel-modal-btn"
              >
                <PixelIcon name="close" size={16} />
              </button>
            </div>

            {/* Scrollable Body */}
            <div
              className="p-3.5 space-y-3.5 overflow-y-auto overscroll-contain flex-1 min-h-0 text-xs"
              style={{
                paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))',
              }}
            >
              {/* 1. Target Cel Summary */}
              <section className="pixel-card p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-[var(--text-secondary)]">
                    {t('linkCelTargetSection')}
                  </span>
                  {targetKind === 'linked' && onUnlinkTarget && (
                    <button
                      type="button"
                      onClick={() => {
                        onUnlinkTarget(targetLayerId, targetFrameId)
                        onClose()
                      }}
                      className="pixel-btn min-h-[30px] px-2.5 text-[11px] font-bold flex items-center gap-1"
                      data-testid="link-modal-unlink-btn"
                    >
                      <PixelIcon name="unlink" size={12} />
                      <span>{t('celUnlinkBtn')}</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  <CelBufferThumbCanvas
                    celBuffer={targetBuffer}
                    canvasWidth={canvasWidth}
                    canvasHeight={canvasHeight}
                    checkerDark={checkerDark}
                    sizePx={44}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-xs truncate">
                      #{targetFrameIdx + 1} · {targetLayerName}
                    </div>
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      {kindLabel(targetKind)}
                    </div>
                  </div>
                </div>
              </section>

              {/* 2. Candidate Source Cel Picker */}
              <section className="pixel-card p-2.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-[var(--accent-primary)]">
                    {t('linkCelSourceSection')}
                  </span>
                  {layers.length > 1 && (
                    <PixelCheckbox
                      checked={showOtherLayers}
                      onChange={setShowOtherLayers}
                      label={t('linkCelOtherLayerBadge')}
                      testId="toggle-link-other-layers"
                    />
                  )}
                </div>

                {candidates.length === 0 ? (
                  <p
                    className="p-3 text-center text-[var(--text-secondary)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)]"
                    data-testid="link-cel-no-candidates"
                  >
                    {t('linkCelNoCandidates')}
                  </p>
                ) : (
                  <div
                    className="space-y-1.5 max-h-52 overflow-y-auto overscroll-contain pr-0.5"
                    data-testid="link-cel-candidate-list"
                  >
                    {candidates.map((cand) => {
                      const selected = cand.cellKey === selectedSourceKey
                      return (
                        <button
                          key={cand.cellKey}
                          type="button"
                          onClick={() => {
                            setSelectedSourceKey(cand.cellKey)
                            setConfirmOverwriteOpen(false)
                          }}
                          className={`w-full p-2 border-2 flex items-center gap-2.5 text-left cursor-pointer ${
                            selected
                              ? 'border-[var(--accent-teal)] bg-[var(--bg-elevated)]'
                              : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)]'
                          }`}
                          data-testid={`link-source-candidate-${cand.layerId}-${cand.frameIndex}`}
                        >
                          <CelBufferThumbCanvas
                            celBuffer={cand.celBuffer}
                            canvasWidth={canvasWidth}
                            canvasHeight={canvasHeight}
                            checkerDark={checkerDark}
                            sizePx={40}
                          />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-bold">
                                #{cand.frameIndex + 1} · {cand.layerName}
                              </span>
                              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-[var(--bg-panel)] border border-[var(--border-subtle)]">
                                {cand.isSameLayer
                                  ? t('linkCelSameLayerBadge')
                                  : t('linkCelOtherLayerBadge')}
                              </span>
                              {cand.isAlreadySharedWithTarget && (
                                <span className="px-1.5 py-0.5 text-[10px] font-bold bg-[var(--accent-teal)] text-[var(--accent-teal-fg)]">
                                  {t('linkCelCurrentSourceBadge')}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-[var(--text-secondary)] truncate">
                              {kindLabel(cand.kind)} · {t('linkCelSharedCountBadge')}:{' '}
                              {cand.sharedCount} ({cand.sharedFrameLabels.join(', ')})
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* 3. Side-by-Side Before -> After Preview & Overwrite Confirmation */}
              {selectedCandidate && (
                <section
                  className="pixel-card p-3 space-y-2.5"
                  data-testid="link-cel-preview-section"
                >
                  <div className="font-bold text-[var(--text-primary)]">
                    {t('linkCelPreviewSection')}
                  </div>

                  <div className="flex items-center justify-center gap-3 py-1">
                    <div className="flex flex-col items-center gap-1">
                      <CelBufferThumbCanvas
                        celBuffer={targetBuffer}
                        canvasWidth={canvasWidth}
                        canvasHeight={canvasHeight}
                        checkerDark={checkerDark}
                        sizePx={64}
                      />
                      <span className="text-[10px] font-bold text-[var(--text-secondary)]">
                        #{targetFrameIdx + 1} ({kindLabel(targetKind)})
                      </span>
                    </div>

                    <PixelIcon
                      name="arrowRight"
                      size={16}
                      className="text-[var(--accent-teal)] shrink-0"
                    />

                    <div className="flex flex-col items-center gap-1">
                      <CelBufferThumbCanvas
                        celBuffer={selectedCandidate.celBuffer}
                        canvasWidth={canvasWidth}
                        canvasHeight={canvasHeight}
                        checkerDark={checkerDark}
                        sizePx={64}
                      />
                      <span className="text-[10px] font-bold text-[var(--accent-teal)] inline-flex items-center gap-0.5">
                        <span>#{selectedCandidate.frameIndex + 1} (</span>
                        <PixelIcon name="celDiamond" size={10} />
                        <span>{t('celLinkedLabel')})</span>
                      </span>
                    </div>
                  </div>

                  {willOverwriteDistinct && !confirmOverwriteOpen && (
                    <div
                      className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-[11px] leading-relaxed"
                      data-testid="link-cel-overwrite-notice"
                    >
                      {t('linkCelOverwriteWarning')}
                    </div>
                  )}

                  {confirmOverwriteOpen ? (
                    <div
                      className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] space-y-2.5"
                      data-testid="link-cel-overwrite-confirm-box"
                    >
                      <div className="font-bold text-[var(--accent-rose)]">
                        {t('linkCelOverwriteConfirmTitle')}
                      </div>
                      <p className="text-xs leading-relaxed text-[var(--text-primary)]">
                        {t('linkCelOverwriteConfirmMessage')}
                      </p>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmOverwriteOpen(false)}
                          className="pixel-btn min-h-[36px] px-3 text-xs font-bold"
                          data-testid="cancel-link-overwrite-btn"
                        >
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={handleConfirmOverwrite}
                          className="pixel-btn pixel-btn-teal min-h-[36px] px-3 text-xs font-bold flex items-center gap-1"
                          data-testid="confirm-link-overwrite-btn"
                        >
                          <PixelIcon name="check" size={13} />
                          <span>{t('confirm')}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={onClose}
                        className="pixel-btn min-h-[38px] px-3 text-xs font-bold"
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        disabled={selectedCandidate.isAlreadySharedWithTarget}
                        onClick={handleRequestApply}
                        className="pixel-btn pixel-btn-teal min-h-[38px] px-3.5 text-xs font-bold flex items-center gap-1.5"
                        data-testid="apply-link-cel-btn"
                      >
                        <PixelIcon name="link" size={13} />
                        <span>{t('linkCelConfirmBtn')}</span>
                      </button>
                    </div>
                  )}
                </section>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
