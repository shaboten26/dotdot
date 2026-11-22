export type NesChannelId = 'pulse1' | 'pulse2' | 'triangle' | 'noise'

export type ScaleId =
  | 'majorPentatonic'
  | 'minorPentatonic'
  | 'major'
  | 'naturalMinor'
  | 'dorian'

export type RootNoteName =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B'

export interface ActiveChannelsConfig {
  pulse1: boolean
  pulse2: boolean
  triangle: boolean
  noise: boolean
}

export interface PixelMusicConfig {
  bpm: number // 60 - 240
  scale: ScaleId
  rootNote: RootNoteName
  volume: number // 0 - 100
  speed: number // 0.5 - 2.0
  seed: number // deterministic integer seed
  loop: boolean
  activeChannels: ActiveChannelsConfig
}

export interface NoteEvent {
  channel: NesChannelId
  startStep: number
  durationSteps: number
  midiNote: number
  frequencyHz: number
  velocity: number // 0.05 - 1.0
  dutyCycle?: 0.125 | 0.25 | 0.5
  sourceX: number
  sourceY: number
  colorHex: string
}

export interface PixelMusicScore {
  width: number
  height: number
  totalSteps: number
  stepDurationSec: number
  totalDurationSec: number
  notes: NoteEvent[]
  channelCounts: Record<NesChannelId, number>
}

export const DEFAULT_PIXEL_MUSIC_CONFIG: PixelMusicConfig = {
  bpm: 132,
  scale: 'majorPentatonic',
  rootNote: 'C',
  volume: 75,
  speed: 1.0,
  seed: 1,
  loop: true,
  activeChannels: {
    pulse1: true,
    pulse2: true,
    triangle: true,
    noise: true,
  },
}
