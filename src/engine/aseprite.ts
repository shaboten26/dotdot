import { unzlibSync, zlibSync } from 'fflate'
import {
  MAX_OPAQUE_PALETTE_COLORS,
  TRANSPARENT_INDEX,
  type BlendMode,
  type CelBufferRuntime,
  type CelMap,
  type FrameMeta,
  type LayerMeta,
  type LayerRuntime,
  type ProjectPalette,
} from '../types'
import { hexToRgba, rgbaToHex } from './color'
import { MAX_LAYERS } from './compositor'
import {
  convertRgbaBuffersToIndexed,
  normalizeProjectPalette,
} from './indexedPalette'
import { createPixelBuffer, MAX_CANVAS_SIZE } from './pixelBuffer'
import { clampFrameDurationMs, makeCellKey } from './animation'

export const ASE_FILE_MAGIC = 0xa5e0
export const ASE_FRAME_MAGIC = 0xf1fa

const CHUNK_OLD_PALETTE_256 = 0x0004
const CHUNK_OLD_PALETTE_64 = 0x0011
const CHUNK_LAYER = 0x2004
const CHUNK_CEL = 0x2005
const CHUNK_CEL_EXTRA = 0x2006
const CHUNK_COLOR_PROFILE = 0x2007
const CHUNK_EXTERNAL_FILES = 0x2008
const CHUNK_TAGS = 0x2018
const CHUNK_PALETTE = 0x2019
const CHUNK_USER_DATA = 0x2020
const CHUNK_SLICE = 0x2022
const CHUNK_TILESET = 0x2023

export interface AsepriteWarningItem {
  code:
    | 'layer-groups-flattened'
    | 'tilemap-layers-skipped'
    | 'unsupported-blend-mode'
    | 'cel-opacity-baked'
    | 'tags-ignored'
    | 'slices-ignored'
    | 'icc-profile-ignored'
    | 'non-square-pixel-aspect'
    | 'layer-limit-truncated'
    | 'canvas-size-exceeded'
    | 'clipping-note'
    | 'colors-quantized'
  detail: string
}

export interface ParsedAsepriteDocument {
  width: number
  height: number
  colorDepth: 8 | 16 | 32
  frameCount: number
  layerCount: number
  linkedCelCount: number
  fitsCanvasLimit: boolean
  layers: LayerRuntime[]
  frames: FrameMeta[]
  cels: CelMap
  celBuffers: Record<string, CelBufferRuntime>
  palette: ProjectPalette
  tagNames: string[]
  warnings: AsepriteWarningItem[]
  wasQuantized?: boolean
  originalOpaqueColorCount?: number
}

const ASE_TO_DOTDOT_BLEND: Record<number, BlendMode> = {
  0: 'normal',
  1: 'multiply',
  2: 'screen',
  3: 'overlay',
  4: 'darken',
  5: 'lighten',
  11: 'difference',
  16: 'add',
}

const DOTDOT_TO_ASE_BLEND: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  difference: 11,
  add: 16,
}

class BinaryReader {
  private view: DataView
  private bytes: Uint8Array
  public pos = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get length(): number {
    return this.bytes.byteLength
  }

  ensure(count: number): void {
    if (this.pos + count > this.bytes.byteLength) {
      throw new Error('CORRUPT_ASEPRITE: Unexpected end of file')
    }
  }

  u8(): number {
    this.ensure(1)
    return this.view.getUint8(this.pos++)
  }

  u16(): number {
    this.ensure(2)
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  i16(): number {
    this.ensure(2)
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    this.ensure(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  skip(count: number): void {
    if (count < 0) {
      throw new Error('CORRUPT_ASEPRITE: Negative skip offset')
    }
    this.ensure(count)
    this.pos += count
  }

  slice(count: number): Uint8Array {
    this.ensure(count)
    const sub = this.bytes.subarray(this.pos, this.pos + count)
    this.pos += count
    return sub
  }

  str(): string {
    const byteLen = this.u16()
    const raw = this.slice(byteLen)
    return new TextDecoder('utf-8', { fatal: false }).decode(raw)
  }
}

class BinaryWriter {
  public buf: Uint8Array
  private view: DataView
  public length = 0

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity)
    this.view = new DataView(this.buf.buffer)
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.buf.length) return
    let nextCap = this.buf.length * 2
    while (nextCap < this.length + extra) {
      nextCap *= 2
    }
    const grown = new Uint8Array(nextCap)
    grown.set(this.buf.subarray(0, this.length))
    this.buf = grown
    this.view = new DataView(this.buf.buffer)
  }

  u8(v: number): void {
    this.reserve(1)
    this.view.setUint8(this.length++, v & 0xff)
  }

  u16(v: number): void {
    this.reserve(2)
    this.view.setUint16(this.length, v & 0xffff, true)
    this.length += 2
  }

  i16(v: number): void {
    this.reserve(2)
    this.view.setInt16(this.length, v, true)
    this.length += 2
  }

  u32(v: number): void {
    this.reserve(4)
    this.view.setUint32(this.length, v >>> 0, true)
    this.length += 4
  }

  zeros(count: number): void {
    this.reserve(count)
    this.buf.fill(0, this.length, this.length + count)
    this.length += count
  }

  bytes(arr: Uint8Array): void {
    this.reserve(arr.length)
    this.buf.set(arr, this.length)
    this.length += arr.length
  }

