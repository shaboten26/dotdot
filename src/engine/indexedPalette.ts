import {
  MAX_OPAQUE_PALETTE_COLORS,
  TRANSPARENT_COLOR_INDEX,
  TRANSPARENT_INDEX,
  type ProjectPalette,
} from '../types'
import { hexToRgba, normalizeHex, rgbaToHex } from './color'

export { MAX_OPAQUE_PALETTE_COLORS, TRANSPARENT_INDEX }
export const PALETTE_TABLE_SIZE = 256

const BAYER_4X4: ReadonlyArray<number> = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]

export interface LabVec {
  L: number
  a: number
  b: number
}

function srgbToLinear(c255: number): number {
  const s = Math.max(0, Math.min(255, c255)) / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function labF(t: number): number {
  const d = 6 / 29
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29
}

export function rgbToLab(r: number, g: number, b: number): LabVec {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883
  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  }
}

export function labDistanceSq(p: LabVec, q: LabVec): number {
  const dL = p.L - q.L
  const da = p.a - q.a
  const db = p.b - q.b
  return dL * dL + da * da + db * db
}

/**
 * Normalize a `ProjectPalette` so that:
 * - `colorTable` is a length-255 array (`0..254`) mapping fixed index -> `'#RRGGBB'` or `null`
 * - `displayOrder` lists active fixed indices (`0..254`) in visual UI order (length `1..255`)
 * - `colors` mirrors `displayOrder.map(idx => colorTable[idx]!)` (max 255 opaque colors)
 * - Sorting / dragging ONLY reorders `displayOrder` & `colors` while keeping `colorTable` fixed indices intact!
 */
export function normalizeProjectPalette(raw: ProjectPalette): ProjectPalette {
  const colorTable: Array<string | null> = new Array<string | null>(
    MAX_OPAQUE_PALETTE_COLORS
  ).fill(null)
  const displayOrder: number[] = []
  const seenIndices = new Set<number>()

  const hasValidTable =
    Array.isArray(raw.colorTable) &&
    raw.colorTable.length <= MAX_OPAQUE_PALETTE_COLORS &&
    Array.isArray(raw.displayOrder) &&
    raw.displayOrder.length > 0

  if (hasValidTable) {
    for (
      let i = 0;
      i < Math.min(MAX_OPAQUE_PALETTE_COLORS, raw.colorTable!.length);
      i++
    ) {
      const entry = raw.colorTable![i]
      if (typeof entry === 'string') {
        const norm = normalizeHex(entry)
        if (norm) colorTable[i] = norm
      }
    }
    for (const idx of raw.displayOrder!) {
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < MAX_OPAQUE_PALETTE_COLORS &&
        colorTable[idx] !== null &&
        !seenIndices.has(idx) &&
        displayOrder.length < MAX_OPAQUE_PALETTE_COLORS
      ) {
        seenIndices.add(idx)
        displayOrder.push(idx)
      }
    }
    for (let i = 0; i < MAX_OPAQUE_PALETTE_COLORS; i++) {
      if (
        colorTable[i] !== null &&
        !seenIndices.has(i) &&
        displayOrder.length < MAX_OPAQUE_PALETTE_COLORS
      ) {
        seenIndices.add(i)
        displayOrder.push(i)
      } else if (!seenIndices.has(i)) {
        colorTable[i] = null
      }
    }
  } else {
    const srcColors =
      Array.isArray(raw.colors) && raw.colors.length > 0
        ? raw.colors
        : ['#000000', '#FFFFFF']
    for (
      let i = 0;
      i < srcColors.length && displayOrder.length < MAX_OPAQUE_PALETTE_COLORS;
      i++
    ) {
      const norm = normalizeHex(srcColors[i] ?? '')
      if (!norm) continue
      const fixedIdx = displayOrder.length
      colorTable[fixedIdx] = norm
      displayOrder.push(fixedIdx)
      seenIndices.add(fixedIdx)
    }
  }

  if (displayOrder.length === 0) {
    colorTable[0] = '#000000'
    colorTable[1] = '#FFFFFF'
    displayOrder.push(0, 1)
  }

  const colors = displayOrder.map((idx) => colorTable[idx]!)

  let originalDisplayOrder: number[] | undefined
  if (
    Array.isArray(raw.originalDisplayOrder) &&
    raw.originalDisplayOrder.length > 0
  ) {
    const filtered = raw.originalDisplayOrder.filter(
      (idx) =>
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < MAX_OPAQUE_PALETTE_COLORS &&
        seenIndices.has(idx)
    )
    if (filtered.length > 0) {
      originalDisplayOrder = filtered
    }
  }

  return {
    ...raw,
    name: raw.name || 'Palette',
    colors,
    colorTable,
    displayOrder,
    ...(originalDisplayOrder ? { originalDisplayOrder } : {}),
  }
}

