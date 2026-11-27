import type { ProjectPalette } from '../types'
import { hexToRgba, rgbaToHex } from './color'
import {
  labDistanceSq,
  MAX_OPAQUE_PALETTE_COLORS,
  normalizeProjectPalette,
  quantizeColorsPerceptually,
  rgbToLab,
  TRANSPARENT_INDEX,
  type ColorSample,
  type LabVec,
} from './indexedPalette'

export type CameraFitMode = 'contain' | 'cover'
export type CameraFinishMode = 'auto' | 'crisp' | 'retro'
export type CameraBayeMatrixSize = 4 | 8
export type CameraBackendKind = 'webgpu' | 'canvas2d'

export const AUTO_PALETTE_COLOR_COUNTS = [8, 16, 32, 64, 128, 255] as const
export type AutoPaletteColorCount = (typeof AUTO_PALETTE_COLOR_COUNTS)[number]

export const CAMERA_SIZE_PRESETS: ReadonlyArray<{
  width: number
  height: number
  label: string
}> = [
  { width: 16, height: 16, label: '16×16' },
  { width: 32, height: 32, label: '32×32' },
  { width: 48, height: 48, label: '48×48' },
  { width: 64, height: 64, label: '64×64' },
  { width: 80, height: 80, label: '80×80' },
  { width: 96, height: 96, label: '96×96' },
  { width: 128, height: 128, label: '128×128' },
  { width: 160, height: 160, label: '160×160' },
  { width: 192, height: 192, label: '192×192' },
  { width: 256, height: 256, label: '256×256' },
]

export interface CameraTransformParams {
  canvasWidth: number
  canvasHeight: number
  fitMode: CameraFitMode
  /** Normalized pan offset in `[-1..1]` used when `fitMode === 'cover'` (`0` = centered) */
  cropPanX: number
  cropPanY: number
  /** Horizontal mirror (selfie mirror) */
  mirrorX: boolean
  finishMode: CameraFinishMode
  bayerSize: CameraBayeMatrixSize
  /** User dither strength multiplier in `[0..2]` (`1.0` = standard) */
  ditherStrength: number
  /** Brightness offset in `[-0.5..0.5]` (`0` = neutral) */
  brightness: number
  /** Contrast multiplier in `[0.5..1.8]` (`1.0` = neutral) */
  contrast: number
  /** Saturation multiplier in `[0.0..2.0]` (`1.0` = neutral) */
  saturation: number
}

export const DEFAULT_CAMERA_TRANSFORM_PARAMS: CameraTransformParams = {
  canvasWidth: 64,
  canvasHeight: 64,
  fitMode: 'cover',
  cropPanX: 0,
  cropPanY: 0,
  mirrorX: false,
  finishMode: 'auto',
  bayerSize: 4,
  ditherStrength: 1.0,
  brightness: 0,
  contrast: 1.0,
  saturation: 1.0,
}

const BAYER_4X4: ReadonlyArray<number> = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]

const BAYER_8X8: ReadonlyArray<number> = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]

export interface PrecomputedGpuPalette {
  normalizedPalette: ProjectPalette
  count: number
  /** Active slots packed for GPU storage buffer: `256 * 8` floats (`[L, a, b, fixedIdx, rN, gN, bN, 1.0]`) */
  gpuSlotData: Float32Array
  /** CPU mirror for capture & Canvas 2D fallback */
  slots: Array<{
    fixedIndex: number
    r: number
    g: number
    b: number
    lab: LabVec
  }>
}

/**
 * Precompute CIELAB + sRGB vectors and fixed `0..254` indices from a `ProjectPalette`
 * so GPU WGSL shader and CPU capture/fallback produce identical color mapping!
 */
export function precomputePaletteForCamera(
  palette: ProjectPalette
): PrecomputedGpuPalette {
  const norm = normalizeProjectPalette(palette)
  const order = norm.displayOrder!
  const table = norm.colorTable!

  const gpuSlotData = new Float32Array(256 * 8)
  const slots: PrecomputedGpuPalette['slots'] = []

  for (let s = 0; s < order.length && s < MAX_OPAQUE_PALETTE_COLORS; s++) {
    const fixedIndex = order[s]!
    const hex = table[fixedIndex]
    if (!hex) continue
    const rgba = hexToRgba(hex, 255)
    const lab = rgbToLab(rgba.r, rgba.g, rgba.b)

    const base = slots.length * 8
    gpuSlotData[base + 0] = lab.L
    gpuSlotData[base + 1] = lab.a
    gpuSlotData[base + 2] = lab.b
    gpuSlotData[base + 3] = fixedIndex
    gpuSlotData[base + 4] = rgba.r / 255
    gpuSlotData[base + 5] = rgba.g / 255
    gpuSlotData[base + 6] = rgba.b / 255
    gpuSlotData[base + 7] = 1.0

    slots.push({
      fixedIndex,
      r: rgba.r,
      g: rgba.g,
      b: rgba.b,
      lab,
    })
  }

  return {
    normalizedPalette: norm,
    count: slots.length,
    gpuSlotData,
    slots,
  }
}

export interface AspectSampleMapping {
  /** Normalized `[0..1]` UV mapping for destination pixel `(px + 0.5, py + 0.5)` */
  scaleX: number
  scaleY: number
  offsetX: number
  offsetY: number
}

/**
 * Compute distortion-free aspect-preserving UV mapping from `(dstX, dstY)` in `[0..canvasW] x [0..canvasH]`
 * to normalized source video UV `[0..1] x [0..1]`:
 * - `'contain'`: fits entire source inside target canvas without stretching; out-of-bounds `[<0 or >1]` becomes transparent (`255`)
 * - `'cover'`: fills entire target canvas without stretching, cropping excess width or height shifted by `cropPanX/Y` in `[-1..1]`
 */