  str(s: string): void {
    const enc = new TextEncoder().encode(s)
    this.u16(enc.length)
    this.bytes(enc)
  }

  patchU32(offset: number, v: number): void {
    this.view.setUint32(offset, v >>> 0, true)
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

interface RawAseLayerEntry {
  aseIndex: number
  layerType: number
  name: string
  visible: boolean
  locked: boolean
  opacity255: number
  blendModeNum: number
  childLevel: number
}

/**
 * Parse an Aseprite `.ase` / `.aseprite` binary into 1-byte Indexed Color `layers`, `celBuffers`, and `ProjectPalette`.
 * - Preserves 8bpp Indexed palette structure & maps Aseprite `transparentIndex` <-> dotdot `TRANSPARENT_INDEX (255)` (Section 9-3).
 * - Preserves Linked Cels (`celType === 1`) via shared `celId` references.
 */
export function parseAsepriteBytes(rawBytes: Uint8Array): ParsedAsepriteDocument {
  if (!rawBytes || rawBytes.byteLength < 128) {
    throw new Error('INVALID_ASEPRITE: File is smaller than 128-byte Aseprite header')
  }

  const r = new BinaryReader(rawBytes)
  const _fileSize = r.u32()
  void _fileSize
  const headerMagic = r.u16()
  if (headerMagic !== ASE_FILE_MAGIC) {
    throw new Error(
      `INVALID_ASEPRITE: Invalid header magic 0x${headerMagic.toString(16)}`
    )
  }

  const numFrames = r.u16()
  const width = r.u16()
  const height = r.u16()
  const colorDepthRaw = r.u16()
  const headerFlags = r.u32()
  const fallbackSpeedMs = r.u16()
  r.skip(8)
  const transparentIndex = r.u8()
  r.skip(3)
  const _numColors = r.u16()
  void _numColors
  const pixelW = r.u8()
  const pixelH = r.u8()
  r.skip(92)

  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new Error(`UNSUPPORTED_ASEPRITE_DIMENSIONS: ${width}x${height}`)
  }
  if (colorDepthRaw !== 32 && colorDepthRaw !== 16 && colorDepthRaw !== 8) {
    throw new Error(`UNSUPPORTED_ASEPRITE_COLOR_DEPTH: ${colorDepthRaw}bpp`)
  }
  const colorDepth = colorDepthRaw as 8 | 16 | 32
  const layerOpacityValid = (headerFlags & 1) !== 0 || headerFlags === 0

  const warnings: AsepriteWarningItem[] = []
  const fitsCanvasLimit = width <= MAX_CANVAS_SIZE && height <= MAX_CANVAS_SIZE
  if (!fitsCanvasLimit) {
    warnings.push({
      code: 'canvas-size-exceeded',
      detail: `${width}×${height}px (dotdot上限: ${MAX_CANVAS_SIZE}×${MAX_CANVAS_SIZE}px)`,
    })
  }
  if (pixelW > 0 && pixelH > 0 && pixelW !== pixelH) {
    warnings.push({
      code: 'non-square-pixel-aspect',
      detail: `${pixelW}:${pixelH}`,
    })
  }

  const paletteRgba: Array<{ r: number; g: number; b: number; a: number } | undefined> = []
  let sawNewPaletteChunk = false

  const rawLayers: RawAseLayerEntry[] = []
  const frames: FrameMeta[] = []
  const tagNames: string[] = []
  let sliceCount = 0
  let tilemapCount = 0
  let groupCount = 0
  let unsupportedBlendCount = 0
  let bakedCelOpacityCount = 0
  let sawIccProfile = false

  type TempCelEntry =
    | {
        kind: 'image'
        x: number
        y: number
        w: number
        h: number
        celOpacity: number
        rawIndexed8?: Uint8Array
        rgba?: Uint8ClampedArray
        celId: string
      }
    | {
        kind: 'linked'
        linkedFrameIndex: number
      }
  const tempCelGrid = new Map<string, TempCelEntry>()
  let nextCelSeq = 1

  const actualFrames = Math.max(1, numFrames)
  for (let fIdx = 0; fIdx < actualFrames; fIdx++) {
    if (r.pos >= r.length && fIdx > 0) {
      break
    }
    const frameStart = r.pos
    r.ensure(16)
    const frameBytes = r.u32()
    const frameMagic = r.u16()
    if (frameMagic !== ASE_FRAME_MAGIC) {
      throw new Error(
        `CORRUPT_ASEPRITE: Invalid frame magic 0x${frameMagic.toString(16)} at frame ${fIdx}`
      )
    }
    const oldChunks = r.u16()
    const frameDurationRaw = r.u16()
    r.skip(2)
    const newChunks = r.u32()

    const chunkCount = newChunks === 0 ? oldChunks : newChunks
    const durationMs = clampFrameDurationMs(
      frameDurationRaw > 0
        ? frameDurationRaw
        : fallbackSpeedMs > 0
          ? fallbackSpeedMs
          : 100
    )
    frames.push({
      id: `frame-${fIdx + 1}`,
      durationMs,
    })

    const frameEnd = Math.min(r.length, frameStart + Math.max(16, frameBytes))

    for (let cIdx = 0; cIdx < chunkCount; cIdx++) {
      if (r.pos + 6 > frameEnd) break
      const chunkStart = r.pos
      const chunkSize = r.u32()
      const chunkType = r.u16()
      if (chunkSize < 6 || chunkStart + chunkSize > r.length) {
        throw new Error('CORRUPT_ASEPRITE: Invalid chunk size')
      }
      const payloadLen = chunkSize - 6
      const chunkEnd = chunkStart + chunkSize

      if (chunkType === CHUNK_PALETTE) {
        sawNewPaletteChunk = true
        const newSize = r.u32()
        const firstIdx = r.u32()
        const lastIdx = r.u32()
        r.skip(8)
        if (paletteRgba.length < Math.min(256, newSize)) {
          paletteRgba.length = Math.min(256, newSize)
        }
        for (let ci = firstIdx; ci <= lastIdx && r.pos + 6 <= chunkEnd; ci++) {
          const entryFlags = r.u16()
          const cr = r.u8()
          const cg = r.u8()
          const cb = r.u8()
          const ca = r.u8()
          if ((entryFlags & 1) !== 0) {
            r.str()
          }
          if (ci < 256) {
            paletteRgba[ci] = { r: cr, g: cg, b: cb, a: ca }
          }
        }
      } else if (
        (chunkType === CHUNK_OLD_PALETTE_256 || chunkType === CHUNK_OLD_PALETTE_64) &&
        !sawNewPaletteChunk
      ) {
        const packets = r.u16()
        let palCursor = 0
        for (let pk = 0; pk < packets && r.pos + 2 <= chunkEnd; pk++) {
          const skipCount = r.u8()
          let count = r.u8()
          if (count === 0) count = 256
          palCursor += skipCount
          for (let k = 0; k < count && r.pos + 3 <= chunkEnd; k++) {
            let cr = r.u8()
            let cg = r.u8()
            let cb = r.u8()
            if (chunkType === CHUNK_OLD_PALETTE_64) {
              cr = Math.round((cr * 255) / 63)
              cg = Math.round((cg * 255) / 63)
              cb = Math.round((cb * 255) / 63)
            }
            if (palCursor < 256) {
              paletteRgba[palCursor] = { r: cr, g: cg, b: cb, a: 255 }
            }
            palCursor++
          }
        }
      } else if (chunkType === CHUNK_COLOR_PROFILE) {
        const profType = r.u16()
        if (profType === 2) {
          sawIccProfile = true
        }
      } else if (chunkType === CHUNK_LAYER) {
        const flags = r.u16()
        const layerType = r.u16()
        const childLevel = r.u16()
        r.skip(4)
        const blendModeNum = r.u16()
        const opacity255 = r.u8()
        r.skip(3)
        const name = r.str()

        if (layerType === 1) groupCount++
        if (layerType === 2) tilemapCount++
        if (layerType === 0 && !(blendModeNum in ASE_TO_DOTDOT_BLEND)) {
          unsupportedBlendCount++
        }

        rawLayers.push({
          aseIndex: rawLayers.length,
          layerType,
          name: name || `Layer ${rawLayers.length + 1}`,
          visible: (flags & 1) !== 0,
          locked: (flags & 2) === 0,
          opacity255: layerOpacityValid ? opacity255 : 255,
          blendModeNum,
          childLevel,
        })
      } else if (chunkType === CHUNK_CEL) {
        const layerIndex = r.u16()
        const celX = r.i16()
        const celY = r.i16()
        const celOpacity = r.u8()
        const celType = r.u16()
        r.skip(7)

        const key = `${layerIndex}:${fIdx}`
        if (celType === 1) {
          const linkedFrameIndex = r.u16()
          tempCelGrid.set(key, { kind: 'linked', linkedFrameIndex })
        } else if (celType === 0 || celType === 2) {
          const cw = r.u16()
          const ch = r.u16()
          const remainBytes = chunkEnd - r.pos
          const rawSlice = r.slice(Math.max(0, remainBytes))
          let pixelBytes: Uint8Array
          if (celType === 2) {
            try {
              pixelBytes = unzlibSync(rawSlice)
            } catch {
              throw new Error(
                `CORRUPT_ASEPRITE: Failed to decompress ZLIB cel at layer ${layerIndex}, frame ${fIdx}`
              )
            }
          } else {
            pixelBytes = rawSlice
          }

          const bpp = colorDepth === 32 ? 4 : colorDepth === 16 ? 2 : 1
          if (pixelBytes.length < cw * ch * bpp) {
            throw new Error('CORRUPT_ASEPRITE: Cel pixel buffer shorter than dimensions')
          }

          if (celOpacity < 255) {
            bakedCelOpacityCount++
          }

          if (cw > 0 && ch > 0) {
            if (colorDepth === 8 && celOpacity === 255) {
              tempCelGrid.set(key, {
                kind: 'image',
                x: celX,
                y: celY,
                w: cw,
                h: ch,
                celOpacity,
                rawIndexed8: new Uint8Array(pixelBytes.subarray(0, cw * ch)),
                celId: `ase-cel-${nextCelSeq++}`,
              })
            } else {
              const rgba = new Uint8ClampedArray(cw * ch * 4)
              if (colorDepth === 32) {
                rgba.set(pixelBytes.subarray(0, cw * ch * 4))
              } else if (colorDepth === 16) {
                for (let p = 0; p < cw * ch; p++) {
                  const v = pixelBytes[p * 2]!
                  const a = pixelBytes[p * 2 + 1]!
                  const di = p * 4
                  rgba[di] = v
                  rgba[di + 1] = v
                  rgba[di + 2] = v
                  rgba[di + 3] = a
                }
              } else {
                for (let p = 0; p < cw * ch; p++) {
                  const idx8 = pixelBytes[p]!
                  const di = p * 4
                  if (idx8 === transparentIndex) {
                    rgba[di + 3] = 0
                  } else {
                    const entry = paletteRgba[idx8] ?? {
                      r: idx8,
                      g: idx8,
                      b: idx8,
                      a: 255,
                    }
                    rgba[di] = entry.r
                    rgba[di + 1] = entry.g
                    rgba[di + 2] = entry.b
                    rgba[di + 3] = entry.a
                  }
                }
              }
              if (celOpacity < 255) {
                const factor = celOpacity / 255
                for (let i = 3; i < rgba.length; i += 4) {
                  rgba[i] = Math.round(rgba[i]! * factor)
                }
              }
              tempCelGrid.set(key, {
                kind: 'image',
                x: celX,
                y: celY,
                w: cw,
                h: ch,
                celOpacity,
                rgba,
                celId: `ase-cel-${nextCelSeq++}`,
              })
            }
          }
        } else if (celType === 3) {
          tilemapCount++
        }
      } else if (chunkType === CHUNK_TAGS) {
        const numTags = r.u16()
        r.skip(8)
        for (let ti = 0; ti < numTags && r.pos < chunkEnd; ti++) {
          if (r.pos + 17 > chunkEnd) break
          r.skip(17)
          if (r.pos + 2 <= chunkEnd) {
            tagNames.push(r.str())
          }
        }
      } else if (chunkType === CHUNK_SLICE) {
        sliceCount++
      } else if (chunkType === CHUNK_TILESET) {
        tilemapCount++
      } else {
        void payloadLen
        void CHUNK_CEL_EXTRA
        void CHUNK_EXTERNAL_FILES
        void CHUNK_USER_DATA
      }

      r.pos = chunkEnd
    }

    r.pos = frameEnd
  }

  const groupVisibleStack: boolean[] = []
  const imageLayerEntries: Array<{
    aseIndex: number
    meta: LayerMeta
  }> = []

  for (const rl of rawLayers) {
    groupVisibleStack.length = rl.childLevel
    const parentVisible = groupVisibleStack.every(Boolean)
    const effectiveVis = parentVisible && rl.visible
    if (rl.layerType === 1) {
      groupVisibleStack[rl.childLevel] = effectiveVis
      continue
    }
    if (rl.layerType !== 0) {
      continue
    }
    const dotBlend: BlendMode = ASE_TO_DOTDOT_BLEND[rl.blendModeNum] ?? 'normal'
    imageLayerEntries.push({
      aseIndex: rl.aseIndex,
      meta: {
        id: `layer-${imageLayerEntries.length + 1}`,
        name: rl.name,
        visible: effectiveVis,
        locked: rl.locked,
        opacity: Math.max(0, Math.min(100, Math.round((rl.opacity255 / 255) * 100))),
        blendMode: dotBlend,
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: Math.min(MAX_CANVAS_SIZE, width),
        dataHeight: Math.min(MAX_CANVAS_SIZE, height),
      },
    })
  }

  if (imageLayerEntries.length === 0) {
    imageLayerEntries.push({
      aseIndex: 0,
      meta: {
        id: 'layer-1',
        name: 'Layer 1',
        visible: true,
        locked: false,
        opacity: 100,
        blendMode: 'normal',
        clipping: false,
        offsetX: 0,
        offsetY: 0,
        dataWidth: Math.min(MAX_CANVAS_SIZE, width),
        dataHeight: Math.min(MAX_CANVAS_SIZE, height),
      },
    })
  }

  if (imageLayerEntries.length > MAX_LAYERS) {
    warnings.push({
      code: 'layer-limit-truncated',
      detail: `${imageLayerEntries.length} → ${MAX_LAYERS}`,
    })
    imageLayerEntries.length = MAX_LAYERS
  }

  if (groupCount > 0) warnings.push({ code: 'layer-groups-flattened', detail: `${groupCount}` })
  if (tilemapCount > 0) warnings.push({ code: 'tilemap-layers-skipped', detail: `${tilemapCount}` })
  if (unsupportedBlendCount > 0) {
    warnings.push({ code: 'unsupported-blend-mode', detail: `${unsupportedBlendCount}` })
  }
  if (bakedCelOpacityCount > 0) {
    warnings.push({ code: 'cel-opacity-baked', detail: `${bakedCelOpacityCount}` })
  }
  if (tagNames.length > 0) warnings.push({ code: 'tags-ignored', detail: tagNames.join(', ') })
  if (sliceCount > 0) warnings.push({ code: 'slices-ignored', detail: `${sliceCount}` })
  if (sawIccProfile) warnings.push({ code: 'icc-profile-ignored', detail: 'ICC → sRGB' })

  const resolveImageCel = (
    aseLayerIdx: number,
    fIdx: number,
    visited = new Set<number>()
  ): Extract<TempCelEntry, { kind: 'image' }> | null => {
    if (visited.has(fIdx)) return null
    visited.add(fIdx)
    const entry = tempCelGrid.get(`${aseLayerIdx}:${fIdx}`)
    if (!entry) return null
    if (entry.kind === 'image') return entry
    return resolveImageCel(aseLayerIdx, entry.linkedFrameIndex, visited)
  }

  const cels: CelMap = {}
  const uniqueResolvedCels = new Map<string, Extract<TempCelEntry, { kind: 'image' }>>()
  let linkedCelCount = 0

  for (const item of imageLayerEntries) {
    for (let fIdx = 0; fIdx < frames.length; fIdx++) {
      const frameId = frames[fIdx]!.id
      const cellKey = makeCellKey(item.meta.id, frameId)
      const direct = tempCelGrid.get(`${item.aseIndex}:${fIdx}`)
      if (!direct) {
        cels[cellKey] = { kind: 'empty' }
        continue
      }
      if (direct.kind === 'linked') {
        linkedCelCount++
      }
      const resolved = resolveImageCel(item.aseIndex, fIdx)
      if (!resolved) {
        cels[cellKey] = { kind: 'empty' }
        continue
      }
      uniqueResolvedCels.set(resolved.celId, resolved)
      cels[cellKey] = { kind: 'cel', celId: resolved.celId }
    }
  }

  const celBuffers: Record<string, CelBufferRuntime> = {}
  let finalPalette: ProjectPalette
  let wasQuantized = false
  let originalOpaqueColorCount = 0

  const allRaw8bpp =
    colorDepth === 8 &&
    Array.from(uniqueResolvedCels.values()).every((c) => Boolean(c.rawIndexed8))

  if (allRaw8bpp) {
    // Native 8bpp Indexed fast-path: preserve exact Aseprite palette indices (remapping `transparentIndex` -> `255`)!
    const usedAseIndices = new Set<number>()
    for (const cel of uniqueResolvedCels.values()) {
      const raw = cel.rawIndexed8!
      for (let i = 0; i < raw.length; i++) {
        const idx8 = raw[i]!
        if (idx8 !== transparentIndex) {
          const palE = paletteRgba[idx8]
          if (!palE || palE.a > 0) {
            usedAseIndices.add(idx8)
          }
        }
      }
    }

    // Collect valid opaque palette entries (`i !== transparentIndex && a > 0`)
    const validOpaqueAseIndices: number[] = []
    for (let i = 0; i < Math.min(256, paletteRgba.length); i++) {
      if (i === transparentIndex) continue
      const entry = paletteRgba[i]
      if (entry && entry.a > 0) {
        validOpaqueAseIndices.push(i)
      }
    }
    // Also ensure any used index in cel data is represented even if palette chunk was short
    for (const uIdx of usedAseIndices) {
      if (!validOpaqueAseIndices.includes(uIdx)) {
        validOpaqueAseIndices.push(uIdx)
      }
    }

    if (
      transparentIndex === TRANSPARENT_INDEX &&
      validOpaqueAseIndices.every((idx) => idx < MAX_OPAQUE_PALETTE_COLORS)
    ) {
      // Exact 1:1 fixed-index identity (including files exported by dotdot)!
      const colorTable = new Array<string | null>(MAX_OPAQUE_PALETTE_COLORS).fill(null)
      const displayOrder: number[] = []
      for (const idx of validOpaqueAseIndices) {
        const e = paletteRgba[idx] ?? { r: idx, g: idx, b: idx, a: 255 }
        colorTable[idx] = rgbaToHex(e).toUpperCase()
        displayOrder.push(idx)
      }
      if (displayOrder.length === 0) {
        colorTable[0] = '#000000'
        colorTable[1] = '#FFFFFF'
        displayOrder.push(0, 1)
      }
      finalPalette = normalizeProjectPalette({
        name: 'Aseprite Palette',
        colors: displayOrder.map((i) => colorTable[i]!),
        colorTable,
        displayOrder,
      })
      originalOpaqueColorCount = displayOrder.length

      for (const cel of uniqueResolvedCels.values()) {
        const src = cel.rawIndexed8!
        const dst = new Uint8Array(src.length)
        for (let i = 0; i < src.length; i++) {
          const v = src[i]!
          if (v === transparentIndex || colorTable[v] === null) {
            dst[i] = TRANSPARENT_INDEX
          } else {
            dst[i] = v
          }
        }
        celBuffers[cel.celId] = {
          id: cel.celId,
          offsetX: cel.x,
          offsetY: cel.y,
          dataWidth: cel.w,
          dataHeight: cel.h,
          data: dst,
        }
      }
    } else if (validOpaqueAseIndices.length <= MAX_OPAQUE_PALETTE_COLORS) {
      // Lossless 1:1 remap from Aseprite index (`transparentIndex` -> `255`, others -> `0..N-1`)!
      const aseToDot = new Int16Array(256).fill(TRANSPARENT_INDEX)
      const colorTable = new Array<string | null>(MAX_OPAQUE_PALETTE_COLORS).fill(null)
      const displayOrder: number[] = []
      for (let slot = 0; slot < validOpaqueAseIndices.length; slot++) {
        const aseIdx = validOpaqueAseIndices[slot]!
        const e = paletteRgba[aseIdx] ?? { r: aseIdx, g: aseIdx, b: aseIdx, a: 255 }
        colorTable[slot] = rgbaToHex(e).toUpperCase()
        displayOrder.push(slot)
        aseToDot[aseIdx] = slot
      }
      if (displayOrder.length === 0) {
        colorTable[0] = '#000000'
        colorTable[1] = '#FFFFFF'
        displayOrder.push(0, 1)
      }
      finalPalette = normalizeProjectPalette({
        name: 'Aseprite Palette',
        colors: displayOrder.map((i) => colorTable[i]!),
        colorTable,
        displayOrder,
      })
      originalOpaqueColorCount = displayOrder.length

      for (const cel of uniqueResolvedCels.values()) {
        const src = cel.rawIndexed8!
        const dst = new Uint8Array(src.length)
        for (let i = 0; i < src.length; i++) {
          const v = src[i]!
          dst[i] = v === transparentIndex ? TRANSPARENT_INDEX : aseToDot[v]!
        }
        celBuffers[cel.celId] = {
          id: cel.celId,
          offsetX: cel.x,
          offsetY: cel.y,
          dataWidth: cel.w,
          dataHeight: cel.h,
          data: dst,
        }
      }
    } else {
      // Rare 256-opaque-color background sprite -> quantize to 255 opaque colors
      const rgbaSources = Array.from(uniqueResolvedCels.values()).map((cel) => {
        const src = cel.rawIndexed8!
        const rgba = new Uint8ClampedArray(cel.w * cel.h * 4)
        for (let i = 0; i < src.length; i++) {
          const idx8 = src[i]!
          if (idx8 === transparentIndex) continue
          const e = paletteRgba[idx8] ?? { r: idx8, g: idx8, b: idx8, a: 255 }
          const off = i * 4
          rgba[off] = e.r
          rgba[off + 1] = e.g
          rgba[off + 2] = e.b
          rgba[off + 3] = e.a
        }
        return { id: cel.celId, width: cel.w, height: cel.h, rgba }
      })
      const conv = convertRgbaBuffersToIndexed(rgbaSources, {
        name: 'Aseprite Palette',
        colors: validOpaqueAseIndices
          .slice(0, MAX_OPAQUE_PALETTE_COLORS)
          .map((idx) => rgbaToHex(paletteRgba[idx] ?? { r: idx, g: idx, b: idx }).toUpperCase()),
      })
      finalPalette = conv.palette
      wasQuantized = conv.wasQuantized
      originalOpaqueColorCount = conv.originalOpaqueColorCount
      for (const cel of uniqueResolvedCels.values()) {
        celBuffers[cel.celId] = {
          id: cel.celId,
          offsetX: cel.x,
          offsetY: cel.y,
          dataWidth: cel.w,
          dataHeight: cel.h,
          data: conv.buffers.get(cel.celId) ?? createPixelBuffer(cel.w, cel.h),
        }
      }
    }
  } else {
    // 32bpp RGBA / 16bpp Grayscale (or 8bpp with baked cel opacity) -> convert all unique cels to Indexed Color
    const prefColors: string[] = []
    const seenHex = new Set<string>()
    for (let i = 0; i < paletteRgba.length; i++) {
      const entry = paletteRgba[i]
      if (!entry || entry.a === 0) continue
      const hex = rgbaToHex(entry).toUpperCase()
      if (!seenHex.has(hex) && prefColors.length < MAX_OPAQUE_PALETTE_COLORS) {
        seenHex.add(hex)
        prefColors.push(hex)
      }
    }

    const rgbaSources = Array.from(uniqueResolvedCels.values()).map((cel) => ({
      id: cel.celId,
      width: cel.w,
      height: cel.h,
      rgba: cel.rgba ?? new Uint8ClampedArray(cel.w * cel.h * 4),
    }))

    const conv = convertRgbaBuffersToIndexed(rgbaSources, {
      name: 'Aseprite Palette',
      colors: prefColors,
    })
    finalPalette = conv.palette
    wasQuantized = conv.wasQuantized
    originalOpaqueColorCount = conv.originalOpaqueColorCount

    for (const cel of uniqueResolvedCels.values()) {
      celBuffers[cel.celId] = {
        id: cel.celId,
        offsetX: cel.x,
        offsetY: cel.y,
        dataWidth: cel.w,
        dataHeight: cel.h,
        data: conv.buffers.get(cel.celId) ?? createPixelBuffer(cel.w, cel.h),
      }
    }
  }

  if (wasQuantized) {
    warnings.push({
      code: 'colors-quantized',
      detail: `${originalOpaqueColorCount} → ${finalPalette.colors.length}`,
    })
  }

  const firstFrameId = frames[0]!.id
  const layers: LayerRuntime[] = imageLayerEntries.map(({ meta }) => {
    const ref = cels[makeCellKey(meta.id, firstFrameId)]
    if (ref?.kind === 'cel' && celBuffers[ref.celId]) {
      const cb = celBuffers[ref.celId]!
      return {
        ...meta,
        offsetX: cb.offsetX,
        offsetY: cb.offsetY,
        dataWidth: cb.dataWidth,
        dataHeight: cb.dataHeight,
        data: new Uint8Array(cb.data),
      }
    }
    return {
      ...meta,
      offsetX: 0,
      offsetY: 0,
      dataWidth: width,
      dataHeight: height,
      data: createPixelBuffer(width, height),
    }
  })

  return {
    width,
    height,
    colorDepth,
    frameCount: frames.length,
    layerCount: layers.length,
    linkedCelCount,
    fitsCanvasLimit,
    layers,
    frames,
    cels,
    celBuffers,
    palette: finalPalette,
    tagNames,
    warnings,
    wasQuantized,
    originalOpaqueColorCount,
  }
}

export interface ExportAsepriteOptions {
  width: number
  height: number
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  palette?: ProjectPalette
  paletteColors?: readonly string[]
}

export interface ExportAsepriteResult {
  bytes: Uint8Array
  frameCount: number
  layerCount: number
  linkedCelCount: number
  hasClippingWarning: boolean
}

function trimIndexedSubRect(
  data: Uint8Array,
  dw: number,
  dh: number,
  baseOffsetX: number,
  baseOffsetY: number
): { x: number; y: number; w: number; h: number; subData: Uint8Array } | null {
  let minX = dw
  let minY = dh
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (data[y * dw + x] !== TRANSPARENT_INDEX) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) return null

