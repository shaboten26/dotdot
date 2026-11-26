import { useEffect, useMemo, useState } from 'react'
import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  PlaybackDirection,
} from '../../types'
import {
  generateSpriteSheet,
  type SpriteSheetLayout,
} from '../../engine/spriteSheet'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelSelect } from '../common/PixelSelect'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

interface ExportSpriteSheetModalProps {
  open: boolean
  onClose: () => void
  projectName: string
  width: number
  height: number
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  defaultDirection?: PlaybackDirection
  checkerDark?: boolean
  onExportedPng?: () => void
  onExportedJson?: () => void
}

export function ExportSpriteSheetModal({
  open,
  onClose,
  projectName,
  width,
  height,
  layerMetas,
  frames,
  cels,
  celBuffers,
  fallbackSingleFrameLayers,
  defaultDirection = 'forward',
  checkerDark = false,
  onExportedPng,
  onExportedJson,
}: ExportSpriteSheetModalProps) {
  const { t } = useI18n()
  const { settings } = useApp()

  const totalFrames = Math.max(1, frames.length)
  const [layout, setLayout] = useState<SpriteSheetLayout>('horizontal')
  const [columns, setColumns] = useState<number>(Math.min(4, totalFrames))
  const [spacing, setSpacing] = useState<number>(
    settings.defaultSpriteSheetPadding ?? 0
  )
  const [margin, setMargin] = useState<number>(0)
  const [scale, setScale] = useState<number>(1)
  const [layerMode, setLayerMode] = useState<'visible' | 'single'>('visible')
  const [singleLayerId, setSingleLayerId] = useState<string>(
    layerMetas[0]?.id ?? ''
  )
  const [fromFrame, setFromFrame] = useState<number>(1)
  const [toFrame, setToFrame] = useState<number>(totalFrames)
  const [direction, setDirection] = useState<PlaybackDirection>(defaultDirection)

  useEffect(() => {
    if (!open) return
    setLayout(totalFrames >= 6 ? 'grid' : 'horizontal')
    setColumns(Math.max(1, Math.min(4, totalFrames)))
    setSpacing(settings.defaultSpriteSheetPadding ?? 0)
    setMargin(0)
    setScale(1)
    setLayerMode('visible')
    setSingleLayerId(
      layerMetas.find((l) => l.visible)?.id ?? layerMetas[0]?.id ?? ''
    )
    setFromFrame(1)
    setToFrame(Math.max(1, frames.length))
    setDirection(defaultDirection)
  }, [
    open,
    totalFrames,
    frames.length,
    settings.defaultSpriteSheetPadding,
    defaultDirection,
  ])

  const sheetResult = useMemo(() => {
    if (!open || width <= 0 || height <= 0) return null
    return generateSpriteSheet({
      projectName,
      canvasWidth: width,
      canvasHeight: height,
      layerMetas,
      frames,
      cels,
      celBuffers,
      fallbackSingleFrameLayers,
      layout,
      columns,
      spacing,
      margin,
      scale,
      layerFilter: layerMode === 'single' && singleLayerId ? singleLayerId : 'visible',
      frameRange: { from: fromFrame, to: toFrame },
      direction,
    })
  }, [
    open,
    projectName,
    width,
    height,
    layerMetas,
    frames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    layout,
    columns,
    spacing,
    margin,
    scale,
    layerMode,
    singleLayerId,
    fromFrame,
    toFrame,
    direction,
  ])

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!sheetResult) {
      setPreviewUrl(null)
      return
    }
    const blob = new Blob([sheetResult.pngBytes.slice().buffer], {
      type: 'image/png',
    })
    const url = URL.createObjectURL(blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [sheetResult])

  const safeBaseName =
    projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-sheet'

  const handleDownloadPng = () => {
    if (!sheetResult) return
    const blob = new Blob([sheetResult.pngBytes.slice().buffer], {
      type: 'image/png',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeBaseName}_sheet_${sheetResult.sheetWidth}x${sheetResult.sheetHeight}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    onExportedPng?.()
  }

  const handleDownloadJson = () => {
    if (!sheetResult) return
    const blob = new Blob([sheetResult.metadataJsonText], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeBaseName}_sheet.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    onExportedJson?.()
  }

  const scaleOptions = useMemo(() => {
    return [1, 2, 3, 4, 6, 8, 10, 12, 16].map((s) => ({
      value: s,
      label: `${s}×`,
    }))
  }, [])

  const layerOptions = useMemo(
    () =>
      layerMetas.map((l) => ({
        value: l.id,
        label: l.name,
      })),
    [layerMetas]
  )

  return (
    <Modal
      open={open}
      title={t('spriteSheetTitle')}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3" data-testid="export-sprite-sheet-modal">
        {/* Preview */}
        <div
          style={getCheckerboardStyle(checkerDark, 10)}
          className="w-full h-40 border-2 border-[var(--border-pixel)] p-2 flex items-center justify-center overflow-hidden"
        >
          {previewUrl && (
            <img
              src={previewUrl}
              alt="Sprite Sheet Preview"
              draggable={false}
              className="max-w-full max-h-full object-contain pixelated"
              data-testid="sprite-sheet-preview-img"
            />
          )}
        </div>

        {/* Dimensions Summary */}
        {sheetResult && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
              <div className="text-[10px] text-[var(--text-secondary)]">
                {t('exportOriginalSize')}
              </div>
              <div className="font-bold mt-0.5">
                {width}×{height}px × {sheetResult.frameCount}F ({sheetResult.columns}×
                {sheetResult.rows})
              </div>
            </div>
            <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
              <div className="text-[10px] text-[var(--text-secondary)]">
                {t('spriteSheetOutputSize')}
              </div>
              <div
                className="font-bold text-[var(--accent-teal)] mt-0.5"
                data-testid="sprite-sheet-output-dims"
              >
                {sheetResult.sheetWidth} × {sheetResult.sheetHeight} px (
                {sheetResult.appliedScale}×)
              </div>
            </div>
          </div>
        )}

        {/* Layout Selector */}
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { id: 'horizontal', label: t('spriteSheetLayoutRow') },
              { id: 'vertical', label: t('spriteSheetLayoutCol') },
              { id: 'grid', label: t('spriteSheetLayoutGrid') },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setLayout(opt.id)}
              className={`min-h-[36px] px-2 text-xs font-bold ${
                layout === opt.id ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
              }`}
              data-testid={`sprite-layout-${opt.id}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Columns + Scale + Spacing + Margin */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {layout === 'grid' && (
            <div>
              <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
                {t('spriteSheetColumns')}
              </label>
              <input
                type="number"
                min={1}
                max={64}
                value={columns}
                onChange={(e) =>
                  setColumns(Math.max(1, Math.min(64, Number(e.target.value) || 1)))
                }
                className="w-full min-h-[34px] px-2 text-xs font-mono font-bold pixel-input"
                data-testid="sprite-columns-input"
              />
            </div>
          )}
          <div>
            <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
              {t('exportScaleMultiplier')}
            </label>
            <PixelSelect<number>
              value={scale}
              options={scaleOptions}
              onChange={setScale}
              ariaLabel={t('exportScaleMultiplier')}
              className="w-full"
              testId="sprite-scale-select"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
              {t('spriteSheetSpacing')}
            </label>
            <input
              type="number"
              min={0}
              max={64}
              value={spacing}
              onChange={(e) =>
                setSpacing(Math.max(0, Math.min(64, Number(e.target.value) || 0)))
              }
              className="w-full min-h-[34px] px-2 text-xs font-mono font-bold pixel-input"
              data-testid="sprite-spacing-input"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
              {t('spriteSheetMargin')}
            </label>
            <input
              type="number"
              min={0}
              max={64}
              value={margin}
              onChange={(e) =>
                setMargin(Math.max(0, Math.min(64, Number(e.target.value) || 0)))
              }
              className="w-full min-h-[34px] px-2 text-xs font-mono font-bold pixel-input"
              data-testid="sprite-margin-input"
            />
          </div>
        </div>

        {/* Layer Filter (Visible Composite vs Single Layer) */}
        <div className="space-y-1.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setLayerMode('visible')}
              className={`min-h-[34px] px-2.5 text-xs font-bold ${
                layerMode === 'visible' ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
              }`}
              data-testid="sprite-layer-visible"
            >
              {t('spriteSheetLayerAllVisible')}
            </button>
            <button
              type="button"
              onClick={() => setLayerMode('single')}
              className={`min-h-[34px] px-2.5 text-xs font-bold ${
                layerMode === 'single' ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
              }`}
              data-testid="sprite-layer-single"
            >
              {t('spriteSheetLayerSingle')}
            </button>
          </div>

          {layerMode === 'single' && layerOptions.length > 0 && (
            <PixelSelect<string>
              value={singleLayerId}
              options={layerOptions}
              onChange={setSingleLayerId}
              ariaLabel={t('spriteSheetSelectLayer')}
              className="w-full"
              testId="sprite-single-layer-select"
            />
          )}
        </div>

        {/* Frame Range & Direction (when multi-frame) */}
        {totalFrames > 1 && (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
                From (1..{totalFrames})
              </label>
              <input
                type="number"
                min={1}
                max={totalFrames}
                value={fromFrame}
                onChange={(e) =>
                  setFromFrame(
                    Math.max(1, Math.min(totalFrames, Number(e.target.value) || 1))
                  )
                }
                className="w-full min-h-[34px] px-2 text-xs font-mono font-bold pixel-input"
                data-testid="sprite-from-frame"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
                To (1..{totalFrames})
              </label>
              <input
                type="number"
                min={1}
                max={totalFrames}
                value={toFrame}
                onChange={(e) =>
                  setToFrame(
                    Math.max(1, Math.min(totalFrames, Number(e.target.value) || 1))
                  )
                }
                className="w-full min-h-[34px] px-2 text-xs font-mono font-bold pixel-input"
                data-testid="sprite-to-frame"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-[var(--text-secondary)] block mb-1">
                {t('gifDirectionLabel')}
              </label>
              <PixelSelect<PlaybackDirection>
                value={direction}
                options={[
                  { value: 'forward', label: t('dirForward') },
                  { value: 'reverse', label: t('dirReverse') },
                  { value: 'pingpong', label: t('dirPingpong') },
                ]}
                onChange={setDirection}
                ariaLabel={t('gifDirectionLabel')}
                className="w-full"
              />
            </div>
          </div>
        )}

        {/* Separate Independent PNG & JSON Download Buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
          <button
            type="button"
            onClick={handleDownloadPng}
            className="pixel-btn pixel-btn-active min-h-[46px] px-3 text-xs font-bold flex items-center justify-center gap-2"
            data-testid="download-sprite-sheet-png-btn"
          >
            <PixelIcon name="sheet" size={15} />
            <span>{t('spriteSheetDownloadPng')}</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadJson}
            className="pixel-btn pixel-btn-teal min-h-[46px] px-3 text-xs font-bold flex items-center justify-center gap-2"
            data-testid="download-sprite-sheet-json-btn"
          >
            <PixelIcon name="download" size={15} />
            <span>{t('spriteSheetDownloadJson')}</span>
          </button>
        </div>
      </div>
    </Modal>
  )
}
