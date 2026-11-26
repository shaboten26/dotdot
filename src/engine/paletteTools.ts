import {
  TRANSPARENT_COLOR_INDEX,
  type CelBufferRuntime,
  type CelMap,
  type FrameMeta,
  type LayerMeta,
  type LayerRuntime,
  type PixelPatch,
  type ProjectPalette,
} from '../types'
import { hexToRgba, normalizeHex, rgbaToHex } from './color'
import { compositeLayers } from './compositor'
import { makeCellKey, projectFrameLayers } from './animation'
import { createLayerPixelPatch } from './history'

export type PaletteSortMode =
  | 'lightness-asc'
  | 'lightness-desc'
  | 'hue'
  | 'saturation-desc'

export interface LabColor {
  L: number // 0..100 perceptual lightness
  a: number
  b: number
  chroma: number // sqrt(a^2 + b^2)
  hueDeg: number // 0..360
}

function srgbChannelToLinear(c255: number): number {
  const s = Math.max(0, Math.min(255, c255)) / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function labF(t: number): number {
  const delta = 6 / 29
  return t > delta * delta * delta
    ? Math.cbrt(t)
    : t / (3 * delta * delta) + 4 / 29
}

/**
 * Convert `#RRGGBB` sRGB hex into perceptual CIELAB (`L*a*b*`, D65 white point).
 */
export function hexToCielab(hex: string): LabColor {
  const { r, g, b } = hexToRgba(hex)
  const lr = srgbChannelToLinear(r)
  const lg = srgbChannelToLinear(g)
  const lb = srgbChannelToLinear(b)

  // sRGB -> XYZ (D65)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / 1.0
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883

  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)

  const L = 116 * fy - 16
  const aVal = 500 * (fx - fy)
  const bVal = 200 * (fy - fz)
  const chroma = Math.hypot(aVal, bVal)
  let hueDeg = (Math.atan2(bVal, aVal) * 180) / Math.PI
  if (hueDeg < 0) hueDeg += 360

  return { L, a: aVal, b: bVal, chroma, hueDeg }
}

export interface SortedPaletteResult {
  palette: ProjectPalette
  nextSelectedIndex: number
}

/**
 * Sort `palette.colors` perceptually without altering any canvas pixels.
 * - Leftmost Transparent Slot (`TRANSPARENT_COLOR_INDEX = -1`) stays untouched at `-1`.
 * - Active selected color index tracks its original swatch to its new position.
 * - Snapshots `originalColors` before the first sort so "元の順番へ戻す" restores the pre-sort order.
 */
export function sortProjectPalette(
  palette: ProjectPalette,
  selectedColorIndex: number,
  mode: PaletteSortMode
): SortedPaletteResult {
  if (palette.colors.length <= 1) {
    return { palette, nextSelectedIndex: selectedColorIndex }
  }

  const originalColors =
    palette.originalColors && palette.originalColors.length > 0
      ? [...palette.originalColors]
      : [...palette.colors]

  const indexed = palette.colors.map((hex, origIdx) => ({
    hex,
    origIdx,
    lab: hexToCielab(hex),
  }))

  indexed.sort((p, q) => {
    if (mode === 'lightness-asc') {
      if (Math.abs(p.lab.L - q.lab.L) > 1e-4) return p.lab.L - q.lab.L
      return p.origIdx - q.origIdx
    }
    if (mode === 'lightness-desc') {
      if (Math.abs(q.lab.L - p.lab.L) > 1e-4) return q.lab.L - p.lab.L
      return p.origIdx - q.origIdx
    }
    if (mode === 'hue') {
      // Group near-achromatic grays (`chroma < 4.5`) first sorted by lightness, then chromatic hues 0..360°
      const pGray = p.lab.chroma < 4.5
      const qGray = q.lab.chroma < 4.5
      if (pGray !== qGray) return pGray ? -1 : 1
      if (pGray && qGray) {
        return p.lab.L - q.lab.L || p.origIdx - q.origIdx
      }
      if (Math.abs(p.lab.hueDeg - q.lab.hueDeg) > 1e-3) {
        return p.lab.hueDeg - q.lab.hueDeg
      }
      return q.lab.L - p.lab.L || p.origIdx - q.origIdx
    }
    // 'saturation-desc' (perceptual CIELAB chroma descending, tie-broken by lightness)
    if (Math.abs(q.lab.chroma - p.lab.chroma) > 1e-4) {
      return q.lab.chroma - p.lab.chroma
    }
    return q.lab.L - p.lab.L || p.origIdx - q.origIdx
  })

  const nextColors = indexed.map((item) => item.hex)
  let nextSelectedIndex = selectedColorIndex
  if (selectedColorIndex !== TRANSPARENT_COLOR_INDEX && selectedColorIndex >= 0) {
    const movedPos = indexed.findIndex((item) => item.origIdx === selectedColorIndex)
    if (movedPos >= 0) {
      nextSelectedIndex = movedPos
    }
  }

  return {
    palette: {
      ...palette,
      colors: nextColors,
      originalColors,
    },
    nextSelectedIndex,
  }
}