  const outW = maxX - minX + 1
  const outH = maxY - minY + 1
  const sub = new Uint8Array(outW * outH)
  for (let y = 0; y < outH; y++) {
    const srcStart = (minY + y) * dw + minX
    sub.set(data.subarray(srcStart, srcStart + outW), y * outW)
  }

  return {
    x: baseOffsetX + minX,
    y: baseOffsetY + minY,
    w: outW,
    h: outH,
    subData: sub,
  }
}

function writeChunk(
  out: BinaryWriter,
  chunkType: number,
  buildPayload: (cw: BinaryWriter) => void
): void {
  const start = out.length
  out.u32(0)
  out.u16(chunkType)
  buildPayload(out)
  const totalSize = out.length - start
  out.patchU32(start, totalSize)
}

/**
 * Encode a dotdot project into a spec-compliant **8bpp Indexed Color** `.aseprite` binary (Section 9-3):
 * - `colorDepth = 8`, `transparentIndex = 255` (`TRANSPARENT_INDEX`)
 * - Fixed palette indices `0..254` map 1:1 to Aseprite palette entries `0..254`, and `255` is reserved transparent `[0,0,0,0]`
 * - Preserves Linked Cels (`Cel Type = 1`), layer opacity (`0..100` -> `0..255`), blend modes, visibility, lock state, and frame durations!
 */
