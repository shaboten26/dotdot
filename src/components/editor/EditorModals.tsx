import { useEffect, useMemo, useState } from 'react'
import type { LayerRuntime } from '../../types'
import {
  exportCompositePngBytes,
  getExportScaleOptions,
} from '../../engine/compositor'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../../engine/pixelBuffer'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelThumbnail } from '../common/PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

interface CanvasResizeModalProps {
  open: boolean
  currentWidth: number
  currentHeight: number
  onClose: () => void
  onResize: (width: number, height: number) => void
}

const PRESET_DIMENSIONS = [16, 24, 32, 48, 64, 96, 128, 256]

export function CanvasResizeModal({
  open,
  currentWidth,
  currentHeight,
  onClose,
  onResize,
}: CanvasResizeModalProps) {
  const { t } = useI18n()
  const [w, setW] = useState(currentWidth)
  const [h, setH] = useState(currentHeight)

  useEffect(() => {
    if (open) {
      setW(currentWidth)
      setH(currentHeight)
    }
  }, [open, currentWidth, currentHeight])

  return (
    <Modal open={open} title={t('resizeCanvasTitle')} onClose={onClose} maxWidthClass="max-w-sm">
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
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {PRESET_DIMENSIONS.map((dim) => {
            const active = w === dim && h === dim
            return (
              <button
                key={dim}
                type="button"
                onClick={() => {
                  setW(dim)
                  setH(dim)
                }}
                className={`min-h-[36px] px-2.5 text-xs font-bold ${
                  active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                }`}
              >
                {dim}×{dim}
              </button>
            )
          })}
        </div>

        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {t('resizeNote')}
        </p>

        <div className="flex gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-[44px] text-xs font-bold pixel-btn"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              const clampedW = Math.max(
                MIN_CANVAS_SIZE,
                Math.min(MAX_CANVAS_SIZE, Math.round(w || 1))
              )
              const clampedH = Math.max(
                MIN_CANVAS_SIZE,
                Math.min(MAX_CANVAS_SIZE, Math.round(h || 1))
              )
              onResize(clampedW, clampedH)
              onClose()
            }}
            className="flex-1 min-h-[44px] text-xs font-bold pixel-btn pixel-btn-active"
          >
            {t('apply')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

interface ExportPngModalProps {
  open: boolean
  projectName: string
  width: number
  height: number
  layers: readonly LayerRuntime[]
  checkerDark?: boolean
  onClose: () => void
  onExported?: () => void
}

export function ExportPngModal({
  open,
  projectName,
  width,
  height,
  layers,
  checkerDark = false,
  onClose,
  onExported,
}: ExportPngModalProps) {
  const { t } = useI18n()
  const scaleOptions = useMemo(() => getExportScaleOptions(width, height), [width, height])

  const defaultScale = useMemo(() => {
    const target = scaleOptions.find((o) => Math.max(o.width, o.height) >= 256)
    return target?.scale ?? 1
  }, [scaleOptions])

  const [selectedScale, setSelectedScale] = useState<number>(defaultScale)

  useEffect(() => {
    if (open) {
      setSelectedScale(defaultScale)
    }
  }, [open, defaultScale])

  const preview1xPng = useMemo(() => {
    if (!open || layers.length === 0) return undefined
    return exportCompositePngBytes(layers, width, height, 1).png
  }, [open, layers, width, height])

  const handleDownload = () => {
    const { png, outWidth, outHeight } = exportCompositePngBytes(
      layers,
      width,
      height,
      selectedScale
    )
    const blob = new Blob([png.slice().buffer], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const safeName =
      projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-artwork'
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeName}_${outWidth}x${outHeight}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    onExported?.()
    onClose()
  }

  return (
    <Modal open={open} title={t('exportPngTitle')} onClose={onClose} maxWidthClass="max-w-md">
      <div className="space-y-4">
        <PixelThumbnail
          pngBytes={preview1xPng}
          alt={projectName}
          checkerDark={checkerDark}
          className="w-full h-48 border-2 border-[var(--border-pixel)] p-3"
        />

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-[var(--text-secondary)] block">
            {t('exportScaleLabel')}
          </label>
          <select
            value={selectedScale}
            onChange={(e) => setSelectedScale(Number(e.target.value))}
            className="w-full min-h-[42px] px-3 text-xs font-bold pixel-input"
            data-testid="export-scale-select"
          >
            {scaleOptions.map((opt) => (
              <option key={opt.scale} value={opt.scale}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {t('exportTransparentNote')}
        </p>

        <button
          type="button"
          onClick={handleDownload}
          className="w-full min-h-[48px] pixel-btn pixel-btn-active text-sm font-bold flex items-center justify-center gap-2"
          data-testid="download-png-btn"
        >
          <PixelIcon name="download" size={18} />
          {t('downloadPng')}
        </button>
      </div>
    </Modal>
  )
}