/**
 * Restore `palette.colors` back to `palette.originalColors` (preserving any newly added colors at the end
 * and omitting any colors deleted since the snapshot).
 */
export function restorePaletteOriginalOrder(
  palette: ProjectPalette,
  selectedColorIndex: number
): SortedPaletteResult | null {
  if (!palette.originalColors || palette.originalColors.length === 0) {
    return null
  }

  const selectedHex =
    selectedColorIndex >= 0 ? palette.colors[selectedColorIndex]?.toUpperCase() : null

  // Count occurrences in current palette (handles potential duplicate hexes gracefully)
  const remainingCounts = new Map<string, string[]>()
  for (const hex of palette.colors) {
    const key = hex.toUpperCase()
    const bucket = remainingCounts.get(key) ?? []
    bucket.push(hex)
    remainingCounts.set(key, bucket)
  }

  const restored: string[] = []
  for (const origHex of palette.originalColors) {
    const key = origHex.toUpperCase()
    const bucket = remainingCounts.get(key)
    if (bucket && bucket.length > 0) {
      restored.push(bucket.shift()!)
    }
  }
  // Append any colors added after `originalColors` was snapshotted
  for (const hex of palette.colors) {
    const key = hex.toUpperCase()
    const bucket = remainingCounts.get(key)
    if (bucket && bucket.length > 0) {
      restored.push(bucket.shift()!)
    }
  }

  let nextSelectedIndex = selectedColorIndex
  if (selectedColorIndex !== TRANSPARENT_COLOR_INDEX && selectedHex) {
    const idx = restored.findIndex((c) => c.toUpperCase() === selectedHex)
    if (idx >= 0) nextSelectedIndex = idx
  }

  const { originalColors: _cleared, ...restPalette } = palette
  return {
    palette: {
      ...restPalette,
      colors: restored,
    },
    nextSelectedIndex,
  }
}

export interface ColorUsageEntry {
  hex: string // '#RRGGBB' uppercase
  pixelCount: number
  /** Share of opaque pixels (`0..100`) */
  opaqueRatioPercent: number
  /** Share of total canvas pixels (`0..100`) */
  canvasRatioPercent: number
  /** Matching index in `palette.colors`, or `-1` if painted via layer blend / imported PNG outside current palette */
  paletteIndex: number
}

export interface ArtworkColorAnalysis {
  totalCanvasPixels: number
  opaquePixels: number
  transparentPixels: number
  usedColorCount: number
  entries: ColorUsageEntry[]
  unusedPaletteColors: Array<{ index: number; hex: string }>
}

/**
 * Read-only color usage analysis on either the visible composite or a specific layer.
 * Never modifies pixel buffers or palettes.
 */