export function buildPaletteRgbaLut(palette: ProjectPalette): Uint8ClampedArray {
  const norm = normalizeProjectPalette(palette)
  const lut = new Uint8ClampedArray(PALETTE_TABLE_SIZE * 4)
  const table = norm.colorTable!
  for (let i = 0; i < MAX_OPAQUE_PALETTE_COLORS; i++) {
    const hex = table[i]
    if (!hex) continue
    const rgba = hexToRgba(hex, 255)
    const off = i * 4
    lut[off] = rgba.r
    lut[off + 1] = rgba.g
    lut[off + 2] = rgba.b
    lut[off + 3] = 255
  }
  return lut
}

export function displaySlotToPixelIndex(
  palette: ProjectPalette,
  displaySlot: number
): number {
  if (displaySlot === TRANSPARENT_COLOR_INDEX || displaySlot < 0) {
    return TRANSPARENT_INDEX
  }
  const norm = normalizeProjectPalette(palette)
  const order = norm.displayOrder!
  if (displaySlot >= order.length) {
    return order[0] ?? 0
  }
  return order[displaySlot] ?? 0
}

export function pixelIndexToDisplaySlot(
  palette: ProjectPalette,
  pixelIndex: number
): number {
  if (
    pixelIndex === TRANSPARENT_INDEX ||
    pixelIndex < 0 ||
    pixelIndex >= MAX_OPAQUE_PALETTE_COLORS
  ) {
    return TRANSPARENT_COLOR_INDEX
  }
  const norm = normalizeProjectPalette(palette)
  const pos = norm.displayOrder!.indexOf(pixelIndex)
  return pos >= 0 ? pos : TRANSPARENT_COLOR_INDEX
}

export function getHexForPixelIndex(
  palette: ProjectPalette,
  pixelIndex: number
): string | null {
  if (
    pixelIndex === TRANSPARENT_INDEX ||
    pixelIndex < 0 ||
    pixelIndex >= MAX_OPAQUE_PALETTE_COLORS
  ) {
    return null
  }
  const norm = normalizeProjectPalette(palette)
  return norm.colorTable![pixelIndex] ?? null
}

export function findExactFixedIndex(
  palette: ProjectPalette,
  hex: string
): number {
  const target = normalizeHex(hex)
  if (!target) return -1
  const norm = normalizeProjectPalette(palette)
  for (const fixedIdx of norm.displayOrder!) {
    if (norm.colorTable![fixedIdx] === target) {
      return fixedIdx
    }
  }
  return -1
}

export function findNearestFixedIndex(
  palette: ProjectPalette,
  r: number,
  g: number,
  b: number
): number {
  const norm = normalizeProjectPalette(palette)
  const order = norm.displayOrder!
  if (order.length === 0) return 0

  const targetLab = rgbToLab(r, g, b)
  let bestIdx = order[0]!
  let bestDist = Infinity

  for (const fixedIdx of order) {
    const hex = norm.colorTable![fixedIdx]
    if (!hex) continue
    const c = hexToRgba(hex)
    if (c.r === r && c.g === g && c.b === b) {
      return fixedIdx
    }
    const dist = labDistanceSq(targetLab, rgbToLab(c.r, c.g, c.b))
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = fixedIdx
    }
  }
  return bestIdx
}

