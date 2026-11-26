import { unzlibSync, zlibSync } from 'fflate'
import type {
  BlendMode,
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  ProjectPalette,
} from '../types'
import { hexToRgba, rgbaToHex } from './color'
import { MAX_LAYERS } from './compositor'
import { createPixelBuffer, MAX_CANVAS_SIZE } from './pixelBuffer'
import { clampFrameDurationMs, makeCellKey } from './animation'
import { extractPaletteColorsFromRgba } from './pngImport'

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
  private buf: Uint8Array
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
  layerType: number // 0 = normal image, 1 = group, 2 = tilemap
  name: string
  visible: boolean
  locked: boolean
  opacity255: number
  blendModeNum: number
  childLevel: number
}

/**
 * Parse and inspect an Aseprite `.ase` / `.aseprite` binary file completely offline in-browser.
 * Maps Linked Cels (`celType === 1`) directly to dotdot shared `celId` references!
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
  r.skip(8) // two zero DWORDs
  const transparentIndex = r.u8()
  r.skip(3)
  const _numColors = r.u16()
  void _numColors
  const pixelW = r.u8()
  const pixelH = r.u8()
  r.skip(92) // grid (8 bytes) + future reserved (84 bytes) -> total 128 bytes

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

  // Palette table RGBA (up to 256 entries for 8bpp indexed or general palette)
  const paletteRgba: Array<{ r: number; g: number; b: number; a: number }> = []
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

  // Store per `(aseLayerIndex, frameIndex)` cel entries before mapping to dotdot layers
  type TempCelEntry =
    | {
        kind: 'image'
        x: number
        y: number
        w: number
        h: number
        rgba: Uint8ClampedArray
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
        while (paletteRgba.length < Math.min(256, newSize)) {
          paletteRgba.push({ r: 0, g: 0, b: 0, a: 255 })
        }
        for (let ci = firstIdx; ci <= lastIdx && r.pos + 6 <= chunkEnd; ci++) {
          const entryFlags = r.u16()
          const cr = r.u8()
          const cg = r.u8()
          const cb = r.u8()
          const ca = r.u8()
          if ((entryFlags & 1) !== 0) {
            r.str() // color name
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
        r.skip(4) // defaultW, defaultH
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
        r.skip(7) // zIndex (SHORT) + future (5 bytes)

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
            // 8bpp Indexed: `transparentIndex` maps to alpha 0 (except background layer if flagged, standard sprite behavior)
            for (let p = 0; p < cw * ch; p++) {
              const idx8 = pixelBytes[p]!
              const di = p * 4
              if (idx8 === transparentIndex) {
                rgba[di] = 0
                rgba[di + 1] = 0
                rgba[di + 2] = 0
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
            bakedCelOpacityCount++
            const factor = celOpacity / 255
            for (let i = 3; i < rgba.length; i += 4) {
              rgba[i] = Math.round(rgba[i]! * factor)
            }
          }

          if (cw > 0 && ch > 0) {
            tempCelGrid.set(key, {
              kind: 'image',
              x: celX,
              y: celY,
              w: cw,
              h: ch,
              rgba,
              celId: `ase-cel-${nextCelSeq++}`,
            })
          }
        } else if (celType === 3) {
          tilemapCount++
        }
      } else if (chunkType === CHUNK_TAGS) {
        const numTags = r.u16()
        r.skip(8)
        for (let ti = 0; ti < numTags && r.pos < chunkEnd; ti++) {
          if (r.pos + 17 > chunkEnd) break
          r.skip(17) // from(2) + to(2) + loopDir(1) + repeat(2) + zero(6) + rgb(3) + extra(1)
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

  // Propagate effective group visibility to child layers when groups exist
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

  if (groupCount > 0) {
    warnings.push({
      code: 'layer-groups-flattened',
      detail: `${groupCount}`,
    })
  }
  if (tilemapCount > 0) {
    warnings.push({
      code: 'tilemap-layers-skipped',
      detail: `${tilemapCount}`,
    })
  }
  if (unsupportedBlendCount > 0) {
    warnings.push({
      code: 'unsupported-blend-mode',
      detail: `${unsupportedBlendCount}`,
    })
  }
  if (bakedCelOpacityCount > 0) {
    warnings.push({
      code: 'cel-opacity-baked',
      detail: `${bakedCelOpacityCount}`,
    })
  }
  if (tagNames.length > 0) {
    warnings.push({
      code: 'tags-ignored',
      detail: tagNames.join(', '),
    })
  }
  if (sliceCount > 0) {
    warnings.push({
      code: 'slices-ignored',
      detail: `${sliceCount}`,
    })
  }
  if (sawIccProfile) {
    warnings.push({
      code: 'icc-profile-ignored',
      detail: 'ICC → sRGB',
    })
  }

  const celBuffers: Record<string, CelBufferRuntime> = {}
  const cels: CelMap = {}
  let linkedCelCount = 0

  // Resolve cel references (supporting chained Linked Cels safely without infinite loops)
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
      if (!celBuffers[resolved.celId]) {
        celBuffers[resolved.celId] = {
          id: resolved.celId,
          offsetX: resolved.x,
          offsetY: resolved.y,
          dataWidth: resolved.w,
          dataHeight: resolved.h,
          data: resolved.rgba,
        }
      }
      cels[cellKey] = { kind: 'cel', celId: resolved.celId }
    }
  }

  // Build Frame 1 LayerRuntime array
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
        data: new Uint8ClampedArray(cb.data),
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

  // Build ProjectPalette from Aseprite palette chunk (deduplicated opaque hexes, fallback to pixel extraction)
  const paletteColors: string[] = []
  const seenHex = new Set<string>()
  for (let i = 0; i < paletteRgba.length; i++) {
    const entry = paletteRgba[i]
    if (!entry) continue
    if (colorDepth === 8 && i === transparentIndex) continue
    if (entry.a === 0) continue
    const hex = rgbaToHex(entry).toUpperCase()
    if (!seenHex.has(hex) && paletteColors.length < 256) {
      seenHex.add(hex)
      paletteColors.push(hex)
    }
  }

  if (paletteColors.length === 0) {
    const firstCel = Object.values(celBuffers)[0]
    const extracted = firstCel
      ? extractPaletteColorsFromRgba(firstCel.data)
      : ['#000000', '#FFFFFF']
    paletteColors.push(...extracted)
  }

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
    palette: {
      name: 'Aseprite Palette',
      colors: paletteColors.slice(0, 256),
    },
    tagNames,
    warnings,
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
  paletteColors: readonly string[]
}

export interface ExportAsepriteResult {
  bytes: Uint8Array
  frameCount: number
  layerCount: number
  linkedCelCount: number
  hasClippingWarning: boolean
}

function trimOpaqueSubRect(
  data: Uint8ClampedArray,
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
      if (data[(y * dw + x) * 4 + 3]! > 0) {
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
  const sub = new Uint8Array(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    const srcStart = ((minY + y) * dw + minX) * 4
    sub.set(data.subarray(srcStart, srcStart + outW * 4), y * outW * 4)
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
  out.u32(0) // placeholder chunk size
  out.u16(chunkType)
  buildPayload(out)
  const totalSize = out.length - start
  out.patchU32(start, totalSize)
}

/**
 * Encode a dotdot project (still or multi-frame animation) into a spec-compliant 32bpp RGBA `.aseprite` binary:
 * - Preserves layer order (bottom-to-top), layer names, visibility, lock state, opacity (`0..100` -> `0..255`), and blend modes.
 * - Preserves frame count and per-frame durations (`durationMs`).
 * - Preserves Linked Cels (`Cel Type = 1`) whenever multiple frames in the same layer share the same non-empty `celId`!
 * - Compresses pixel cels via ZLIB (`Cel Type = 2`) and trims empty transparent bounds with exact `(x, y)` cel offsets.
 * - Writes sRGB Color Profile (`0x2007`), New Palette (`0x2019`), and Legacy Palette (`0x0004`) chunks for universal compatibility.
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
    paletteColors,
  } = options

  const frames: FrameMeta[] =
    rawFrames.length > 0 ? [...rawFrames] : [{ id: 'frame-1', durationMs: 100 }]

  const colors =
    paletteColors.length > 0
      ? paletteColors.slice(0, 255)
      : ['#000000', '#FFFFFF']
  // Entry 0 reserved as transparent index `0` in palette (`[0,0,0,0]`), followed by project colors
  const totalPaletteEntries = Math.min(256, colors.length + 1)

  const hasClippingWarning = layerMetas.some((l) => l.clipping)
  let linkedCelCount = 0

  const w = new BinaryWriter(8192)

  // 128-byte Aseprite Header
  w.u32(0) // placeholder file size
  w.u16(ASE_FILE_MAGIC)
  w.u16(frames.length)
  w.u16(width)
  w.u16(height)
  w.u16(32) // 32bpp RGBA
  w.u32(1) // flags = 1 (layer opacity has valid value)
  w.u16(frames[0]?.durationMs ?? 100) // deprecated speed
  w.u32(0)
  w.u32(0)
  w.u8(0) // transparent palette entry index = 0
  w.zeros(3)
  w.u16(totalPaletteEntries)
  w.u8(1) // pixel width 1:1
  w.u8(1) // pixel height 1:1
  w.i16(0) // grid X
  w.i16(0) // grid Y
  w.u16(Math.min(16, width)) // grid W
  w.u16(Math.min(16, height)) // grid H
  w.zeros(84)

  // Track first non-empty written frame index per `(layerIdx, celId)` so subsequent shared cels emit Linked Cel (`celType = 1`)!
  const writtenCelFirstFrame = new Map<string, number>()

  for (let fIdx = 0; fIdx < frames.length; fIdx++) {
    const frame = frames[fIdx]!
    const frameStart = w.length
    w.u32(0) // placeholder frame bytes
    w.u16(ASE_FRAME_MAGIC)
    w.u16(0) // placeholder old chunk count
    w.u16(clampFrameDurationMs(frame.durationMs))
    w.zeros(2)
    w.u32(0) // placeholder new chunk count

    let chunkCount = 0

    if (fIdx === 0) {
      // 1. Color Profile Chunk (`0x2007`: sRGB)
      writeChunk(w, CHUNK_COLOR_PROFILE, (cw) => {
        cw.u16(1) // 1 = sRGB
        cw.u16(0) // flags
        cw.u32(0) // fixed gamma unused
        cw.zeros(8)
      })
      chunkCount++

      // 2. New Palette Chunk (`0x2019`)
      writeChunk(w, CHUNK_PALETTE, (cw) => {
        cw.u32(totalPaletteEntries)
        cw.u32(0)
        cw.u32(totalPaletteEntries - 1)
        cw.zeros(8)
        // Index 0: transparent slot
        cw.u16(0)
        cw.u8(0)
        cw.u8(0)
        cw.u8(0)
        cw.u8(0)
        for (let ci = 0; ci < totalPaletteEntries - 1; ci++) {
          const rgb = hexToRgba(colors[ci]!)
          cw.u16(0)
          cw.u8(rgb.r)
          cw.u8(rgb.g)
          cw.u8(rgb.b)
          cw.u8(255)
        }
      })
      chunkCount++

      // 3. Old Palette Chunk (`0x0004`) as recommended by Aseprite spec for older readers
      writeChunk(w, CHUNK_OLD_PALETTE_256, (cw) => {
        cw.u16(1) // 1 packet
        cw.u8(0) // skip 0
        cw.u8(totalPaletteEntries === 256 ? 0 : totalPaletteEntries)
        cw.u8(0)
        cw.u8(0)
        cw.u8(0)
        for (let ci = 0; ci < totalPaletteEntries - 1; ci++) {
          const rgb = hexToRgba(colors[ci]!)
          cw.u8(rgb.r)
          cw.u8(rgb.g)
          cw.u8(rgb.b)
        }
      })
      chunkCount++

      // 4. Layer Chunks (`0x2004`) in bottom-to-top order
      for (let lIdx = 0; lIdx < layerMetas.length; lIdx++) {
        const layer = layerMetas[lIdx]!
        writeChunk(w, CHUNK_LAYER, (cw) => {
          let flags = 0
          if (layer.visible) flags |= 1
          if (!layer.locked) flags |= 2 // editable
          cw.u16(flags)
          cw.u16(0) // Normal image layer
          cw.u16(0) // child level 0
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

    // 5. Cel Chunks (`0x2005`) for this frame
    for (let lIdx = 0; lIdx < layerMetas.length; lIdx++) {
      const layer = layerMetas[lIdx]!
      const ref = cels[makeCellKey(layer.id, frame.id)]

      if (ref?.kind === 'cel' && celBuffers[ref.celId]) {
        const mapKey = `${lIdx}:${ref.celId}`
        const prevLinkedFrame = writtenCelFirstFrame.get(mapKey)
        if (prevLinkedFrame !== undefined) {
          // Emit Linked Cel (`celType = 1`) pointing to `prevLinkedFrame`!
          linkedCelCount++
          writeChunk(w, CHUNK_CEL, (cw) => {
            cw.u16(lIdx)
            cw.i16(0)
            cw.i16(0)
            cw.u8(255)
            cw.u16(1) // celType = 1 (Linked Cel)
            cw.i16(0)
            cw.zeros(5)
            cw.u16(prevLinkedFrame)
          })
          chunkCount++
          continue
        }

        const cb = celBuffers[ref.celId]!
        const trimmed = trimOpaqueSubRect(
          cb.data,
          cb.dataWidth,
          cb.dataHeight,
          cb.offsetX,
          cb.offsetY
        )
        if (!trimmed) {
          // Completely transparent cel -> omit chunk (= empty cel in Aseprite) unless linked later;
          // if linked later, empty cel in both frames is already identical!
          continue
        }

        writtenCelFirstFrame.set(mapKey, fIdx)
        const compressed = zlibSync(trimmed.subData, { level: 6 })
        writeChunk(w, CHUNK_CEL, (cw) => {
          cw.u16(lIdx)
          cw.i16(Math.max(-32768, Math.min(32767, trimmed.x)))
          cw.i16(Math.max(-32768, Math.min(32767, trimmed.y)))
          cw.u8(255)
          cw.u16(2) // celType = 2 (Compressed Image)
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
        const trimmed = trimOpaqueSubRect(
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
    // Patch oldChunks (capped at 0xFFFF) and newChunks
    const frameView = new DataView(
      w['buf'].buffer,
      w['buf'].byteOffset,
      w.length
    )
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