export function encodeAsepriteBytes(
  options: ExportAsepriteOptions
): ExportAsepriteResult {
  const {
    width,
    height,
    layerMetas,
    frames: rawFrames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    palette: rawPalette,
    paletteColors,
  } = options

  const frames: FrameMeta[] =
    rawFrames.length > 0 ? [...rawFrames] : [{ id: 'frame-1', durationMs: 100 }]

  const normPalette = normalizeProjectPalette(
    rawPalette ?? {
      name: 'Palette',
      colors:
        paletteColors && paletteColors.length > 0
          ? [...paletteColors]
          : ['#000000', '#FFFFFF'],
    }
  )
  const colorTable = normPalette.colorTable!

  const hasClippingWarning = layerMetas.some((l) => l.clipping)
  let linkedCelCount = 0

  const w = new BinaryWriter(8192)

  // 128-byte Aseprite Header (8bpp Indexed Color, transparent index = 255)
  w.u32(0) // placeholder file size
  w.u16(ASE_FILE_MAGIC)
  w.u16(frames.length)
  w.u16(width)
  w.u16(height)
  w.u16(8) // 8bpp Indexed Color!
  w.u32(1) // flags = 1 (layer opacity has valid value)
  w.u16(frames[0]?.durationMs ?? 100)
  w.u32(0)
  w.u32(0)
  w.u8(TRANSPARENT_INDEX) // transparent palette entry index = 255!
  w.zeros(3)
  w.u16(256) // 256-entry palette table (`0..254` fixed slots + `255` transparent)
  w.u8(1)
  w.u8(1)
  w.i16(0)
  w.i16(0)
  w.u16(Math.min(16, width))
  w.u16(Math.min(16, height))
  w.zeros(84)

  const writtenCelFirstFrame = new Map<string, number>()

  for (let fIdx = 0; fIdx < frames.length; fIdx++) {
    const frame = frames[fIdx]!
    const frameStart = w.length
    w.u32(0)
    w.u16(ASE_FRAME_MAGIC)
    w.u16(0)
    w.u16(clampFrameDurationMs(frame.durationMs))
    w.zeros(2)
    w.u32(0)

    let chunkCount = 0

    if (fIdx === 0) {
      // 1. sRGB Color Profile (`0x2007`)
      writeChunk(w, CHUNK_COLOR_PROFILE, (cw) => {
        cw.u16(1)
        cw.u16(0)
        cw.u32(0)
        cw.zeros(8)
      })
      chunkCount++

      // 2. New Palette Chunk (`0x2019`): entries `0..254` (unassigned slots get alpha 0) + entry `255` transparent `[0,0,0,0]`
      writeChunk(w, CHUNK_PALETTE, (cw) => {
        cw.u32(256)
        cw.u32(0)
        cw.u32(255)
        cw.zeros(8)
        for (let ci = 0; ci < MAX_OPAQUE_PALETTE_COLORS; ci++) {
          const hex = colorTable[ci]
          cw.u16(0)
          if (hex) {
            const rgb = hexToRgba(hex)
            cw.u8(rgb.r)
            cw.u8(rgb.g)
            cw.u8(rgb.b)
            cw.u8(255)
          } else {
            cw.u8(0)
            cw.u8(0)
            cw.u8(0)
            cw.u8(0)
          }
        }
        // Entry 255: reserved transparent index
        cw.u16(0)
        cw.u8(0)
        cw.u8(0)
        cw.u8(0)
        cw.u8(0)
      })
      chunkCount++

      // 3. Old Palette Chunk (`0x0004`) for legacy readers
      writeChunk(w, CHUNK_OLD_PALETTE_256, (cw) => {
        cw.u16(1)
        cw.u8(0)
        cw.u8(0) // 0 means 256 colors in Old Palette Chunk
        for (let ci = 0; ci < MAX_OPAQUE_PALETTE_COLORS; ci++) {
          const hex = colorTable[ci]
          if (hex) {
            const rgb = hexToRgba(hex)
            cw.u8(rgb.r)
            cw.u8(rgb.g)
            cw.u8(rgb.b)
          } else {
            cw.u8(0)
            cw.u8(0)
            cw.u8(0)
          }
        }
        cw.u8(0)
        cw.u8(0)
        cw.u8(0)
      })
      chunkCount++

      // 4. Layer Chunks (`0x2004`)
      for (let lIdx = 0; lIdx < layerMetas.length; lIdx++) {
        const layer = layerMetas[lIdx]!
        writeChunk(w, CHUNK_LAYER, (cw) => {
          let flags = 0
          if (layer.visible) flags |= 1
          if (!layer.locked) flags |= 2
          cw.u16(flags)
          cw.u16(0)
          cw.u16(0)
          cw.u16(0)
          cw.u16(0)
          cw.u16(DOTDOT_TO_ASE_BLEND[layer.blendMode] ?? 0)
          cw.u8(Math.max(0, Math.min(255, Math.round((layer.opacity / 100) * 255))))
          cw.zeros(3)
          cw.str(layer.name || `Layer ${lIdx + 1}`)
        })
        chunkCount++
      }
    }

    // 5. Cel Chunks (`0x2005`)
    for (let lIdx = 0; lIdx < layerMetas.length; lIdx++) {
      const layer = layerMetas[lIdx]!
      const ref = cels[makeCellKey(layer.id, frame.id)]

      if (ref?.kind === 'cel' && celBuffers[ref.celId]) {
        const mapKey = `${lIdx}:${ref.celId}`
        const prevLinkedFrame = writtenCelFirstFrame.get(mapKey)
        if (prevLinkedFrame !== undefined) {
          linkedCelCount++
          writeChunk(w, CHUNK_CEL, (cw) => {
            cw.u16(lIdx)
            cw.i16(0)
            cw.i16(0)
            cw.u8(255)
            cw.u16(1)
            cw.i16(0)
            cw.zeros(5)
            cw.u16(prevLinkedFrame)
          })
          chunkCount++
          continue
        }

        const cb = celBuffers[ref.celId]!
        const trimmed = trimIndexedSubRect(
          cb.data,
          cb.dataWidth,
          cb.dataHeight,
          cb.offsetX,
          cb.offsetY
        )
        if (!trimmed) continue

        writtenCelFirstFrame.set(mapKey, fIdx)
        const compressed = zlibSync(trimmed.subData, { level: 6 })
        writeChunk(w, CHUNK_CEL, (cw) => {
          cw.u16(lIdx)
          cw.i16(Math.max(-32768, Math.min(32767, trimmed.x)))
          cw.i16(Math.max(-32768, Math.min(32767, trimmed.y)))
          cw.u8(255)
          cw.u16(2)
          cw.i16(0)
          cw.zeros(5)
          cw.u16(trimmed.w)
          cw.u16(trimmed.h)
          cw.bytes(compressed)
        })
        chunkCount++
      } else if (
        Object.keys(cels).length === 0 &&
        fIdx === 0 &&
        fallbackSingleFrameLayers
      ) {
        const fb = fallbackSingleFrameLayers.find((fl) => fl.id === layer.id)
        if (!fb) continue
        const trimmed = trimIndexedSubRect(
          fb.data,
          fb.dataWidth,
          fb.dataHeight,
          fb.offsetX,
          fb.offsetY
        )
        if (!trimmed) continue
        const compressed = zlibSync(trimmed.subData, { level: 6 })
        writeChunk(w, CHUNK_CEL, (cw) => {
          cw.u16(lIdx)
          cw.i16(Math.max(-32768, Math.min(32767, trimmed.x)))
          cw.i16(Math.max(-32768, Math.min(32767, trimmed.y)))
          cw.u8(255)
          cw.u16(2)
          cw.i16(0)
          cw.zeros(5)
          cw.u16(trimmed.w)
          cw.u16(trimmed.h)
          cw.bytes(compressed)
        })
        chunkCount++
      }
    }

    const frameTotalBytes = w.length - frameStart
    w.patchU32(frameStart, frameTotalBytes)
    const frameView = new DataView(w.buf.buffer, w.buf.byteOffset, w.length)
    frameView.setUint16(frameStart + 6, Math.min(0xffff, chunkCount), true)
    frameView.setUint32(frameStart + 12, chunkCount, true)
  }

  w.patchU32(0, w.length)

  return {
    bytes: w.toUint8Array(),
    frameCount: frames.length,
    layerCount: layerMetas.length,
    linkedCelCount,
    hasClippingWarning,
  }
}