export function computeAspectSampleMapping(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  fitMode: CameraFitMode,
  cropPanX: number,
  cropPanY: number
): AspectSampleMapping {
  const sw = Math.max(1, srcWidth)
  const sh = Math.max(1, srcHeight)
  const dw = Math.max(1, dstWidth)
  const dh = Math.max(1, dstHeight)

  const srcAspect = sw / sh
  const dstAspect = dw / dh
  const panX = Math.max(-1, Math.min(1, cropPanX || 0))
  const panY = Math.max(-1, Math.min(1, cropPanY || 0))

  if (fitMode === 'contain') {
    if (srcAspect >= dstAspect) {
      // Source is wider -> full width fits, letterbox top/bottom
      const activeH = dh * (dstAspect / srcAspect)
      const padY = (dh - activeH) * 0.5
      return {
        scaleX: 1 / dw,
        scaleY: 1 / Math.max(1e-6, activeH),
        offsetX: 0,
        offsetY: -padY / Math.max(1e-6, activeH),
      }
    } else {
      // Source is taller -> full height fits, pillarbox left/right
      const activeW = dw * (srcAspect / dstAspect)
      const padX = (dw - activeW) * 0.5
      return {
        scaleX: 1 / Math.max(1e-6, activeW),
        scaleY: 1 / dh,
        offsetX: -padX / Math.max(1e-6, activeW),
        offsetY: 0,
      }
    }
  }

  // 'cover': fill canvas completely without distortion, cropping excess along wider axis
  if (srcAspect >= dstAspect) {
    // Source is wider than destination -> crop left/right
    const visibleUvW = dstAspect / srcAspect // <= 1
    const maxShift = (1 - visibleUvW) * 0.5
    const startU = (1 - visibleUvW) * 0.5 + panX * maxShift
    return {
      scaleX: visibleUvW / dw,
      scaleY: 1 / dh,
      offsetX: startU,
      offsetY: 0,
    }
  } else {
    // Source is taller than destination -> crop top/bottom
    const visibleUvH = srcAspect / dstAspect // <= 1
    const maxShift = (1 - visibleUvH) * 0.5
    const startV = (1 - visibleUvH) * 0.5 + panY * maxShift
    return {
      scaleX: 1 / dw,
      scaleY: visibleUvH / dh,
      offsetX: 0,
      offsetY: startV,
    }
  }
}

export function applyColorAdjustmentsRgb(
  r255: number,
  g255: number,
  b255: number,
  brightness: number,
  contrast: number,
  saturation: number
): [number, number, number] {
  let r = r255 / 255
  let g = g255 / 255
  let b = b255 / 255

  // Brightness & Contrast around 0.5 midpoint
  r = (r - 0.5) * contrast + 0.5 + brightness
  g = (g - 0.5) * contrast + 0.5 + brightness
  b = (b - 0.5) * contrast + 0.5 + brightness

  // Rec.709 Luma saturation
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  r = luma + (r - luma) * saturation
  g = luma + (g - luma) * saturation
  b = luma + (b - luma) * saturation

  return [
    Math.max(0, Math.min(255, Math.round(r * 255))),
    Math.max(0, Math.min(255, Math.round(g * 255))),
    Math.max(0, Math.min(255, Math.round(b * 255))),
  ]
}

export function getBayerCenteredValue(
  x: number,
  y: number,
  size: CameraBayeMatrixSize
): number {
  if (size === 8) {
    const idx = ((y & 7) << 3) | (x & 7)
    return (BAYER_8X8[idx]! + 0.5) / 64 - 0.5
  }
  const idx = ((y & 3) << 2) | (x & 3)
  return (BAYER_4X4[idx]! + 0.5) / 16 - 0.5
}

/**
 * Compute adaptive luminance + quantization-error weight for `'auto'` ("おまかせ") mode:
 * - Suppresses noisy dithering in very dark shadows (`L < 14`) and bright highlights (`L > 90`)
 * - Suppresses dithering when the palette already contains a very close match (`deltaE < 3.0`)
 * - Boosts dithering in midtones and regions with noticeable palette quantization gap (`deltaE` 4..26)
 */
export function computeAutoDitherModulation(
  labL: number,
  nearestDeltaE: number
): number {
  // Smooth bell curve across L in [0..100]: quiet near 0 and 100, strongest in [22..82]
  const shadowGate = Math.max(0, Math.min(1, (labL - 8) / 18))
  const highlightGate = Math.max(0, Math.min(1, (95 - labL) / 16))
  const midtoneWeight = shadowGate * highlightGate

  // Error gate: 0 when nearest palette color is almost exact (< 2.5 Lab units), ramps up to 1 by ~18 Lab units
  const errorWeight = Math.max(0, Math.min(1, (nearestDeltaE - 2.5) / 15.5))

  return midtoneWeight * (0.25 + 0.75 * errorWeight)
}

/**
 * Deterministic CPU pixel-art conversion matching the WGSL GPU shader math 1:1.
 * Used for:
 * 1. Exact 1-byte `indexed-v1` capture at shutter press when needed or in Canvas 2D fallback
 * 2. WebGPU-unavailable fallback live preview
 * 3. Deterministic unit tests of aspect crop/contain, fixed palette lock, and dithering modes
 */