export function indexedBufferToRgba(
  indices: Uint8Array,
  lut: Uint8ClampedArray
): Uint8ClampedArray {
  const pixelCount = indices.length
  const out = new Uint8ClampedArray(pixelCount * 4)
  for (let p = 0; p < pixelCount; p++) {
    const idx = indices[p]!
    if (idx === TRANSPARENT_INDEX) continue
    const lutOff = idx * 4
    const a = lut[lutOff + 3]!
    if (a === 0) continue
    const dstOff = p * 4
    out[dstOff] = lut[lutOff]!
    out[dstOff + 1] = lut[lutOff + 1]!
    out[dstOff + 2] = lut[lutOff + 2]!
    out[dstOff + 3] = 255
  }
  return out
}

export { BAYER_4X4 }

export function addColorToIndexedPalette(
  palette: ProjectPalette,
  hex: string
): {
  palette: ProjectPalette
  fixedIndex: number
  displaySlot: number
  alreadyExisted: boolean
} | null {
  const clean = normalizeHex(hex)
  if (!clean) return null
  const norm = normalizeProjectPalette(palette)

  const existingFixed = findExactFixedIndex(norm, clean)
  if (existingFixed >= 0) {
    const displaySlot = norm.displayOrder!.indexOf(existingFixed)
    return {
      palette: norm,
      fixedIndex: existingFixed,
      displaySlot,
      alreadyExisted: true,
    }
  }

  if (norm.displayOrder!.length >= MAX_OPAQUE_PALETTE_COLORS) {
    return null
  }

  const nextTable = [...norm.colorTable!]
  let freeFixed = -1
  for (let i = 0; i < MAX_OPAQUE_PALETTE_COLORS; i++) {
    if (nextTable[i] === null) {
      freeFixed = i
      break
    }
  }
  if (freeFixed < 0) return null

  nextTable[freeFixed] = clean
  const nextOrder = [...norm.displayOrder!, freeFixed]
  const nextColors = nextOrder.map((idx) => nextTable[idx]!)

  return {
    palette: {
      ...norm,
      colorTable: nextTable,
      displayOrder: nextOrder,
      colors: nextColors,
    },
    fixedIndex: freeFixed,
    displaySlot: nextOrder.length - 1,
    alreadyExisted: false,
  }
}

export function updateIndexedPaletteSlotColor(
  palette: ProjectPalette,
  displaySlot: number,
  nextHex: string
): ProjectPalette {
  const clean = normalizeHex(nextHex)
  if (!clean) return normalizeProjectPalette(palette)
  const norm = normalizeProjectPalette(palette)
  if (displaySlot < 0 || displaySlot >= norm.displayOrder!.length) {
    return norm
  }
  const fixedIdx = norm.displayOrder![displaySlot]!
  const nextTable = [...norm.colorTable!]
  nextTable[fixedIdx] = clean
  const nextColors = norm.displayOrder!.map((idx) => nextTable[idx]!)
  return {
    ...norm,
    colorTable: nextTable,
    colors: nextColors,
  }
}

export function moveIndexedPaletteDisplaySlot(
  palette: ProjectPalette,
  fromSlot: number,
  toSlot: number,
  selectedDisplaySlot: number
): { palette: ProjectPalette; nextSelectedSlot: number } {
  const norm = normalizeProjectPalette(palette)
  const order = [...norm.displayOrder!]
  if (
    fromSlot < 0 ||
    toSlot < 0 ||
    fromSlot >= order.length ||
    toSlot >= order.length ||
    fromSlot === toSlot
  ) {
    return { palette: norm, nextSelectedSlot: selectedDisplaySlot }
  }

  const selectedFixed =
    selectedDisplaySlot >= 0 && selectedDisplaySlot < order.length
      ? order[selectedDisplaySlot]
      : null

  const [moved] = order.splice(fromSlot, 1)
  order.splice(toSlot, 0, moved!)
  const nextColors = order.map((idx) => norm.colorTable![idx]!)

  const nextSelectedSlot =
    selectedFixed !== null && selectedFixed !== undefined
      ? order.indexOf(selectedFixed)
      : selectedDisplaySlot

  return {
    palette: {
      ...norm,
      displayOrder: order,
      colors: nextColors,
    },
    nextSelectedSlot,
  }
}

