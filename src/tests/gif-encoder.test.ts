import { describe, expect, it } from 'vitest'
import {
  encodeAnimatedGif,
  encodeAnimatedGifSync,
  quantizeRgbaFrame1x,
} from '../engine/gifEncoder'

interface ParsedGifFrameInfo {
  disposalMethod: number
  transparentFlag: boolean
  transparentIndex: number
  delayCs: number
  width: number
  height: number
  localColorTableCount: number
  decodedIndices: Uint8Array
}

interface ParsedGifSummary {
  header: string
  logicalWidth: number
  logicalHeight: number
  hasNetscapeLoop: boolean
  frames: ParsedGifFrameInfo[]
}

function lzwDecompress(
  minCodeSize: number,
  compressedBytes: Uint8Array,
  expectedPixelCount: number
): Uint8Array {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1

  let dict: number[][] = []
  let codeSize = minCodeSize + 1

  const resetDict = () => {
    dict = []
    for (let i = 0; i < clearCode; i++) {
      dict[i] = [i]
    }
    dict[clearCode] = []
    dict[eoiCode] = []
    codeSize = minCodeSize + 1
  }

  resetDict()

  let bitPos = 0
  const totalBits = compressedBytes.length * 8
  const readCode = (): number | null => {
    if (bitPos + codeSize > totalBits) return null
    let val = 0
    for (let b = 0; b < codeSize; b++) {
      const byteIdx = (bitPos + b) >>> 3
      const bitIdx = (bitPos + b) & 7
      if ((compressedBytes[byteIdx]! & (1 << bitIdx)) !== 0) {
        val |= 1 << b
      }
    }
    bitPos += codeSize
    return val
  }

  const out: number[] = []
  let prevSeq: number[] | null = null

  while (out.length < expectedPixelCount) {
    const code = readCode()
    if (code === null || code === eoiCode) break
    if (code === clearCode) {
      resetDict()
      prevSeq = null
      continue
    }

    let entry: number[]
    if (code < dict.length && dict[code]) {
      entry = dict[code]!
    } else if (code === dict.length && prevSeq) {
      entry = [...prevSeq, prevSeq[0]!]
    } else {
      throw new Error(`Invalid LZW code ${code}`)
    }

    for (let i = 0; i < entry.length; i++) {
      out.push(entry[i]!)
    }

    if (prevSeq !== null && dict.length < 4096) {
      dict.push([...prevSeq, entry[0]!])
      if (dict.length === 1 << codeSize && codeSize < 12) {
        codeSize++
      }
    }
    prevSeq = entry
  }

  return new Uint8Array(out)
}

function parseGif89a(bytes: Uint8Array): ParsedGifSummary {
  const header = String.fromCharCode(...bytes.subarray(0, 6))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const logicalWidth = view.getUint16(6, true)
  const logicalHeight = view.getUint16(8, true)
  const lsdPacked = bytes[10]!
  let offset = 13
  if ((lsdPacked & 0x80) !== 0) {
    const gctSize = 1 << ((lsdPacked & 0x07) + 1)
    offset += gctSize * 3
  }

  let hasNetscapeLoop = false
  const frames: ParsedGifFrameInfo[] = []
  let pendingDisposal = 0
  let pendingTransFlag = false
  let pendingTransIdx = 0
  let pendingDelayCs = 0

  while (offset < bytes.length) {
    const introducer = bytes[offset++]!
    if (introducer === 0x3b) {
      break
    }
    if (introducer === 0x21) {
      const label = bytes[offset++]!
      if (label === 0xf9) {
        const blockSize = bytes[offset++]!
        expect(blockSize).toBe(4)
        const packed = bytes[offset++]!
        pendingDisposal = (packed >>> 2) & 0x07
        pendingTransFlag = (packed & 0x01) !== 0
        pendingDelayCs = view.getUint16(offset, true)
        offset += 2
        pendingTransIdx = bytes[offset++]!
        offset++ // terminator 0x00
      } else if (label === 0xff) {
        const blockSize = bytes[offset++]!
        const appId = String.fromCharCode(...bytes.subarray(offset, offset + blockSize))
        offset += blockSize
        if (appId === 'NETSCAPE2.0') {
          hasNetscapeLoop = true
        }
        while (offset < bytes.length) {
          const subLen = bytes[offset++]!
          if (subLen === 0) break
          offset += subLen
        }
      } else {
        while (offset < bytes.length) {
          const subLen = bytes[offset++]!
          if (subLen === 0) break
          offset += subLen
        }
      }
    } else if (introducer === 0x2c) {
      offset += 4 // left, top
      const w = view.getUint16(offset, true)
      const h = view.getUint16(offset + 2, true)
      offset += 4
      const imgPacked = bytes[offset++]!
      let lctCount = 0
      if ((imgPacked & 0x80) !== 0) {
        lctCount = 1 << ((imgPacked & 0x07) + 1)
        offset += lctCount * 3
      }
      const minCodeSize = bytes[offset++]!
      const chunks: number[] = []
      while (offset < bytes.length) {
        const subLen = bytes[offset++]!
        if (subLen === 0) break
        for (let i = 0; i < subLen; i++) {
          chunks.push(bytes[offset + i]!)
        }
        offset += subLen
      }
      const decodedIndices = lzwDecompress(
        minCodeSize,
        new Uint8Array(chunks),
        w * h
      )
      frames.push({
        disposalMethod: pendingDisposal,
        transparentFlag: pendingTransFlag,
        transparentIndex: pendingTransIdx,
        delayCs: pendingDelayCs,
        width: w,
        height: h,
        localColorTableCount: lctCount,
        decodedIndices,
      })
    } else {
      throw new Error(`Unexpected GIF block byte 0x${introducer.toString(16)}`)
    }
  }

  return {
    header,
    logicalWidth,
    logicalHeight,
    hasNetscapeLoop,
    frames,
  }
}