export function convertRgbaFrameToPixelArtCpu(
  sourceRgba: Uint8ClampedArray | Uint8Array,
  srcWidth: number,
  srcHeight: number,
  params: CameraTransformParams,
  precomputedPalette: PrecomputedGpuPalette
): {
  indexedData: Uint8Array
  previewRgba: Uint8ClampedArray
} {
  const dstW = Math.max(1, Math.min(256, Math.round(params.canvasWidth)))
  const dstH = Math.max(1, Math.min(256, Math.round(params.canvasHeight)))
  const indexedData = new Uint8Array(dstW * dstH)
  const previewRgba = new Uint8ClampedArray(dstW * dstH * 4)

  if (precomputedPalette.count === 0 || srcWidth <= 0 || srcHeight <= 0) {
    indexedData.fill(TRANSPARENT_INDEX)
    return { indexedData, previewRgba }
  }

  const mapping = computeAspectSampleMapping(
    srcWidth,
    srcHeight,
    dstW,
    dstH,
    params.fitMode,
    params.cropPanX,
    params.cropPanY
  )

  const slots = precomputedPalette.slots
  const slotCount = precomputedPalette.count

  for (let py = 0; py < dstH; py++) {
    const v = (py + 0.5) * mapping.scaleY + mapping.offsetY
    for (let px = 0; px < dstW; px++) {
      const dstIdx = py * dstW + px
      let u = (px + 0.5) * mapping.scaleX + mapping.offsetX
      if (params.mirrorX) {
        u = 1.0 - u
      }

      if (u < 0 || u >= 1 || v < 0 || v >= 1) {
        indexedData[dstIdx] = TRANSPARENT_INDEX
        const pOff = dstIdx * 4
        previewRgba[pOff] = 0
        previewRgba[pOff + 1] = 0
        previewRgba[pOff + 2] = 0
        previewRgba[pOff + 3] = 0
        continue
      }

      // Area-box average over source footprint (`1` to `4x4` taps) to avoid aliasing shimmer before pixelation
      const u0 = Math.max(0, (px * mapping.scaleX + mapping.offsetX))
      const u1 = Math.min(1, ((px + 1) * mapping.scaleX + mapping.offsetX))
      const v0 = Math.max(0, (py * mapping.scaleY + mapping.offsetY))
      const v1 = Math.min(1, ((py + 1) * mapping.scaleY + mapping.offsetY))

      const effU0 = params.mirrorX ? 1 - u1 : u0
      const effU1 = params.mirrorX ? 1 - u0 : u1

      const sx0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(effU0 * srcWidth)))
      const sx1 = Math.max(sx0, Math.min(srcWidth - 1, Math.floor(Math.max(0, effU1 * srcWidth - 1e-4))))
      const sy0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(v0 * srcHeight)))
      const sy1 = Math.max(sy0, Math.min(srcHeight - 1, Math.floor(Math.max(0, v1 * srcHeight - 1e-4))))

      const stepX = Math.max(1, Math.ceil((sx1 - sx0 + 1) / 2))
      const stepY = Math.max(1, Math.ceil((sy1 - sy0 + 1) / 2))
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      let taps = 0

      for (let sy = sy0; sy <= sy1; sy += stepY) {
        for (let sx = sx0; sx <= sx1; sx += stepX) {
          const sOff = (sy * srcWidth + sx) * 4
          sumR += sourceRgba[sOff]!
          sumG += sourceRgba[sOff + 1]!
          sumB += sourceRgba[sOff + 2]!
          sumA += sourceRgba[sOff + 3]!
          taps++
        }
      }

      if (taps === 0 || sumA / taps < 32) {
        indexedData[dstIdx] = TRANSPARENT_INDEX
        continue
      }

      const [adjR, adjG, adjB] = applyColorAdjustmentsRgb(
        sumR / taps,
        sumG / taps,
        sumB / taps,
        params.brightness,
        params.contrast,
        params.saturation
      )

      const baseLab = rgbToLab(adjR, adjG, adjB)

      let chosenSlot = slots[0]!

      if (params.finishMode === 'crisp' || params.ditherStrength <= 0.001 || slotCount <= 1) {
        let bestDist = Infinity
        for (let i = 0; i < slotCount; i++) {
          const d = labDistanceSq(baseLab, slots[i]!.lab)
          if (d < bestDist) {
            bestDist = d
            chosenSlot = slots[i]!
          }
        }
      } else {
        // First find nearest & second-nearest error scale in CIELAB for adaptive / retro ordered Bayer offset
        let bestDistSq = Infinity
        let secondDistSq = Infinity
        for (let i = 0; i < slotCount; i++) {
          const d = labDistanceSq(baseLab, slots[i]!.lab)
          if (d < bestDistSq) {
            secondDistSq = bestDistSq
            bestDistSq = d
            chosenSlot = slots[i]!
          } else if (d < secondDistSq) {
            secondDistSq = d
          }
        }

        const nearestDeltaE = Math.sqrt(bestDistSq)
        const paletteGap = Number.isFinite(secondDistSq)
          ? Math.min(28, Math.max(6, Math.sqrt(secondDistSq) * 0.65))
          : 14

        const bayerVal = getBayerCenteredValue(px, py, params.bayerSize) // [-0.5..0.5]
        let amplitude = paletteGap * params.ditherStrength

        if (params.finishMode === 'auto') {
          amplitude *= computeAutoDitherModulation(baseLab.L, nearestDeltaE)
        } else {
          // 'retro': classic crisp ordered Bayer dithering across tones
          amplitude *= 1.15
        }

        if (Math.abs(amplitude) > 0.05) {
          const ditheredLab: LabVec = {
            L: Math.max(0, Math.min(100, baseLab.L + bayerVal * amplitude)),
            a: baseLab.a + bayerVal * amplitude * 0.25,
            b: baseLab.b + bayerVal * amplitude * 0.25,
          }
          let dBest = Infinity
          for (let i = 0; i < slotCount; i++) {
            const d = labDistanceSq(ditheredLab, slots[i]!.lab)
            if (d < dBest) {
              dBest = d
              chosenSlot = slots[i]!
            }
          }
        }
      }

      indexedData[dstIdx] = chosenSlot.fixedIndex
      const pOff = dstIdx * 4
      previewRgba[pOff] = chosenSlot.r
      previewRgba[pOff + 1] = chosenSlot.g
      previewRgba[pOff + 2] = chosenSlot.b
      previewRgba[pOff + 3] = 255
    }
  }

  return { indexedData, previewRgba }
}

/**
 * Generate a fixed perceptual `ProjectPalette` of `targetCount` (`8 | 16 | 32 | 64 | 128 | 255`) opaque colors
 * from a single sampled camera frame.
 * Once generated, callers MUST lock this palette until the user explicitly requests regeneration
 * so live video never flickers!
 */
export function generateAutoPaletteFromRgbaSample(
  sampleRgba: Uint8ClampedArray | Uint8Array,
  srcWidth: number,
  srcHeight: number,
  targetCount: AutoPaletteColorCount,
  params?: Partial<CameraTransformParams>,
  paletteName = `Auto ${targetCount}`
): ProjectPalette {
  const safeCount = Math.max(
    2,
    Math.min(MAX_OPAQUE_PALETTE_COLORS, Math.round(targetCount))
  )
  const brightness = params?.brightness ?? 0
  const contrast = params?.contrast ?? 1
  const saturation = params?.saturation ?? 1

  // Quantize source pixels lightly to 6-bit per channel bins (`64^3`) if huge so CIELAB median-cut runs in <10ms on mobile
  const colorMap = new Map<string, ColorSample>()
  const totalPixels = Math.min(
    srcWidth * srcHeight,
    Math.floor(sampleRgba.length / 4)
  )
  const stride = Math.max(1, Math.floor(totalPixels / 16384))

  for (let p = 0; p < totalPixels; p += stride) {
    const off = p * 4
    const a = sampleRgba[off + 3]!
    if (a < 32) continue
    const [adjR, adjG, adjB] = applyColorAdjustmentsRgb(
      sampleRgba[off]!,
      sampleRgba[off + 1]!,
      sampleRgba[off + 2]!,
      brightness,
      contrast,
      saturation
    )
    // Snap to 4-step (`& 0xfc` + subtle preserve) only when > 4096 pixels to bound unique sample count cleanly
    const qr = totalPixels > 4096 ? adjR & 0xfc : adjR
    const qg = totalPixels > 4096 ? adjG & 0xfc : adjG
    const qb = totalPixels > 4096 ? adjB & 0xfc : adjB
    const hex = rgbaToHex({ r: qr, g: qg, b: qb }).toUpperCase()
    const existing = colorMap.get(hex)
    if (existing) {
      existing.count++
    } else {
      colorMap.set(hex, {
        hex,
        r: qr,
        g: qg,
        b: qb,
        lab: rgbToLab(qr, qg, qb),
        count: 1,
      })
    }
  }

  const samples = Array.from(colorMap.values())
  const hexes =
    samples.length > 0
      ? quantizeColorsPerceptually(samples, safeCount)
      : ['#1F1926', '#F3EDF7']

  // Sort generated palette by CIELAB lightness ascending for clean visual usability in dotdot's 1-row palette bar
  const sortedHexes = [...hexes].sort((ha, hb) => {
    const ca = hexToRgba(ha)
    const cb = hexToRgba(hb)
    const la = rgbToLab(ca.r, ca.g, ca.b).L
    const lb = rgbToLab(cb.r, cb.g, cb.b).L
    return la - lb
  })

  return normalizeProjectPalette({
    name: paletteName,
    colors: sortedHexes.slice(0, safeCount),
  })
}