export function removeFixedIndexFromPalette(
  palette: ProjectPalette,
  fixedIndex: number,
  selectedDisplaySlot: number
): { palette: ProjectPalette; nextSelectedSlot: number } | null {
  const norm = normalizeProjectPalette(palette)
  if (norm.displayOrder!.length <= 1) return null
  if (!norm.displayOrder!.includes(fixedIndex)) {
    return { palette: norm, nextSelectedSlot: selectedDisplaySlot }
  }

  const selectedFixed =
    selectedDisplaySlot >= 0 && selectedDisplaySlot < norm.displayOrder!.length
      ? norm.displayOrder![selectedDisplaySlot]
      : null

  const nextTable = [...norm.colorTable!]
  nextTable[fixedIndex] = null
  const nextOrder = norm.displayOrder!.filter((idx) => idx !== fixedIndex)
  const nextColors = nextOrder.map((idx) => nextTable[idx]!)

  let nextSelectedSlot = selectedDisplaySlot
  if (selectedDisplaySlot === TRANSPARENT_COLOR_INDEX) {
    nextSelectedSlot = TRANSPARENT_COLOR_INDEX
  } else if (
    selectedFixed !== null &&
    selectedFixed !== undefined &&
    selectedFixed !== fixedIndex
  ) {
    nextSelectedSlot = Math.max(0, nextOrder.indexOf(selectedFixed))
  } else {
    nextSelectedSlot = Math.min(selectedDisplaySlot, nextOrder.length - 1)
  }

  const nextOrig = norm.originalDisplayOrder?.filter((idx) => idx !== fixedIndex)

  return {
    palette: {
      ...norm,
      colorTable: nextTable,
      displayOrder: nextOrder,
      colors: nextColors,
      ...(nextOrig && nextOrig.length > 0
        ? { originalDisplayOrder: nextOrig }
        : { originalDisplayOrder: undefined }),
    },
    nextSelectedSlot,
  }
}

export interface QuantizeRgbaSourceInput {
  id: string
  width: number
  height: number
  /** Legacy or imported RGBA bytes (`width * height * 4`) */
  rgba: Uint8Array | Uint8ClampedArray
}

export interface QuantizedIndexedConversionResult {
  palette: ProjectPalette
  buffers: Map<string, Uint8Array>
  originalOpaqueColorCount: number
  finalOpaqueColorCount: number
  wasQuantized: boolean
  hadSemiTransparentPixels: boolean
  semiTransparentPixelCount: number
}

export interface ColorSample {
  hex: string
  r: number
  g: number
  b: number
  lab: LabVec
  count: number
}

/**
 * Perceptual CIELAB Median-Cut + Weighted Centroid Quantizer to `targetCount` (`<= 255`) opaque colors.
 * Uses sub-linear frequency weight (`sqrt(count)`) so small important accents (eyes, highlights) are preserved.
 */
