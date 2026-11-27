import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  PlaybackDirection,
  ProjectPalette,
} from '../../types'
import {
  getDefaultExportScale,
  getExportScaleOptions,
} from '../../engine/compositor'
import {
  exportTimelineAnimatedGif,
  type GifAlphaMode,
  type GifEncodeResult,
} from '../../engine/gifEncoder'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelSelect } from '../common/PixelSelect'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

interface ExportGifModalProps {
  open: boolean
  projectName: string
  width: number
  height: number
  palette: ProjectPalette
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  defaultDirection?: PlaybackDirection
  defaultLoop?: boolean
  checkerDark?: boolean
  onClose: () => void
  onDownloaded?: () => void
  onShared?: () => void
  onCancelled?: () => void
}

export function ExportGifModal({
  open,
  projectName,
  width,
  height,
  palette,
  layerMetas,
  frames,
  cels,
  celBuffers,
  fallbackSingleFrameLayers,
  defaultDirection = 'forward',
  defaultLoop = true,
  checkerDark = false,
  onClose,
  onDownloaded,
  onShared,
  onCancelled,
}: ExportGifModalProps) {
  const { t } = useI18n()
  const { settings } = useApp()

  const scaleOptions = useMemo(
    () => getExportScaleOptions(width, height),
    [width, height]
  )
  const defaultScale = useMemo(
    () => getDefaultExportScale(width, height),
    [width, height]
  )

  const [selectedScale, setSelectedScale] = useState<number>(defaultScale)
  const [alphaMode, setAlphaMode] = useState<GifAlphaMode>('dither')
  const [matteColor, setMatteColor] = useState<string>('#221E2E')
  const [direction, setDirection] = useState<PlaybackDirection>(defaultDirection)
  const [loop, setLoop] = useState<boolean>(defaultLoop)
  const [embedMeta, setEmbedMeta] = useState<boolean>(
    settings.embedPngMetadata ?? true
  )

  const [encoding, setEncoding] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  })
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [shareFallbackNotice, setShareFallbackNotice] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setSelectedScale(defaultScale)
      setDirection(defaultDirection)
      setLoop(defaultLoop)
      setEmbedMeta(settings.embedPngMetadata ?? true)
      setShareFallbackNotice(false)
    } else {
      abortRef.current?.abort()
      abortRef.current = null
      setEncoding(false)
    }
  }, [open, defaultScale, defaultDirection, defaultLoop, settings.embedPngMetadata])

  // Build crisp lightweight animated GIF preview whenever modal is open & settings change
  useEffect(() => {
    if (!open) {
      setPreviewUrl(null)
      return
    }
    const previewScale = Math.max(
      1,
      Math.min(
        selectedScale,
        Math.max(1, Math.floor(512 / Math.max(1, width, height)))
      )
    )
    const ctrl = new AbortController()
    let activeUrl: string | null = null

    void (async () => {
      try {
        const res = await exportTimelineAnimatedGif({
          width,
          height,
          palette,
          layerMetas,
          frames,
          cels,
          celBuffers,
          fallbackSingleFrameLayers,
          scale: previewScale,
          alphaMode,
          matteColor,
          direction,
          loop,
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        const blob = new Blob([res.gif.slice().buffer], { type: 'image/gif' })
        activeUrl = URL.createObjectURL(blob)
        setPreviewUrl(activeUrl)
      } catch {
        // ignore aborted preview
      }
    })()

    return () => {
      ctrl.abort()
      if (activeUrl) {
        URL.revokeObjectURL(activeUrl)
      }
    }
  }, [
    open,
    width,
    height,
    palette,
    layerMetas,
    frames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    selectedScale,
    alphaMode,
    matteColor,
    direction,
    loop,
  ])

  const selectedOption =
    scaleOptions.find((o) => o.scale === selectedScale) ?? scaleOptions[0]
  const outWidth = selectedOption?.width ?? width * selectedScale
  const outHeight = selectedOption?.height ?? height * selectedScale
  const safeBaseName =
    projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-animation'

  const runFullEncode = async (): Promise<GifEncodeResult | null> => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setEncoding(true)
    setProgress({ done: 0, total: Math.max(1, frames.length) })
    try {
      const res = await exportTimelineAnimatedGif({
        width,
        height,
        palette,
        layerMetas,
        frames,
        cels,
        celBuffers,
        fallbackSingleFrameLayers,
        scale: selectedScale,
        alphaMode,
        matteColor,
        direction,
        loop,
        embedMetadata: embedMeta,
        signal: ctrl.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      return res
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        onCancelled?.()
        return null
      }
      throw err
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null
      }
      setEncoding(false)
    }
  }

  const handleCancelEncode = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setEncoding(false)
  }

  const handleDownloadGif = async () => {
    const res = await runFullEncode()
    if (!res) return
    const filename = `${safeBaseName}_${res.outWidth}x${res.outHeight}.gif`
    const blob = new Blob([res.gif.slice().buffer], { type: 'image/gif' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    onDownloaded?.()
    onClose()
  }

  const handleShareGif = async () => {
    const res = await runFullEncode()
    if (!res) return
    const filename = `${safeBaseName}_${res.outWidth}x${res.outHeight}.gif`
    const blob = new Blob([res.gif.slice().buffer], { type: 'image/gif' })
    const file = new File([blob], filename, { type: 'image/gif' })
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean
      share?: (data?: ShareData) => Promise<void>
    }

    if (typeof nav.share === 'function') {
      const canShareFiles =
        typeof nav.canShare === 'function' ? nav.canShare({ files: [file] }) : true
      if (canShareFiles) {
        try {
          await nav.share({ files: [file], title: projectName })
          onShared?.()
          onClose()
          return
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return
          }
        }
      }
    }
    setShareFallbackNotice(true)
  }

  const selectOpts = scaleOptions.map((opt) => ({
    value: opt.scale,
    label: opt.label,
  }))

  return (
    <Modal
      open={open}
      title={t('exportGifTitle')}
      onClose={() => {
        handleCancelEncode()
        onClose()
      }}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-3" data-testid="export-gif-modal">
        {/* Animated GIF Preview (long-press friendly native <img>) */}
        <div
          style={getCheckerboardStyle(checkerDark, 10)}
          className="w-full h-44 border-2 border-[var(--border-pixel)] p-2.5 flex items-center justify-center overflow-hidden"
        >
          {previewUrl && (
            <img
              src={previewUrl}
              alt={`${safeBaseName}.gif`}
              draggable={false}
              className="max-w-full max-h-full object-contain pixelated"
              data-testid="export-gif-preview-img"
            />
          )}
        </div>

        {/* Dimensions Summary */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div className="text-[10px] text-[var(--text-secondary)]">
              {t('exportOriginalSize')}
            </div>
            <div className="font-bold mt-0.5">
              {width} × {height} px ({frames.length}f)
            </div>
          </div>
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div className="text-[10px] text-[var(--text-secondary)]">
              {t('exportOutputSize')}
            </div>
            <div
              className="font-bold text-[var(--accent-teal)] mt-0.5"
              data-testid="export-gif-output-size"
            >
              {outWidth} × {outHeight} px ({selectedScale}x)
            </div>
          </div>
        </div>

        {/* Integer Scale Selector (~2000px default, <=4000px max) */}
        <div className="space-y-1">
          <label className="text-xs font-bold text-[var(--text-secondary)] block">
            {t('exportScaleMultiplier')}
          </label>
          <PixelSelect<number>
            value={selectedScale}
            options={selectOpts}
            onChange={setSelectedScale}
            ariaLabel={t('exportScaleMultiplier')}
            direction="up"
            className="w-full"
            testId="export-gif-scale-select"
          />
        </div>

        {/* Semi-Transparency Handling: Dither vs Matte */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-[var(--text-secondary)] block">
            {t('gifAlphaModeLabel')}
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setAlphaMode('dither')}
              className={`min-h-[36px] px-2 text-[11px] font-bold ${
                alphaMode === 'dither' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="gif-alpha-dither-btn"
            >
              {t('gifAlphaDither')}
            </button>
            <button
              type="button"
              onClick={() => setAlphaMode('matte')}
              className={`min-h-[36px] px-2 text-[11px] font-bold ${
                alphaMode === 'matte' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid="gif-alpha-matte-btn"
            >
              {t('gifAlphaMatte')}
            </button>
          </div>
          {alphaMode === 'matte' && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-[var(--text-secondary)]">
                {t('gifMatteColorLabel')}
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono font-bold">{matteColor}</span>
                <input
                  type="color"
                  value={matteColor}
                  onChange={(e) => setMatteColor(e.target.value.toUpperCase())}
                  className="w-8 h-8 border-2 border-[var(--border-pixel)] cursor-pointer bg-transparent"
                  data-testid="gif-matte-color-input"
                />
              </div>
            </div>
          )}
        </div>

        {/* Playback Direction & Loop Controls */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-[var(--text-secondary)]">
              {t('gifDirectionLabel')}
            </span>
            <PixelCheckbox
              checked={loop}
              onChange={setLoop}
              label={t('loopPlaybackLabel')}
              testId="gif-loop-checkbox"
            />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                ['forward', 'dirForward'],
                ['reverse', 'dirReverse'],
                ['pingpong', 'dirPingpong'],
              ] as const
            ).map(([dir, labelKey]) => (
              <button
                key={dir}
                type="button"
                onClick={() => setDirection(dir)}
                className={`min-h-[34px] px-2 text-xs font-bold ${
                  direction === dir ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                }`}
                data-testid={`gif-dir-${dir}`}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1">
          <PixelCheckbox
            checked={embedMeta}
            onChange={setEmbedMeta}
            label={t('exportEmbedMetaLabel')}
            testId="export-gif-embed-meta-checkbox"
          />
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            {t('exportEmbedMetaHint')}
          </p>
        </div>

        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {t('gifFrameRoundingNote')}
        </p>

        {encoding && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] space-y-2"
            data-testid="gif-encoding-progress"
          >
            <div className="flex items-center justify-between text-xs font-bold">
              <span>{t('gifGeneratingLabel')}</span>
              <span>
                {progress.done} / {progress.total}
              </span>
            </div>
            <div className="w-full h-2.5 bg-[var(--bg-surface)] border border-[var(--border-pixel)]">
              <div
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((progress.done / Math.max(1, progress.total)) * 100)
                  )}%`,
                }}
                className="h-full bg-[var(--accent-teal)]"
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleCancelEncode}
                className="pixel-btn pixel-btn-danger min-h-[32px] px-3 text-xs font-bold"
                data-testid="gif-cancel-encode-btn"
              >
                {t('gifCancelBtn')}
              </button>
            </div>
          </div>
        )}

        {shareFallbackNotice && (
          <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-xs font-bold leading-relaxed">
            {t('shareUnsupportedFallback')}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button
            type="button"
            disabled={encoding}
            onClick={() => void handleDownloadGif()}
            className="min-h-[46px] px-3 pixel-btn pixel-btn-active text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5"
            data-testid="download-gif-btn"
          >
            <PixelIcon name="download" size={16} />
            <span>{t('downloadGifBtn')}</span>
          </button>

          <button
            type="button"
            disabled={encoding}
            onClick={() => void handleShareGif()}
            className="min-h-[46px] px-3 pixel-btn pixel-btn-teal text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5"
            data-testid="share-gif-btn"
          >
            <PixelIcon name="share" size={16} />
            <span>{t('shareGifBtn')}</span>
          </button>
        </div>
      </div>
    </Modal>
  )
}