function makeRgbaFrame(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4)
}

function setRgbaPixel(
  buf: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  c: { r: number; g: number; b: number; a: number }
): void {
  const off = (y * width + x) * 4
  buf[off] = c.r
  buf[off + 1] = c.g
  buf[off + 2] = c.b
  buf[off + 3] = c.a
}

describe('GIF89a Animated Encoder (Disposal=2, Dither/Matte Semi-Transparency, <=256 Quantization, Ping-Pong, Scale & Cancel)', () => {
  it('encodes multi-frame transparent animation with Disposal=2, exact LZW reconstruction, ~2000px default scale, and loop control', () => {
    const f1 = makeRgbaFrame(80, 80)
    setRgbaPixel(f1, 80, 2, 2, { r: 255, g: 40, b: 80, a: 255 })
    const f2 = makeRgbaFrame(80, 80)
    setRgbaPixel(f2, 80, 10, 10, { r: 40, g: 200, b: 255, a: 255 })
    const f3 = makeRgbaFrame(80, 80)
    setRgbaPixel(f3, 80, 20, 20, { r: 120, g: 255, b: 90, a: 255 })

    // Default scale on 80x80 -> 25x (2000x2000px)
    const defaultRes = encodeAnimatedGifSync({
      width: 80,
      height: 80,
      frames: [{ rgba: f1, durationMs: 100 }],
    })
    expect(defaultRes.scale).toBe(25)
    expect(defaultRes.outWidth).toBe(2000)
    expect(defaultRes.outHeight).toBe(2000)

    // Ping-pong loop on 3 frames -> [0, 1, 2, 1] (4 frames, endpoints NOT duplicated!)
    const pingpongRes = encodeAnimatedGifSync({
      width: 80,
      height: 80,
      scale: 2,
      direction: 'pingpong',
      loop: true,
      frames: [
        { rgba: f1, durationMs: 80 },
        { rgba: f2, durationMs: 125 }, // rounds to 13cs (130ms)
        { rgba: f3, durationMs: 15 }, // < 20ms warning, clamps to 2cs (20ms)
      ],
    })

    expect(pingpongRes.encodedFrameCount).toBe(4)
    expect(pingpongRes.hasVeryShortFrameWarning).toBe(true)

    const parsed = parseGif89a(pingpongRes.gif)
    expect(parsed.header).toBe('GIF89a')
    expect(parsed.logicalWidth).toBe(160)
    expect(parsed.logicalHeight).toBe(160)
    expect(parsed.hasNetscapeLoop).toBe(true)
    expect(parsed.frames.length).toBe(4)

    for (const frame of parsed.frames) {
      expect(frame.disposalMethod).toBe(2) // Restore to background -> zero ghosting!
      expect(frame.transparentFlag).toBe(true)
      expect(frame.decodedIndices.length).toBe(160 * 160)
    }
    expect(parsed.frames[0]!.delayCs).toBe(8)
    expect(parsed.frames[1]!.delayCs).toBe(13)
    expect(parsed.frames[2]!.delayCs).toBe(2)
    expect(parsed.frames[3]!.delayCs).toBe(13)

    // Verify `loop: false` omits NETSCAPE2.0 extension
    const onceRes = encodeAnimatedGifSync({
      width: 80,
      height: 80,
      scale: 1,
      loop: false,
      frames: [
        { rgba: f1, durationMs: 100 },
        { rgba: f2, durationMs: 100 },
      ],
    })
    expect(parseGif89a(onceRes.gif).hasNetscapeLoop).toBe(false)
  })

  it('handles semi-transparent pixels via 4x4 Bayer Dither vs Matte blend and quantizes >256 colors cleanly within <=256 limit', () => {
    const semi = makeRgbaFrame(16, 16)
    // Fill upper half with 50% alpha red, lower half fully transparent
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        setRgbaPixel(semi, 16, x, y, { r: 240, g: 60, b: 80, a: 128 })
      }
    }

    const ditherIndexed = quantizeRgbaFrame1x(semi, 16, 16, 'dither', {
      r: 0,
      g: 0,
      b: 0,
    })
    expect(ditherIndexed.hasTransparency).toBe(true)
    // In 4x4 Bayer at alpha=128 (~50%), roughly half of the 128 semi-transparent pixels become opaque and half transparent
    let opaqueCountDither = 0
    for (let p = 0; p < 8 * 16; p++) {
      if (ditherIndexed.indices1x[p] !== ditherIndexed.transparentIndex) {
        opaqueCountDither++
      }
    }
    expect(opaqueCountDither).toBe(64)

    // In Matte mode, ALL 128 semi-transparent pixels become opaque blended against matte RGB, while lower half (a=0) stays transparent!
    const matteIndexed = quantizeRgbaFrame1x(semi, 16, 16, 'matte', {
      r: 20,
      g: 20,
      b: 30,
    })
    expect(matteIndexed.hasTransparency).toBe(true)
    let opaqueCountMatte = 0
    for (let p = 0; p < 8 * 16; p++) {
      if (matteIndexed.indices1x[p] !== matteIndexed.transparentIndex) {
        opaqueCountMatte++
      }
    }
    expect(opaqueCountMatte).toBe(128)
    for (let p = 8 * 16; p < 16 * 16; p++) {
      expect(matteIndexed.indices1x[p]).toBe(matteIndexed.transparentIndex)
    }

    // Over 500 distinct colors + transparency -> quantized strictly to <= 256 table entries (255 opaque + 1 transparent)
    const manyColors = makeRgbaFrame(32, 32)
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 32; x++) {
        setRgbaPixel(manyColors, 32, x, y, {
          r: (x * 8) & 0xff,
          g: (y * 8) & 0xff,
          b: ((x + y) * 4) & 0xff,
          a: 255,
        })
      }
    }
    const quantMany = quantizeRgbaFrame1x(manyColors, 32, 32, 'dither', {
      r: 0,
      g: 0,
      b: 0,
    })
    expect(quantMany.colorTableBytes.length).toBeLessThanOrEqual(256 * 3)
    expect(quantMany.transparentIndex).toBe(255)
  })

  it('supports async progress reporting and AbortController cancellation', async () => {
    const f1 = makeRgbaFrame(16, 16)
    setRgbaPixel(f1, 16, 1, 1, { r: 255, g: 0, b: 0, a: 255 })
    const f2 = makeRgbaFrame(16, 16)
    setRgbaPixel(f2, 16, 2, 2, { r: 0, g: 255, b: 0, a: 255 })
    const f3 = makeRgbaFrame(16, 16)
    setRgbaPixel(f3, 16, 3, 3, { r: 0, g: 0, b: 255, a: 255 })

    const progressSteps: Array<[number, number]> = []
    const okRes = await encodeAnimatedGif({
      width: 16,
      height: 16,
      scale: 2,
      frames: [
        { rgba: f1, durationMs: 100 },
        { rgba: f2, durationMs: 100 },
        { rgba: f3, durationMs: 100 },
      ],
      onProgress: (done, total) => progressSteps.push([done, total]),
    })
    expect(okRes.encodedFrameCount).toBe(3)
    expect(progressSteps).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])

    const controller = new AbortController()
    const abortPromise = encodeAnimatedGif({
      width: 16,
      height: 16,
      scale: 2,
      frames: [
        { rgba: f1, durationMs: 100 },
        { rgba: f2, durationMs: 100 },
        { rgba: f3, durationMs: 100 },
      ],
      signal: controller.signal,
      onProgress: (done) => {
        if (done === 1) controller.abort()
      },
    })
    await expect(abortPromise).rejects.toThrow(/aborted/i)
  })
})
