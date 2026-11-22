import type { PixelMusicScore } from './types'
import { DEFAULT_SAMPLE_RATE, synthesizeScoreToPcm } from './wavEncoder'

export type MusicPlaybackState = 'stopped' | 'playing' | 'paused'

/**
 * Web Audio API player backed by `synthesizeScoreToPcm` so live playback and `.wav` export sound 100% identical!
 * Supports Play, Pause, Stop, Restart, live Volume control, Loop toggle, and playback progress polling.
 */
export class PixelMusicPlayer {
  private ctx: AudioContext | null = null
  private gainNode: GainNode | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private renderedBuffer: AudioBuffer | null = null
  private scoreDurationSec = 0
  private startedAtCtxTime = 0
  private pausedOffsetSec = 0
  private loop = true
  private volume = 75
  private state: MusicPlaybackState = 'stopped'

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AudioCtx) return null
    if (!this.ctx) {
      this.ctx = new AudioCtx()
      this.gainNode = this.ctx.createGain()
      this.gainNode.gain.value = Math.max(0, Math.min(1.5, this.volume / 75))
      this.gainNode.connect(this.ctx.destination)
    }
    return this.ctx
  }

  loadScore(score: PixelMusicScore, loop: boolean, volumePercent: number): void {
    this.stop()
    this.loop = loop
    this.volume = volumePercent
    this.scoreDurationSec = score.totalDurationSec

    const ctx = this.ensureContext()
    if (!ctx) return

    const sampleRate = DEFAULT_SAMPLE_RATE
    // Synthesize at nominal 75% reference so live gain node scales cleanly without re-rendering
    const pcm = synthesizeScoreToPcm(score, 75, sampleRate)
    const buf = ctx.createBuffer(1, Math.max(1, pcm.length), sampleRate)
    buf.getChannelData(0).set(pcm)
    this.renderedBuffer = buf
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1.5, volumePercent / 75))
    }
  }

  async play(onEnded?: () => void): Promise<void> {
    const ctx = this.ensureContext()
    if (!ctx || !this.renderedBuffer || !this.gainNode) return
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
    if (this.state === 'playing') return

    this.disconnectSource()
    const src = ctx.createBufferSource()
    src.buffer = this.renderedBuffer
    src.loop = this.loop
    src.connect(this.gainNode)

    const startOffset =
      this.scoreDurationSec > 0
        ? Math.max(0, Math.min(this.scoreDurationSec - 0.001, this.pausedOffsetSec))
        : 0

    src.onended = () => {
      if (this.sourceNode === src && !this.loop && this.state === 'playing') {
        this.state = 'stopped'
        this.pausedOffsetSec = 0
        this.sourceNode = null
        onEnded?.()
      }
    }

    this.sourceNode = src
    this.startedAtCtxTime = ctx.currentTime - startOffset
    this.state = 'playing'
    src.start(0, startOffset)
  }

  pause(): void {
    if (this.state !== 'playing' || !this.ctx) return
    const elapsed = this.ctx.currentTime - this.startedAtCtxTime
    this.pausedOffsetSec =
      this.scoreDurationSec > 0
        ? this.loop
          ? elapsed % this.scoreDurationSec
          : Math.min(this.scoreDurationSec, elapsed)
        : 0
    this.disconnectSource()
    this.state = 'paused'
  }

  stop(): void {
    this.disconnectSource()
    this.pausedOffsetSec = 0
    this.state = 'stopped'
  }

  async restart(onEnded?: () => void): Promise<void> {
    this.stop()
    await this.play(onEnded)
  }

  setVolume(volumePercent: number): void {
    this.volume = volumePercent
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1.5, volumePercent / 75))
    }
  }

  setLoop(loop: boolean): void {
    this.loop = loop
    if (this.sourceNode) {
      this.sourceNode.loop = loop
    }
  }

  getState(): MusicPlaybackState {
    return this.state
  }

  getCurrentTimeSec(): number {
    if (this.state === 'playing' && this.ctx && this.scoreDurationSec > 0) {
      const elapsed = Math.max(0, this.ctx.currentTime - this.startedAtCtxTime)
      return this.loop
        ? elapsed % this.scoreDurationSec
        : Math.min(this.scoreDurationSec, elapsed)
    }
    return this.pausedOffsetSec
  }

  dispose(): void {
    this.stop()
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.gainNode = null
    }
  }

  private disconnectSource(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null
        this.sourceNode.stop()
        this.sourceNode.disconnect()
      } catch {
        // ignore already stopped source
      }
      this.sourceNode = null
    }
  }
}
