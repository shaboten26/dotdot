import { useEffect, useMemo, useRef, useState } from 'react'
import {
  inspectGifForImport,
  prepareImportedGifAsIndexed,
  type GifImportWarning,
  type GifResolutionInspection,
} from '../../engine/gifImport'
import { MAX_CANVAS_SIZE } from '../../engine/pixelBuffer'
import { createImportedProject } from '../../db/database'
import type { ProjectRecord } from '../../types'
import { Modal } from './Modal'
import { PixelIcon } from './PixelIcon'
import { PixelSelect } from './PixelSelect'
import { getCheckerboardStyle } from './PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

interface ImportGifModalProps {
  open: boolean
  onClose: () => void
  checkerDark?: boolean
  onCreatedProject?: (project: ProjectRecord) => void
  onError?: (msg: string) => void
}

function AnimatedIndexedPreview({
  framesRgba,
  frameDurationsMs,
  width,
  height,
  checkerDark,
}: {
  framesRgba: readonly Uint8ClampedArray[]
  frameDurationsMs: readonly number[]
  width: number
  height: number
  checkerDark: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [frameIdx, setFrameIdx] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    setFrameIdx(0)
    setPlaying(framesRgba.length > 1)
  }, [framesRgba.length, width, height])

  useEffect(() => {
    if (!playing || framesRgba.length <= 1) return
    const safeIdx = frameIdx % framesRgba.length
    const delay = Math.max(20, frameDurationsMs[safeIdx] ?? 100)
    const id = window.setTimeout(() => {
      setFrameIdx((prev) => (prev + 1) % framesRgba.length)
    }, delay)
    return () => window.clearTimeout(id)
  }, [playing, frameIdx, framesRgba.length, frameDurationsMs])

  const activeData = framesRgba[frameIdx % Math.max(1, framesRgba.length)]

  useEffect(() => {
    const c = canvasRef.current
    if (!c || !activeData) return
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    if (typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(width * height * 4)
      copy.set(activeData.subarray(0, copy.length))
      ctx.putImageData(new ImageData(copy, width, height), 0, 0)
    } else {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          const a = activeData[i + 3]!
          if (a === 0) continue
          ctx.fillStyle = `rgba(${activeData[i]},${activeData[i + 1]},${activeData[i + 2]},${(a / 255).toFixed(3)})`
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }, [activeData, width, height])

  return (
    <div className="space-y-1">
      <div
        style={getCheckerboardStyle(checkerDark, 10)}
        className="relative w-full h-40 border-2 border-[var(--border-pixel)] p-2 flex items-center justify-center overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full object-contain pixelated"
          style={{
            aspectRatio: `${width} / ${height}`,
            width: width >= height ? '100%' : 'auto',
            height: height > width ? '100%' : 'auto',
          }}
          data-testid="import-gif-preview-canvas"
        />
        {framesRgba.length > 1 && (
          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1 bg-[var(--bg-surface)] border border-[var(--border-pixel)] px-1.5 py-0.5 text-[10px] font-bold">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="px-1 cursor-pointer hover:text-[var(--accent-primary)]"
              data-testid="import-gif-preview-play-toggle"
            >
              <PixelIcon name={playing ? 'pause' : 'play'} size={11} />
            </button>
            <span data-testid="import-gif-preview-frame-indicator">
              {(frameIdx % framesRgba.length) + 1}/{framesRgba.length}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result))
      } else {
        reject(new Error('Failed to read GIF file buffer'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('File read error'))
    reader.readAsArrayBuffer(file)
  })
}