export function quantizeColorsPerceptually(
  samples: readonly ColorSample[],
  targetCount = MAX_OPAQUE_PALETTE_COLORS,
  preferredHexes: readonly string[] = []
): string[] {
  if (samples.length <= targetCount) {
    return samples.map((s) => s.hex)
  }

  interface Bucket {
    items: ColorSample[]
    rangeL: number
    rangeA: number
    rangeB: number
    score: number
  }

  const makeBucket = (items: ColorSample[]): Bucket => {
    let minL = Infinity
    let maxL = -Infinity
    let minA = Infinity
    let maxA = -Infinity
    let minB = Infinity
    let maxB = -Infinity
    let totalWeight = 0
    for (const s of items) {
      if (s.lab.L < minL) minL = s.lab.L
      if (s.lab.L > maxL) maxL = s.lab.L
      if (s.lab.a < minA) minA = s.lab.a
      if (s.lab.a > maxA) maxA = s.lab.a
      if (s.lab.b < minB) minB = s.lab.b
      if (s.lab.b > maxB) maxB = s.lab.b
      totalWeight += Math.sqrt(s.count)
    }
    const rangeL = maxL - minL
    const rangeA = maxA - minA
    const rangeB = maxB - minB
    const maxRange = Math.max(rangeL, rangeA, rangeB)
    const score = items.length <= 1 ? -1 : maxRange * Math.pow(totalWeight, 0.25)
    return { items, rangeL, rangeA, rangeB, score }
  }

  const buckets: Bucket[] = [makeBucket([...samples])]

  while (buckets.length < targetCount) {
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i]!.items.length > 1 && buckets[i]!.score > bestScore) {
        bestScore = buckets[i]!.score
        bestIdx = i
      }
    }
    if (bestIdx < 0) break

    const target = buckets.splice(bestIdx, 1)[0]!
    const axis: 'L' | 'a' | 'b' =
      target.rangeL >= target.rangeA && target.rangeL >= target.rangeB
        ? 'L'
        : target.rangeA >= target.rangeB
          ? 'a'
          : 'b'

    const sorted = [...target.items].sort((p, q) => p.lab[axis] - q.lab[axis])
    const totalW = sorted.reduce((acc, s) => acc + Math.sqrt(s.count), 0)
    let accW = 0
    let splitAt = Math.floor(sorted.length / 2)
    for (let i = 0; i < sorted.length - 1; i++) {
      accW += Math.sqrt(sorted[i]!.count)
      if (accW >= totalW / 2) {
        splitAt = i + 1
        break
      }
    }
    splitAt = Math.max(1, Math.min(sorted.length - 1, splitAt))
    buckets.push(makeBucket(sorted.slice(0, splitAt)))
    buckets.push(makeBucket(sorted.slice(splitAt)))
  }

  const preferredSet = new Set(
    preferredHexes
      .map((h) => normalizeHex(h))
      .filter((h): h is string => Boolean(h))
  )

  const outHexes: string[] = []
  const seen = new Set<string>()
  for (const b of buckets) {
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let wSum = 0
    for (const s of b.items) {
      const w = Math.sqrt(s.count)
      sumR += s.r * w
      sumG += s.g * w
      sumB += s.b * w
      wSum += w
    }
    const avgR = wSum > 0 ? sumR / wSum : b.items[0]!.r
    const avgG = wSum > 0 ? sumG / wSum : b.items[0]!.g
    const avgB = wSum > 0 ? sumB / wSum : b.items[0]!.b
    const centroidLab = rgbToLab(avgR, avgG, avgB)

    let chosen = b.items[0]!
    let bestD = Infinity
    for (const s of b.items) {
      const bonus = preferredSet.has(s.hex) ? 0.85 : 1.0
      const d = labDistanceSq(centroidLab, s.lab) * bonus
      if (d < bestD) {
        bestD = d
        chosen = s
      }
    }
    if (!seen.has(chosen.hex)) {
      seen.add(chosen.hex)
      outHexes.push(chosen.hex)
    }
  }

  return outHexes.length > 0 ? outHexes.slice(0, targetCount) : ['#000000', '#FFFFFF']
}

/**
 * Convert RGBA buffers into 1-byte Indexed Color buffers (`0..254` opaque + `255` transparent):
 * - Preserves `preferredPalette` order/colors whenever total unique opaque colors <= 255
 * - Quantizes perceptually in CIELAB when unique opaque colors > 255
 * - Approximates semi-transparent pixels (`0 < a < 255`) using 4x4 Ordered Bayer alpha dithering
 *   between `TRANSPARENT_INDEX (255)` and the pixel's opaque palette index!
 */