// ============================================================================
// WebGPU Shader & Reusable Pipeline Manager (with honest Canvas 2D Fallback)
// ============================================================================

const WGSL_CAMERA_PIXEL_SHADER = /* wgsl */ `
struct Params {
  dstWidth: u32,
  dstHeight: u32,
  srcWidth: u32,
  srcHeight: u32,
  paletteCount: u32,
  finishMode: u32,   // 0 = auto, 1 = crisp, 2 = retro
  bayerSize: u32,    // 4 or 8
  mirrorX: u32,      // 0 or 1
  scaleX: f32,
  scaleY: f32,
  offsetX: f32,
  offsetY: f32,
  ditherStrength: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
};

struct PaletteEntry {
  labAndIndex: vec4<f32>, // xyz = Lab, w = fixedIndex (0..254)
  srgb: vec4<f32>,        // rgb in 0..1, a = 1
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> palette: array<PaletteEntry, 256>;
@group(0) @binding(2) var srcTex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> outIndices: array<u32>;
@group(0) @binding(4) var outPreviewTex: texture_storage_2d<rgba8unorm, write>;

fn srgbToLinear(c: f32) -> f32 {
  let s = clamp(c, 0.0, 1.0);
  if (s <= 0.04045) {
    return s / 12.92;
  }
  return pow((s + 0.055) / 1.055, 2.4);
}

fn labF(t: f32) -> f32 {
  let d = 6.0 / 29.0;
  let d3 = d * d * d;
  if (t > d3) {
    return pow(t, 1.0 / 3.0);
  }
  return t / (3.0 * d * d) + (4.0 / 29.0);
}

fn rgb01ToLab(rgb: vec3<f32>) -> vec3<f32> {
  let lr = srgbToLinear(rgb.r);
  let lg = srgbToLinear(rgb.g);
  let lb = srgbToLinear(rgb.b);
  let x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  let y = 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
  let z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883;
  let fx = labF(x);
  let fy = labF(y);
  let fz = labF(z);
  return vec3<f32>(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

fn bayer4(x: u32, y: u32) -> f32 {
  let m = array<f32, 16>(
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  let idx = ((y & 3u) * 4u) + (x & 3u);
  return (m[idx] + 0.5) / 16.0 - 0.5;
}

fn bayer8(x: u32, y: u32) -> f32 {
  let bx = x & 7u;
  let by = y & 7u;
  let fine = bayer4(bx >> 1u, by >> 1u) + 0.5;
  let sub = bayer4(bx & 1u, by & 1u) + 0.5;
  return clamp((fine * 16.0 * 4.0 + sub * 4.0) / 64.0, 0.0, 1.0) - 0.5;
}

@compute @workgroup_size(8, 8, 1)
fn csMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.dstWidth || gid.y >= params.dstHeight) {
    return;
  }
  let pixelIdx = gid.y * params.dstWidth + gid.x;
  if (params.paletteCount == 0u || params.srcWidth == 0u || params.srcHeight == 0u) {
    outIndices[pixelIdx] = 255u;
    textureStore(outPreviewTex, vec2<i32>(gid.xy), vec4<f32>(0.0));
    return;
  }

  var u = (f32(gid.x) + 0.5) * params.scaleX + params.offsetX;
  let v = (f32(gid.y) + 0.5) * params.scaleY + params.offsetY;
  if (params.mirrorX != 0u) {
    u = 1.0 - u;
  }

  if (u < 0.0 || u >= 1.0 || v < 0.0 || v >= 1.0) {
    outIndices[pixelIdx] = 255u;
    textureStore(outPreviewTex, vec2<i32>(gid.xy), vec4<f32>(0.0));
    return;
  }

  // 2x2 area supersample inside source pixel footprint for clean anti-shimmer downsampling
  let du = params.scaleX * 0.25;
  let dv = params.scaleY * 0.25;
  var acc = vec4<f32>(0.0);
  for (var sy: i32 = -1; sy <= 1; sy = sy + 2) {
    for (var sx: i32 = -1; sx <= 1; sx = sx + 2) {
      let su = clamp(u + f32(sx) * du, 0.0, 0.9999);
      let sv = clamp(v + f32(sy) * dv, 0.0, 0.9999);
      let tx = i32(su * f32(params.srcWidth));
      let ty = i32(sv * f32(params.srcHeight));
      acc = acc + textureLoad(srcTex, vec2<i32>(tx, ty), 0);
    }
  }
  let avg = acc * 0.25;
  if (avg.a < 0.125) {
    outIndices[pixelIdx] = 255u;
    textureStore(outPreviewTex, vec2<i32>(gid.xy), vec4<f32>(0.0));
    return;
  }

  var rgb = (avg.rgb - vec3<f32>(0.5)) * params.contrast + vec3<f32>(0.5 + params.brightness);
  let luma = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  rgb = clamp(vec3<f32>(luma) + (rgb - vec3<f32>(luma)) * params.saturation, vec3<f32>(0.0), vec3<f32>(1.0));

  let baseLab = rgb01ToLab(rgb);

  var bestSlot: u32 = 0u;
  var bestDistSq: f32 = 1e30;
  var secondDistSq: f32 = 1e30;

  let count = min(params.paletteCount, 255u);
  for (var i: u32 = 0u; i < count; i = i + 1u) {
    let diff = baseLab - palette[i].labAndIndex.xyz;
    let d = dot(diff, diff);
    if (d < bestDistSq) {
      secondDistSq = bestDistSq;
      bestDistSq = d;
      bestSlot = i;
    } else if (d < secondDistSq) {
      secondDistSq = d;
    }
  }

  if (params.finishMode != 1u && params.ditherStrength > 0.001 && count > 1u) {
    let nearestDeltaE = sqrt(bestDistSq);
    var gap: f32 = 14.0;
    if (secondDistSq < 1e20) {
      gap = clamp(sqrt(secondDistSq) * 0.65, 6.0, 28.0);
    }
    var bVal = bayer4(gid.x, gid.y);
    if (params.bayerSize == 8u) {
      bVal = bayer8(gid.x, gid.y);
    }
    var amp = gap * params.ditherStrength;
    if (params.finishMode == 0u) {
      let shadowGate = clamp((baseLab.x - 8.0) / 18.0, 0.0, 1.0);
      let highlightGate = clamp((95.0 - baseLab.x) / 16.0, 0.0, 1.0);
      let errorWeight = clamp((nearestDeltaE - 2.5) / 15.5, 0.0, 1.0);
      amp = amp * shadowGate * highlightGate * (0.25 + 0.75 * errorWeight);
    } else {
      amp = amp * 1.15;
    }

    if (abs(amp) > 0.05) {
      let dLab = vec3<f32>(
        clamp(baseLab.x + bVal * amp, 0.0, 100.0),
        baseLab.y + bVal * amp * 0.25,
        baseLab.z + bVal * amp * 0.25
      );
      var dBest: f32 = 1e30;
      for (var j: u32 = 0u; j < count; j = j + 1u) {
        let diff2 = dLab - palette[j].labAndIndex.xyz;
        let d2 = dot(diff2, diff2);
        if (d2 < dBest) {
          dBest = d2;
          bestSlot = j;
        }
      }
    }
  }

  let fixedIdx = u32(palette[bestSlot].labAndIndex.w);
  outIndices[pixelIdx] = fixedIdx;
  textureStore(outPreviewTex, vec2<i32>(gid.xy), vec4<f32>(palette[bestSlot].srgb.rgb, 1.0));
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsPresent(@builtin(vertex_index) vid: u32) -> VsOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0)
  );
  var out: VsOut;
  out.pos = vec4<f32>(positions[vid], 0.0, 1.0);
  out.uv = uvs[vid];
  return out;
}

@group(0) @binding(0) var presentTex: texture_2d<f32>;
@group(0) @binding(1) var nearestSamp: sampler;

@fragment
fn fsPresent(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(presentTex, nearestSamp, in.uv);
}
`

