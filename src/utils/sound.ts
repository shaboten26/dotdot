let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!audioCtx) {
    audioCtx = new Ctor()
  }
  return audioCtx
}

/**
 * Subtle tactile synth tick for Draw button / Undo / Redo when soundEnabled is turned ON in Settings.
 */
export function playUiTick(kind: 'draw' | 'step' | 'undo' = 'draw', enabled = false): void {
  if (!enabled) return
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    const now = ctx.currentTime
    osc.frequency.setValueAtTime(
      kind === 'draw' ? 520 : kind === 'step' ? 660 : 380,
      now
    )
    gain.gain.setValueAtTime(0.035, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.04)
  } catch {
    // Ignore audio errors
  }
}
