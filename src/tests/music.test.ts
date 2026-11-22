import { describe, expect, it } from 'vitest'
import { createPixelBuffer, setPixel } from '../engine/pixelBuffer'
import { analyzePixelsToMusic } from '../music/analyzer'
import { DEFAULT_PIXEL_MUSIC_CONFIG } from '../music/types'
import {
  DEFAULT_SAMPLE_RATE,
  encodePcmToWavBytes,
  synthesizeScoreToPcm,
} from '../music/wavEncoder'

const RED = { r: 240, g: 50, b: 60, a: 255 }
const BLUE = { r: 50, g: 100, b: 220, a: 255 }
const DARK_GRAY = { r: 40, g: 40, b: 42, a: 255 }

describe('Pixel-to-8bit Music Engine (4ch NES APU Analyzer, Synth & Lossless WAV Encoder)', () => {
  it('treats fully transparent canvas as silence (0 note events)', () => {
    const empty = createPixelBuffer(16, 16)
    const score = analyzePixelsToMusic(
      empty,
      16,
      16,
      ['#F0323C', '#3264DC'],
      DEFAULT_PIXEL_MUSIC_CONFIG
    )
    expect(score.notes.length).toBe(0)
    const pcm = synthesizeScoreToPcm(score, 75)
    expect(pcm.every((s) => s === 0)).toBe(true)
  })

  it('maps Y coordinate to pitch (top = higher pitch, bottom = lower pitch) and horizontal contiguous runs to longer note duration', () => {
    const w = 16
    const h = 16
    const buf = createPixelBuffer(w, h)

    // Top row (y = 1): 4-pixel horizontal contiguous run starting at x = 0
    for (let x = 0; x < 4; x++) {
      setPixel(buf, w, h, x, 1, RED)
    }
    // Lower row (y = 10): single 1-pixel staccato note at x = 6
    setPixel(buf, w, h, 6, 10, RED)
    // Bottom dark pixel (y = 15): percussion noise hit at x = 8
    setPixel(buf, w, h, 8, 15, DARK_GRAY)

    const score = analyzePixelsToMusic(
      buf,
      w,
      h,
      ['#F0323C', '#3264DC', '#28282A'],
      DEFAULT_PIXEL_MUSIC_CONFIG
    )

    const highSustained = score.notes.find((n) => n.sourceX === 0 && n.sourceY === 1)!
    const lowShort = score.notes.find((n) => n.sourceX === 6 && n.sourceY === 10)!
    const drumHit = score.notes.find((n) => n.sourceX === 8 && n.sourceY === 15)!

    expect(highSustained).toBeTruthy()
    expect(lowShort).toBeTruthy()
    expect(drumHit).toBeTruthy()

    expect(highSustained.durationSteps).toBe(4)
    expect(lowShort.durationSteps).toBe(1)
    expect(highSustained.midiNote).toBeGreaterThan(lowShort.midiNote)
    expect(drumHit.channel).toBe('noise')
  })

  it('is 100% deterministic for identical seed & config, and encodes valid 16-bit RIFF WAVE audio', () => {
    const buf = createPixelBuffer(8, 8)
    setPixel(buf, 8, 8, 0, 1, RED)
    setPixel(buf, 8, 8, 2, 4, BLUE)
    setPixel(buf, 8, 8, 4, 7, DARK_GRAY)

    const cfg = { ...DEFAULT_PIXEL_MUSIC_CONFIG, bpm: 160, seed: 42 }
    const s1 = analyzePixelsToMusic(buf, 8, 8, ['#F0323C', '#3264DC', '#28282A'], cfg)
    const s2 = analyzePixelsToMusic(buf, 8, 8, ['#F0323C', '#3264DC', '#28282A'], cfg)
    expect(s1).toEqual(s2)

    const pcm = synthesizeScoreToPcm(s1, 80, DEFAULT_SAMPLE_RATE)
    expect(pcm.some((v) => Math.abs(v) > 0.01)).toBe(true)

    const wav = encodePcmToWavBytes(pcm, DEFAULT_SAMPLE_RATE)
    const headerAscii = String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)
    const waveAscii = String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)
    const fmtAscii = String.fromCharCode(wav[12]!, wav[13]!, wav[14]!, wav[15]!)
    const dataAscii = String.fromCharCode(wav[36]!, wav[37]!, wav[38]!, wav[39]!)

    expect(headerAscii).toBe('RIFF')
    expect(waveAscii).toBe('WAVE')
    expect(fmtAscii).toBe('fmt ')
    expect(dataAscii).toBe('data')
    expect(wav.byteLength).toBe(44 + pcm.length * 2)
  })
})
