import { useEffect, useMemo, useState } from 'react'
import type { LayerRuntime, ResizeAnchor } from '../../types'
import {
  exportCompositePngBytes,
  getDefaultExportScale,
  getExportScaleOptions,
} from '../../engine/compositor'
import {
  countPixelsOutsideResizedCanvas,
  MAX_CANVAS_SIZE,
  MIN_CANVAS_SIZE,
} from '../../engine/pixelBuffer'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelSelect } from '../common/PixelSelect'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { CanvasSizePresetsPicker } from '../common/CanvasSizePresetsPicker'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

const ANCHOR_GRID: Array<{
  anchor: ResizeAnchor
  labelKey: TranslationKey
  dotClass: string
}> = [
  { anchor: 'top-left', labelKey: 'anchorTopLeft', dotClass: 'items-start justify-start' },
  { anchor: 'top-center', labelKey: 'anchorTopCenter', dotClass: 'items-start justify-center' },
  { anchor: 'top-right', labelKey: 'anchorTopRight', dotClass: 'items-start justify-end' },
  { anchor: 'middle-left', labelKey: 'anchorMiddleLeft', dotClass: 'items-center justify-start' },
  { anchor: 'center', labelKey: 'anchorCenter', dotClass: 'items-center justify-center' },
  { anchor: 'middle-right', labelKey: 'anchorMiddleRight', dotClass: 'items-center justify-end' },
  { anchor: 'bottom-left', labelKey: 'anchorBottomLeft', dotClass: 'items-end justify-start' },
  { anchor: 'bottom-center', labelKey: 'anchorBottomCenter', dotClass: 'items-end justify-center' },
  { anchor: 'bottom-right', labelKey: 'anchorBottomRight', dotClass: 'items-end justify-end' },
]

interface CanvasResizeModalProps {
  open: boolean
  currentWidth: number
  currentHeight: number
  layers?: readonly LayerRuntime[]
  onClose: () => void
  onResize: (width: number, height: number, anchor: ResizeAnchor) => void
}