export function analyzeArtworkColors(params: {
  width: number
  height: number
  layers: readonly LayerRuntime[]
  paletteColors: readonly string[]
  targetLayerId?: string | 'composite'
}): ArtworkColorAnalysis {
  const {
    width,
    height,
    layers,
    paletteColors,
    targetLayerId = 'composite',
  } = params

  let sampleBuffer: Uint8ClampedArray
  if (targetLayerId !== 'composite') {
    const found = layers.find((l) => l.id === targetLayerId)
    sampleBuffer = found
      ? compositeLayers([{ ...found, visible: true, opacity: 100, blendMode: 'normal', clipping: false }], width, height)
      : new Uint8ClampedArray(width * height * 4)
  } else {
    sampleBuffer = compositeLayers(layers, width, height)
  }

  const totalCanvasPixels = width * height
  let opaquePixels = 0
  let transparentPixels = 0
  const counts = new Map<string, number>()

  for (let i = 0; i < sampleBuffer.length; i += 4) {
    const a = sampleBuffer[i + 3]!
    if (a === 0) {
      transparentPixels++
      continue
    }
    opaquePixels++
    const hex = rgbaToHex({
      r: sampleBuffer[i]!,
      g: sampleBuffer[i + 1]!,
      b: sampleBuffer[i + 2]!,
    }).toUpperCase()
    counts.set(hex, (counts.get(hex) ?? 0) + 1)
  }

  const paletteLookup = new Map<string, number>()
  paletteColors.forEach((c, idx) => {
    const key = c.toUpperCase()
    if (!paletteLookup.has(key)) {
      paletteLookup.set(key, idx)
    }
  })

  const entries: ColorUsageEntry[] = Array.from(counts.entries())
    .map(([hex, pixelCount]) => ({
      hex,
      pixelCount,
      opaqueRatioPercent:
        opaquePixels > 0 ? Math.round((pixelCount / opaquePixels) * 1000) / 10 : 0,
      canvasRatioPercent:
        totalCanvasPixels > 0
          ? Math.round((pixelCount / totalCanvasPixels) * 1000) / 10
          : 0,
      paletteIndex: paletteLookup.get(hex) ?? -1,
    }))
    .sort((a, b) => b.pixelCount - a.pixelCount || a.hex.localeCompare(b.hex))

  const usedHexSet = new Set(counts.keys())
  const unusedPaletteColors: Array<{ index: number; hex: string }> = []
  paletteColors.forEach((c, index) => {
    const norm = c.toUpperCase()
    if (!usedHexSet.has(norm)) {
      unusedPaletteColors.push({ index, hex: norm })
    }
  })

  return {
    totalCanvasPixels,
    opaquePixels,
    transparentPixels,
    usedColorCount: entries.length,
    entries,
    unusedPaletteColors,
  }
}

export interface ReplaceColorParams {
  sourceHex: string
  /** Target `#RRGGBB` or `'transparent'` to erase matching pixels to alpha 0 */
  targetHexOrTransparent: string | 'transparent'
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  activeFrameId: string
  canvasWidth: number
  canvasHeight: number
  /** `'all'` replaces across all layers & frames; `'active-layer'` restricts to `targetLayerId` */
  layerScope?: 'all' | 'active-layer'
  targetLayerId?: string
  frameScope?: 'all-frames' | 'active-frame'
}

export interface ReplaceColorResult {
  replacedPixelCount: number
  affectedCelCount: number
  nextCelBuffers: Record<string, CelBufferRuntime>
  nextActiveLayers: LayerRuntime[]
  pixelPatches: PixelPatch[]
}

/**
 * Replace `sourceHex` with `targetHexOrTransparent` while strictly preserving Linked Cels (`celId` sharing):
 * - Deduplicates target `celId`s so shared linked cels are modified once in-place without unlinking!
 * - Produces sparse `PixelPatch[]` with `celId` so a single Undo/Redo restores every frame & linked cel atomically.
 */
