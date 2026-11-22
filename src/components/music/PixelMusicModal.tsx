import { useEffect, useMemo, useRef, useState } from 'react'
import type { LanguageCode, LayerRuntime } from '../../types'
import { compositeLayers } from '../../engine/compositor'
import { analyzePixelsToMusic } from '../../music/analyzer'
import { PixelMusicPlayer, type MusicPlaybackState } from '../../music/player'
import {
  DEFAULT_PIXEL_MUSIC_CONFIG,
  type NesChannelId,
  type PixelMusicConfig,
  type RootNoteName,
  type ScaleId,
} from '../../music/types'
import { encodePcmToWavBytes, synthesizeScoreToPcm } from '../../music/wavEncoder'
import { Modal } from '../common/Modal'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { PixelIcon } from '../common/PixelIcon'
import { PixelSelect } from '../common/PixelSelect'
import { PixelSlider } from '../common/PixelSlider'
import { useI18n } from '../../i18n/I18nContext'

const MUSIC_LABELS: Record<
  LanguageCode,
  {
    title: string
    subtitle: string
    play: string
    pause: string
    stop: string
    restart: string
    regenerate: string
    downloadWav: string
    tabBasic: string
    tabDetailed: string
    volume: string
    bpm: string
    speed: string
    scale: string
    rootNote: string
    loop: string
    seed: string
    channels: string
    chPulse1: string
    chPulse2: string
    chTriangle: string
    chNoise: string
    emptyScoreHint: string
    notesCount: string
    durationSec: string
    scaleMajorPenta: string
    scaleMinorPenta: string
    scaleMajor: string
    scaleMinor: string
    scaleDorian: string
  }
> = {
  ja: {
    title: 'ドット絵 → 8bit音楽変換 (NES 4ch)',
    subtitle: 'X=時間・Y=音高・色=音色・横連続=音価として4chファミコン風音源へ変換します',
    play: '再生',
    pause: '一時停止',
    stop: '停止',
    restart: '先頭から',
    regenerate: '別パターン生成',
    downloadWav: 'WAV保存 (.wav)',
    tabBasic: 'かんたん設定',
    tabDetailed: '詳細設定',
    volume: '音量',
    bpm: 'テンポ (BPM)',
    speed: '再生速度',
    scale: 'スケール（音階）',
    rootNote: 'ルート音（基音）',
    loop: 'ループ再生',
    seed: 'シード値',
    channels: '有効チャンネル (4ch APU)',
    chPulse1: 'Pulse 1（主旋律・矩形波）',
    chPulse2: 'Pulse 2（伴奏・矩形波）',
    chTriangle: 'Triangle（ベース・三角波）',
    chNoise: 'Noise（ドラム・ノイズ）',
    emptyScoreHint: '描画された不透明ピクセルがないため無音です。ピクセルを描くとメロディが生成されます。',
    notesCount: '発音ノート数',
    durationSec: '1ループ長',
    scaleMajorPenta: 'メジャーペンタトニック（明るい王道）',
    scaleMinorPenta: 'マイナーペンタトニック（哀愁・チップチューン）',
    scaleMajor: 'メジャースケール（長調）',
    scaleMinor: 'ナチュラルマイナー（短調）',
    scaleDorian: 'ドリアン（RPGフィールド風）',
  },
  en: {
    title: 'Pixel Art → 8-bit Music (NES 4ch)',
    subtitle: 'Maps X=time, Y=pitch, color=channel, and horizontal runs=note length',
    play: 'Play',
    pause: 'Pause',
    stop: 'Stop',
    restart: 'Restart',
    regenerate: 'Regenerate',
    downloadWav: 'Export WAV (.wav)',
    tabBasic: 'Basic',
    tabDetailed: 'Detailed',
    volume: 'Volume',
    bpm: 'Tempo (BPM)',
    speed: 'Speed',
    scale: 'Scale',
    rootNote: 'Root Note',
    loop: 'Loop Playback',
    seed: 'Seed',
    channels: 'Active Channels (4ch APU)',
    chPulse1: 'Pulse 1 (Lead Square)',
    chPulse2: 'Pulse 2 (Harmony Square)',
    chTriangle: 'Triangle (Bass)',
    chNoise: 'Noise (Percussion)',
    emptyScoreHint: 'Canvas has no opaque pixels yet — draw pixels to generate chiptune notes.',
    notesCount: 'Notes',
    durationSec: 'Loop Length',
    scaleMajorPenta: 'Major Pentatonic',
    scaleMinorPenta: 'Minor Pentatonic',
    scaleMajor: 'Major',
    scaleMinor: 'Natural Minor',
    scaleDorian: 'Dorian',
  },
  ko: {
    title: '도트 그림 → 8비트 음악 변환 (NES 4ch)',
    subtitle: 'X=시간 · Y=음높이 · 색상=음색 · 가로 연속=음길이로 4채널 사운드를 생성합니다',
    play: '재생',
    pause: '일시정지',
    stop: '정지',
    restart: '처음부터',
    regenerate: '패턴 재생성',
    downloadWav: 'WAV 저장 (.wav)',
    tabBasic: '기본 설정',
    tabDetailed: '상세 설정',
    volume: '볼륨',
    bpm: '템포 (BPM)',
    speed: '재생 속도',
    scale: '스케일 (음계)',
    rootNote: '루트 음',
    loop: '반복 재생',
    seed: '시드 값',
    channels: '활성 채널 (4ch APU)',
    chPulse1: 'Pulse 1 (주선율 사각파)',
    chPulse2: 'Pulse 2 (반주 사각파)',
    chTriangle: 'Triangle (베이스 삼각파)',
    chNoise: 'Noise (드럼 노이즈)',
    emptyScoreHint: '불투명 픽셀이 없어 무음 상태입니다. 도트를 그리면 멜로디가 생성됩니다.',
    notesCount: '노트 수',
    durationSec: '길이',
    scaleMajorPenta: '메이저 펜타토닉',
    scaleMinorPenta: '마이너 펜타토닉',
    scaleMajor: '메이저 스케일',
    scaleMinor: '내추럴 마이너',
    scaleDorian: '도리안',
  },
}