export function CanvasResizeModal({
  open,
  currentWidth,
  currentHeight,
  layers = [],
  onClose,
  onResize,
}: CanvasResizeModalProps) {
  const { t } = useI18n()
  const [w, setW] = useState(currentWidth)
  const [h, setH] = useState(currentHeight)
  const [anchor, setAnchor] = useState<ResizeAnchor>('center')

  useEffect(() => {
    if (open) {
      setW(currentWidth)
      setH(currentHeight)
      setAnchor('center')
    }
  }, [open, currentWidth, currentHeight])

  const clampedW = Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(w || 1))
  )
  const clampedH = Math.max(
    MIN_CANVAS_SIZE,
    Math.min(MAX_CANVAS_SIZE, Math.round(h || 1))
  )

  const clippedPixelCount = useMemo(() => {
    if (!open || layers.length === 0) return 0
    if (clampedW >= currentWidth && clampedH >= currentHeight) return 0
    return countPixelsOutsideResizedCanvas(
      layers,
      currentWidth,
      currentHeight,
      clampedW,
      clampedH,
      anchor
    )
  }, [open, layers, currentWidth, currentHeight, clampedW, clampedH, anchor])

  return (
    <Modal
      open={open}
      title={t('resizeCanvasTitle')}
      onClose={onClose}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-bold text-[var(--text-secondary)]">
              {t('widthPx')}
            </span>
            <input
              type="number"
              min={MIN_CANVAS_SIZE}
              max={MAX_CANVAS_SIZE}
              value={w}
              onChange={(e) => setW(Number(e.target.value))}
              className="w-full min-h-[40px] px-3 text-sm pixel-input"
              data-testid="resize-width-input"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-bold text-[var(--text-secondary)]">
              {t('heightPx')}
            </span>
            <input
              type="number"
              min={MIN_CANVAS_SIZE}
              max={MAX_CANVAS_SIZE}
              value={h}
              onChange={(e) => setH(Number(e.target.value))}
              className="w-full min-h-[40px] px-3 text-sm pixel-input"
              data-testid="resize-height-input"
            />
          </label>
        </div>

        <CanvasSizePresetsPicker
          selectedWidth={w}
          selectedHeight={h}
          onSelectDimensions={(nextW, nextH) => {
            setW(nextW)
            setH(nextH)
          }}
        />

        {/* Section 5: Custom 3x3 Pixel-Art 9-Directional Anchor Selector (defaults to Center) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-[var(--text-secondary)]">
              {t('resizeAnchorLabel')}
            </span>
            <span
              className="font-bold text-[var(--accent-primary)]"
              data-testid="resize-anchor-current-label"
            >
              {t(
                ANCHOR_GRID.find((item) => item.anchor === anchor)?.labelKey ??
                  'anchorCenter'
              )}
            </span>
          </div>

          <div className="flex items-center gap-3 p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div
              className="grid grid-cols-3 gap-1.5 shrink-0"
              role="radiogroup"
              aria-label={t('resizeAnchorLabel')}
              data-testid="resize-anchor-grid"
            >
              {ANCHOR_GRID.map((cell) => {
                const active = anchor === cell.anchor
                return (
                  <button
                    key={cell.anchor}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={t(cell.labelKey)}
                    title={t(cell.labelKey)}
                    onClick={() => setAnchor(cell.anchor)}
                    className={`w-9 h-9 p-1.5 flex ${cell.dotClass} cursor-pointer ${
                      active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid={`resize-anchor-${cell.anchor}`}
                  >
                    <span
                      className={`w-2.5 h-2.5 border ${
                        active
                          ? 'bg-[var(--accent-primary-fg)] border-[var(--accent-primary-fg)]'
                          : 'bg-[var(--text-secondary)] border-[var(--border-pixel)]'
                      }`}
                    />
                  </button>
                )
              })}
            </div>

            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {t('resizeNote')}
            </p>
          </div>
        </div>

        {/* Shrink warning when non-transparent pixels move outside visible canvas bounds */}
        {clippedPixelCount > 0 && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs text-[var(--accent-rose)] font-bold leading-relaxed"
            data-testid="resize-clip-warning"
          >
            {t('resizeClipWarning')}
          </div>
        )}

        {/* Confirm + Rightmost Cancel */}
        <div className="flex gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => {
              onResize(clampedW, clampedH, anchor)
              onClose()
            }}
            className="flex-1 min-h-[44px] text-xs font-bold pixel-btn pixel-btn-active"
            data-testid="confirm-resize-btn"
          >
            {t('apply')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 text-xs font-bold pixel-btn"
          >
            {t('cancel')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export type ExportPngInitialIntent = 'download' | 'share'

interface ExportPngModalProps {
  open: boolean
  projectName: string
  width: number
  height: number
  layers: readonly LayerRuntime[]
  checkerDark?: boolean
  initialIntent?: ExportPngInitialIntent
  onClose: () => void
  onDownloaded?: () => void
  onShared?: () => void
}

/**
 * Sections 14, 15 & 16: PNG Export Modal (4000px Max, ~2000px Initial Default) + Independent Download & OS Share Sheet
 * - Never updates backup reminder `lastExportAt` (only Environment Pack ZIP updates that!)
 * - Renders a clean, unobstructed `<img>` preview (no `pointer-events: none` or `user-select: none`) so iOS Safari/PWA long-press "Save to Photos" works natively!
 */
export function ExportPngModal({
  open,
  projectName,
  width,
  height,
  layers,
  checkerDark = false,
  initialIntent = 'download',
  onClose,
  onDownloaded,
  onShared,
}: ExportPngModalProps) {
  const { t } = useI18n()

  const scaleOptions = useMemo(
    () => getExportScaleOptions(width, height),
    [width, height]
  )
  const defaultScale = useMemo(
    () => getDefaultExportScale(width, height),
    [width, height]
  )

  const [selectedScale, setSelectedScale] = useState<number>(defaultScale)
  const [shareFallbackNotice, setShareFallbackNotice] = useState(false)

  useEffect(() => {
    if (open) {
      setSelectedScale(defaultScale)
      setShareFallbackNotice(false)
    }
  }, [open, defaultScale])

  const selectedOption =
    scaleOptions.find((o) => o.scale === selectedScale) ?? scaleOptions[0]
  const outWidth = selectedOption?.width ?? width * selectedScale
  const outHeight = selectedOption?.height ?? height * selectedScale

  const safeBaseName =
    projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-artwork'
  const exportFileName = `${safeBaseName}_${outWidth}x${outHeight}.png`

  // Generate object URL for crisp long-pressable `<img>` preview
  const previewPngBytes = useMemo(() => {
    if (!open || layers.length === 0) return null
    // Use selected scale up to 1024px for crisp preview & fast rendering, or 1x minimum
    const previewScale = Math.max(
      1,
      Math.min(selectedScale, Math.max(1, Math.floor(1024 / Math.max(1, width, height))))
    )
    return exportCompositePngBytes(layers, width, height, previewScale).png
  }, [open, layers, width, height, selectedScale])

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!previewPngBytes) {
      setPreviewUrl(null)
      return
    }
    const blob = new Blob([previewPngBytes.slice().buffer], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    setPreviewUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [previewPngBytes])

  const buildScaledPngBlob = (): { blob: Blob; filename: string } => {
    const { png, outWidth: ow, outHeight: oh } = exportCompositePngBytes(
      layers,
      width,
      height,
      selectedScale
    )
    const blob = new Blob([png.slice().buffer], { type: 'image/png' })
    return {
      blob,
      filename: `${safeBaseName}_${ow}x${oh}.png`,
    }
  }

  const handleDownload = () => {
    const { blob, filename } = buildScaledPngBlob()
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

  const handleShare = async () => {
    const { blob, filename } = buildScaledPngBlob()
    const file = new File([blob], filename, { type: 'image/png' })
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean
      share?: (data?: ShareData) => Promise<void>
    }

    if (typeof nav.share === 'function') {
      const shareData: ShareData = {
        files: [file],
        title: projectName,
      }
      const canShareFiles =
        typeof nav.canShare === 'function' ? nav.canShare({ files: [file] }) : true

      if (canShareFiles) {
        try {
          await nav.share(shareData)
          onShared?.()
          onClose()
          return
        } catch (err) {
          // User cancelled native OS share sheet -> do nothing destructive
          if (err instanceof DOMException && err.name === 'AbortError') {
            return
          }
        }
      }
    }

    // Fallback notice when Web Share API with files is unsupported
    setShareFallbackNotice(true)
  }

  const selectOpts = scaleOptions.map((opt) => ({
    value: opt.scale,
    label: opt.label,
  }))

  return (
    <Modal
      open={open}
      title={t('exportPngTitle')}
      onClose={onClose}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-3.5">
        {/* Long-press friendly native <img> preview (NO pointer-events-none, NO select-none!) */}
        <div
          style={getCheckerboardStyle(checkerDark, 10)}
          className="w-full h-48 border-2 border-[var(--border-pixel)] p-3 flex items-center justify-center overflow-hidden"
        >
          {previewUrl && (
            <img
              src={previewUrl}
              alt={exportFileName}
              draggable={false}
              className="max-w-full max-h-full object-contain pixelated"
              data-testid="export-png-preview-img"
            />
          )}
        </div>

        {/* Original Size & Live Output Dimensions */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div className="text-[10px] text-[var(--text-secondary)]">
              {t('exportOriginalSize')}
            </div>
            <div className="font-bold mt-0.5" data-testid="export-original-size">
              {width} × {height} px
            </div>
          </div>
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div className="text-[10px] text-[var(--text-secondary)]">
              {t('exportOutputSize')}
            </div>
            <div
              className="font-bold text-[var(--accent-teal)] mt-0.5"
              data-testid="export-output-size"
            >
              {outWidth} × {outHeight} px ({selectedScale}x)
            </div>
          </div>
        </div>

        {/* Integer Scale Selector up to 4000px */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-[var(--text-secondary)] block">
            {t('exportScaleMultiplier')}
          </label>
          <PixelSelect<number>
            value={selectedScale}
            options={selectOpts}
            onChange={(nextScale) => setSelectedScale(nextScale)}
            ariaLabel={t('exportScaleMultiplier')}
            direction="up"
            className="w-full"
            testId="export-scale-select"
          />
        </div>

        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {t('exportTransparentNote')} {t('longPressSaveHint')}
        </p>

        {shareFallbackNotice && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-xs font-bold leading-relaxed"
            data-testid="share-fallback-notice"
          >
            {t('shareUnsupportedFallback')}
          </div>
        )}

        {/* Independent Download & OS Share Sheet Buttons */}
        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button
            type="button"
            onClick={handleDownload}
            className={`min-h-[48px] px-3 text-xs sm:text-sm font-bold flex items-center justify-center gap-2 ${
              initialIntent === 'download'
                ? 'pixel-btn pixel-btn-active'
                : 'pixel-btn'
            }`}
            data-testid="download-png-btn"
          >
            <PixelIcon name="download" size={16} />
            <span>{t('downloadPngBtn')}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleShare()}
            className={`min-h-[48px] px-3 text-xs sm:text-sm font-bold flex items-center justify-center gap-2 ${
              initialIntent === 'share'
                ? 'pixel-btn pixel-btn-teal'
                : 'pixel-btn pixel-btn-teal'
            }`}
            data-testid="share-png-btn"
          >
            <PixelIcon name="share" size={16} />
            <span>{t('sharePngBtn')}</span>
          </button>
        </div>
      </div>
    </Modal>
  )
}