export function ImportGifModal({
  open,
  onClose,
  checkerDark = false,
  onCreatedProject,
  onError,
}: ImportGifModalProps) {
  const { t } = useI18n()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [fileName, setFileName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [inspection, setInspection] = useState<GifResolutionInspection | null>(
    null
  )
  const [selectedScale, setSelectedScale] = useState<number>(1)
  const [decoding, setDecoding] = useState(false)
  const [decodedFrameCount, setDecodedFrameCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setFileName('')
      setProjectName('')
      setInspection(null)
      setSelectedScale(1)
      setDecoding(false)
      setDecodedFrameCount(0)
      setBusy(false)
      setErrorMsg(null)
    } else {
      abortRef.current?.abort()
      abortRef.current = null
      setDecoding(false)
      setBusy(false)
    }
  }, [open])

  const handleCancelOperation = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setDecoding(false)
    setBusy(false)
  }

  const handleFileChange = async (file: File | null) => {
    if (!file) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setErrorMsg(null)
    setInspection(null)
    setDecoding(true)
    setDecodedFrameCount(0)

    try {
      const buf = await readFileBytes(file)
      if (ctrl.signal.aborted) return

      const result = await inspectGifForImport(buf, MAX_CANVAS_SIZE, {
        signal: ctrl.signal,
        onProgress: (done) => setDecodedFrameCount(done),
      })
      if (ctrl.signal.aborted) return

      const baseName = file.name.replace(/\.gif$/i, '').trim() || 'Imported GIF'
      setFileName(file.name)
      setProjectName(baseName.slice(0, 48))
      setInspection(result)
      // Section 1-7-C:
      // - Verified dotdot metadata -> pre-select exact original resolution (`recommendedScale`)
      // - Heuristic image estimation -> do NOT silently shrink without explicit user choice unless 1x exceeds 256x256 limit;
      //   default to `1x` when raw GIF fits <= 256x256, or `recommendedScale` if 1x exceeds 256x256, while showing clear toggle buttons!
      if (result.confidence === 'metadata') {
        setSelectedScale(result.recommendedScale)
      } else if (result.exceedsCanvasAt1x && result.recommendedScale > 1) {
        setSelectedScale(result.recommendedScale)
      } else {
        setSelectedScale(1)
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMsg(t('importGifCancelledMsg'))
        return
      }
      const msg =
        err instanceof Error ? err.message : 'Invalid or corrupted GIF file.'
      setInspection(null)
      setErrorMsg(msg)
      onError?.(msg)
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null
      }
      setDecoding(false)
    }
  }

  const prepared = useMemo(() => {
    if (!inspection) return null
    const targetW = Math.max(
      1,
      Math.floor(inspection.decoded.width / selectedScale)
    )
    const targetH = Math.max(
      1,
      Math.floor(inspection.decoded.height / selectedScale)
    )
    if (targetW > MAX_CANVAS_SIZE || targetH > MAX_CANVAS_SIZE) {
      return null
    }
    try {
      return prepareImportedGifAsIndexed(inspection.decoded, selectedScale, {
        paletteName: `${projectName.trim() || 'GIF'} Palette`,
        layerName:
          inspection.decoded.frames.length > 1
            ? t('importGifLayerDefaultName')
            : 'Layer 1',
      })
    } catch {
      return null
    }
  }, [inspection, selectedScale, projectName, t])

  const targetDimensions = useMemo(() => {
    if (!inspection) return null
    return {
      width: Math.max(1, Math.floor(inspection.decoded.width / selectedScale)),
      height: Math.max(1, Math.floor(inspection.decoded.height / selectedScale)),
    }
  }, [inspection, selectedScale])

  const exceedsLimit = Boolean(
    targetDimensions &&
      (targetDimensions.width > MAX_CANVAS_SIZE ||
        targetDimensions.height > MAX_CANVAS_SIZE)
  )

  const handleConfirmImport = async () => {
    if (!inspection || !prepared || exceedsLimit || busy || decoding) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(true)
    setErrorMsg(null)

    try {
      if (ctrl.signal.aborted) return
      const created = await createImportedProject({
        name: projectName.trim() || 'Imported GIF',
        width: prepared.width,
        height: prepared.height,
        layers: [prepared.layer],
        activeLayerId: prepared.layer.id,
        timeline: {
          frames: prepared.frames,
          cels: prepared.cels,
          celBuffers: prepared.celBuffers,
          activeFrameId: prepared.frames[0]?.id,
          loopPlayback: prepared.loopPlayback,
          playbackDirection: 'forward',
        },
        palette: prepared.palette,
      })
      if (ctrl.signal.aborted) return
      onCreatedProject?.(created)
      onClose()
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        return
      }
      const msg = err instanceof Error ? err.message : 'GIF import failed.'
      setErrorMsg(msg)
      onError?.(msg)
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null
      }
      setBusy(false)
    }
  }

  const formatWarning = (w: GifImportWarning): string => {
    switch (w.code) {
      case 'large-dimensions':
        return `${t('importGifWarnLargeDimensions')} (${w.detail ?? ''})`
      case 'many-frames':
        return `${t('importGifWarnManyFrames')} (${w.detail ?? ''}f)`
      case 'very-short-delays':
        return `${t('importGifWarnShortDelays')} (${w.detail ?? ''}f)`
      case 'finite-loop-approximated':
        return `${t('importGifWarnFiniteLoop')} (×${w.detail ?? ''})`
      case 'metadata-mismatch':
        return t('importGifMetaMismatchWarn')
    }
  }

  const scaleSelectOptions = useMemo(() => {
    if (!inspection) return []
    return inspection.candidates.map((c) => ({
      value: c.scale,
      label:
        c.scale === 1
          ? `1× — ${c.restoredWidth}×${c.restoredHeight}px (${t('importGifKeepRawSizeBtn')})`
          : `1/${c.scale} (${c.scale}×) → ${c.restoredWidth}×${c.restoredHeight}px`,
    }))
  }, [inspection, t])

  const estimatedBaseText = useMemo(() => {
    if (!inspection) return '—'
    const rec = inspection.recommendedScale
    const bw = Math.floor(inspection.decoded.width / rec)
    const bh = Math.floor(inspection.decoded.height / rec)
    return rec > 1 ? `${bw} × ${bh} px (${rec}×)` : `${bw} × ${bh} px (1×)`
  }, [inspection])

  const previewFrames = useMemo(() => {
    if (prepared) return prepared.previewFramesRgba
    if (!inspection) return []
    return inspection.decoded.frames.map((f) => f.rgba)
  }, [prepared, inspection])

  const previewDurations = useMemo(() => {
    if (!inspection) return []
    return inspection.decoded.frames.map((f) => f.durationMs)
  }, [inspection])

  const previewW = prepared?.width ?? inspection?.decoded.width ?? 1
  const previewH = prepared?.height ?? inspection?.decoded.height ?? 1

  return (
    <Modal
      open={open}
      title={t('importGifTitle')}
      onClose={() => {
        handleCancelOperation()
        onClose()
      }}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3.5" data-testid="import-gif-modal">
        {/* File Picker */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/gif,.gif"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              void handleFileChange(f)
              e.currentTarget.value = ''
            }}
            className="hidden"
            data-testid="import-gif-file-input"
          />
          <button
            type="button"
            disabled={decoding || busy}
            onClick={() => fileInputRef.current?.click()}
            className="pixel-btn pixel-btn-teal min-h-[40px] px-3.5 text-xs font-bold flex items-center gap-2"
            data-testid="import-gif-choose-btn"
          >
            <PixelIcon name="film" size={14} />
            <span>{t('importGifSelectFile')}</span>
          </button>
          {fileName && (
            <span className="text-xs font-mono truncate max-w-[220px] text-[var(--text-secondary)]">
              {fileName}
            </span>
          )}
        </div>

        {/* Decoding Progress + Cancel */}
        {decoding && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] flex items-center justify-between gap-2 text-xs font-bold"
            data-testid="import-gif-decoding-box"
          >
            <span>
              {t('importGifDecodingProgress')} ({decodedFrameCount}f)
            </span>
            <button
              type="button"
              onClick={handleCancelOperation}
              className="pixel-btn pixel-btn-danger min-h-[32px] px-3 text-xs font-bold"
              data-testid="import-gif-cancel-decode-btn"
            >
              {t('importGifCancelBtn')}
            </button>
          </div>
        )}

        {errorMsg && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)]"
            data-testid="import-gif-error"
          >
            {errorMsg}
          </div>
        )}

        {inspection && targetDimensions && !decoding && (
          <>
            {/* Artwork Name Input */}
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              maxLength={48}
              className="w-full min-h-[38px] px-2.5 text-xs font-bold pixel-input select-text"
              data-testid="import-gif-name-input"
            />

            {/* Resolution Confidence Badge (Metadata vs Heuristic clearly distinguished) */}
            {inspection.confidence === 'metadata' && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] text-xs font-bold text-[var(--accent-teal)] flex items-center gap-1.5"
                data-testid="import-gif-meta-badge"
              >
                <PixelIcon name="check" size={13} />
                <span>
                  {t('importGifDetectedMeta')} (
                  {inspection.metadata?.originalWidth}×
                  {inspection.metadata?.originalHeight}px /{' '}
                  {inspection.metadata?.scale}×)
                </span>
              </div>
            )}

            {inspection.confidence === 'heuristic' && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] text-xs font-bold text-[var(--accent-primary)] flex items-center gap-1.5"
                data-testid="import-gif-heuristic-badge"
              >
                <PixelIcon name="sparkle" size={13} />
                <span>
                  {t('importGifDetectedHeuristic')} (1/
                  {inspection.recommendedScale} →{' '}
                  {inspection.decoded.width / inspection.recommendedScale}×
                  {inspection.decoded.height / inspection.recommendedScale}px)
                </span>
              </div>
            )}

            {/* Converted Indexed Preview */}
            <div className="space-y-1">
              <span className="text-[10px] font-bold text-[var(--text-secondary)] block">
                {t('importGifPreviewConvertedLabel')}
              </span>
              <AnimatedIndexedPreview
                framesRgba={previewFrames}
                frameDurationsMs={previewDurations}
                width={previewW}
                height={previewH}
                checkerDark={checkerDark}
              />
            </div>

            {/* Comprehensive GIF & Palette Summary Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importGifRawSize')}
                </div>
                <div className="font-bold mt-0.5" data-testid="import-gif-raw-size">
                  {inspection.decoded.width} × {inspection.decoded.height} px
                </div>
              </div>

              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importGifEstimatedBaseSize')}
                </div>
                <div
                  className="font-bold mt-0.5"
                  data-testid="import-gif-estimated-size"
                >
                  {estimatedBaseText}
                </div>
              </div>

              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importGifCanvasSizeAfter')}
                </div>
                <div
                  className={`font-bold mt-0.5 ${
                    exceedsLimit
                      ? 'text-[var(--accent-rose)]'
                      : 'text-[var(--accent-teal)]'
                  }`}
                  data-testid="import-gif-after-size"
                >
                  {targetDimensions.width} × {targetDimensions.height} px (1/
                  {selectedScale})
                </div>
              </div>

              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importGifFrameCount')}
                </div>
                <div
                  className="font-bold mt-0.5"
                  data-testid="import-gif-frame-count"
                >
                  {inspection.decoded.frames.length} f
                </div>
              </div>

              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importGifTotalDuration')}
                </div>
                <div
                  className="font-bold mt-0.5"
                  data-testid="import-gif-total-duration"
                >
                  {inspection.decoded.totalDurationMs} ms
                </div>
              </div>

              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importGifLoopStatus')}
                </div>
                <div className="font-bold mt-0.5 truncate">
                  {inspection.decoded.finiteLoopCountNote !== null
                    ? `${t('importGifLoopFiniteApprox')}`
                    : inspection.decoded.loopPlayback
                      ? t('importGifLoopInfinite')
                      : t('importGifLoopOnce')}
                </div>
              </div>
            </div>

            {/* Color Count & Quantization Status */}
            {prepared && (
              <div
                className={`p-2 bg-[var(--bg-elevated)] border-2 ${
                  prepared.wasQuantized
                    ? 'border-[var(--accent-amber)]'
                    : 'border-[var(--border-pixel)]'
                } flex flex-wrap items-center justify-between gap-2 text-xs`}
                data-testid="import-gif-color-summary"
              >
                <div>
                  <span className="text-[var(--text-secondary)] mr-1.5">
                    {t('importGifColorSummary')}:
                  </span>
                  <span className="font-bold" data-testid="import-gif-color-counts">
                    {prepared.wasQuantized
                      ? `${prepared.originalOpaqueColorCount} → ${prepared.finalOpaqueColorCount}`
                      : `${prepared.finalOpaqueColorCount}`}
                  </span>
                </div>
                <span
                  className={`font-bold ${
                    prepared.wasQuantized
                      ? 'text-[var(--accent-amber)]'
                      : 'text-[var(--accent-teal)]'
                  }`}
                  data-testid="import-gif-quantized-badge"
                >
                  {prepared.wasQuantized
                    ? t('importGifQuantizedYes')
                    : t('importGifQuantizedNo')}
                </span>
              </div>
            )}

            {/* Resolution Restoration Quick Choice + Candidate Dropdown */}
            {inspection.candidates.length > 1 && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedScale(
                        inspection.recommendedScale > 1
                          ? inspection.recommendedScale
                          : inspection.candidates[
                              inspection.candidates.length - 1
                            ]!.scale
                      )
                    }
                    className={`min-h-[38px] px-2.5 text-xs font-bold ${
                      selectedScale > 1
                        ? 'pixel-btn pixel-btn-teal'
                        : 'pixel-btn'
                    }`}
                    data-testid="import-gif-restore-btn"
                  >
                    {inspection.confidence === 'metadata'
                      ? t('importGifRestoreMetaBtn')
                      : t('importGifRestoreEstimatedBtn')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedScale(1)}
                    className={`min-h-[38px] px-2.5 text-xs font-bold ${
                      selectedScale === 1
                        ? 'pixel-btn pixel-btn-teal'
                        : 'pixel-btn'
                    }`}
                    data-testid="import-gif-keep-raw-btn"
                  >
                    {t('importGifKeepRawSizeBtn')}
                  </button>
                </div>

                <div className="space-y-1">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {t('importGifScaleCandidateLabel')}
                  </span>
                  <PixelSelect<number>
                    value={selectedScale}
                    options={scaleSelectOptions}
                    onChange={(s) => setSelectedScale(s)}
                    ariaLabel={t('importGifScaleCandidateLabel')}
                    direction="up"
                    className="w-full"
                    testId="import-gif-scale-select"
                  />
                </div>
              </div>
            )}

            {/* Warnings */}
            {inspection.warnings.length > 0 && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] space-y-1 text-[11px] leading-relaxed"
                data-testid="import-gif-warnings"
              >
                {inspection.warnings.map((w, i) => (
                  <div key={`${w.code}-${i}`}>• {formatWarning(w)}</div>
                ))}
              </div>
            )}

            {/* >256x256 Limit Guard */}
            {exceedsLimit && (
              <div
                className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)] leading-relaxed"
                data-testid="import-gif-size-limit-error"
              >
                {t('importGifTooLargeError')}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  handleCancelOperation()
                  onClose()
                }}
                className="pixel-btn min-h-[42px] px-4 text-xs font-bold"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={exceedsLimit || !prepared || busy || decoding}
                onClick={() => void handleConfirmImport()}
                className="pixel-btn pixel-btn-active min-h-[42px] px-4 text-xs font-bold flex items-center gap-1.5"
                data-testid="import-gif-confirm-btn"
              >
                <PixelIcon name="check" size={14} />
                <span>{t('confirm')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
