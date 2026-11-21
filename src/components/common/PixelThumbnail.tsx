import { useEffect, useMemo } from 'react'
import type { DitherPatternId } from '../../types'
import { shouldDrawWithDither } from '../../engine/dithering'

interface PixelThumbnailProps {
  pngBytes?: Uint8Array
  alt: string
  className?: string
  checkerDark?: boolean
}

export function PixelThumbnail({
  pngBytes,
  alt,
  className = '',
  checkerDark = false,
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

  const checkerStyle = checkerDark
    ? {
        backgroundImage:
          'linear-gradient(45deg, #272334 25%, transparent 25%), linear-gradient(-45deg, #272334 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #272334 75%), linear-gradient(-45deg, transparent 75%, #272334 75%)',
        backgroundColor: '#1d1a27',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
      }
    : {
        backgroundImage:
          'linear-gradient(45deg, #ddd8cd 25%, transparent 25%), linear-gradient(-45deg, #ddd8cd 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ddd8cd 75%), linear-gradient(-45deg, transparent 75%, #ddd8cd 75%)',
        backgroundColor: '#f1ede4',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
      }

  return (
    <div
      style={checkerStyle}
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

/**
 * 8x8 crisp pixel swatch showing exact dither pattern density & layout,
 * with distinct corner bracket indicator when active (never relies on color alone).
 */
export function DitherSwatch({
  patternId,
  active,
  color = '#6b5ea8',
}: {
  patternId: DitherPatternId
  active?: boolean
  color?: string
}) {
  const cells: boolean[] = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cells.push(shouldDrawWithDither(patternId, x, y))
    }
  }

  return (
    <div
      className={`relative grid grid-cols-8 w-8 h-8 shrink-0 bg-[var(--bg-panel)] ${
        active
          ? 'border-2 border-[var(--text-primary)] shadow-[2px_2px_0px_var(--accent-primary)]'
          : 'border-2 border-[var(--border-subtle)]'
      }`}
    >
      {cells.map((filled, idx) => (
        <span
          key={idx}
          style={filled ? { backgroundColor: color } : undefined}
          className="w-full h-full"
        />
      ))}
    </div>
  )
}