export function convertRgbaBuffersToIndexed(
  sources: readonly QuantizeRgbaSourceInput[],
  preferredPalette?: ProjectPalette | null
): QuantizedIndexedConversionResult {
  const colorCounts = new Map<string, ColorSample>()
  let semiTransparentPixelCount = 0

  for (const src of sources) {
    const data = src.rgba
    const totalPx = Math.min(src.width * src.height, Math.floor(data.length / 4))
    for (let p = 0; p < totalPx; p++) {
      const off = p * 4
      const a = data[off + 3]!
      if (a === 0) continue
      if (a < 255) {
        semiTransparentPixelCount++
      }
      const r = data[off]!
      const g = data[off + 1]!
      const b = data[off + 2]!
      const hex = rgbaToHex({ r, g, b }).toUpperCase()
      const existing = colorCounts.get(hex)
      if (existing) {
        existing.count++
      } else {
        colorCounts.set(hex, {
          hex,
          r,
          g,
          b,
          lab: rgbToLab(r, g, b),
          count: 1,
        })
      }
    }
  }

  const originalOpaqueColorCount = colorCounts.size
  const prefColors = (preferredPalette?.colors ?? [])
    .map((c) => normalizeHex(c))
    .filter((c): c is string => Boolean(c))

  let finalPaletteColors: string[] = []
  let wasQuantized = false

  if (originalOpaqueColorCount <= MAX_OPAQUE_PALETTE_COLORS) {
    const usedHexesOrdered = Array.from(colorCounts.values())
      .sort((a, b) => b.count - a.count)
      .map((s) => s.hex)
    const usedSet = new Set(usedHexesOrdered)
    const chosenSet = new Set<string>()
    const unionCount = new Set([...prefColors, ...usedHexesOrdered]).size

    if (unionCount <= MAX_OPAQUE_PALETTE_COLORS) {
      for (const hex of prefColors) {
        if (!chosenSet.has(hex) && finalPaletteColors.length < MAX_OPAQUE_PALETTE_COLORS) {
          chosenSet.add(hex)
          finalPaletteColors.push(hex)
        }
      }
      for (const hex of usedHexesOrdered) {
        if (!chosenSet.has(hex) && finalPaletteColors.length < MAX_OPAQUE_PALETTE_COLORS) {
          chosenSet.add(hex)
          finalPaletteColors.push(hex)
        }
      }
    } else {
      for (const hex of prefColors) {
        if (usedSet.has(hex) && !chosenSet.has(hex)) {
          chosenSet.add(hex)
          finalPaletteColors.push(hex)
        }
      }
      for (const hex of usedHexesOrdered) {
        if (!chosenSet.has(hex)) {
          chosenSet.add(hex)
          finalPaletteColors.push(hex)
        }
      }
      for (const hex of prefColors) {
        if (!chosenSet.has(hex) && finalPaletteColors.length < MAX_OPAQUE_PALETTE_COLORS) {
          chosenSet.add(hex)
          finalPaletteColors.push(hex)
        }
      }
    }
  } else {
    wasQuantized = true
    finalPaletteColors = quantizeColorsPerceptually(
      Array.from(colorCounts.values()),
      MAX_OPAQUE_PALETTE_COLORS,
      prefColors
    )
  }

  if (finalPaletteColors.length === 0) {
    finalPaletteColors =
      prefColors.length > 0
        ? prefColors.slice(0, MAX_OPAQUE_PALETTE_COLORS)
        : ['#000000', '#FFFFFF']
  }

  const palette = normalizeProjectPalette({
    name: preferredPalette?.name || 'Palette',
    colors: finalPaletteColors,
    ...(preferredPalette?.sourcePaletteId
      ? { sourcePaletteId: preferredPalette.sourcePaletteId }
      : {}),
    ...(preferredPalette?.author ? { author: preferredPalette.author } : {}),
    ...(preferredPalette?.sourceUrl ? { sourceUrl: preferredPalette.sourceUrl } : {}),
  })

  const hexToFixed = new Map<string, number>()
  const paletteEntriesLab: Array<{ fixedIdx: number; lab: LabVec }> = []
  for (const fixedIdx of palette.displayOrder!) {
    const hex = palette.colorTable![fixedIdx]!
    if (!hexToFixed.has(hex)) {
      hexToFixed.set(hex, fixedIdx)
    }
    const c = hexToRgba(hex)
    paletteEntriesLab.push({
      fixedIdx,
      lab: rgbToLab(c.r, c.g, c.b),
    })
  }

  const resolveRgbIndex = (r: number, g: number, b: number): number => {
    const hex = rgbaToHex({ r, g, b }).toUpperCase()
    const cached = hexToFixed.get(hex)
    if (cached !== undefined) return cached

    const tLab = rgbToLab(r, g, b)
    let best = paletteEntriesLab[0]?.fixedIdx ?? 0
    let bestDist = Infinity
    for (let i = 0; i < paletteEntriesLab.length; i++) {
      const e = paletteEntriesLab[i]!
      const d = labDistanceSq(tLab, e.lab)
      if (d < bestDist) {
        bestDist = d
        best = e.fixedIdx
      }
    }
    hexToFixed.set(hex, best)
    return best
  }

  const buffers = new Map<string, Uint8Array>()
  for (const src of sources) {
    const w = src.width
    const h = src.height
    const out = new Uint8Array(w * h)
    out.fill(TRANSPARENT_INDEX)
    const data = src.rgba
    const maxPx = Math.min(w * h, Math.floor(data.length / 4))

    for (let p = 0; p < maxPx; p++) {
      const off = p * 4
      const a = data[off + 3]!
      if (a === 0) {
        out[p] = TRANSPARENT_INDEX
        continue
      }
      if (a < 255) {
        const x = p % w
        const y = (p - x) / w
        const threshold = (BAYER_4X4[(y & 3) * 4 + (x & 3)]! + 0.5) * (255 / 16)
        if (a < threshold) {
          out[p] = TRANSPARENT_INDEX
          continue
        }
      }
      out[p] = resolveRgbIndex(data[off]!, data[off + 1]!, data[off + 2]!)
    }

    buffers.set(src.id, out)
  }

  return {
    palette,
    buffers,
    originalOpaqueColorCount,
    finalOpaqueColorCount: palette.displayOrder!.length,
    wasQuantized,
    hadSemiTransparentPixels: semiTransparentPixelCount > 0,
    semiTransparentPixelCount,
  }
}

