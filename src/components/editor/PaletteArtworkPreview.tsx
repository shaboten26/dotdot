import { useEffect, useRef, useState } from 'react'
import type { LayerRuntime, ProjectPalette } from '../../types'
import { compositeLayers } from '../../engine/compositor'
import { toGrayscaleRgbaBuffer } from '../../engine/color'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { PixelIcon } from '../common/PixelIcon'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

interface PaletteArtworkPreviewProps {
  canvasWidth?: number
  canvasHeight?: number
  layers?: readonly LayerRuntime[]
  palette: ProjectPalette
  checkerDark?: boolean
  testId?: string
}

/**
 * Live Current Artwork Preview Banner pinned at the top of Palette editing modals (`PaletteSheet` / `PaletteToolsModal`).
 * - Immediately reflects live palette edits (`palette`), color replacements (`layers`), and non-destructive grayscale preview (`settings.grayscalePreview`).
 * - Renders crisp nearest-neighbor pixel art (`image-rendering: pixelated`) with preserved aspect ratio over the transparency checkerboard.
 */
export function PaletteArtworkPreview({
  canvasWidth = 0,
  canvasHeight = 0,
  layers,
  palette,
  checkerDark = false,
  testId = 'palette-artwork-live-preview',
}: PaletteArtworkPreviewProps) {
  const { settings, updateSettings } = useApp()
  const { t } = useI18n()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [expanded, setExpanded] = useState(false)

  const hasArtwork = Boolean(
    layers && layers.length > 0 && canvasWidth > 0 && canvasHeight > 0
  )
  const grayscale = Boolean(settings.grayscalePreview)

  useEffect(() => {
    if (!hasArtwork || !layers) return
    const el = canvasRef.current
    if (!el) return

    if (el.width !== canvasWidth || el.height !== canvasHeight) {
      el.width = canvasWidth
      el.height = canvasHeight
    }

    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false

    const composited = compositeLayers(layers, canvasWidth, canvasHeight, {
      palette,
    })
    const rgba: Uint8ClampedArray<ArrayBuffer> = grayscale
      ? toGrayscaleRgbaBuffer(composited)
      : new Uint8ClampedArray(composited)

    const imgData = new ImageData(rgba, canvasWidth, canvasHeight)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    ctx.putImageData(imgData, 0, 0)
  }, [
    hasArtwork,
    layers,
    canvasWidth,
    canvasHeight,
    palette,
    palette.colors,
    palette.colorTable,
    grayscale,
  ])

  if (!hasArtwork) return null

  return (
    <div
      className="sticky top-0 z-20 -mt-1 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1.5"
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-1.5 text-[11px]">
        <div className="flex items-center gap-1.5 min-w-0 font-bold text-[var(--text-primary)]">
          <PixelIcon
            name="gallery"
            size={12}
            className="text-[var(--accent-teal)] shrink-0"
          />
          <span className="truncate">{t('paletteArtworkPreviewTitle')}</span>
          <span className="font-mono text-[10px] text-[var(--text-secondary)] shrink-0">
            [{canvasWidth}×{canvasHeight}]
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() =>
              void updateSettings({ grayscalePreview: !grayscale })
            }
            aria-pressed={grayscale}
            title={t('grayscalePreviewToggleBtn')}
            className={`min-h-[26px] px-1.5 text-[10px] font-bold flex items-center gap-1 ${
              grayscale ? 'pixel-btn pixel-btn-teal' : 'pixel-btn'
            }`}
            data-testid={`${testId}-grayscale-btn`}
          >
            <span className="inline-flex shrink-0">
              <span className="w-2 h-2.5 bg-[#1e1b29] border border-[var(--border-strong)]" />
              <span className="w-2 h-2.5 bg-[#e6e2ee] border-y border-r border-[var(--border-strong)]" />
            </span>
            <span>{t('grayscalePreviewActiveBadge')}</span>
          </button>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="pixel-btn min-h-[26px] px-1.5 text-[10px] font-bold flex items-center gap-0.5"
            data-testid={`${testId}-size-btn`}
          >
            <PixelIcon name="fit" size={11} />
            <span>
              {expanded
                ? t('paletteArtworkPreviewCompactBtn')
                : t('paletteArtworkPreviewExpandBtn')}
            </span>
          </button>
        </div>
      </div>

      <div
        style={getCheckerboardStyle(checkerDark, 10)}
        className={`w-full border-2 border-[var(--border-pixel)] flex items-center justify-center p-1.5 overflow-hidden ${
          expanded ? 'h-44 sm:h-52' : 'h-24 sm:h-28'
        }`}
      >
        <canvas
          ref={canvasRef}
          style={{
            aspectRatio: `${canvasWidth} / ${canvasHeight}`,
          }}
          className="h-full w-auto max-w-full object-contain pixelated block pointer-events-none border border-[var(--border-subtle)]"
          data-testid={`${testId}-canvas`}
        />
      </div>
    </div>
  )
}
