import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  PlaybackDirection,
  ProjectPalette,
} from '../types'
import { computePlaybackFrameIndices, projectFrameLayers } from './animation'
import {
  compositeLayers,
  encodeRgbaToPng,
  MAX_EXPORT_DIMENSION,
  upscaleNearestNeighbor,
} from './compositor'

export type SpriteSheetLayout = 'horizontal' | 'vertical' | 'grid'

export interface SpriteSheetExportOptions {
  projectName: string
  canvasWidth: number
  canvasHeight: number
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  palette?: ProjectPalette
  layout: SpriteSheetLayout
  /** Number of columns when `layout === 'grid'` (`>= 1`) */
  columns?: number
  /** Inner spacing between frames in 1x canvas pixel units (`0..64`) */
  spacing?: number
  /** Outer margin around the sheet in 1x canvas pixel units (`0..64`) */
  margin?: number
  /** Integer nearest-neighbor scale (`1..32`) */
  scale?: number
  /** `'visible'` = composite all visible layers (default); otherwise a specific `layerId` */
  layerFilter?: 'visible' | string
  /** Optional 1-based inclusive range `[startFrame, endFrame]` */
  frameRange?: { from: number; to: number } | null
  direction?: PlaybackDirection
}

export interface SpriteSheetFrameEntry {
  index: number
  /** 1-based frame number in the source timeline */
  sourceFrameNumber: number
  sourceFrameId: string
  x: number
  y: number
  w: number
  h: number
  durationMs: number
}

export interface SpriteSheetJsonMetadata {
  /** Aseprite JSON Array compatible `frames` array for direct Unity / Godot / Phaser / PixiJS import */
  frames: Array<{
    filename: string
    frame: { x: number; y: number; w: number; h: number }
    rotated: boolean
    trimmed: boolean
    spriteSourceSize: { x: number; y: number; w: number; h: number }
    sourceSize: { w: number; h: number }
    duration: number
  }>
  meta: {
    app: 'dotdot'
    version: '2.5.0'
    image: string
    format: 'RGBA8888'
    size: { w: number; h: number }
    scale: string
  }
  dotdot: {
    projectName: string
    canvasSize: { w: number; h: number }
    sheetSize: { w: number; h: number }
    scale: number
    layerMode: 'visible-composite' | 'single-layer'
    layerName: string | null
    grid: {
      layout: SpriteSheetLayout
      columns: number
      rows: number
      spacingPx: number
      marginPx: number
    }
    frames: SpriteSheetFrameEntry[]
  }
}

export interface SpriteSheetExportResult {
  pngBytes: Uint8Array
  rgbaPreview: Uint8ClampedArray
  sheetWidth: number
  sheetHeight: number
  baseWidth: number
  baseHeight: number
  appliedScale: number
  columns: number
  rows: number
  frameCount: number
  metadata: SpriteSheetJsonMetadata
  metadataJsonText: string
}

/**
 * Render animation/still frames into a crisp nearest-neighbor PNG Sprite Sheet + JSON metadata.
 * Hidden layers are NEVER included in `'visible'` composite mode.
 */