/**
 * Remap an indexed clipboard buffer from another project into `targetPalette`:
 * - Exact matching colors reuse existing fixed indices in `targetPalette`
 * - Missing colors are allocated into free slots up to 255 opaque colors
 * - If `targetPalette` reaches 255 colors, remaining colors map to the perceptually closest palette slot!
 */
export function remapClipboardToTargetPalette(
  clipData: Uint8Array,
  sourceColorMap: Readonly<Record<number, string>> | undefined,
  targetPalette: ProjectPalette
): { remappedData: Uint8Array; nextPalette: ProjectPalette; mappedNearest: boolean } {
  if (!sourceColorMap || Object.keys(sourceColorMap).length === 0) {
    return {
      remappedData: new Uint8Array(clipData),
      nextPalette: normalizeProjectPalette(targetPalette),
      mappedNearest: false,
    }
  }

  let pal = normalizeProjectPalette(targetPalette)
  const indexMap = new Map<number, number>()
  let mappedNearest = false

  for (let i = 0; i < clipData.length; i++) {
    const sIdx = clipData[i]!
    if (sIdx === TRANSPARENT_INDEX || indexMap.has(sIdx)) continue
    const hex = sourceColorMap[sIdx]
    if (!hex) {
      indexMap.set(sIdx, TRANSPARENT_INDEX)
      continue
    }
    const added = addColorToIndexedPalette(pal, hex)
    if (added) {
      pal = added.palette
      indexMap.set(sIdx, added.fixedIndex)
    } else {
      const c = hexToRgba(hex)
      const nearest = findNearestFixedIndex(pal, c.r, c.g, c.b)
      indexMap.set(sIdx, nearest)
      mappedNearest = true
    }
  }

  const out = new Uint8Array(clipData.length)
  for (let i = 0; i < clipData.length; i++) {
    const sIdx = clipData[i]!
    out[i] =
      sIdx === TRANSPARENT_INDEX
        ? TRANSPARENT_INDEX
        : (indexMap.get(sIdx) ?? sIdx)
  }

  return { remappedData: out, nextPalette: pal, mappedNearest }
}

/**
 * Build a compact `sourceColorMap` (`fixedIdx -> #RRGGBB`) for all opaque indices referenced in `buf`.
 */
export function extractUsedColorMap(
  buf: Uint8Array,
  palette: ProjectPalette
): Record<number, string> {
  const norm = normalizeProjectPalette(palette)
  const map: Record<number, string> = {}
  for (let i = 0; i < buf.length; i++) {
    const idx = buf[i]!
    if (idx === TRANSPARENT_INDEX || map[idx] !== undefined) continue
    const hex = norm.colorTable![idx]
    if (hex) {
      map[idx] = hex
    }
  }
  return map
}