// Minimal ambient structural interfaces so TypeScript builds cleanly without adding heavy `@webgpu/types` dependencies
export interface MinimalGpuDevice {
  lost: Promise<{ reason?: string; message?: string }>
  destroy: () => void
  createShaderModule: (desc: { code: string }) => unknown
  createBuffer: (desc: {
    size: number
    usage: number
    mappedAtCreation?: boolean
  }) => {
    destroy: () => void
    mapAsync?: (mode: number) => Promise<void>
    getMappedRange?: () => ArrayBuffer
    unmap?: () => void
  }
  createTexture: (desc: {
    size: [number, number, number?]
    format: string
    usage: number
  }) => {
    createView: () => unknown
    destroy: () => void
  }
  createSampler: (desc: { magFilter: string; minFilter: string }) => unknown
  createComputePipeline: (desc: unknown) => {
    getBindGroupLayout: (index: number) => unknown
  }
  createRenderPipeline: (desc: unknown) => {
    getBindGroupLayout: (index: number) => unknown
  }
  createBindGroup: (desc: unknown) => unknown
  createCommandEncoder: () => {
    beginComputePass: () => {
      setPipeline: (p: unknown) => void
      setBindGroup: (idx: number, bg: unknown) => void
      dispatchWorkgroups: (x: number, y: number, z?: number) => void
      end: () => void
    }
    beginRenderPass: (desc: unknown) => {
      setPipeline: (p: unknown) => void
      setBindGroup: (idx: number, bg: unknown) => void
      draw: (vertexCount: number) => void
      end: () => void
    }
    copyBufferToBuffer: (
      src: unknown,
      srcOff: number,
      dst: unknown,
      dstOff: number,
      size: number
    ) => void
    finish: () => unknown
  }
  queue: {
    writeBuffer: (
      buf: unknown,
      offset: number,
      data: ArrayBufferView | ArrayBuffer
    ) => void
    writeTexture?: (
      dest: { texture: unknown },
      data: ArrayBufferView,
      dataLayout: { bytesPerRow: number; rowsPerImage: number },
      size: [number, number, number?]
    ) => void
    copyExternalImageToTexture?: (
      source: { source: unknown },
      destination: { texture: unknown },
      copySize: [number, number]
    ) => void
    submit: (cmds: unknown[]) => void
  }
}

export interface MinimalGpuLike {
  requestAdapter: (opts?: { powerPreference?: string }) => Promise<{
    requestDevice: () => Promise<MinimalGpuDevice>
  } | null>
  getPreferredCanvasFormat?: () => string
}

export interface CameraEngineStatus {
  backend: CameraBackendKind
  fallbackReason: string | null
  deviceLostRecoveries: number
  targetFps: number
}

const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  COPY_SRC: 0x0004,
} as const