const ROOT_NOTES: RootNoteName[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
]

interface PixelMusicModalProps {
  open: boolean
  projectName: string
  width: number
  height: number
  layers: readonly LayerRuntime[]
  paletteColors: readonly string[]
  onClose: () => void
}

export function PixelMusicModal({
  open,
  projectName,
  width,
  height,
  layers,
  paletteColors,
  onClose,
}: PixelMusicModalProps) {
  const { language } = useI18n()
  const m = MUSIC_LABELS[language]

  const [config, setConfig] = useState<PixelMusicConfig>(DEFAULT_PIXEL_MUSIC_CONFIG)
  const [settingsTab, setSettingsTab] = useState<'basic' | 'detailed'>('basic')
  const [playState, setPlayState] = useState<MusicPlaybackState>('stopped')
  const [progressRatio, setProgressRatio] = useState(0)

  const playerRef = useRef<PixelMusicPlayer | null>(null)

  const composited = useMemo(() => {
    if (!open || layers.length === 0) return null
    return compositeLayers(layers, width, height)
  }, [open, layers, width, height])

  const score = useMemo(() => {
    if (!composited) return null
    return analyzePixelsToMusic(composited, width, height, paletteColors, config)
  }, [composited, width, height, paletteColors, config])

  useEffect(() => {
    if (!open) {
      playerRef.current?.stop()
      setPlayState('stopped')
      setProgressRatio(0)
      return
    }
    if (!playerRef.current) {
      playerRef.current = new PixelMusicPlayer()
    }
    if (score) {
      playerRef.current.loadScore(score, config.loop, config.volume)
      setPlayState('stopped')
      setProgressRatio(0)
    }
  }, [
    open,
    score,
    // Keep volume/loop live without resetting playback when adjusted alone:
  ])

  useEffect(() => {
    return () => {
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (playState !== 'playing' || !score || score.totalDurationSec <= 0) return
    const id = window.setInterval(() => {
      const cur = playerRef.current?.getCurrentTimeSec() ?? 0
      setProgressRatio(Math.max(0, Math.min(1, cur / score.totalDurationSec)))
    }, 60)
    return () => window.clearInterval(id)
  }, [playState, score])

  const handlePlayPause = async () => {
    if (!playerRef.current || !score || score.notes.length === 0) return
    if (playState === 'playing') {
      playerRef.current.pause()
      setPlayState('paused')
    } else {
      await playerRef.current.play(() => {
        setPlayState('stopped')
        setProgressRatio(0)
      })
      setPlayState('playing')
    }
  }

  const handleStop = () => {
    playerRef.current?.stop()
    setPlayState('stopped')
    setProgressRatio(0)
  }

  const handleRestart = async () => {
    if (!playerRef.current || !score || score.notes.length === 0) return
    setProgressRatio(0)
    await playerRef.current.restart(() => {
      setPlayState('stopped')
      setProgressRatio(0)
    })
    setPlayState('playing')
  }

  const handleRegenerate = () => {
    setConfig((prev) => ({ ...prev, seed: (prev.seed % 9999) + 1 }))
  }

  const handleDownloadWav = () => {
    if (!score) return
    const pcm = synthesizeScoreToPcm(score, config.volume)
    const wavBytes = encodePcmToWavBytes(pcm)
    const blob = new Blob([wavBytes.slice().buffer], { type: 'audio/wav' })
    const url = URL.createObjectURL(blob)
    const safeName =
      projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-artwork'
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeName}_8bit_seed${config.seed}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const scaleOptions: Array<{ value: ScaleId; label: string }> = [
    { value: 'majorPentatonic', label: m.scaleMajorPenta },
    { value: 'minorPentatonic', label: m.scaleMinorPenta },
    { value: 'major', label: m.scaleMajor },
    { value: 'naturalMinor', label: m.scaleMinor },
    { value: 'dorian', label: m.scaleDorian },
  ]

  const rootOptions: Array<{ value: RootNoteName; label: string }> =
    ROOT_NOTES.map((r) => ({ value: r, label: r }))

  const toggleChannel = (ch: NesChannelId, next: boolean) => {
    setConfig((prev) => ({
      ...prev,
      activeChannels: {
        ...prev.activeChannels,
        [ch]: next,
      },
    }))
  }

  return (
    <Modal open={open} title={m.title} onClose={onClose} maxWidthClass="max-w-lg">
      <div className="space-y-3.5" data-testid="pixel-music-modal">
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {m.subtitle}
        </p>

        {/* Step Progress & Summary Card */}
        <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span>
              {m.notesCount}:{' '}
              <strong data-testid="music-note-count">
                {score?.notes.length ?? 0}
              </strong>
            </span>
            <span>
              {m.durationSec}:{' '}
              <strong>{(score?.totalDurationSec ?? 0).toFixed(2)}s</strong>
            </span>
          </div>

          {/* Pixel Step Progress Bar */}
          <div className="w-full h-3 bg-[var(--bg-app)] border-2 border-[var(--border-pixel)] overflow-hidden">
            <div
              style={{ width: `${Math.round(progressRatio * 100)}%` }}
              className="h-full bg-[var(--accent-teal)]"
            />
          </div>

          {score && score.notes.length === 0 && (
            <p className="text-xs font-bold text-[var(--accent-amber)]">
              {m.emptyScoreHint}
            </p>
          )}

          {/* Transport Controls */}
          <div className="grid grid-cols-4 gap-1.5 pt-1">
            <button
              type="button"
              disabled={!score || score.notes.length === 0}
              onClick={() => void handlePlayPause()}
              className="pixel-btn pixel-btn-active min-h-[42px] px-2 text-xs font-bold flex items-center justify-center gap-1.5"
              data-testid="music-play-pause-btn"
            >
              <PixelIcon
                name={playState === 'playing' ? 'pause' : 'play'}
                size={14}
              />
              <span>{playState === 'playing' ? m.pause : m.play}</span>
            </button>

            <button
              type="button"
              disabled={playState === 'stopped'}
              onClick={handleStop}
              className="pixel-btn min-h-[42px] px-2 text-xs font-bold flex items-center justify-center gap-1.5"
              data-testid="music-stop-btn"
            >
              <PixelIcon name="stop" size={14} />
              <span>{m.stop}</span>
            </button>

            <button
              type="button"
              disabled={!score || score.notes.length === 0}
              onClick={() => void handleRestart()}
              className="pixel-btn min-h-[42px] px-2 text-xs font-bold flex items-center justify-center gap-1"
              data-testid="music-restart-btn"
            >
              <PixelIcon name="undo" size={14} />
              <span>{m.restart}</span>
            </button>

            <button
              type="button"
              onClick={handleRegenerate}
              className="pixel-btn pixel-btn-teal min-h-[42px] px-2 text-xs font-bold flex items-center justify-center gap-1"
              data-testid="music-regenerate-btn"
            >
              <PixelIcon name="sparkle" size={14} />
              <span className="truncate">{m.regenerate}</span>
            </button>
          </div>
        </div>

        {/* Basic vs Detailed Mode Switch */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setSettingsTab('basic')}
            className={`min-h-[38px] text-xs font-bold ${
              settingsTab === 'basic' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="music-tab-basic"
          >
            {m.tabBasic}
          </button>
          <button
            type="button"
            onClick={() => setSettingsTab('detailed')}
            className={`min-h-[38px] text-xs font-bold ${
              settingsTab === 'detailed'
                ? 'pixel-btn pixel-btn-active'
                : 'pixel-btn'
            }`}
            data-testid="music-tab-detailed"
          >
            {m.tabDetailed}
          </button>
        </div>

        {/* Basic Controls (Always clean & approachable) */}
        <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-3">
          <div className="flex items-center gap-2.5">
            <span className="w-24 text-xs font-bold text-[var(--text-secondary)] shrink-0">
              {m.volume}: {config.volume}%
            </span>
            <PixelSlider
              min={0}
              max={100}
              step={5}
              value={config.volume}
              ariaLabel={m.volume}
              onChange={(vol) => {
                setConfig((prev) => ({ ...prev, volume: vol }))
                playerRef.current?.setVolume(vol)
              }}
              className="flex-1"
              testId="music-volume-slider"
            />
          </div>

          <div className="flex items-center gap-2.5">
            <span className="w-24 text-xs font-bold text-[var(--text-secondary)] shrink-0">
              {m.bpm}: {config.bpm}
            </span>
            <PixelSlider
              min={60}
              max={240}
              step={4}
              value={config.bpm}
              ariaLabel={m.bpm}
              onChange={(bpm) => setConfig((prev) => ({ ...prev, bpm }))}
              className="flex-1"
              testId="music-bpm-slider"
            />
          </div>

          <div className="space-y-1">
            <span className="text-xs font-bold text-[var(--text-secondary)] block">
              {m.scale}
            </span>
            <PixelSelect<ScaleId>
              value={config.scale}
              options={scaleOptions}
              onChange={(scale) => setConfig((prev) => ({ ...prev, scale }))}
              ariaLabel={m.scale}
              className="w-full"
              testId="music-scale-select"
            />
          </div>

          <PixelCheckbox
            checked={config.loop}
            onChange={(loop) => {
              setConfig((prev) => ({ ...prev, loop }))
              playerRef.current?.setLoop(loop)
            }}
            label={m.loop}
            testId="music-loop-checkbox"
          />

          {/* Detailed Controls */}
          {settingsTab === 'detailed' && (
            <div className="pt-2.5 border-t border-[var(--border-subtle)] space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {m.rootNote}
                  </span>
                  <PixelSelect<RootNoteName>
                    value={config.rootNote}
                    options={rootOptions}
                    onChange={(rootNote) =>
                      setConfig((prev) => ({ ...prev, rootNote }))
                    }
                    ariaLabel={m.rootNote}
                    className="w-full"
                    testId="music-root-select"
                  />
                </div>

                <label className="space-y-1 block">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {m.seed}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={config.seed}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        seed: Math.max(1, Math.min(9999, Number(e.target.value) || 1)),
                      }))
                    }
                    className="w-full min-h-[38px] px-2.5 text-xs font-bold pixel-input"
                    data-testid="music-seed-input"
                  />
                </label>
              </div>

              <div className="flex items-center gap-2.5">
                <span className="w-28 text-xs font-bold text-[var(--text-secondary)] shrink-0">
                  {m.speed}: {config.speed.toFixed(2)}x
                </span>
                <PixelSlider
                  min={50}
                  max={200}
                  step={25}
                  value={Math.round(config.speed * 100)}
                  ariaLabel={m.speed}
                  onChange={(pct) =>
                    setConfig((prev) => ({ ...prev, speed: pct / 100 }))
                  }
                  className="flex-1"
                  testId="music-speed-slider"
                />
              </div>

              <div className="space-y-1">
                <span className="text-xs font-bold text-[var(--text-secondary)] block">
                  {m.channels}
                </span>
                <div className="flex flex-col gap-0.5">
                  <PixelCheckbox
                    checked={config.activeChannels.pulse1}
                    onChange={(v) => toggleChannel('pulse1', v)}
                    label={`${m.chPulse1} (${score?.channelCounts.pulse1 ?? 0})`}
                  />
                  <PixelCheckbox
                    checked={config.activeChannels.pulse2}
                    onChange={(v) => toggleChannel('pulse2', v)}
                    label={`${m.chPulse2} (${score?.channelCounts.pulse2 ?? 0})`}
                  />
                  <PixelCheckbox
                    checked={config.activeChannels.triangle}
                    onChange={(v) => toggleChannel('triangle', v)}
                    label={`${m.chTriangle} (${score?.channelCounts.triangle ?? 0})`}
                  />
                  <PixelCheckbox
                    checked={config.activeChannels.noise}
                    onChange={(v) => toggleChannel('noise', v)}
                    label={`${m.chNoise} (${score?.channelCounts.noise ?? 0})`}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Lossless WAV Download CTA */}
        <button
          type="button"
          onClick={handleDownloadWav}
          className="w-full min-h-[48px] pixel-btn pixel-btn-teal text-sm font-bold flex items-center justify-center gap-2"
          data-testid="music-download-wav-btn"
        >
          <PixelIcon name="download" size={16} />
          <span>{m.downloadWav}</span>
        </button>
      </div>
    </Modal>
  )
}
