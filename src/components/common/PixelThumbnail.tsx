import { useEffect, useMemo, useRef } from 'react'
import type { DitherPatternId, LayerRuntime, ProjectPalette } from '../../types'
import { shouldDrawWithDither } from '../../engine/dithering'
import { buildPaletteRgbaLut, indexedBufferToRgba } from '../../engine/indexedPalette'
import { extractLayerCanvasView } from '../../engine/pixelBuffer'

interface PixelThumbnailProps {
  pngBytes?: Uint8Array
  alt: string
  className?: string
  checkerDark?: boolean
  /**
   * When true (used in Gallery cards), renders with a completely transparent background
   * so transparent artwork pixels show the underlying card surface without checkerboard.
   */
  transparentBg?: boolean
}

export function getCheckerboardStyle(checkerDark: boolean, cellPx = 10) {
  const half = cellPx / 2
  return checkerDark
    ? {
        backgroundImage:
          'linear-gradient(45deg, #272235 25%, transparent 25%), linear-gradient(-45deg, #272235 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #272235 75%), linear-gradient(-45deg, transparent 75%, #272235 75%)',
        backgroundColor: '#1d1928',
        backgroundSize: `${cellPx}px ${cellPx}px`,
        backgroundPosition: `0 0, 0 ${half}px, ${half}px -${half}px, -${half}px 0px`,
      }
    : {
        backgroundImage:
          'linear-gradient(45deg, #e4dce9 25%, transparent 25%), linear-gradient(-45deg, #e4dce9 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e4dce9 75%), linear-gradient(-45deg, transparent 75%, #e4dce9 75%)',
        backgroundColor: '#f5f1f8',
        backgroundSize: `${cellPx}px ${cellPx}px`,
        backgroundPosition: `0 0, 0 ${half}px, ${half}px -${half}px, -${half}px 0px`,
      }
}

export function PixelThumbnail({
  pngBytes,
  alt,
  className = '',
  checkerDark = false,
  transparentBg = false,
}: PixelThumbnailProps) {
  const url = useMemo(() => {
    if (!pngBytes || pngBytes.byteLength === 0) return null
    const blob = new Blob([pngBytes.slice().buffer], { type: 'image/png' })
    return URL.createObjectURL(blob)
  }, [pngBytes])

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  const bgStyle = transparentBg
    ? { backgroundColor: 'transparent' }
    : getCheckerboardStyle(checkerDark, 12)

  return (
    <div
      style={bgStyle}
      data-transparent-bg={transparentBg ? 'true' : 'false'}
      className={`flex items-center justify-center overflow-hidden ${className}`}
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          className="w-full h-full object-contain pixelated select-none pointer-events-none"
          draggable={false}
        />
      ) : (
        <div className="w-full h-full" />
      )}
    </div>
  )
}

const FALLBACK_PREVIEW_PALETTE: ProjectPalette = {
  name: 'Fallback',
  colors: ['#241F31'],
  colorTable: ['#241F31'],
  displayOrder: [0],
}

/**
 * Live Layer Pixel Thumbnail (`LayerBufferThumbnail`)
 * - Renders actual 1-byte indexed pixel content of a single layer onto a `<canvas>` over a checkerboard background
 * - Preserves canvas aspect ratio inside a fixed square frame (`44x44px`)
 * - Never clears or hides pixel preview when `layer.visible === false` (dimmed badge indicates hidden state instead)
 */
export function LayerBufferThumbnail({
  layer,
  palette,
  canvasWidth,
  canvasHeight,
  checkerDark = false,
  size = 44,
}: {
  layer: LayerRuntime
  palette?: ProjectPalette
  canvasWidth: number
  canvasHeight: number
  checkerDark?: boolean
  size?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activePalette = palette ?? FALLBACK_PREVIEW_PALETTE

  useEffect(() => {
    const el = canvasRef.current
    if (!el || canvasWidth <= 0 || canvasHeight <= 0) return
    if (el.width !== canvasWidth || el.height !== canvasHeight) {
      el.width = canvasWidth
      el.height = canvasHeight
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    const view = extractLayerCanvasView(layer, canvasWidth, canvasHeight)
    const lut = buildPaletteRgbaLut(activePalette)
    const rgba = indexedBufferToRgba(view, lut)
    const imgData = new ImageData(
      new Uint8ClampedArray(rgba),
      canvasWidth,
      canvasHeight
    )
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    ctx.putImageData(imgData, 0, 0)
  }, [
    layer,
    layer.data,
    layer.offsetX,
    layer.offsetY,
    layer.dataWidth,
    layer.dataHeight,
    activePalette,
    canvasWidth,
    canvasHeight,
  ])

  const checkerStyle = getCheckerboardStyle(checkerDark, 8)

  return (
    <div
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        ...checkerStyle,
      }}
      className={`relative flex items-center justify-center border-2 border-[var(--border-pixel)] overflow-hidden shrink-0 ${
        layer.visible ? '' : 'opacity-65'
      }`}
      data-testid={`layer-thumb-${layer.id}`}
    >
      <canvas
        ref={canvasRef}
        style={{
          aspectRatio: `${canvasWidth} / ${canvasHeight}`,
        }}
        className="max-w-full max-h-full object-contain pixelated block pointer-events-none"
      />
      {!layer.visible && (
        <span
          className="absolute bottom-0 right-0 px-1 bg-[var(--bg-panel)] border-t border-l border-[var(--border-pixel)] text-[8px] font-bold leading-none py-0.5 text-[var(--text-secondary)]"
          aria-hidden="true"
        >
          OFF
        </span>
      )}
    </div>
  )
}

/**
 * High-Contrast Theme-Aware Dither Swatch (`DitherSwatch`)
 * - NEVER depends on the active drawing color or palette color!
 * - Uses theme-aware high-contrast foreground (`--text-primary`) & background (`--bg-panel`)
 *   so all 8 dither patterns remain 100% legible even when white, pale yellow, or black is selected.
 * - Zero shadows; active state uses double border + accent frame.
 */
export function DitherSwatch({
  patternId,
  active,
}: {
  patternId: DitherPatternId
  active?: boolean
}) {
  const cells: boolean[] = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cells.push(shouldDrawWithDither(patternId, x, y))
    }
  }

  return (
    <div
      className={`relative grid grid-cols-8 w-9 h-9 shrink-0 bg-[var(--bg-panel)] p-[1px] ${
        active
          ? 'border-2 border-[var(--accent-primary)] outline-2 outline-offset-1 outline-[var(--border-strong)]'
          : 'border-2 border-[var(--border-pixel)]'
      }`}
    >
      {cells.map((filled, idx) => (
        <span
          key={idx}
          className={
            filled ? 'w-full h-full bg-[var(--text-primary)]' : 'w-full h-full bg-[var(--bg-app)]'
          }
        />
      ))}
    </div>
  )
}