const GPU_TEXTURE_USAGE = {
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const

const GPU_MAP_MODE_READ = 0x0001

/**
 * Isolated WebGPU + Canvas 2D Fallback Real-Time Camera Pixel-Art Processor.
 * - Verifies `requestAdapter()` AND `requestDevice()` (never trusts `'gpu' in navigator` alone)
 * - Reuses GPU buffers & textures across frames (re-allocating ONLY when source/canvas dimensions change)
 * - Keeps live preview 100% on GPU (`csMain` -> `outPreviewTex` -> `fsPresent` nearest-neighbor) with zero per-frame CPU readback
 * - Reads back `outIndices` ONLY once when the user presses Capture, or falls back cleanly to deterministic Canvas 2D CPU
 * - Recovers from `device.lost` automatically or falls back to Canvas 2D without freezing UI
 */
export class CameraPixelArtProcessor {
  private gpuApi: MinimalGpuLike | null
  private device: MinimalGpuDevice | null = null
  private backend: CameraBackendKind = 'canvas2d'
  private fallbackReason: string | null = null
  private deviceLostRecoveries = 0
  private disposed = false

  private displayCanvas: HTMLCanvasElement | null = null
  private gpuCanvasCtx: {
    configure: (cfg: {
      device: MinimalGpuDevice
      format: string
      alphaMode?: string
    }) => void
    unconfigure?: () => void
    getCurrentTexture: () => { createView: () => unknown }
  } | null = null
  private canvas2dCtx: CanvasRenderingContext2D | null = null

  // Reusable offscreen sampling canvas (downscales large camera frames before CPU fallback or `writeTexture` upload)
  private sampleCanvas: HTMLCanvasElement | null = null
  private sampleCtx: CanvasRenderingContext2D | null = null

  // Reusable GPU resources
  private computePipeline: { getBindGroupLayout: (i: number) => unknown } | null =
    null
  private renderPipeline: { getBindGroupLayout: (i: number) => unknown } | null =
    null
  private nearestSampler: unknown = null
  private uniformBuffer: { destroy: () => void } | null = null
  private paletteBuffer: { destroy: () => void } | null = null
  private indexStorageBuffer: { destroy: () => void } | null = null
  private indexReadbackBuffer: {
    destroy: () => void
    mapAsync?: (mode: number) => Promise<void>
    getMappedRange?: () => ArrayBuffer
    unmap?: () => void
  } | null = null
  private srcTexture: { createView: () => unknown; destroy: () => void } | null =
    null
  private previewTexture: {
    createView: () => unknown
    destroy: () => void
  } | null = null

  private allocatedSrcW = 0
  private allocatedSrcH = 0
  private allocatedDstW = 0
  private allocatedDstH = 0

  private uniformScratch = new ArrayBuffer(64)
  private uniformU32 = new Uint32Array(this.uniformScratch)
  private uniformF32 = new Float32Array(this.uniformScratch)

  private currentPalette: PrecomputedGpuPalette | null = null
  private lastCpuResult: {
    width: number
    height: number
    indexedData: Uint8Array
    previewRgba: Uint8ClampedArray
  } | null = null

  private onStatusChange?: (status: CameraEngineStatus) => void

  constructor(options?: {
    gpu?: MinimalGpuLike | null
    onStatusChange?: (status: CameraEngineStatus) => void
  }) {
    const navGpu =
      options && 'gpu' in options
        ? options.gpu ?? null
        : typeof navigator !== 'undefined' && 'gpu' in navigator
          ? ((navigator as unknown as { gpu?: MinimalGpuLike }).gpu ?? null)
          : null
    this.gpuApi = navGpu
    this.onStatusChange = options?.onStatusChange
  }

  getStatus(): CameraEngineStatus {
    return {
      backend: this.backend,
      fallbackReason: this.fallbackReason,
      deviceLostRecoveries: this.deviceLostRecoveries,
      targetFps: this.backend === 'webgpu' ? 30 : 18,
    }
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }

  async initialize(displayCanvas: HTMLCanvasElement): Promise<CameraEngineStatus> {
    this.disposed = false
    this.displayCanvas = displayCanvas

    if (!this.gpuApi || typeof this.gpuApi.requestAdapter !== 'function') {
      this.switchToCanvas2d('WebGPU API unavailable on this browser')
      return this.getStatus()
    }

    try {
      const adapter = await this.gpuApi.requestAdapter({
        powerPreference: 'low-power',
      })
      if (!adapter || this.disposed) {
        this.switchToCanvas2d('GPUAdapter unavailable')
        return this.getStatus()
      }

      const device = await adapter.requestDevice()
      if (!device || this.disposed) {
        this.switchToCanvas2d('GPUDevice creation failed')
        return this.getStatus()
      }

      const webgpuCtx = displayCanvas.getContext('webgpu') as unknown as
        | typeof this.gpuCanvasCtx
        | null
      if (!webgpuCtx) {
        device.destroy()
        this.switchToCanvas2d('WebGPU canvas context unavailable')
        return this.getStatus()
      }

      const format =
        typeof this.gpuApi.getPreferredCanvasFormat === 'function'
          ? this.gpuApi.getPreferredCanvasFormat()
          : 'bgra8unorm'

      webgpuCtx.configure({
        device,
        format,
        alphaMode: 'premultiplied',
      })

      const shaderModule = device.createShaderModule({
        code: WGSL_CAMERA_PIXEL_SHADER,
      })

      this.computePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: shaderModule,
          entryPoint: 'csMain',
        },
      })

      this.renderPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: shaderModule,
          entryPoint: 'vsPresent',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fsPresent',
          targets: [{ format }],
        },
        primitive: {
          topology: 'triangle-list',
        },
      })

      this.nearestSampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
      })

      this.uniformBuffer = device.createBuffer({
        size: 64,
        usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
      })

      this.paletteBuffer = device.createBuffer({
        size: 256 * 8 * 4,
        usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
      })

      this.device = device
      this.gpuCanvasCtx = webgpuCtx
      this.canvas2dCtx = null
      this.backend = 'webgpu'
      this.fallbackReason = null

      if (this.currentPalette) {
        device.queue.writeBuffer(
          this.paletteBuffer,
          0,
          this.currentPalette.gpuSlotData
        )
      }

      // Watch for asynchronous GPU device loss (e.g. iOS Safari backgrounding or driver reset)
      void device.lost.then((info) => {
        if (this.disposed || this.device !== device) return
        this.releaseGpuBuffersOnly()
        this.device = null
        this.deviceLostRecoveries++
        void this.handleDeviceLost(info?.message || 'GPU device lost')
      })

      this.emitStatus()
      return this.getStatus()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'WebGPU initialization error'
      this.switchToCanvas2d(msg)
      return this.getStatus()
    }
  }

  private async handleDeviceLost(reason: string): Promise<void> {
    if (this.disposed || !this.displayCanvas) return
    if (this.deviceLostRecoveries <= 2) {
      const status = await this.initialize(this.displayCanvas)
      if (status.backend === 'webgpu') {
        return
      }
    }
    this.switchToCanvas2d(reason)
  }

  private switchToCanvas2d(reason: string): void {
    this.releaseGpuDevice()
    this.backend = 'canvas2d'
    this.fallbackReason = reason
    if (this.displayCanvas) {
      this.canvas2dCtx = this.displayCanvas.getContext('2d')
    }
    this.emitStatus()
  }

  setPalette(palette: ProjectPalette): PrecomputedGpuPalette {
    const pre = precomputePaletteForCamera(palette)
    this.currentPalette = pre
    if (this.backend === 'webgpu' && this.device && this.paletteBuffer) {
      this.device.queue.writeBuffer(this.paletteBuffer, 0, pre.gpuSlotData)
    }
    return pre
  }

  private ensureSampleCanvas(w: number, h: number): CanvasRenderingContext2D | null {
    if (typeof document === 'undefined') return null
    if (!this.sampleCanvas) {
      this.sampleCanvas = document.createElement('canvas')
      this.sampleCtx = this.sampleCanvas.getContext('2d', {
        willReadFrequently: true,
      })
    }
    if (this.sampleCanvas.width !== w || this.sampleCanvas.height !== h) {
      this.sampleCanvas.width = w
      this.sampleCanvas.height = h
    }
    return this.sampleCtx
  }

  /**
   * Sample a bounded RGBA buffer (`<= 512px` long edge) from an `HTMLVideoElement` or `ImageData`
   * without allocating unbounded HD/4K buffers in memory.
   */
  extractBoundedRgbaFromVideo(
    video: HTMLVideoElement,
    maxLongEdge = 384
  ): { rgba: Uint8ClampedArray; width: number; height: number } | null {
    const vw = video.videoWidth || video.width || 0
    const vh = video.videoHeight || video.height || 0
    if (vw <= 0 || vh <= 0) return null

    const scale = Math.min(1, maxLongEdge / Math.max(vw, vh))
    const sw = Math.max(1, Math.round(vw * scale))
    const sh = Math.max(1, Math.round(vh * scale))
    const ctx = this.ensureSampleCanvas(sw, sh)
    if (!ctx) return null

    ctx.clearRect(0, 0, sw, sh)
    ctx.drawImage(video, 0, 0, sw, sh)
    const img = ctx.getImageData(0, 0, sw, sh)
    return { rgba: img.data, width: sw, height: sh }
  }

  private ensureGpuFrameResources(
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number
  ): void {
    if (!this.device) return

    if (srcW !== this.allocatedSrcW || srcH !== this.allocatedSrcH) {
      this.srcTexture?.destroy()
      this.srcTexture = this.device.createTexture({
        size: [srcW, srcH, 1],
        format: 'rgba8unorm',
        usage:
          GPU_TEXTURE_USAGE.TEXTURE_BINDING |
          GPU_TEXTURE_USAGE.COPY_DST |
          GPU_TEXTURE_USAGE.RENDER_ATTACHMENT,
      })
      this.allocatedSrcW = srcW
      this.allocatedSrcH = srcH
    }

    if (dstW !== this.allocatedDstW || dstH !== this.allocatedDstH) {
      this.previewTexture?.destroy()
      this.indexStorageBuffer?.destroy()
      this.indexReadbackBuffer?.destroy()

      this.previewTexture = this.device.createTexture({
        size: [dstW, dstH, 1],
        format: 'rgba8unorm',
        usage:
          GPU_TEXTURE_USAGE.STORAGE_BINDING |
          GPU_TEXTURE_USAGE.TEXTURE_BINDING,
      })

      const byteSize = Math.max(16, dstW * dstH * 4)
      this.indexStorageBuffer = this.device.createBuffer({
        size: byteSize,
        usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
      })
      this.indexReadbackBuffer = this.device.createBuffer({
        size: byteSize,
        usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
      })

      this.allocatedDstW = dstW
      this.allocatedDstH = dstH
    }
  }

  /**
   * Render a single live frame onto `displayCanvas` (100% GPU-resident when `backend === 'webgpu'`,
   * or crisp nearest-neighbor Canvas 2D in fallback mode).
   */
  renderFrameFromRgba(
    sourceRgba: Uint8ClampedArray | Uint8Array,
    srcWidth: number,
    srcHeight: number,
    params: CameraTransformParams
  ): void {
    if (this.disposed || !this.currentPalette) return
    const dstW = Math.max(1, Math.min(256, Math.round(params.canvasWidth)))
    const dstH = Math.max(1, Math.min(256, Math.round(params.canvasHeight)))

    if (
      this.backend === 'webgpu' &&
      this.device &&
      this.gpuCanvasCtx &&
      this.computePipeline &&
      this.renderPipeline &&
      this.uniformBuffer &&
      this.paletteBuffer &&
      typeof this.device.queue.writeTexture === 'function'
    ) {
      try {
        this.ensureGpuFrameResources(srcWidth, srcHeight, dstW, dstH)
        if (
          this.displayCanvas &&
          (this.displayCanvas.width !== dstW ||
            this.displayCanvas.height !== dstH)
        ) {
          this.displayCanvas.width = dstW
          this.displayCanvas.height = dstH
        }

        this.device.queue.writeTexture(
          { texture: this.srcTexture! },
          sourceRgba,
          { bytesPerRow: srcWidth * 4, rowsPerImage: srcHeight },
          [srcWidth, srcHeight, 1]
        )

        this.writeUniforms(srcWidth, srcHeight, dstW, dstH, params)
        this.dispatchGpuPreview(dstW, dstH)
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'WebGPU render error'
        this.switchToCanvas2d(msg)
      }
    }

    // Honest Canvas 2D CPU fallback
    const cpu = convertRgbaFrameToPixelArtCpu(
      sourceRgba,
      srcWidth,
      srcHeight,
      params,
      this.currentPalette
    )
    this.lastCpuResult = {
      width: dstW,
      height: dstH,
      indexedData: cpu.indexedData,
      previewRgba: cpu.previewRgba,
    }

    if (this.displayCanvas) {
      if (
        this.displayCanvas.width !== dstW ||
        this.displayCanvas.height !== dstH
      ) {
        this.displayCanvas.width = dstW
        this.displayCanvas.height = dstH
      }
      const ctx = this.canvas2dCtx ?? this.displayCanvas.getContext('2d')
      this.canvas2dCtx = ctx
      if (ctx) {
        ctx.imageSmoothingEnabled = false
        ctx.clearRect(0, 0, dstW, dstH)
        if (typeof ImageData !== 'undefined') {
          const copy = new Uint8ClampedArray(dstW * dstH * 4)
          copy.set(cpu.previewRgba)
          ctx.putImageData(new ImageData(copy, dstW, dstH), 0, 0)
        } else {
          for (let y = 0; y < dstH; y++) {
            for (let x = 0; x < dstW; x++) {
              const off = (y * dstW + x) * 4
              if (cpu.previewRgba[off + 3] === 0) continue
              ctx.fillStyle = `rgb(${cpu.previewRgba[off]},${cpu.previewRgba[off + 1]},${cpu.previewRgba[off + 2]})`
              ctx.fillRect(x, y, 1, 1)
            }
          }
        }
      }
    }
  }

  renderVideoFrame(
    video: HTMLVideoElement,
    params: CameraTransformParams
  ): boolean {
    if (this.disposed || !this.currentPalette) return false
    const maxSampleEdge = this.backend === 'webgpu' ? 512 : 256
    const sampled = this.extractBoundedRgbaFromVideo(video, maxSampleEdge)
    if (!sampled) return false
    this.renderFrameFromRgba(
      sampled.rgba,
      sampled.width,
      sampled.height,
      params
    )
    return true
  }

  private writeUniforms(
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    params: CameraTransformParams
  ): void {
    if (!this.device || !this.uniformBuffer || !this.currentPalette) return
    const mapping = computeAspectSampleMapping(
      srcW,
      srcH,
      dstW,
      dstH,
      params.fitMode,
      params.cropPanX,
      params.cropPanY
    )

    this.uniformU32[0] = dstW
    this.uniformU32[1] = dstH
    this.uniformU32[2] = srcW
    this.uniformU32[3] = srcH
    this.uniformU32[4] = this.currentPalette.count
    this.uniformU32[5] =
      params.finishMode === 'crisp' ? 1 : params.finishMode === 'retro' ? 2 : 0
    this.uniformU32[6] = params.bayerSize === 8 ? 8 : 4
    this.uniformU32[7] = params.mirrorX ? 1 : 0

    this.uniformF32[8] = mapping.scaleX
    this.uniformF32[9] = mapping.scaleY
    this.uniformF32[10] = mapping.offsetX
    this.uniformF32[11] = mapping.offsetY
    this.uniformF32[12] = params.ditherStrength
    this.uniformF32[13] = params.brightness
    this.uniformF32[14] = params.contrast
    this.uniformF32[15] = params.saturation

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch)
  }

  private dispatchGpuPreview(dstW: number, dstH: number): void {
    if (
      !this.device ||
      !this.gpuCanvasCtx ||
      !this.computePipeline ||
      !this.renderPipeline ||
      !this.srcTexture ||
      !this.previewTexture ||
      !this.uniformBuffer ||
      !this.paletteBuffer ||
      !this.indexStorageBuffer
    ) {
      return
    }

    const computeBg = this.device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.paletteBuffer } },
        { binding: 2, resource: this.srcTexture.createView() },
        { binding: 3, resource: { buffer: this.indexStorageBuffer } },
        { binding: 4, resource: this.previewTexture.createView() },
      ],
    })

    const presentBg = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.previewTexture.createView() },
        { binding: 1, resource: this.nearestSampler },
      ],
    })

    const encoder = this.device.createCommandEncoder()
    const cPass = encoder.beginComputePass()
    cPass.setPipeline(this.computePipeline)
    cPass.setBindGroup(0, computeBg)
    cPass.dispatchWorkgroups(Math.ceil(dstW / 8), Math.ceil(dstH / 8), 1)
    cPass.end()

    const rPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.gpuCanvasCtx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    rPass.setPipeline(this.renderPipeline)
    rPass.setBindGroup(0, presentBg)
    rPass.draw(6)
    rPass.end()

    this.device.queue.submit([encoder.finish()])
  }

  /**
   * Capture the exact 1-byte Fixed Index array (`Uint8Array` of `width * height`)
   * matching the live preview at shutter press.
   * Performs GPU readback ONLY on explicit capture (never per-frame!), or returns the exact CPU buffer.
   */
  async captureCurrentIndexedFrame(
    sourceRgba: Uint8ClampedArray | Uint8Array | null,
    srcWidth: number,
    srcHeight: number,
    params: CameraTransformParams
  ): Promise<{
    width: number
    height: number
    indexedData: Uint8Array
    palette: ProjectPalette
  }> {
    if (!this.currentPalette) {
      throw new Error('Palette not initialized')
    }
    const dstW = Math.max(1, Math.min(256, Math.round(params.canvasWidth)))
    const dstH = Math.max(1, Math.min(256, Math.round(params.canvasHeight)))

    if (sourceRgba && srcWidth > 0 && srcHeight > 0) {
      this.renderFrameFromRgba(sourceRgba, srcWidth, srcHeight, params)
    }

    if (
      this.backend === 'webgpu' &&
      this.device &&
      this.indexStorageBuffer &&
      this.indexReadbackBuffer &&
      typeof this.indexReadbackBuffer.mapAsync === 'function' &&
      typeof this.indexReadbackBuffer.getMappedRange === 'function' &&
      typeof this.indexReadbackBuffer.unmap === 'function' &&
      this.allocatedDstW === dstW &&
      this.allocatedDstH === dstH
    ) {
      const byteSize = dstW * dstH * 4
      const encoder = this.device.createCommandEncoder()
      encoder.copyBufferToBuffer(
        this.indexStorageBuffer,
        0,
        this.indexReadbackBuffer,
        0,
        byteSize
      )
      this.device.queue.submit([encoder.finish()])

      await this.indexReadbackBuffer.mapAsync(GPU_MAP_MODE_READ)
      const mapped = new Uint32Array(this.indexReadbackBuffer.getMappedRange())
      const out = new Uint8Array(dstW * dstH)
      for (let i = 0; i < out.length; i++) {
        out[i] = mapped[i]! & 0xff
      }
      this.indexReadbackBuffer.unmap()

      return {
        width: dstW,
        height: dstH,
        indexedData: out,
        palette: this.currentPalette.normalizedPalette,
      }
    }

    if (sourceRgba && srcWidth > 0 && srcHeight > 0) {
      const cpu = convertRgbaFrameToPixelArtCpu(
        sourceRgba,
        srcWidth,
        srcHeight,
        params,
        this.currentPalette
      )
      return {
        width: dstW,
        height: dstH,
        indexedData: cpu.indexedData,
        palette: this.currentPalette.normalizedPalette,
      }
    }

    if (
      this.lastCpuResult &&
      this.lastCpuResult.width === dstW &&
      this.lastCpuResult.height === dstH
    ) {
      return {
        width: dstW,
        height: dstH,
        indexedData: new Uint8Array(this.lastCpuResult.indexedData),
        palette: this.currentPalette.normalizedPalette,
      }
    }

    return {
      width: dstW,
      height: dstH,
      indexedData: new Uint8Array(dstW * dstH).fill(TRANSPARENT_INDEX),
      palette: this.currentPalette.normalizedPalette,
    }
  }

  private releaseGpuBuffersOnly(): void {
    this.srcTexture?.destroy()
    this.previewTexture?.destroy()
    this.uniformBuffer?.destroy()
    this.paletteBuffer?.destroy()
    this.indexStorageBuffer?.destroy()
    this.indexReadbackBuffer?.destroy()

    this.srcTexture = null
    this.previewTexture = null
    this.uniformBuffer = null
    this.paletteBuffer = null
    this.indexStorageBuffer = null
    this.indexReadbackBuffer = null
    this.computePipeline = null
    this.renderPipeline = null
    this.nearestSampler = null
    this.allocatedSrcW = 0
    this.allocatedSrcH = 0
    this.allocatedDstW = 0
    this.allocatedDstH = 0
  }

  private releaseGpuDevice(): void {
    this.releaseGpuBuffersOnly()
    try {
      this.gpuCanvasCtx?.unconfigure?.()
    } catch {
      // ignore unconfigure errors on detached canvas
    }
    this.gpuCanvasCtx = null
    if (this.device) {
      const dev = this.device
      this.device = null
      try {
        dev.destroy()
      } catch {
        // ignore destroy errors
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.releaseGpuDevice()
    this.sampleCanvas = null
    this.sampleCtx = null
    this.displayCanvas = null
    this.canvas2dCtx = null
    this.lastCpuResult = null
  }
}

/**
 * Stop every track in a `MediaStream` safely and idempotently.
 */
export function stopMediaStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream) return
  try {
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        // ignore already-stopped track errors
      }
    }
  } catch {
    // ignore
  }
}
