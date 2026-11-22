import { hexToHsv, rgbaToHex } from '../engine/color'
import type {
  NesChannelId,
  NoteEvent,
  PixelMusicConfig,
  PixelMusicScore,
  RootNoteName,
  ScaleId,
} from './types'

const ROOT_SEMITONES: Record<RootNoteName, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
}

const SCALE_INTERVALS: Record<ScaleId, readonly number[]> = {
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
}

/** Deterministic 32-bit PRNG (Mulberry32) */
export function createSeededRng(seed: number): () => number {
  let s = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function midiToFrequencyHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * Map a vertical Y coordinate (`0` = top = highest pitch, `height - 1` = bottom = lowest pitch)
 * onto a musical scale degree for the given channel register.
 */
export function mapYToMidiNote(
  y: number,
  height: number,
  channel: NesChannelId,
  scale: ScaleId,
  rootNote: RootNoteName,
  seedOffset = 0
): number {
  const safeH = Math.max(1, height)
  const normFromBottom =
    safeH <= 1 ? 0.5 : Math.max(0, Math.min(1, (safeH - 1 - y) / (safeH - 1)))

  const intervals = SCALE_INTERVALS[scale]
  const rootSemi = ROOT_SEMITONES[rootNote]

  // Register per channel: Triangle = bass (C2..C4), Pulse2 = mid (C4..C6), Pulse1 = lead (C4..C7), Noise = percussion index (36..72)
  const baseMidi =
    channel === 'triangle'
      ? 36 + rootSemi
      : channel === 'pulse2'
        ? 55 + rootSemi
        : channel === 'noise'
          ? 36
          : 60 + rootSemi

  const octaveSpan = channel === 'triangle' ? 2 : 3
  const totalDegrees = intervals.length * octaveSpan
  const rawDegree = Math.round(normFromBottom * totalDegrees) + seedOffset
  const clampedDegree = Math.max(0, Math.min(totalDegrees, rawDegree))
  const oct = Math.floor(clampedDegree / intervals.length)
  const degInOct = clampedDegree % intervals.length
  return Math.max(24, Math.min(96, baseMidi + oct * 12 + intervals[degInOct]!))
}

/**
 * Deterministic color -> NES APU channel classifier:
 * - Low saturation / dark / rocky colors -> Noise percussion (`noise`)
 * - Cool/deep hues or lower-brightness colors -> Bass (`triangle`)
 * - Bright warm/vivid colors -> Lead (`pulse1`) or Harmony (`pulse2`)
 * Also incorporates palette index + seed rotation so monochrome/2-color sprites still use musical voices!
 */
export function classifyColorToChannel(
  hex: string,
  paletteColors: readonly string[],
  y: number,
  height: number,
  seed: number
): { channel: NesChannelId; dutyCycle: 0.125 | 0.25 | 0.5 } {
  const upper = hex.toUpperCase()
  const palIdx = paletteColors.findIndex((c) => c.toUpperCase() === upper)
  const hsv = hexToHsv(upper)
  const seedShift = Math.abs(Math.trunc(seed)) % 4

  // Very low saturation & dark pixels -> crisp 8-bit percussion ticks unless near the top
  if (hsv.s <= 14 && hsv.v <= 38 && y >= Math.floor(height * 0.55)) {
    return { channel: 'noise', dutyCycle: 0.25 }
  }

  // Bottom quarter dark/cool pixels -> Triangle bassline
  if (y >= Math.floor(height * 0.68) && hsv.v <= 75) {
    return { channel: 'triangle', dutyCycle: 0.5 }
  }

  const hash =
    ((palIdx >= 0 ? palIdx : Math.floor(hsv.h / 30)) + seedShift) % 4
  if (hash === 0) {
    return { channel: 'pulse1', dutyCycle: 0.5 }
  }
  if (hash === 1) {
    return { channel: 'pulse2', dutyCycle: 0.25 }
  }
  if (hash === 2) {
    return {
      channel: y >= Math.floor(height * 0.5) ? 'triangle' : 'pulse1',
      dutyCycle: 0.25,
    }
  }
  return {
    channel: hsv.s < 22 ? 'noise' : 'pulse2',
    dutyCycle: 0.125,
  }
}

/**
 * Analyze a composited RGBA pixel buffer (`width * height * 4`) into a deterministic 4-channel NES APU score:
 * - X coordinate -> Start step (downsampled cleanly when width > 64 so large 256px artworks play at musical phrasing lengths)
 * - Y coordinate -> Pitch (top = high, bottom = low)
 * - Horizontal contiguous same-color run -> Note duration (`durationSteps`)
 * - Vertical simultaneous runs -> Chords / multi-channel voices with strict per-channel polyphony caps
 * - Transparent (`alpha === 0`) -> Silence / Rest
 */
export function analyzePixelsToMusic(
  rgbaBuffer: Uint8ClampedArray,
  width: number,
  height: number,
  paletteColors: readonly string[],
  config: PixelMusicConfig
): PixelMusicScore {
  const safeW = Math.max(1, Math.trunc(width))
  const safeH = Math.max(1, Math.trunc(height))

  // Group large canvases into musical 16th-note steps (max 64 steps) while keeping <=64px 1:1 pixel-to-step!
  const xStride = Math.max(1, Math.ceil(safeW / 64))
  const yStride = Math.max(1, Math.ceil(safeH / 32))
  const totalSteps = Math.max(1, Math.ceil(safeW / xStride))

  const effectiveBpm = Math.max(
    40,
    Math.min(300, config.bpm * Math.max(0.5, Math.min(2.0, config.speed)))
  )
  // 1 step = 16th note = (60 / BPM) / 4 seconds
  const stepDurationSec = 60 / effectiveBpm / 4

  const rng = createSeededRng(config.seed)
  const seedRegisterShift =
    config.seed === 1 ? 0 : Math.floor(rng() * 3) - 1

  // Build grid of representative hex colors (or null for transparent) of size `totalSteps x sampledRows`
  const sampledRows: number[] = []
  for (let y = 0; y < safeH; y += yStride) {
    sampledRows.push(y)
  }

  const rawCandidates: NoteEvent[] = []

  for (const y of sampledRows) {
    let step = 0
    while (step < totalSteps) {
      const px = Math.min(safeW - 1, step * xStride)
      const off = (y * safeW + px) * 4
      const a = rgbaBuffer[off + 3] ?? 0
      if (a === 0) {
        step++
        continue
      }

      const hex = rgbaToHex({
        r: rgbaBuffer[off]!,
        g: rgbaBuffer[off + 1]!,
        b: rgbaBuffer[off + 2]!,
      })

      // Measure horizontal contiguous run of the same color!
      let runLen = 1
      while (step + runLen < totalSteps && runLen < 16) {
        const nx = Math.min(safeW - 1, (step + runLen) * xStride)
        const nOff = (y * safeW + nx) * 4
        const na = rgbaBuffer[nOff + 3] ?? 0
        if (na === 0) break
        const nHex = rgbaToHex({
          r: rgbaBuffer[nOff]!,
          g: rgbaBuffer[nOff + 1]!,
          b: rgbaBuffer[nOff + 2]!,
        })
        if (nHex !== hex) break
        runLen++
      }

      const { channel, dutyCycle } = classifyColorToChannel(
        hex,
        paletteColors,
        y,
        safeH,
        config.seed
      )

      if (config.activeChannels[channel]) {
        const midiNote = mapYToMidiNote(
          y,
          safeH,
          channel,
          config.scale,
          config.rootNote,
          seedRegisterShift
        )
        const velocity = Math.max(0.2, Math.min(0.95, (a / 255) * 0.85))
        rawCandidates.push({
          channel,
          startStep: step,
          durationSteps: channel === 'noise' ? Math.min(2, runLen) : runLen,
          midiNote,
          frequencyHz: midiToFrequencyHz(midiNote),
          velocity,
          dutyCycle,
          sourceX: px,
          sourceY: y,
          colorHex: hex,
        })
      }

      step += runLen
    }
  }

  // Enforce authentic NES polyphony cap per step & channel so dense filled artworks sound musical, never clipped!
  // Max simultaneous attacks per step: pulse1=2, pulse2=2, triangle=1 (monophonic bass), noise=1
  const POLYPHONY_CAP: Record<NesChannelId, number> = {
    pulse1: 2,
    pulse2: 2,
    triangle: 1,
    noise: 1,
  }

  const byStepAndChannel = new Map<string, NoteEvent[]>()
  for (const ev of rawCandidates) {
    const key = `${ev.startStep}:${ev.channel}`
    const bucket = byStepAndChannel.get(key)
    if (bucket) bucket.push(ev)
    else byStepAndChannel.set(key, [ev])
  }

  const selectedNotes: NoteEvent[] = []
  const channelCounts: Record<NesChannelId, number> = {
    pulse1: 0,
    pulse2: 0,
    triangle: 0,
    noise: 0,
  }

  const sortedKeys = Array.from(byStepAndChannel.keys()).sort((a, b) => {
    const sa = Number(a.split(':')[0])
    const sb = Number(b.split(':')[0])
    return sa - sb
  })

  for (const key of sortedKeys) {
    const list = byStepAndChannel.get(key)!
    const ch = list[0]!.channel
    const cap = POLYPHONY_CAP[ch]

    // Deterministic priority: prefer longer horizontal melodic runs, then top/outer contour notes
    list.sort((a, b) => {
      if (b.durationSteps !== a.durationSteps) {
        return b.durationSteps - a.durationSteps
      }
      return ch === 'triangle' ? b.sourceY - a.sourceY : a.sourceY - b.sourceY
    })

    const picked = list.slice(0, cap)
    for (const note of picked) {
      selectedNotes.push(note)
      channelCounts[note.channel]++
    }
  }

  selectedNotes.sort((a, b) =>
    a.startStep !== b.startStep
      ? a.startStep - b.startStep
      : a.midiNote - b.midiNote
  )

  return {
    width: safeW,
    height: safeH,
    totalSteps,
    stepDurationSec,
    totalDurationSec: totalSteps * stepDurationSec,
    notes: selectedNotes,
    channelCounts,
  }
}
