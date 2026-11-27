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
  compositeLayers,
  exportCompositePngBytes,
  getDefaultExportScale,
  getExportScaleOptions,
  upscaleNearestNeighbor,
} from '../../engine/compositor'
import {
  exportTimelineAnimatedGif,
  type GifAlphaMode,
} from '../../engine/gifEncoder'
import {
  buildOrderedCompositeFrames1x,
  encodeAsepriteBytes,
  encodeFramesToAnimatedSvg,
  encodeNumberedPngFramesZip,
  encodeRgba1xToIco,
  encodeRgbaToBmp32,
  encodeRgbaToCrispSvg,
  encodeRgbaViaCanvasMime,
  generateSpriteSheet,
  type AnimationExportFormat,
  type SpriteSheetLayout,
  type StillExportFormat,
} from '../../engine/multiFormatExport'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelSelect } from '../common/PixelSelect'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

export type UnifiedExportMode = 'still' | 'animation' | 'current-frame'

export interface UnifiedExportModalProps {
  open: boolean
  mode: UnifiedExportMode
  projectName: string
  width: number
  height: number
  palette: ProjectPalette
  layers: readonly LayerRuntime[]
  layerMetas?: readonly LayerMeta[]
  frames?: readonly FrameMeta[]
  cels?: CelMap
  celBuffers?: Readonly<Record<string, CelBufferRuntime>>
  activeFrameIndex?: number
  defaultDirection?: PlaybackDirection
  defaultLoop?: boolean
  checkerDark?: boolean
  onClose: () => void
  onDownloaded?: (format: string) => void
  onShared?: (format: string) => void
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function UnifiedExportModal({
  open,
  mode,
  projectName,
  width,
  height,
  palette,
  layers,
  layerMetas,
  frames,
  cels,
  celBuffers,
  activeFrameIndex = 0,
  defaultDirection = 'forward',
  defaultLoop = true,
  checkerDark = false,
  onClose,
  onDownloaded,
  onShared,
}: UnifiedExportModalProps) {
  const { t } = useI18n()
  const { settings } = useApp()

  const isAnimationMode = mode === 'animation'
  const isCurrentFrameMode = mode === 'current-frame'

  const scaleOptions = useMemo(
    () => getExportScaleOptions(width, height),
    [width, height]
  )
  const defaultScale = useMemo(
    () => getDefaultExportScale(width, height),
    [width, height]
  )

  const [stillFormat, setStillFormat] = useState<StillExportFormat>('png')
  const [animFormat, setAnimFormat] = useState<AnimationExportFormat>('gif')
  const [selectedScale, setSelectedScale] = useState<number>(defaultScale)
  const [embedMeta, setEmbedMeta] = useState<boolean>(
    settings.embedPngMetadata ?? true
  )
  const [jpegBgColor, setJpegBgColor] = useState<string>('#FFFFFF')

  // GIF / Animation options
  const [gifAlphaMode, setGifAlphaMode] = useState<GifAlphaMode>('dither')
  const [gifMatteColor, setGifMatteColor] = useState<string>('#221E2E')
  const [direction, setDirection] = useState<PlaybackDirection>(defaultDirection)
  const [loop, setLoop] = useState<boolean>(defaultLoop)

  // Sprite sheet options (when animFormat === 'spritesheet')
  const totalFrames = Math.max(1, frames?.length ?? 1)
  const [sheetLayout, setSheetLayout] = useState<SpriteSheetLayout>('horizontal')
  const [sheetColumns, setSheetColumns] = useState<number>(
    Math.min(4, totalFrames)
  )
  const [sheetSpacing, setSheetSpacing] = useState<number>(
    settings.defaultSpriteSheetPadding ?? 0
  )

  const [encoding, setEncoding] = useState(false)
  const [shareFallbackNotice, setShareFallbackNotice] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setStillFormat('png')
      setAnimFormat('gif')
      setSelectedScale(defaultScale)
      setEmbedMeta(settings.embedPngMetadata ?? true)
      setDirection(defaultDirection)
      setLoop(defaultLoop)
      setSheetLayout(totalFrames >= 6 ? 'grid' : 'horizontal')
      setSheetColumns(Math.max(1, Math.min(4, totalFrames)))
      setSheetSpacing(settings.defaultSpriteSheetPadding ?? 0)
      setShareFallbackNotice(false)
    } else {
      abortRef.current?.abort()
      abortRef.current = null
      setEncoding(false)
    }
  }, [
    open,
    mode,
    defaultScale,
    defaultDirection,
    defaultLoop,
    totalFrames,
    settings.embedPngMetadata,
    settings.defaultSpriteSheetPadding,
  ])

  const activeFormat = isAnimationMode ? animFormat : stillFormat

  // Effective 1x RGBA for still / current-frame modes
  const stillRgba1x = useMemo(() => {
    if (!open || isAnimationMode || layers.length === 0) return null
    return compositeLayers(layers, width, height, { palette })
  }, [open, isAnimationMode, layers, width, height, palette])

  // Sprite sheet result when animFormat === 'spritesheet'
  const spriteSheetResult = useMemo(() => {
    if (!open || !isAnimationMode || animFormat !== 'spritesheet') return null
    const safeMetas = layerMetas ?? layers
    const safeFrames: FrameMeta[] =
      frames && frames.length > 0
        ? [...frames]
        : [{ id: 'f1', durationMs: 100 }]
    const sheetScale = Math.max(1, Math.min(16, selectedScale))
    return generateSpriteSheet({
      projectName,
      canvasWidth: width,
      canvasHeight: height,
      palette,
      layerMetas: safeMetas,
      frames: safeFrames,
      cels: cels ?? {},
      celBuffers: celBuffers ?? {},
      fallbackSingleFrameLayers: layers,
      layout: sheetLayout,
      columns: sheetColumns,
      spacing: sheetSpacing,
      margin: 0,
      scale: sheetScale,
      layerFilter: 'visible',
      direction,
    })
  }, [
    open,
    isAnimationMode,
    animFormat,
    projectName,
    width,
    height,
    palette,
    layerMetas,
    layers,
    frames,
    cels,
    celBuffers,
    sheetLayout,
    sheetColumns,
    sheetSpacing,
    selectedScale,
    direction,
  ])

  // Build live preview URL
  useEffect(() => {
    if (!open) {
      setPreviewUrl(null)
      return
    }

    let revokedUrl: string | null = null
    const ctrl = new AbortController()

    if (!isAnimationMode) {
      if (!stillRgba1x || layers.length === 0) {
        setPreviewUrl(null)
        return
      }
      if (stillFormat === 'svg') {
        const svgText = encodeRgbaToCrispSvg(stillRgba1x, width, height, 8)
        const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
        revokedUrl = URL.createObjectURL(blob)
        setPreviewUrl(revokedUrl)
      } else {
        const previewScale = Math.max(
          1,
          Math.min(
            selectedScale,
            Math.max(1, Math.floor(1024 / Math.max(1, width, height)))
          )
        )
        const png = exportCompositePngBytes(layers, width, height, previewScale, {
          palette,
        }).png
        const blob = new Blob([png.slice().buffer], { type: 'image/png' })
        revokedUrl = URL.createObjectURL(blob)
        setPreviewUrl(revokedUrl)
      }
      return () => {
        if (revokedUrl) URL.revokeObjectURL(revokedUrl)
      }
    }

    // Animation mode preview
    if (animFormat === 'spritesheet') {
      if (spriteSheetResult) {
        const blob = new Blob([spriteSheetResult.pngBytes.slice().buffer], {
          type: 'image/png',
        })
        revokedUrl = URL.createObjectURL(blob)
        setPreviewUrl(revokedUrl)
      }
      return () => {
        if (revokedUrl) URL.revokeObjectURL(revokedUrl)
      }
    }

    if (animFormat === 'svg-anim') {
      const ordered = buildOrderedCompositeFrames1x({
        width,
        height,
        palette,
        layerMetas: layerMetas ?? layers,
        frames: frames ?? [],
        cels: cels ?? {},
        celBuffers: celBuffers ?? {},
        fallbackSingleFrameLayers: layers,
        direction,
        loop,
      })
      const svgText = encodeFramesToAnimatedSvg(ordered, width, height, 8, loop)
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      revokedUrl = URL.createObjectURL(blob)
      setPreviewUrl(revokedUrl)
      return () => {
        if (revokedUrl) URL.revokeObjectURL(revokedUrl)
      }
    }

    // Default animated preview via lightweight GIF
    const previewScale = Math.max(
      1,
      Math.min(
        selectedScale,
        Math.max(1, Math.floor(512 / Math.max(1, width, height)))
      )
    )
    void (async () => {
      try {
        const res = await exportTimelineAnimatedGif({
          width,
          height,
          palette,
          layerMetas: layerMetas ?? layers,
          frames: frames ?? [],
          cels: cels ?? {},
          celBuffers: celBuffers ?? {},
          fallbackSingleFrameLayers: layers,
          scale: previewScale,
          alphaMode: gifAlphaMode,
          matteColor: gifMatteColor,
          direction,
          loop,
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        const blob = new Blob([res.gif.slice().buffer], { type: 'image/gif' })
        revokedUrl = URL.createObjectURL(blob)
        setPreviewUrl(revokedUrl)
      } catch {
        // ignore aborted preview
      }
    })()

    return () => {
      ctrl.abort()
      if (revokedUrl) URL.revokeObjectURL(revokedUrl)
    }
  }, [
    open,
    isAnimationMode,
    stillFormat,
    animFormat,
    stillRgba1x,
    layers,
    layerMetas,
    frames,
    cels,
    celBuffers,
    width,
    height,
    palette,
    selectedScale,
    gifAlphaMode,
    gifMatteColor,
    direction,
    loop,
    spriteSheetResult,
  ])

  const safeBaseName = useMemo(() => {
    const base =
      projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-artwork'
    if (isCurrentFrameMode) {
      const fNum = String(activeFrameIndex + 1).padStart(2, '0')
      return `${base}_frame${fNum}`
    }
    return base
  }, [projectName, isCurrentFrameMode, activeFrameIndex])

  const selectedOption =
    scaleOptions.find((o) => o.scale === selectedScale) ?? scaleOptions[0]
  const outWidth = selectedOption?.width ?? width * selectedScale
  const outHeight = selectedOption?.height ?? height * selectedScale

  const stillFormatOptions = useMemo(() => {
    const base: Array<{ value: StillExportFormat; label: string }> = [
      { value: 'png', label: t('formatPngLabel') },
      { value: 'svg', label: t('formatSvgLabel') },
      { value: 'webp', label: t('formatWebpLabel') },
      { value: 'bmp', label: t('formatBmpLabel') },
      { value: 'jpeg', label: t('formatJpegLabel') },
      { value: 'ico', label: t('formatIcoLabel') },
    ]
    if (!isCurrentFrameMode) {
      base.push({ value: 'aseprite', label: t('formatAsepriteLabel') })
    }
    return base
  }, [t, isCurrentFrameMode])

  const animFormatOptions = useMemo<
    Array<{ value: AnimationExportFormat; label: string }>
  >(
    () => [
      { value: 'gif', label: t('formatGifLabel') },
      { value: 'svg-anim', label: t('formatSvgAnimLabel') },
      { value: 'spritesheet', label: t('formatSpriteSheetLabel') },
      { value: 'png-zip', label: t('formatPngZipLabel') },
      { value: 'aseprite', label: t('formatAsepriteLabel') },
    ],
    [t]
  )

  const scaleSelectOpts = useMemo(
    () =>
      scaleOptions.map((opt) => ({
        value: opt.scale,
        label: opt.label,
      })),
    [scaleOptions]
  )

  const buildExportPayload = async (): Promise<{
    blob: Blob
    filename: string
    mimeType: string
  } | null> => {
    if (!isAnimationMode) {
      const rgba1x =
        stillRgba1x ?? compositeLayers(layers, width, height, { palette })

      if (stillFormat === 'png') {
        const { png, outWidth: ow, outHeight: oh } = exportCompositePngBytes(
          layers,
          width,
          height,
          selectedScale,
          { palette, embedMetadata: embedMeta }
        )
        return {
          blob: new Blob([png.slice().buffer], { type: 'image/png' }),
          filename: `${safeBaseName}_${ow}x${oh}.png`,
          mimeType: 'image/png',
        }
      }

      if (stillFormat === 'svg') {
        const svgText = encodeRgbaToCrispSvg(rgba1x, width, height, selectedScale)
        return {
          blob: new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }),
          filename: `${safeBaseName}_${outWidth}x${outHeight}.svg`,
          mimeType: 'image/svg+xml',
        }
      }

      if (stillFormat === 'webp') {
        const upscaled = upscaleNearestNeighbor(rgba1x, width, height, selectedScale)
        const blob = await encodeRgbaViaCanvasMime(
          upscaled.data,
          upscaled.width,
          upscaled.height,
          'image/webp'
        )
        return {
          blob,
          filename: `${safeBaseName}_${upscaled.width}x${upscaled.height}.webp`,
          mimeType: 'image/webp',
        }
      }

      if (stillFormat === 'jpeg') {
        const upscaled = upscaleNearestNeighbor(rgba1x, width, height, selectedScale)
        const blob = await encodeRgbaViaCanvasMime(
          upscaled.data,
          upscaled.width,
          upscaled.height,
          'image/jpeg',
          { matteHex: jpegBgColor }
        )
        return {
          blob,
          filename: `${safeBaseName}_${upscaled.width}x${upscaled.height}.jpg`,
          mimeType: 'image/jpeg',
        }
      }

      if (stillFormat === 'bmp') {
        const upscaled = upscaleNearestNeighbor(rgba1x, width, height, selectedScale)
        const bmp = encodeRgbaToBmp32(
          upscaled.data,
          upscaled.width,
          upscaled.height
        )
        return {
          blob: new Blob([bmp.slice().buffer], { type: 'image/bmp' }),
          filename: `${safeBaseName}_${upscaled.width}x${upscaled.height}.bmp`,
          mimeType: 'image/bmp',
        }
      }

      if (stillFormat === 'ico') {
        const { icoBytes, icoWidth, icoHeight } = encodeRgba1xToIco(
          rgba1x,
          width,
          height,
          selectedScale
        )
        return {
          blob: new Blob([icoBytes.slice().buffer], { type: 'image/x-icon' }),
          filename: `${safeBaseName}_${icoWidth}x${icoHeight}.ico`,
          mimeType: 'image/x-icon',
        }
      }

      if (stillFormat === 'aseprite') {
        const aseRes = encodeAsepriteBytes({
          width,
          height,
          layerMetas: layerMetas ?? layers,
          frames:
            frames && frames.length > 0
              ? frames
              : [{ id: 'f1', durationMs: 100 }],
          cels: cels ?? {},
          celBuffers: celBuffers ?? {},
          fallbackSingleFrameLayers: layers,
          palette,
          paletteColors: palette.colors,
        })
        return {
          blob: new Blob([aseRes.bytes.slice().buffer], {
            type: 'application/octet-stream',
          }),
          filename: `${safeBaseName}.aseprite`,
          mimeType: 'application/octet-stream',
        }
      }
    }

    // Animation export modes
    if (animFormat === 'gif') {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setEncoding(true)
      try {
        const res = await exportTimelineAnimatedGif({
          width,
          height,
          palette,
          layerMetas: layerMetas ?? layers,
          frames: frames ?? [],
          cels: cels ?? {},
          celBuffers: celBuffers ?? {},
          fallbackSingleFrameLayers: layers,
          scale: selectedScale,
          alphaMode: gifAlphaMode,
          matteColor: gifMatteColor,
          direction,
          loop,
          embedMetadata: embedMeta,
          signal: ctrl.signal,
        })
        return {
          blob: new Blob([res.gif.slice().buffer], { type: 'image/gif' }),
          filename: `${safeBaseName}_${res.outWidth}x${res.outHeight}.gif`,
          mimeType: 'image/gif',
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          return null
        }
        throw err
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null
        setEncoding(false)
      }
    }

    if (animFormat === 'svg-anim') {
      const ordered = buildOrderedCompositeFrames1x({
        width,
        height,
        palette,
        layerMetas: layerMetas ?? layers,
        frames: frames ?? [],
        cels: cels ?? {},
        celBuffers: celBuffers ?? {},
        fallbackSingleFrameLayers: layers,
        direction,
        loop,
      })
      const svgText = encodeFramesToAnimatedSvg(
        ordered,
        width,
        height,
        selectedScale,
        loop
      )
      return {
        blob: new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }),
        filename: `${safeBaseName}_${outWidth}x${outHeight}_anim.svg`,
        mimeType: 'image/svg+xml',
      }
    }

    if (animFormat === 'spritesheet') {
      if (!spriteSheetResult) return null
      return {
        blob: new Blob([spriteSheetResult.pngBytes.slice().buffer], {
          type: 'image/png',
        }),
        filename: `${safeBaseName}_sheet_${spriteSheetResult.sheetWidth}x${spriteSheetResult.sheetHeight}.png`,
        mimeType: 'image/png',
      }
    }

    if (animFormat === 'png-zip') {
      const ordered = buildOrderedCompositeFrames1x({
        width,
        height,
        palette,
        layerMetas: layerMetas ?? layers,
        frames: frames ?? [],
        cels: cels ?? {},
        celBuffers: celBuffers ?? {},
        fallbackSingleFrameLayers: layers,
        direction,
        loop,
      })
      const zipBytes = encodeNumberedPngFramesZip(
        safeBaseName,
        ordered,
        width,
        height,
        selectedScale,
        embedMeta
      )
      return {
        blob: new Blob([zipBytes.slice().buffer], { type: 'application/zip' }),
        filename: `${safeBaseName}_${outWidth}x${outHeight}_frames.zip`,
        mimeType: 'application/zip',
      }
    }

    if (animFormat === 'aseprite') {
      const aseRes = encodeAsepriteBytes({
        width,
        height,
        layerMetas: layerMetas ?? layers,
        frames:
          frames && frames.length > 0
            ? frames
            : [{ id: 'f1', durationMs: 100 }],
        cels: cels ?? {},
        celBuffers: celBuffers ?? {},
        fallbackSingleFrameLayers: layers,
        palette,
        paletteColors: palette.colors,
      })
      return {
        blob: new Blob([aseRes.bytes.slice().buffer], {
          type: 'application/octet-stream',
        }),
        filename: `${safeBaseName}.aseprite`,
        mimeType: 'application/octet-stream',
      }
    }

    return null
  }

  const handleDownload = async () => {
    setEncoding(true)
    try {
      const payload = await buildExportPayload()
      if (!payload) return
      triggerBlobDownload(payload.blob, payload.filename)
      onDownloaded?.(activeFormat)
      onClose()
    } finally {
      setEncoding(false)
    }
  }

  const handleDownloadSpriteJson = () => {
    if (!spriteSheetResult) return
    const blob = new Blob([spriteSheetResult.metadataJsonText], {
      type: 'application/json;charset=utf-8',
    })
    triggerBlobDownload(blob, `${safeBaseName}_sheet.json`)
    onDownloaded?.('spritesheet-json')
  }

  const handleShare = async () => {
    setEncoding(true)
    try {
      const payload = await buildExportPayload()
      if (!payload) return
      const file = new File([payload.blob], payload.filename, {
        type: payload.mimeType,
      })
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean
        share?: (data?: ShareData) => Promise<void>
      }
      if (typeof nav.share === 'function') {
        const canShareFiles =
          typeof nav.canShare === 'function'
            ? nav.canShare({ files: [file] })
            : true
        if (canShareFiles) {
          try {
            await nav.share({ files: [file], title: projectName })
            onShared?.(activeFormat)
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
    } finally {
      setEncoding(false)
    }
  }

  const modalTitle = isAnimationMode
    ? t('exportAnimationModalTitle')
    : isCurrentFrameMode
      ? t('exportCurrentFrameModalTitle')
      : t('exportImageModalTitle')

  const showScaleSelector =
    activeFormat !== 'aseprite' && activeFormat !== 'ico'

  return (
    <Modal
      open={open}
      title={modalTitle}
      onClose={() => {
        abortRef.current?.abort()
        onClose()
      }}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-3" data-testid="unified-export-modal">
        {/* Live Preview */}
        <div
          style={
            !isAnimationMode && stillFormat === 'jpeg'
              ? { backgroundColor: jpegBgColor }
              : getCheckerboardStyle(checkerDark, 10)
          }
          className="w-full h-44 border-2 border-[var(--border-pixel)] p-2.5 flex items-center justify-center overflow-hidden"
        >
          {previewUrl && (
            <img
              src={previewUrl}
              alt={safeBaseName}
              draggable={false}
              className="max-w-full max-h-full object-contain pixelated"
              data-testid="unified-export-preview-img"
            />
          )}
        </div>

        {/* Format Selector */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-[var(--text-secondary)] block">
            {t('exportFormatLabel')}
          </label>
          {isAnimationMode ? (
            <PixelSelect<AnimationExportFormat>
              value={animFormat}
              options={animFormatOptions}
              onChange={(fmt) => {
                setAnimFormat(fmt)
                setShareFallbackNotice(false)
              }}
              ariaLabel={t('exportFormatLabel')}
              className="w-full"
              testId="export-format-select"
            />
          ) : (
            <PixelSelect<StillExportFormat>
              value={stillFormat}
              options={stillFormatOptions}
              onChange={(fmt) => {
                setStillFormat(fmt)
                setShareFallbackNotice(false)
              }}
              ariaLabel={t('exportFormatLabel')}
              className="w-full"
              testId="export-format-select"
            />
          )}
        </div>

        {/* Size Summary */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div className="text-[10px] text-[var(--text-secondary)]">
              {t('exportOriginalSize')}
            </div>
            <div className="font-bold mt-0.5">
              {width} × {height} px
              {isAnimationMode && frames && frames.length >= 2
                ? ` (${frames.length}F)`
                : ''}
            </div>
          </div>
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            <div className="text-[10px] text-[var(--text-secondary)]">
              {t('exportOutputSize')}
            </div>
            <div
              className="font-bold text-[var(--accent-teal)] mt-0.5"
              data-testid="export-output-dimensions"
            >
              {activeFormat === 'aseprite'
                ? `${width} × ${height} px (.aseprite)`
                : activeFormat === 'ico'
                  ? `${Math.min(256, outWidth)} × ${Math.min(256, outHeight)} px (.ico)`
                  : activeFormat === 'spritesheet' && spriteSheetResult
                    ? `${spriteSheetResult.sheetWidth} × ${spriteSheetResult.sheetHeight} px`
                    : `${outWidth} × ${outHeight} px`}
            </div>
          </div>
        </div>

        {/* Scale Multiplier */}
        {showScaleSelector && (
          <div className="space-y-1">
            <label className="text-xs font-bold text-[var(--text-secondary)] block">
              {t('exportScaleMultiplier')}
            </label>
            <PixelSelect<number>
              value={selectedScale}
              options={scaleSelectOpts}
              onChange={setSelectedScale}
              ariaLabel={t('exportScaleMultiplier')}
              className="w-full"
              testId="export-scale-select"
            />
          </div>
        )}

        {/* Format-specific Notes & Controls */}
        {(activeFormat === 'svg' || activeFormat === 'svg-anim') && (
          <div
            className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-[11px] text-[var(--text-secondary)] leading-relaxed"
            data-testid="export-svg-note"
          >
            {t('exportSvgNote')}
          </div>
        )}

        {activeFormat === 'ico' && (
          <div
            className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-[11px] text-[var(--text-secondary)] leading-relaxed"
            data-testid="export-ico-note"
          >
            {t('exportIcoNote')}
          </div>
        )}

        {activeFormat === 'jpeg' && (
          <div className="flex items-center justify-between gap-2 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-xs">
            <span className="font-bold text-[var(--text-secondary)]">
              {t('exportJpegBgLabel')}
            </span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={jpegBgColor}
                onChange={(e) => setJpegBgColor(e.target.value)}
                className="w-8 h-8 border-2 border-[var(--border-pixel)] cursor-pointer bg-transparent"
                data-testid="export-jpeg-bg-input"
              />
              <span className="font-mono text-[11px] font-bold">
                {jpegBgColor.toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {activeFormat === 'png-zip' && (
          <div
            className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-[11px] text-[var(--text-secondary)] leading-relaxed"
            data-testid="export-zip-note"
          >
            {t('exportZipNote')}
          </div>
        )}

        {/* Metadata embedding toggle for PNG / GIF / PNG-ZIP */}
        {(activeFormat === 'png' ||
          activeFormat === 'gif' ||
          activeFormat === 'png-zip') && (
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1">
            <PixelCheckbox
              checked={embedMeta}
              onChange={setEmbedMeta}
              label={t('exportEmbedMetaLabel')}
              testId="export-embed-meta-checkbox"
            />
            <p className="text-[10px] text-[var(--text-secondary)] pl-6">
              {t('exportEmbedMetaHint')}
            </p>
          </div>
        )}

        {/* GIF-specific controls */}
        {isAnimationMode && animFormat === 'gif' && (
          <div className="space-y-2 p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-xs">
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { id: 'dither', label: t('gifAlphaDither') },
                  { id: 'matte', label: t('gifAlphaMatte') },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setGifAlphaMode(opt.id)}
                  className={`min-h-[34px] px-1.5 text-[11px] font-bold ${
                    gifAlphaMode === opt.id
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                  data-testid={`export-gif-alpha-${opt.id}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {gifAlphaMode === 'matte' && (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                  {t('gifMatteColorLabel')}
                </span>
                <input
                  type="color"
                  value={gifMatteColor}
                  onChange={(e) => setGifMatteColor(e.target.value)}
                  className="w-8 h-7 border-2 border-[var(--border-pixel)] cursor-pointer"
                />
              </div>
            )}
          </div>
        )}

        {/* Animation playback direction & loop (for GIF / Animated SVG / PNG ZIP) */}
        {isAnimationMode &&
          (animFormat === 'gif' ||
            animFormat === 'svg-anim' ||
            animFormat === 'png-zip') && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-xs">
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: 'forward', label: t('dirForward') },
                    { id: 'reverse', label: t('dirReverse') },
                    { id: 'pingpong', label: t('dirPingpong') },
                  ] as const
                ).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDirection(d.id)}
                    className={`min-h-[30px] px-2 text-[11px] font-bold ${
                      direction === d.id
                        ? 'pixel-btn pixel-btn-active'
                        : 'pixel-btn'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {animFormat !== 'png-zip' && (
                <PixelCheckbox
                  checked={loop}
                  onChange={setLoop}
                  label={t('loopPlaybackLabel')}
                  testId="export-loop-checkbox"
                />
              )}
            </div>
          )}

        {/* Sprite Sheet controls when animFormat === 'spritesheet' */}
        {isAnimationMode && animFormat === 'spritesheet' && (
          <div className="space-y-2 p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] text-xs">
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
                  onClick={() => setSheetLayout(opt.id)}
                  className={`min-h-[34px] px-2 text-[11px] font-bold ${
                    sheetLayout === opt.id
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {sheetLayout === 'grid' && (
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-secondary)] block mb-1">
                    {t('spriteSheetColumns')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={sheetColumns}
                    onChange={(e) =>
                      setSheetColumns(
                        Math.max(1, Math.min(64, Number(e.target.value) || 1))
                      )
                    }
                    className="w-full min-h-[32px] px-2 text-xs font-mono font-bold pixel-input"
                  />
                </div>
              )}
              <div>
                <label className="text-[10px] font-bold text-[var(--text-secondary)] block mb-1">
                  {t('spriteSheetSpacing')}
                </label>
                <input
                  type="number"
                  min={0}
                  max={64}
                  value={sheetSpacing}
                  onChange={(e) =>
                    setSheetSpacing(
                      Math.max(0, Math.min(64, Number(e.target.value) || 0))
                    )
                  }
                  className="w-full min-h-[32px] px-2 text-xs font-mono font-bold pixel-input"
                />
              </div>
            </div>
          </div>
        )}

        {shareFallbackNotice && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-xs text-[var(--text-primary)]"
            data-testid="export-share-fallback-notice"
          >
            {t('shareUnsupportedFallback')}
          </div>
        )}

        {/* Primary Download + Share Actions */}
        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button
            type="button"
            disabled={encoding}
            onClick={() => void handleDownload()}
            className="min-h-[46px] px-3 pixel-btn pixel-btn-active text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5"
            data-testid="unified-export-download-btn"
          >
            <PixelIcon name="download" size={16} />
            <span>{t('exportSaveFileBtn')}</span>
          </button>

          <button
            type="button"
            disabled={encoding}
            onClick={() => void handleShare()}
            className="min-h-[46px] px-3 pixel-btn pixel-btn-teal text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5"
            data-testid="unified-export-share-btn"
          >
            <PixelIcon name="share" size={16} />
            <span>{t('exportShareFileBtn')}</span>
          </button>
        </div>

        {/* Extra JSON metadata button when Sprite Sheet format is selected */}
        {isAnimationMode && animFormat === 'spritesheet' && (
          <button
            type="button"
            onClick={handleDownloadSpriteJson}
            className="w-full min-h-[38px] px-3 pixel-btn text-xs font-bold flex items-center justify-center gap-1.5"
            data-testid="unified-export-sprite-json-btn"
          >
            <PixelIcon name="sheet" size={14} />
            <span>{t('spriteSheetDownloadJson')}</span>
          </button>
        )}
      </div>
    </Modal>
  )
}
