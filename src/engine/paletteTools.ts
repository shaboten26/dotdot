import {
  TRANSPARENT_COLOR_INDEX,
  TRANSPARENT_INDEX,
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
import {
  addColorToIndexedPalette,
  displaySlotToPixelIndex,
  findExactFixedIndex,
  normalizeProjectPalette,
  removeFixedIndexFromPalette,
} from './indexedPalette'

export type PaletteSortMode =
  | 'lightness-asc'
  | 'lightness-desc'
  | 'hue'
  | 'saturation-desc'

export interface LabColor {
  L: number
  a: number
  b: number
  chroma: number
  hueDeg: number
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

export function hexToCielab(hex: string): LabColor {
  const { r, g, b } = hexToRgba(hex)
  const lr = srgbChannelToLinear(r)
  const lg = srgbChannelToLinear(g)
  const lb = srgbChannelToLinear(b)

  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb)
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
 * Sort ONLY `palette.displayOrder` (& `palette.colors`) perceptually in CIELAB space
 * WITHOUT changing `palette.colorTable` fixed indices (`0..254`) or any pixel buffers (Section 7-2 & 10)!
 */
export function sortProjectPalette(
  palette: ProjectPalette,
  selectedColorIndex: number,
  mode: PaletteSortMode
): SortedPaletteResult {
  const norm = normalizeProjectPalette(palette)
  if (norm.displayOrder!.length <= 1) {
    return { palette: norm, nextSelectedIndex: selectedColorIndex }
  }

  const originalDisplayOrder =
    norm.originalDisplayOrder && norm.originalDisplayOrder.length > 0
      ? [...norm.originalDisplayOrder]
      : [...norm.displayOrder!]

  const originalColors =
    norm.originalColors && norm.originalColors.length > 0
      ? [...norm.originalColors]
      : [...norm.colors]

  const selectedFixed =
    selectedColorIndex !== TRANSPARENT_COLOR_INDEX &&
    selectedColorIndex >= 0 &&
    selectedColorIndex < norm.displayOrder!.length
      ? norm.displayOrder![selectedColorIndex]
      : null

  const items = norm.displayOrder!.map((fixedIdx, displayPos) => {
    const hex = norm.colorTable![fixedIdx]!
    return {
      fixedIdx,
      hex,
      displayPos,
      lab: hexToCielab(hex),
    }
  })

  items.sort((p, q) => {
    if (mode === 'lightness-asc') {
      if (Math.abs(p.lab.L - q.lab.L) > 1e-4) return p.lab.L - q.lab.L
      return p.displayPos - q.displayPos
    }
    if (mode === 'lightness-desc') {
      if (Math.abs(q.lab.L - p.lab.L) > 1e-4) return q.lab.L - p.lab.L
      return p.displayPos - q.displayPos
    }
    if (mode === 'hue') {
      const pGray = p.lab.chroma < 4.5
      const qGray = q.lab.chroma < 4.5
      if (pGray !== qGray) return pGray ? -1 : 1
      if (pGray && qGray) {
        return p.lab.L - q.lab.L || p.displayPos - q.displayPos
      }
      if (Math.abs(p.lab.hueDeg - q.lab.hueDeg) > 1e-3) {
        return p.lab.hueDeg - q.lab.hueDeg
      }
      return q.lab.L - p.lab.L || p.displayPos - q.displayPos
    }
    if (Math.abs(q.lab.chroma - p.lab.chroma) > 1e-4) {
      return q.lab.chroma - p.lab.chroma
    }
    return q.lab.L - p.lab.L || p.displayPos - q.displayPos
  })

  const nextDisplayOrder = items.map((it) => it.fixedIdx)
  const nextColors = nextDisplayOrder.map((idx) => norm.colorTable![idx]!)

  let nextSelectedIndex = selectedColorIndex
  if (selectedFixed !== null && selectedFixed !== undefined) {
    const movedPos = nextDisplayOrder.indexOf(selectedFixed)
    if (movedPos >= 0) nextSelectedIndex = movedPos
  }

  return {
    palette: {
      ...norm,
      displayOrder: nextDisplayOrder,
      colors: nextColors,
      originalDisplayOrder,
      originalColors,
    },
    nextSelectedIndex,
  }
}

/**
 * Restore `palette.displayOrder` (& `palette.colors`) back to `originalDisplayOrder`
 * WITHOUT changing `colorTable` or any pixel indices!
 */
export function restorePaletteOriginalOrder(
  palette: ProjectPalette,
  selectedColorIndex: number
): SortedPaletteResult | null {
  const norm = normalizeProjectPalette(palette)
  if (
    (!norm.originalDisplayOrder || norm.originalDisplayOrder.length === 0) &&
    (!norm.originalColors || norm.originalColors.length === 0)
  ) {
    return null
  }

  const selectedFixed =
    selectedColorIndex !== TRANSPARENT_COLOR_INDEX &&
    selectedColorIndex >= 0 &&
    selectedColorIndex < norm.displayOrder!.length
      ? norm.displayOrder![selectedColorIndex]
      : null

  const activeSet = new Set(norm.displayOrder!)
  const restoredOrder: number[] = []
  const placed = new Set<number>()

  if (norm.originalDisplayOrder && norm.originalDisplayOrder.length > 0) {
    for (const fixedIdx of norm.originalDisplayOrder) {
      if (activeSet.has(fixedIdx) && !placed.has(fixedIdx)) {
        placed.add(fixedIdx)
        restoredOrder.push(fixedIdx)
      }
    }
  } else if (norm.originalColors) {
    for (const origHex of norm.originalColors) {
      const clean = normalizeHex(origHex)
      if (!clean) continue
      const match = norm.displayOrder!.find(
        (idx) => !placed.has(idx) && norm.colorTable![idx] === clean
      )
      if (match !== undefined) {
        placed.add(match)
        restoredOrder.push(match)
      }
    }
  }

  for (const fixedIdx of norm.displayOrder!) {
    if (!placed.has(fixedIdx)) {
      placed.add(fixedIdx)
      restoredOrder.push(fixedIdx)
    }
  }

  const nextColors = restoredOrder.map((idx) => norm.colorTable![idx]!)
  let nextSelectedIndex = selectedColorIndex
  if (selectedFixed !== null && selectedFixed !== undefined) {
    const pos = restoredOrder.indexOf(selectedFixed)
    if (pos >= 0) nextSelectedIndex = pos
  }

  const {
    originalDisplayOrder: _dropOrder,
    originalColors: _dropColors,
    ...restPalette
  } = norm

  return {
    palette: {
      ...restPalette,
      displayOrder: restoredOrder,
      colors: nextColors,
    },
    nextSelectedIndex,
  }
}

export interface ColorUsageEntry {
  hex: string
  pixelCount: number
  opaqueRatioPercent: number
  canvasRatioPercent: number
  /** Current UI display slot (`0..colors.length-1`), or `-1` if blended composite color */
  paletteIndex: number
  /** Fixed palette index (`0..254`), or `-1` if blended composite color */
  fixedIndex?: number
}

export interface ArtworkColorAnalysis {
  totalCanvasPixels: number
  opaquePixels: number
  transparentPixels: number
  usedColorCount: number
  entries: ColorUsageEntry[]
  unusedPaletteColors: Array<{ index: number; fixedIndex: number; hex: string }>
}

export function analyzeArtworkColors(params: {
  width: number
  height: number
  layers: readonly LayerRuntime[]
  palette?: ProjectPalette
  paletteColors?: readonly string[]
  targetLayerId?: string | 'composite'
}): ArtworkColorAnalysis {
  const {
    width,
    height,
    layers,
    palette: rawPalette,
    paletteColors,
    targetLayerId = 'composite',
  } = params

  const normPalette = normalizeProjectPalette(
    rawPalette ?? {
      name: 'Palette',
      colors: paletteColors ? [...paletteColors] : ['#000000', '#FFFFFF'],
    }
  )

  let sampleBuffer: Uint8ClampedArray
  if (targetLayerId !== 'composite') {
    const found = layers.find((l) => l.id === targetLayerId)
    sampleBuffer = found
      ? compositeLayers(
          [{ ...found, visible: true, opacity: 100, blendMode: 'normal', clipping: false }],
          width,
          height,
          { palette: normPalette }
        )
      : new Uint8ClampedArray(width * height * 4)
  } else {
    sampleBuffer = compositeLayers(layers, width, height, { palette: normPalette })
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

  const displayLookup = new Map<string, { displayIdx: number; fixedIdx: number }>()
  normPalette.displayOrder!.forEach((fixedIdx, displayIdx) => {
    const hex = normPalette.colorTable![fixedIdx]!.toUpperCase()
    if (!displayLookup.has(hex)) {
      displayLookup.set(hex, { displayIdx, fixedIdx })
    }
  })

  const entries: ColorUsageEntry[] = Array.from(counts.entries())
    .map(([hex, pixelCount]) => {
      const info = displayLookup.get(hex)
      return {
        hex,
        pixelCount,
        opaqueRatioPercent:
          opaquePixels > 0 ? Math.round((pixelCount / opaquePixels) * 1000) / 10 : 0,
        canvasRatioPercent:
          totalCanvasPixels > 0
            ? Math.round((pixelCount / totalCanvasPixels) * 1000) / 10
            : 0,
        paletteIndex: info ? info.displayIdx : -1,
        fixedIndex: info ? info.fixedIdx : -1,
      }
    })
    .sort((a, b) => b.pixelCount - a.pixelCount || a.hex.localeCompare(b.hex))

  // Also check raw layer indices so colors referenced on layers under blend/opacity aren't falsely marked unused
  const usedFixedIndices = new Set<number>()
  const inspectLayers =
    targetLayerId !== 'composite'
      ? layers.filter((l) => l.id === targetLayerId)
      : layers.filter((l) => l.visible)
  for (const l of inspectLayers) {
    for (let i = 0; i < l.data.length; i++) {
      const v = l.data[i]!
      if (v !== TRANSPARENT_INDEX) usedFixedIndices.add(v)
    }
  }

  const usedHexSet = new Set(counts.keys())
  const unusedPaletteColors: Array<{ index: number; fixedIndex: number; hex: string }> = []
  normPalette.displayOrder!.forEach((fixedIndex, index) => {
    const hex = normPalette.colorTable![fixedIndex]!.toUpperCase()
    if (!usedHexSet.has(hex) && !usedFixedIndices.has(fixedIndex)) {
      unusedPaletteColors.push({ index, fixedIndex, hex })
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

/**
 * Count how many pixels across ALL referenced cel buffers (or fallback layers) in the project
 * currently reference `fixedIndex` (`0..254`). Used before deleting a palette color (Section 7-8).
 */
export function countFixedIndexUsageAcrossProject(params: {
  fixedIndex: number
  cels?: CelMap
  celBuffers?: Readonly<Record<string, CelBufferRuntime>>
  layers?: readonly LayerRuntime[]
}): { pixelCount: number; celCount: number } {
  const { fixedIndex, cels, celBuffers, layers } = params
  if (fixedIndex < 0 || fixedIndex >= TRANSPARENT_INDEX) {
    return { pixelCount: 0, celCount: 0 }
  }

  let pixelCount = 0
  let celCount = 0

  if (celBuffers && cels && Object.keys(celBuffers).length > 0) {
    const referencedIds = new Set<string>()
    for (const ref of Object.values(cels)) {
      if (ref?.kind === 'cel' && celBuffers[ref.celId]) {
        referencedIds.add(ref.celId)
      }
    }
    for (const celId of referencedIds) {
      const data = celBuffers[celId]!.data
      let hits = 0
      for (let i = 0; i < data.length; i++) {
        if (data[i] === fixedIndex) hits++
      }
      if (hits > 0) {
        celCount++
        pixelCount += hits
      }
    }
    return { pixelCount, celCount }
  }

  if (layers) {
    for (const l of layers) {
      let hits = 0
      for (let i = 0; i < l.data.length; i++) {
        if (l.data[i] === fixedIndex) hits++
      }
      if (hits > 0) {
        celCount++
        pixelCount += hits
      }
    }
  }
  return { pixelCount, celCount }
}

export interface ReplaceColorParams {
  /** Source `#RRGGBB` or explicit `sourceFixedIndex` (`0..254`) */
  sourceHex?: string
  sourceFixedIndex?: number
  /** Target `#RRGGBB`, `'transparent'`, or explicit `targetFixedIndex` */
  targetHexOrTransparent: string | 'transparent'
  targetFixedIndex?: number
  palette: ProjectPalette
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  activeFrameId: string
  canvasWidth: number
  canvasHeight: number
  layerScope?: 'all' | 'active-layer'
  targetLayerId?: string
  frameScope?: 'all-frames' | 'active-frame'
}

export interface ReplaceColorResult {
  replacedPixelCount: number
  affectedCelCount: number
  nextPalette: ProjectPalette
  nextCelBuffers: Record<string, CelBufferRuntime>
  nextActiveLayers: LayerRuntime[]
  pixelPatches: PixelPatch[]
}

/**
 * Replace a palette color (by `sourceFixedIndex` or `sourceHex`) with another palette color or `TRANSPARENT_INDEX (255)`
 * across unique `celId` buffers while preserving Linked Cel sharing and 1-step Undo/Redo!
 */
export function replaceColorAcrossTimeline(
  params: ReplaceColorParams
): ReplaceColorResult {
  const {
    sourceHex,
    sourceFixedIndex,
    targetHexOrTransparent,
    targetFixedIndex,
    palette: rawPalette,
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

  let workingPalette = normalizeProjectPalette(rawPalette)

  // Collect all fixed indices matching `sourceFixedIndex` or `sourceHex`
  const srcIndices = new Set<number>()
  if (typeof sourceFixedIndex === 'number' && sourceFixedIndex >= 0 && sourceFixedIndex < TRANSPARENT_INDEX) {
    srcIndices.add(sourceFixedIndex)
  } else if (sourceHex) {
    const normSrc = normalizeHex(sourceHex)
    if (normSrc) {
      for (const fIdx of workingPalette.displayOrder!) {
        if (workingPalette.colorTable![fIdx] === normSrc) {
          srcIndices.add(fIdx)
        }
      }
    }
  }

  if (srcIndices.size === 0) {
    return {
      replacedPixelCount: 0,
      affectedCelCount: 0,
      nextPalette: workingPalette,
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

  let dstIndex: number
  if (targetHexOrTransparent === 'transparent') {
    dstIndex = TRANSPARENT_INDEX
  } else if (
    typeof targetFixedIndex === 'number' &&
    targetFixedIndex >= 0 &&
    targetFixedIndex < TRANSPARENT_INDEX
  ) {
    dstIndex = targetFixedIndex
  } else {
    const normDst = normalizeHex(targetHexOrTransparent)
    if (!normDst) {
      return {
        replacedPixelCount: 0,
        affectedCelCount: 0,
        nextPalette: workingPalette,
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
    const existing = findExactFixedIndex(workingPalette, normDst)
    if (existing >= 0) {
      dstIndex = existing
    } else {
      const added = addColorToIndexedPalette(workingPalette, normDst)
      if (!added) {
        return {
          replacedPixelCount: 0,
          affectedCelCount: 0,
          nextPalette: workingPalette,
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
      workingPalette = added.palette
      dstIndex = added.fixedIndex
    }
  }

  if (srcIndices.size === 1 && srcIndices.has(dstIndex)) {
    return {
      replacedPixelCount: 0,
      affectedCelCount: 0,
      nextPalette: workingPalette,
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
    const nextData = new Uint8Array(origCel.data)
    let celChangedCount = 0

    for (let i = 0; i < nextData.length; i++) {
      if (srcIndices.has(nextData[i]!)) {
        nextData[i] = dstIndex
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
      const diff = createLayerPixelPatch(dummyBefore, dummyAfter, celId)
      if (diff) {
        pixelPatches.push(diff)
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
    nextPalette: workingPalette,
    nextCelBuffers,
    nextActiveLayers,
    pixelPatches,
  }
}

/**
 * Delete a palette display slot safely (Section 7-8):
 * - Replaces any referencing pixels across ALL unlocked & locked cels with `replacementDisplaySlot` or `'transparent'` (`255`)
 * - Removes the fixed index from `palette`
 * - Returns combined `pixelPatches` + `nextPalette` + `nextSelectedSlot` for 1-step atomic Undo/Redo!
 */
export function deletePaletteSlotWithReplacement(params: {
  palette: ProjectPalette
  deleteDisplaySlot: number
  selectedDisplaySlot: number
  replacementTarget: { kind: 'transparent' } | { kind: 'slot'; displaySlot: number }
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  activeFrameId: string
  canvasWidth: number
  canvasHeight: number
}): {
  nextPalette: ProjectPalette
  nextSelectedSlot: number
  nextCelBuffers: Record<string, CelBufferRuntime>
  nextActiveLayers: LayerRuntime[]
  pixelPatches: PixelPatch[]
  replacedPixelCount: number
} | null {
  const {
    palette,
    deleteDisplaySlot,
    selectedDisplaySlot,
    replacementTarget,
    layerMetas,
    frames,
    cels,
    celBuffers,
    activeFrameId,
    canvasWidth,
    canvasHeight,
  } = params

  const norm = normalizeProjectPalette(palette)
  if (
    deleteDisplaySlot < 0 ||
    deleteDisplaySlot >= norm.displayOrder!.length ||
    norm.displayOrder!.length <= 1
  ) {
    return null
  }

  const deleteFixed = displaySlotToPixelIndex(norm, deleteDisplaySlot)
  const dstFixed =
    replacementTarget.kind === 'transparent'
      ? TRANSPARENT_INDEX
      : displaySlotToPixelIndex(norm, replacementTarget.displaySlot)

  if (dstFixed === deleteFixed) return null

  // Replace across ALL cels (including locked layers, since the palette slot itself is being deleted!)
  const unlockedAllMetas = layerMetas.map((m) => ({ ...m, locked: false }))
  const replaced = replaceColorAcrossTimeline({
    sourceFixedIndex: deleteFixed,
    targetHexOrTransparent:
      replacementTarget.kind === 'transparent'
        ? 'transparent'
        : norm.colorTable![dstFixed] ?? '#000000',
    targetFixedIndex: dstFixed,
    palette: norm,
    layerMetas: unlockedAllMetas,
    frames,
    cels,
    celBuffers,
    activeFrameId,
    canvasWidth,
    canvasHeight,
    layerScope: 'all',
    frameScope: 'all-frames',
  })

  const removed = removeFixedIndexFromPalette(
    replaced.nextPalette,
    deleteFixed,
    selectedDisplaySlot
  )
  if (!removed) return null

  return {
    nextPalette: removed.palette,
    nextSelectedSlot: removed.nextSelectedSlot,
    nextCelBuffers: replaced.nextCelBuffers,
    nextActiveLayers: replaced.nextActiveLayers,
    pixelPatches: replaced.pixelPatches,
    replacedPixelCount: replaced.replacedPixelCount,
  }
}

// ==================== ADVANCED PIXEL-ART PALETTE GENERATORS & CLEANUP ====================

function linearToSrgbByte(lin: number): number {
  const c = Math.max(0, Math.min(1, lin))
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(s * 255)))
}

function labInvF(t: number): number {
  const delta = 6 / 29
  return t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29)
}

export function cielabToHex(L: number, a: number, b: number): string {
  const fy = (L + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200

  const x = 0.95047 * labInvF(fx)
  const y = 1.0 * labInvF(fy)
  const z = 1.08883 * labInvF(fz)

  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z

  return rgbaToHex({
    r: linearToSrgbByte(lr),
    g: linearToSrgbByte(lg),
    b: linearToSrgbByte(lb),
  })
}

/**
 * Generate `intermediateCount` perceptually even intermediate colors (CIELAB interpolation)
 * between `fromHex` and `toHex`! Ideal for pixel-art anti-aliasing and color ramps.
 */
export function generateIntermediateRampColors(
  fromHex: string,
  toHex: string,
  intermediateCount: number
): string[] {
  const n = Math.max(1, Math.min(12, Math.trunc(intermediateCount)))
  const startLab = hexToCielab(fromHex)
  const endLab = hexToCielab(toHex)
  const out: string[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1)
    const L = startLab.L + (endLab.L - startLab.L) * t
    const a = startLab.a + (endLab.a - startLab.a) * t
    const b = startLab.b + (endLab.b - startLab.b) * t
    out.push(cielabToHex(L, a, b))
  }
  return out
}

/**
 * Pixel-Art Hue-Shifted Shade / Highlight Generator:
 * - Darker shade (`shade`): lowers L while shifting hue slightly toward cool violet/indigo (`~255°`) for rich retro shadows!
 * - Lighter tint (`tint`): raises L while shifting hue slightly toward warm sunlight (`~65°`) for crisp highlights!
 */
export function generatePixelArtToneVariant(
  baseHex: string,
  kind: 'tint' | 'shade'
): string {
  const lab = hexToCielab(baseHex)
  if (kind === 'tint') {
    const nextL = Math.min(97, lab.L + Math.max(8, (100 - lab.L) * 0.28))
    const nextChroma = Math.max(0, lab.chroma * 0.88)
    const targetHue = 75 // warm golden light
    const diff = ((targetHue - lab.hueDeg + 540) % 360) - 180
    const nextHue = ((lab.hueDeg + diff * 0.16 + 360) % 360) * (Math.PI / 180)
    return cielabToHex(
      nextL,
      nextChroma * Math.cos(nextHue),
      nextChroma * Math.sin(nextHue)
    )
  }
  const nextL = Math.max(5, lab.L - Math.max(8, lab.L * 0.26))
  const nextChroma = Math.min(95, lab.chroma * 1.06 + (lab.chroma > 4 ? 2 : 0))
  const targetHue = 285 // cool plum/indigo shadow
  const diff = ((targetHue - lab.hueDeg + 540) % 360) - 180
  const nextHue = ((lab.hueDeg + diff * 0.18 + 360) % 360) * (Math.PI / 180)
  return cielabToHex(
    nextL,
    nextChroma * Math.cos(nextHue),
    nextChroma * Math.sin(nextHue)
  )
}

/**
 * Generate color-harmony companions (Complementary `+180°`, Triadic `+120°/-120°`, Analogous `+32°/-32°`) in CIELAB LCh space.
 */
export function generateColorHarmonyCompanions(
  baseHex: string,
  harmony: 'complementary' | 'triadic' | 'analogous'
): string[] {
  const lab = hexToCielab(baseHex)
  const effectiveChroma = Math.max(18, lab.chroma)
  const offsets =
    harmony === 'complementary'
      ? [180]
      : harmony === 'triadic'
        ? [120, 240]
        : [-32, 32]
  return offsets.map((deg) => {
    const rad = (((lab.hueDeg + deg) % 360 + 360) % 360) * (Math.PI / 180)
    return cielabToHex(
      Math.max(18, Math.min(88, lab.L)),
      effectiveChroma * Math.cos(rad),
      effectiveChroma * Math.sin(rad)
    )
  })
}

/**
 * Insert one or more new `#RRGGBB` colors into an indexed `ProjectPalette` right after `insertAfterDisplaySlot`
 * WITHOUT modifying any existing fixed index in `colorTable` (zero pixel mutation on canvas!).
 */
export function insertColorsIntoIndexedPalette(
  palette: ProjectPalette,
  hexList: readonly string[],
  insertAfterDisplaySlot?: number
): {
  palette: ProjectPalette
  addedCount: number
  lastDisplaySlot: number
} {
  let working = normalizeProjectPalette(palette)
  let insertPos =
    typeof insertAfterDisplaySlot === 'number' &&
    insertAfterDisplaySlot >= 0 &&
    insertAfterDisplaySlot < working.displayOrder!.length
      ? insertAfterDisplaySlot + 1
      : working.displayOrder!.length

  let addedCount = 0
  let lastSlot = Math.max(0, insertPos - 1)

  for (const rawHex of hexList) {
    const clean = normalizeHex(rawHex)
    if (!clean) continue
    const existingFixed = findExactFixedIndex(working, clean)
    if (existingFixed >= 0) {
      lastSlot = working.displayOrder!.indexOf(existingFixed)
      continue
    }
    const added = addColorToIndexedPalette(working, clean)
    if (!added) break

    // Move newly appended fixedIndex from end to `insertPos`
    const order = [...added.palette.displayOrder!]
    const popped = order.pop()!
    order.splice(insertPos, 0, popped)
    working = {
      ...added.palette,
      displayOrder: order,
      colors: order.map((idx) => added.palette.colorTable![idx]!),
    }
    lastSlot = insertPos
    insertPos++
    addedCount++
  }

  return {
    palette: working,
    addedCount,
    lastDisplaySlot: lastSlot,
  }
}

/**
 * Remove duplicate `#RRGGBB` slots or unused slots that have ZERO pixel references across the project
 * while keeping at least 1 color and preserving all used fixed indices verbatim!
 */
export function removeUnusedColorsFromIndexedPalette(params: {
  palette: ProjectPalette
  selectedDisplaySlot: number
  cels?: CelMap
  celBuffers?: Readonly<Record<string, CelBufferRuntime>>
  layers?: readonly LayerRuntime[]
}): {
  palette: ProjectPalette
  removedCount: number
  nextSelectedSlot: number
} {
  const norm = normalizeProjectPalette(params.palette)
  if (norm.displayOrder!.length <= 1) {
    return {
      palette: norm,
      removedCount: 0,
      nextSelectedSlot: params.selectedDisplaySlot,
    }
  }

  let working = norm
  let currentSelected = params.selectedDisplaySlot
  let removedCount = 0

  // Snapshot original fixed indices in reverse so removing doesn't shift earlier checks
  const candidates = [...norm.displayOrder!]
  for (const fixedIdx of candidates) {
    if (working.displayOrder!.length <= 1) break
    const usage = countFixedIndexUsageAcrossProject({
      fixedIndex: fixedIdx,
      cels: params.cels,
      celBuffers: params.celBuffers,
      layers: params.layers,
    })
    if (usage.pixelCount === 0) {
      const removed = removeFixedIndexFromPalette(
        working,
        fixedIdx,
        currentSelected
      )
      if (removed) {
        working = removed.palette
        currentSelected = removed.nextSelectedSlot
        removedCount++
      }
    }
  }

  return {
    palette: working,
    removedCount,
    nextSelectedSlot: currentSelected,
  }
}
