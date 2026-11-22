import type { PixelMusicScore } from './types'

export const DEFAULT_SAMPLE_RATE = 44100

/**
 * Synthesize a `PixelMusicScore` into a normalized mono `Float32Array` PCM buffer
 * emulating NES 2A03 APU 4-channel waveforms:
 * - Pulse 1 & Pulse 2: Duty-cycle square wave (`12.5%`, `25%`, `50%`)
 * - Triangle: Quantized 16-step (4-bit) NES staircase triangle wave
 * - Noise: 15-bit LFSR pseudo-random chiptune percussion noise
 */
export function synthesizeScoreToPcm(
  score: PixelMusicScore,
  volumePercent = 75,
  sampleRate = DEFAULT_SAMPLE_RATE
): Float32Array {
  const totalSamples = Math.max(
    1,
    Math.ceil(score.totalDurationSec * sampleRate)
  )
  const pcm = new Float32Array(totalSamples)
  if (score.notes.length === 0) {
    return pcm
  }

  const masterGain = Math.max(0, Math.min(1, volumePercent / 100)) * 0.42

  for (const note of score.notes) {
    const startSample = Math.max(
      0,
      Math.floor(note.startStep * score.stepDurationSec * sampleRate)
    )
    const noteSamples = Math.max(
      1,
      Math.floor(note.durationSteps * score.stepDurationSec * sampleRate)
    )
    const endSample = Math.min(totalSamples, startSample + noteSamples)
    if (endSample <= startSample) continue

    const attackSamples = Math.max(1, Math.floor(0.004 * sampleRate))
    const releaseSamples = Math.max(1, Math.floor(0.018 * sampleRate))

    const chWeight =
      note.channel === 'triangle'
        ? 0.34
        : note.channel === 'noise'
          ? 0.22
          : 0.26
    const amp = note.velocity * chWeight * masterGain
    const duty = note.dutyCycle ?? 0.5
    const phaseInc = note.frequencyHz / sampleRate

    let phase = 0
    // Deterministic LFSR state for NES noise channel
    let lfsr = (0x7fff ^ (note.midiNote * 131)) & 0x7fff
    if (lfsr === 0) lfsr = 1
    const noisePeriodSamples = Math.max(
      2,
      Math.round(sampleRate / Math.max(400, note.frequencyHz * 8))
    )

    for (let i = startSample; i < endSample; i++) {
      const localIdx = i - startSample
      const remIdx = endSample - 1 - i

      let env = 1.0
      if (localIdx < attackSamples) {
        env = localIdx / attackSamples
      } else if (note.channel === 'noise') {
        env = Math.exp((-localIdx / sampleRate) * 22)
      } else if (remIdx < releaseSamples) {
        env = remIdx / releaseSamples
      }

      let rawSample = 0
      if (note.channel === 'pulse1' || note.channel === 'pulse2') {
        rawSample = phase < duty ? 1 : -1
      } else if (note.channel === 'triangle') {
        // 4-bit quantized staircase triangle (authentic NES 2A03 character)
        const tri = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4
        rawSample = Math.round(tri * 7.5) / 7.5
      } else {
        if (localIdx % noisePeriodSamples === 0) {
          const feedback = ((lfsr & 1) ^ ((lfsr >> 1) & 1)) & 1
          lfsr = (lfsr >> 1) | (feedback << 14)
        }
        rawSample = (lfsr & 1) === 1 ? 1 : -1
      }

      pcm[i] += rawSample * amp * env
      phase += phaseInc
      if (phase >= 1) phase -= Math.floor(phase)
    }
  }

  // Soft clamp to [-1, 1] to guarantee zero digital clipping
  for (let i = 0; i < totalSamples; i++) {
    const v = pcm[i]!
    if (v > 0.98) pcm[i] = 0.98
    else if (v < -0.98) pcm[i] = -0.98
  }

  return pcm
}

/**
 * Encode mono `Float32Array` PCM samples into a standard lossless 16-bit PCM RIFF `.wav` byte array.
 */
export function encodePcmToWavBytes(
  pcm: Float32Array,
  sampleRate = DEFAULT_SAMPLE_RATE
): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const dataByteLength = pcm.length * numChannels * bytesPerSample
  const totalByteLength = 44 + dataByteLength

  const buffer = new ArrayBuffer(totalByteLength)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  // RIFF chunk descriptor
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataByteLength, true)
  writeAscii(8, 'WAVE')

  // fmt sub-chunk
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // Subchunk1Size for PCM
  view.setUint16(20, 1, true) // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true) // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true) // BlockAlign
  view.setUint16(34, bitsPerSample, true)

  // data sub-chunk
  writeAscii(36, 'data')
  view.setUint32(40, dataByteLength, true)

  let offset = 44
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]!))
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
    view.setInt16(offset, int16, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}