export function generateSpriteSheet(
  options: SpriteSheetExportOptions
): SpriteSheetExportResult {
  const {
    projectName,
    canvasWidth,
    canvasHeight,
    layerMetas,
    frames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    layout,
    columns: rawCols = 4,
    spacing: rawSpacing = 0,
    margin: rawMargin = 0,
    scale: rawScale = 1,
    layerFilter = 'visible',
    frameRange = null,
    direction = 'forward',
  } = options

  const totalSourceFrames = Math.max(1, frames.length)
  let fromIdx = 0
  let toIdx = totalSourceFrames - 1
  if (frameRange) {
    const a = Math.max(1, Math.min(totalSourceFrames, Math.round(frameRange.from))) - 1
    const b = Math.max(1, Math.min(totalSourceFrames, Math.round(frameRange.to))) - 1
    fromIdx = Math.min(a, b)
    toIdx = Math.max(a, b)
  }

  const slicedIndices: number[] = []
  for (let i = fromIdx; i <= toIdx; i++) {
    slicedIndices.push(i)
  }

  const playbackRelIndices =
    slicedIndices.length <= 1
      ? [0]
      : computePlaybackFrameIndices(slicedIndices.length, direction, false)
  const orderedSourceIndices = playbackRelIndices.map((ri) => slicedIndices[ri]!)

  const frameCount = Math.max(1, orderedSourceIndices.length)
  const cols =
    layout === 'horizontal'
      ? frameCount
      : layout === 'vertical'
        ? 1
        : Math.max(1, Math.min(frameCount, Math.round(rawCols || 1)))
  const rows = Math.max(1, Math.ceil(frameCount / cols))

  const spacing1x = Math.max(0, Math.min(64, Math.round(rawSpacing || 0)))
  const margin1x = Math.max(0, Math.min(64, Math.round(rawMargin || 0)))

  const baseSheetW =
    margin1x * 2 + cols * canvasWidth + Math.max(0, cols - 1) * spacing1x
  const baseSheetH =
    margin1x * 2 + rows * canvasHeight + Math.max(0, rows - 1) * spacing1x

  const maxAllowedScale = Math.max(
    1,
    Math.floor(MAX_EXPORT_DIMENSION / Math.max(1, baseSheetW, baseSheetH))
  )
  const appliedScale = Math.max(
    1,
    Math.min(32, maxAllowedScale, Math.round(rawScale || 1))
  )

  const sheet1x = new Uint8ClampedArray(baseSheetW * baseSheetH * 4)
  const targetSingleLayerMeta =
    layerFilter !== 'visible'
      ? layerMetas.find((l) => l.id === layerFilter) ?? null
      : null

  const frameEntries: SpriteSheetFrameEntry[] = []
  const asepriteFrames: SpriteSheetJsonMetadata['frames'] = []
  const safeBaseName =
    (projectName || 'spritesheet')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-') || 'spritesheet'

  for (let outIdx = 0; outIdx < frameCount; outIdx++) {
    const srcIdx = orderedSourceIndices[outIdx]!
    const frameMeta = frames[srcIdx]
    const durationMs = frameMeta?.durationMs ?? 100

    let projectedLayers: LayerRuntime[]
    if (frameMeta && Object.keys(cels).length > 0) {
      projectedLayers = projectFrameLayers(
        layerMetas,
        cels,
        celBuffers,
        frameMeta.id,
        canvasWidth,
        canvasHeight
      )
    } else if (fallbackSingleFrameLayers && fallbackSingleFrameLayers.length > 0) {
      projectedLayers = [...fallbackSingleFrameLayers]
    } else {
      projectedLayers = []
    }

    let layersToComposite: LayerRuntime[]
    if (targetSingleLayerMeta) {
      const targetRuntime = projectedLayers.find(
        (l) => l.id === targetSingleLayerMeta.id
      )
      layersToComposite = targetRuntime
        ? [
            {
              ...targetRuntime,
              visible: true,
              clipping: false,
            },
          ]
        : []
    } else {
      // Strictly composite visible layers only (hidden layers are NEVER included!)
      layersToComposite = projectedLayers.filter((l) => l.visible)
    }

    const frameRgba = compositeLayers(layersToComposite, canvasWidth, canvasHeight, {
      palette: options.palette,
    })

    const col = outIdx % cols
    const row = Math.floor(outIdx / cols)
    const dstX1x = margin1x + col * (canvasWidth + spacing1x)
    const dstY1x = margin1x + row * (canvasHeight + spacing1x)

    for (let fy = 0; fy < canvasHeight; fy++) {
      const srcRowOff = fy * canvasWidth * 4
      const dstRowOff = ((dstY1x + fy) * baseSheetW + dstX1x) * 4
      sheet1x.set(
        frameRgba.subarray(srcRowOff, srcRowOff + canvasWidth * 4),
        dstRowOff
      )
    }

    const scaledX = dstX1x * appliedScale
    const scaledY = dstY1x * appliedScale
    const scaledW = canvasWidth * appliedScale
    const scaledH = canvasHeight * appliedScale

    frameEntries.push({
      index: outIdx,
      sourceFrameNumber: srcIdx + 1,
      sourceFrameId: frameMeta?.id ?? `frame-${srcIdx + 1}`,
      x: scaledX,
      y: scaledY,
      w: scaledW,
      h: scaledH,
      durationMs,
    })

    asepriteFrames.push({
      filename: `${safeBaseName} #${outIdx}`,
      frame: { x: scaledX, y: scaledY, w: scaledW, h: scaledH },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: scaledW, h: scaledH },
      sourceSize: { w: scaledW, h: scaledH },
      duration: durationMs,
    })
  }

  const scaled = upscaleNearestNeighbor(
    sheet1x,
    baseSheetW,
    baseSheetH,
    appliedScale
  )
  const pngBytes = encodeRgbaToPng(scaled.data, scaled.width, scaled.height)

  const metadata: SpriteSheetJsonMetadata = {
    frames: asepriteFrames,
    meta: {
      app: 'dotdot',
      version: '2.5.0',
      image: `${safeBaseName}-sheet.png`,
      format: 'RGBA8888',
      size: { w: scaled.width, h: scaled.height },
      scale: String(appliedScale),
    },
    dotdot: {
      projectName: projectName.trim() || 'Untitled',
      canvasSize: { w: canvasWidth, h: canvasHeight },
      sheetSize: { w: scaled.width, h: scaled.height },
      scale: appliedScale,
      layerMode: targetSingleLayerMeta ? 'single-layer' : 'visible-composite',
      layerName: targetSingleLayerMeta ? targetSingleLayerMeta.name : null,
      grid: {
        layout,
        columns: cols,
        rows,
        spacingPx: spacing1x * appliedScale,
        marginPx: margin1x * appliedScale,
      },
      frames: frameEntries,
    },
  }

  return {
    pngBytes,
    rgbaPreview: scaled.data,
    sheetWidth: scaled.width,
    sheetHeight: scaled.height,
    baseWidth: baseSheetW,
    baseHeight: baseSheetH,
    appliedScale,
    columns: cols,
    rows,
    frameCount,
    metadata,
    metadataJsonText: JSON.stringify(metadata, null, 2),
  }
}