export function replaceColorAcrossTimeline(
  params: ReplaceColorParams
): ReplaceColorResult {
  const {
    sourceHex,
    targetHexOrTransparent,
    layerMetas,
    frames,
    cels,
    celBuffers,
    activeFrameId,
    canvasWidth,
    canvasHeight,
    layerScope = 'all',
    targetLayerId,
    frameScope = 'all-frames',
  } = params

  const normSrc = normalizeHex(sourceHex)
  if (!normSrc) {
    return {
      replacedPixelCount: 0,
      affectedCelCount: 0,
      nextCelBuffers: { ...celBuffers },
      nextActiveLayers: projectFrameLayers(
        layerMetas,
        cels,
        celBuffers,
        activeFrameId,
        canvasWidth,
        canvasHeight
      ),
      pixelPatches: [],
    }
  }

  const srcRgba = hexToRgba(normSrc)
  const dstRgba =
    targetHexOrTransparent === 'transparent'
      ? { r: 0, g: 0, b: 0, a: 0 }
      : hexToRgba(normalizeHex(targetHexOrTransparent) ?? normSrc, 255)

  if (
    dstRgba.a > 0 &&
    srcRgba.r === dstRgba.r &&
    srcRgba.g === dstRgba.g &&
    srcRgba.b === dstRgba.b
  ) {
    return {
      replacedPixelCount: 0,
      affectedCelCount: 0,
      nextCelBuffers: { ...celBuffers },
      nextActiveLayers: projectFrameLayers(
        layerMetas,
        cels,
        celBuffers,
        activeFrameId,
        canvasWidth,
        canvasHeight
      ),
      pixelPatches: [],
    }
  }

  const targetLayers =
    layerScope === 'active-layer' && targetLayerId
      ? layerMetas.filter((l) => l.id === targetLayerId && !l.locked)
      : layerMetas.filter((l) => !l.locked)

  const targetFrames =
    frameScope === 'active-frame'
      ? frames.filter((f) => f.id === activeFrameId)
      : frames

  // Collect unique `(celId -> representative layerId)` pairs so linked cels are processed once!
  const targetCelMap = new Map<string, string>()
  for (const layer of targetLayers) {
    for (const frame of targetFrames) {
      const ref = cels[makeCellKey(layer.id, frame.id)]
      if (ref?.kind === 'cel' && celBuffers[ref.celId] && !targetCelMap.has(ref.celId)) {
        targetCelMap.set(ref.celId, layer.id)
      }
    }
  }

  const nextCelBuffers: Record<string, CelBufferRuntime> = { ...celBuffers }
  const pixelPatches: PixelPatch[] = []
  let replacedPixelCount = 0
  let affectedCelCount = 0

  for (const [celId, ownerLayerId] of targetCelMap.entries()) {
    const origCel = celBuffers[celId]!
    const nextData = new Uint8ClampedArray(origCel.data)
    let celChangedCount = 0

    for (let i = 0; i < nextData.length; i += 4) {
      const a = nextData[i + 3]!
      if (a === 0) continue
      if (
        nextData[i] === srcRgba.r &&
        nextData[i + 1] === srcRgba.g &&
        nextData[i + 2] === srcRgba.b
      ) {
        if (dstRgba.a === 0) {
          nextData[i] = 0
          nextData[i + 1] = 0
          nextData[i + 2] = 0
          nextData[i + 3] = 0
        } else {
          nextData[i] = dstRgba.r
          nextData[i + 1] = dstRgba.g
          nextData[i + 2] = dstRgba.b
          // Preserve existing non-zero alpha (255 in standard pixel art)
        }
        celChangedCount++
      }
    }

    if (celChangedCount > 0) {
      affectedCelCount++
      replacedPixelCount += celChangedCount
      const dummyBefore: LayerRuntime = {
        id: ownerLayerId,
        name: '',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: origCel.offsetX,
        offsetY: origCel.offsetY,
        dataWidth: origCel.dataWidth,
        dataHeight: origCel.dataHeight,
        data: origCel.data,
      }
      const dummyAfter: LayerRuntime = {
        ...dummyBefore,
        data: nextData,
      }
      const diff = createLayerPixelPatch(dummyBefore, dummyAfter)
      if (diff) {
        pixelPatches.push({
          ...diff,
          celId,
        })
      }
      nextCelBuffers[celId] = {
        ...origCel,
        data: nextData,
      }
    }
  }

  const nextActiveLayers = projectFrameLayers(
    layerMetas,
    cels,
    nextCelBuffers,
    activeFrameId,
    canvasWidth,
    canvasHeight
  )

  return {
    replacedPixelCount,
    affectedCelCount,
    nextCelBuffers,
    nextActiveLayers,
    pixelPatches,
  }
}
