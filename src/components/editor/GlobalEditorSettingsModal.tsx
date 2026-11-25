import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  CursorDisplaySize,
  CustomCursorData,
  CustomCursorGridSize,
} from '../../types'
import {
  generateId,
  MAX_CURSOR_SPEED,
  MIN_CURSOR_SPEED,
} from '../../db/database'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { getCheckerboardStyle } from '../common/PixelThumbnail'

const CURSOR_EDITOR_PALETTE = [
  '#f8f6f2',
  '#181521',
  '#9b8ec7',
  '#5fa399',
  '#cc7a8f',
  '#deb068',
  '#7ba2cc',
  '#8fc48a',
] as const

type CursorEditorTool = 'pen' | 'eraser' | 'hotspot'

export function createArrowCursorTemplate(
  gridSize: CustomCursorGridSize
): Pick<CustomCursorData, 'pixels' | 'hotspotX' | 'hotspotY'> {
  const pixels = new Array<string>(gridSize * gridSize).fill('')
  const setPx = (x: number, y: number, hex: string) => {
    if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
      pixels[y * gridSize + x] = hex
    }
  }
  if (gridSize === 8) {
    const rows = [
      '#.......',
      '##......',
      '###.....',
      '####....',
      '#####...',
      '###.....',
      '#.##....',
      '...#....',
    ]
    rows.forEach((row, y) => {
      for (let x = 0; x < 8; x++) {
        if (row[x] === '#') setPx(x, y, '#f8f6f2')
      }
    })
    return { pixels, hotspotX: 0, hotspotY: 0 }
  }
  const rows16 = [
    '#...............',
    '##..............',
    '###.............',
    '####............',
    '#####...........',
    '######..........',
    '#######.........',
    '########........',
    '#########.......',
    '######..........',
    '###.###.........',
    '##...###........',
    '#.....###.......',
    '.......##.......',
    '................',
    '................',
  ]
  rows16.forEach((row, y) => {
    for (let x = 0; x < 16; x++) {
      if (row[x] === '#') setPx(x, y, '#f8f6f2')
    }
  })
  return { pixels, hotspotX: 0, hotspotY: 0 }
}

export function createCrossCursorTemplate(
  gridSize: CustomCursorGridSize
): Pick<CustomCursorData, 'pixels' | 'hotspotX' | 'hotspotY'> {
  const pixels = new Array<string>(gridSize * gridSize).fill('')
  const mid = Math.floor(gridSize / 2)
  const setPx = (x: number, y: number, hex: string) => {
    if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
      pixels[y * gridSize + x] = hex
    }
  }
  const span = gridSize === 8 ? 3 : 6
  for (let d = -span; d <= span; d++) {
    if (d === 0) continue
    setPx(mid + d, mid, '#f8f6f2')
    setPx(mid, mid + d, '#f8f6f2')
  }
  setPx(mid, mid, '#9b8ec7')
  return { pixels, hotspotX: mid, hotspotY: mid }
}

export function CustomCursorMiniPreview({
  cursor,
  checkerDark = false,
  sizePx = 32,
}: {
  cursor: CustomCursorData
  checkerDark?: boolean
  sizePx?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const g = cursor.gridSize
    cvs.width = g
    cvs.height = g
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, g, g)
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const hex = cursor.pixels[y * g + x]
        if (hex) {
          ctx.fillStyle = hex
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
    // Subtle hotspot dot indicator in preview
    ctx.fillStyle = '#cc7a8f'
    ctx.fillRect(cursor.hotspotX, cursor.hotspotY, 1, 1)
  }, [cursor])

  return (
    <div
      style={{
        width: `${sizePx}px`,
        height: `${sizePx}px`,
        ...getCheckerboardStyle(checkerDark, 6),
      }}
      className="border border-[var(--border-pixel)] flex items-center justify-center shrink-0 overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
        }}
      />
    </div>
  )
}

interface GlobalEditorSettingsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Global Editor & Input Settings Modal opened from the Tool Tab's vacated slot (`設定`).
 * Strictly contains ONLY workspace-wide / input-wide settings:
 * - Cursor Speed (slider + presets + live readout, pixel-accurate sub-pixel accumulation)
 * - Cursor Display Size (Small / Standard / Large for touch virtual cursor)
 * - Cursor Design (Standard vs saved Custom Cursors) + Custom Cursor Pixel & Hotspot Editor (`8x8` / `16x16`)
 * - Double-Tap Eyedropper ON/OFF (shared directly with `AppSettings.eyedropperDoubleTap`)
 * Never includes animation settings or tool-specific settings!
 */
export function GlobalEditorSettingsModal({
  open,
  onClose,
}: GlobalEditorSettingsModalProps) {
  const { settings, updateSettings, reducedMotion } = useApp()
  const { t } = useI18n()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftGridSize, setDraftGridSize] = useState<CustomCursorGridSize>(16)
  const [draftPixels, setDraftPixels] = useState<string[]>(() =>
    createArrowCursorTemplate(16).pixels
  )
  const [draftHotspotX, setDraftHotspotX] = useState(0)
  const [draftHotspotY, setDraftHotspotY] = useState(0)
  const [draftTool, setDraftTool] = useState<CursorEditorTool>('pen')
  const [draftColor, setDraftColor] = useState<string>(CURSOR_EDITOR_PALETTE[0])
  const isDrawingCursorRef = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const openNewCursorEditor = () => {
    const nextNum = settings.customCursors.length + 1
    const tpl = createArrowCursorTemplate(16)
    setEditingId(null)
    setDraftName(`マイカーソル ${nextNum}`)
    setDraftGridSize(16)
    setDraftPixels([...tpl.pixels])
    setDraftHotspotX(tpl.hotspotX)
    setDraftHotspotY(tpl.hotspotY)
    setDraftTool('pen')
    setEditorOpen(true)
  }

  const openEditExistingCursor = (cursor: CustomCursorData) => {
    setEditingId(cursor.id)
    setDraftName(cursor.name)
    setDraftGridSize(cursor.gridSize)
    setDraftPixels([...cursor.pixels])
    setDraftHotspotX(cursor.hotspotX)
    setDraftHotspotY(cursor.hotspotY)
    setDraftTool('pen')
    setEditorOpen(true)
  }

  const handleChangeDraftGridSize = (nextSize: CustomCursorGridSize) => {
    if (nextSize === draftGridSize) return
    const nextPixels = new Array<string>(nextSize * nextSize).fill('')
    const copyLimit = Math.min(draftGridSize, nextSize)
    for (let y = 0; y < copyLimit; y++) {
      for (let x = 0; x < copyLimit; x++) {
        nextPixels[y * nextSize + x] = draftPixels[y * draftGridSize + x] ?? ''
      }
    }
    setDraftGridSize(nextSize)
    setDraftPixels(nextPixels)
    setDraftHotspotX((hx) => Math.min(nextSize - 1, hx))
    setDraftHotspotY((hy) => Math.min(nextSize - 1, hy))
  }

  const applyCellAction = (x: number, y: number) => {
    if (x < 0 || x >= draftGridSize || y < 0 || y >= draftGridSize) return
    if (draftTool === 'hotspot') {
      setDraftHotspotX(x)
      setDraftHotspotY(y)
      return
    }
    const nextVal = draftTool === 'eraser' ? '' : draftColor
    setDraftPixels((prev) => {
      const idx = y * draftGridSize + x
      if (prev[idx] === nextVal) return prev
      const copy = [...prev]
      copy[idx] = nextVal
      return copy
    })
  }

  const handleSaveCustomCursor = () => {
    const trimmedName = draftName.trim() || `マイカーソル ${settings.customCursors.length + 1}`
    const id = editingId ?? generateId('cursor')
    const saved: CustomCursorData = {
      id,
      name: trimmedName.slice(0, 32),
      gridSize: draftGridSize,
      hotspotX: Math.max(0, Math.min(draftGridSize - 1, draftHotspotX)),
      hotspotY: Math.max(0, Math.min(draftGridSize - 1, draftHotspotY)),
      pixels: [...draftPixels],
    }
    const exists = settings.customCursors.some((c) => c.id === id)
    const nextList = exists
      ? settings.customCursors.map((c) => (c.id === id ? saved : c))
      : [...settings.customCursors, saved]
    void updateSettings({
      customCursors: nextList,
      activeCursorId: id,
    })
    setEditorOpen(false)
  }

  const handleDeleteCustomCursor = (id: string) => {
    const nextList = settings.customCursors.filter((c) => c.id !== id)
    const nextActive =
      settings.activeCursorId === id ? 'standard' : settings.activeCursorId
    void updateSettings({
      customCursors: nextList,
      activeCursorId: nextActive,
    })
    if (editingId === id) {
      setEditorOpen(false)
      setEditingId(null)
    }
  }

  const speedPresets = useMemo(
    () => [
      { label: t('cursorSpeedSlow'), value: 0.5 },
      { label: t('cursorSpeedStandard'), value: 1.0 },
      { label: t('cursorSpeedFast'), value: 1.8 },
    ],
    [t]
  )

  const sizeOptions: Array<{ value: CursorDisplaySize; label: string }> = useMemo(
    () => [
      { value: 'small', label: t('cursorSizeSmall') },
      { value: 'standard', label: t('cursorSizeStandard') },
      { value: 'large', label: t('cursorSizeLarge') },
    ],
    [t]
  )

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t('editorGlobalSettingsTitle')}
          data-testid="global-editor-settings-modal"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.12 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/55"
          />
          <motion.div
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
            transition={{ duration: reducedMotion ? 0 : 0.14, ease: 'easeOut' }}
            className="relative z-10 w-full sm:max-w-lg max-h-[88dvh] flex flex-col pixel-panel overflow-hidden"
          >
            {/* Sticky Header */}
            <div className="flex items-center justify-between px-3.5 py-2.5 bg-[var(--bg-elevated)] border-b-2 border-[var(--border-pixel)] shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <PixelIcon
                  name="settings"
                  size={15}
                  className="text-[var(--accent-primary)] shrink-0"
                />
                <h2 className="text-sm font-bold tracking-wide truncate text-[var(--text-primary)]">
                  {t('editorGlobalSettingsTitle')}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('close')}
                className="pixel-btn min-w-[38px] min-h-[38px] flex items-center justify-center"
                data-testid="close-global-editor-settings-btn"
              >
                <PixelIcon name="close" size={16} />
              </button>
            </div>

            {/* Scrollable Body (Safe-area aware, overscroll-contain) */}
            <div
              className="p-3.5 space-y-4 overflow-y-auto overscroll-contain flex-1 min-h-0"
              style={{
                paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
              }}
              data-testid="global-editor-settings-scroll"
            >
              {/* 1. Cursor Speed */}
              <section className="pixel-card p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--text-primary)]">
                    {t('cursorSpeedSection')}
                  </span>
                  <span
                    className="text-xs font-mono font-bold px-2 py-0.5 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--accent-primary)]"
                    data-testid="cursor-speed-value"
                  >
                    {settings.cursorSpeed.toFixed(2)}x (
                    {Math.round(settings.cursorSpeed * 100)}%)
                  </span>
                </div>

                <input
                  type="range"
                  min={Math.round(MIN_CURSOR_SPEED * 100)}
                  max={Math.round(MAX_CURSOR_SPEED * 100)}
                  step={5}
                  value={Math.round(settings.cursorSpeed * 100)}
                  aria-label={t('cursorSpeedSection')}
                  onChange={(e) => {
                    const next = Number(e.target.value) / 100
                    void updateSettings({ cursorSpeed: next })
                  }}
                  className="w-full cursor-pointer accent-[var(--accent-primary)]"
                  data-testid="cursor-speed-slider"
                />

                <div className="grid grid-cols-3 gap-1.5">
                  {speedPresets.map((preset) => {
                    const active = Math.abs(settings.cursorSpeed - preset.value) < 0.03
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() =>
                          void updateSettings({ cursorSpeed: preset.value })
                        }
                        className={`min-h-[34px] px-2 text-xs font-bold ${
                          active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                        }`}
                        data-testid={`cursor-speed-preset-${preset.value}`}
                      >
                        {preset.label} ({preset.value.toFixed(1)}x)
                      </button>
                    )
                  })}
                </div>
              </section>

              {/* 2. Cursor Display Size */}
              <section className="pixel-card p-3 space-y-2">
                <div className="text-xs font-bold text-[var(--text-primary)]">
                  {t('cursorSizeSection')}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {sizeOptions.map((opt) => {
                    const active = settings.cursorSize === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          void updateSettings({ cursorSize: opt.value })
                        }
                        className={`min-h-[36px] px-2 text-xs font-bold ${
                          active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                        }`}
                        data-testid={`cursor-size-${opt.value}`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  {t('cursorSizeHint')}
                </p>
              </section>

              {/* 3. Cursor Design & Custom Cursor List */}
              <section className="pixel-card p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--text-primary)]">
                    {t('cursorDesignSection')}
                  </span>
                  <button
                    type="button"
                    onClick={openNewCursorEditor}
                    className="pixel-btn pixel-btn-primary min-h-[32px] px-2.5 text-xs font-bold flex items-center gap-1"
                    data-testid="new-custom-cursor-btn"
                  >
                    <PixelIcon name="plus" size={12} />
                    <span>{t('customCursorNewBtn')}</span>
                  </button>
                </div>

                <div className="space-y-1.5">
                  {/* Built-in Standard Cursor */}
                  <div
                    className={`flex items-center justify-between gap-2 p-2 border-2 ${
                      settings.activeCursorId === 'standard'
                        ? 'border-[var(--accent-primary)] bg-[var(--bg-elevated)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-surface)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        void updateSettings({ activeCursorId: 'standard' })
                      }
                      className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer"
                      data-testid="select-cursor-standard"
                    >
                      <div className="w-8 h-8 border border-[var(--border-pixel)] bg-[var(--bg-canvas)] flex items-center justify-center shrink-0">
                        <PixelIcon name="select" size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold truncate">
                          {t('cursorStandardLabel')}
                        </div>
                      </div>
                      {settings.activeCursorId === 'standard' && (
                        <span className="px-1.5 py-0.5 text-[10px] font-bold bg-[var(--accent-primary)] text-[var(--text-on-accent)] shrink-0">
                          {t('cursorActiveBadge')}
                        </span>
                      )}
                    </button>
                  </div>

                  {/* User-Saved Custom Cursors */}
                  {settings.customCursors.map((cursor) => {
                    const isActive = settings.activeCursorId === cursor.id
                    return (
                      <div
                        key={cursor.id}
                        className={`flex items-center justify-between gap-2 p-2 border-2 ${
                          isActive
                            ? 'border-[var(--accent-primary)] bg-[var(--bg-elevated)]'
                            : 'border-[var(--border-subtle)] bg-[var(--bg-surface)]'
                        }`}
                        data-testid={`custom-cursor-item-${cursor.id}`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            void updateSettings({ activeCursorId: cursor.id })
                          }
                          className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer"
                          data-testid={`select-custom-cursor-${cursor.id}`}
                        >
                          <CustomCursorMiniPreview
                            cursor={cursor}
                            checkerDark={settings.checkerboardDark}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold truncate">
                              {cursor.name}
                            </div>
                            <div className="text-[10px] font-mono text-[var(--text-secondary)]">
                              {cursor.gridSize}×{cursor.gridSize} · Hotspot (
                              {cursor.hotspotX},{cursor.hotspotY})
                            </div>
                          </div>
                          {isActive && (
                            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-[var(--accent-primary)] text-[var(--text-on-accent)] shrink-0">
                              {t('cursorActiveBadge')}
                            </span>
                          )}
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => openEditExistingCursor(cursor)}
                            className="pixel-btn min-h-[30px] px-2 text-[11px] font-bold"
                            data-testid={`edit-custom-cursor-${cursor.id}`}
                          >
                            {t('customCursorEditBtn')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCustomCursor(cursor.id)}
                            className="pixel-btn pixel-btn-danger min-h-[30px] px-2 text-[11px] font-bold"
                            data-testid={`delete-custom-cursor-${cursor.id}`}
                          >
                            <PixelIcon name="trash" size={12} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Inline Custom Cursor Pixel & Hotspot Editor */}
                {editorOpen && (
                  <div
                    className="p-2.5 border-2 border-[var(--border-strong)] bg-[var(--bg-elevated)] space-y-2.5"
                    data-testid="custom-cursor-editor"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-[var(--accent-primary)]">
                        {t('customCursorEditorSection')}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditorOpen(false)}
                        className="pixel-btn min-h-[28px] px-2 text-[11px]"
                      >
                        {t('cancel')}
                      </button>
                    </div>

                    {/* Cursor Name & Grid Size */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className="space-y-1 text-[11px] font-bold">
                        <span>{t('customCursorNameLabel')}</span>
                        <input
                          type="text"
                          value={draftName}
                          maxLength={32}
                          onChange={(e) => setDraftName(e.target.value)}
                          onFocus={(e) => e.currentTarget.select()}
                          className="pixel-input w-full px-2 py-1 text-xs"
                          data-testid="custom-cursor-name-input"
                        />
                      </label>

                      <div className="space-y-1 text-[11px] font-bold">
                        <span>{t('customCursorGridLabel')}</span>
                        <div className="grid grid-cols-2 gap-1">
                          {([8, 16] as const).map((g) => (
                            <button
                              key={g}
                              type="button"
                              onClick={() => handleChangeDraftGridSize(g)}
                              className={`min-h-[32px] text-xs font-bold ${
                                draftGridSize === g
                                  ? 'pixel-btn pixel-btn-active'
                                  : 'pixel-btn'
                              }`}
                              data-testid={`custom-cursor-grid-${g}`}
                            >
                              {g}×{g}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Drawing Tools: Pen / Eraser / Hotspot + Templates */}
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setDraftTool('pen')}
                        className={`min-h-[32px] px-2 text-xs font-bold flex items-center gap-1 ${
                          draftTool === 'pen'
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                        data-testid="custom-cursor-tool-pen"
                      >
                        <PixelIcon name="pen" size={12} />
                        <span>{t('customCursorToolPen')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraftTool('eraser')}
                        className={`min-h-[32px] px-2 text-xs font-bold flex items-center gap-1 ${
                          draftTool === 'eraser'
                            ? 'pixel-btn pixel-btn-active'
                            : 'pixel-btn'
                        }`}
                        data-testid="custom-cursor-tool-eraser"
                      >
                        <PixelIcon name="eraser" size={12} />
                        <span>{t('customCursorToolEraser')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraftTool('hotspot')}
                        className={`min-h-[32px] px-2 text-xs font-bold flex items-center gap-1 ${
                          draftTool === 'hotspot'
                            ? 'pixel-btn pixel-btn-teal'
                            : 'pixel-btn'
                        }`}
                        data-testid="custom-cursor-tool-hotspot"
                      >
                        <PixelIcon name="crosshair" size={12} />
                        <span>
                          {t('customCursorToolHotspot')} ({draftHotspotX},
                          {draftHotspotY})
                        </span>
                      </button>
                    </div>

                    {/* Color swatches for Pen */}
                    {draftTool === 'pen' && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {CURSOR_EDITOR_PALETTE.map((hex) => (
                          <button
                            key={hex}
                            type="button"
                            onClick={() => setDraftColor(hex)}
                            style={{ backgroundColor: hex }}
                            className={`w-6 h-6 cursor-pointer ${
                              draftColor.toLowerCase() === hex.toLowerCase()
                                ? 'border-2 border-[var(--border-strong)] outline-2 outline-[var(--accent-primary)]'
                                : 'border border-[var(--border-pixel)]'
                            }`}
                            aria-label={`Color ${hex}`}
                          />
                        ))}
                        <input
                          type="color"
                          value={draftColor}
                          onChange={(e) => setDraftColor(e.target.value)}
                          className="w-7 h-6 p-0 border border-[var(--border-pixel)] cursor-pointer bg-transparent"
                          aria-label="Custom cursor color"
                        />
                      </div>
                    )}

                    {/* Pixel Grid Canvas */}
                    <div className="flex flex-col items-center gap-2">
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: `repeat(${draftGridSize}, minmax(0, 1fr))`,
                          width: draftGridSize === 8 ? '192px' : '240px',
                          height: draftGridSize === 8 ? '192px' : '240px',
                          touchAction: 'none',
                          ...getCheckerboardStyle(settings.checkerboardDark, 8),
                        }}
                        onPointerLeave={() => {
                          isDrawingCursorRef.current = false
                        }}
                        onPointerUp={() => {
                          isDrawingCursorRef.current = false
                        }}
                        className="border-2 border-[var(--border-strong)] select-none"
                        data-testid="custom-cursor-pixel-grid"
                      >
                        {draftPixels.map((hex, idx) => {
                          const x = idx % draftGridSize
                          const y = Math.floor(idx / draftGridSize)
                          const isHotspot =
                            x === draftHotspotX && y === draftHotspotY
                          return (
                            <div
                              key={idx}
                              onPointerDown={(e) => {
                                e.preventDefault()
                                isDrawingCursorRef.current = true
                                applyCellAction(x, y)
                              }}
                              onPointerEnter={() => {
                                if (isDrawingCursorRef.current) {
                                  applyCellAction(x, y)
                                }
                              }}
                              style={{
                                backgroundColor: hex || 'transparent',
                              }}
                              className={`relative border-[0.5px] border-black/15 cursor-crosshair ${
                                isHotspot
                                  ? 'outline-2 -outline-offset-2 outline-[#e05268] z-10'
                                  : ''
                              }`}
                              data-testid={`cursor-cell-${x}-${y}`}
                            >
                              {isHotspot && (
                                <span
                                  className="absolute inset-0 flex items-center justify-center pointer-events-none text-[#e05268]"
                                  aria-hidden="true"
                                >
                                  <PixelIcon name="crosshair" size={9} />
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      <p className="text-[11px] text-[var(--text-secondary)] text-center">
                        {t('customCursorHotspotHint')}
                      </p>
                    </div>

                    {/* Preset Starters + Clear + Save */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-[var(--border-subtle)]">
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            const tpl = createArrowCursorTemplate(draftGridSize)
                            setDraftPixels(tpl.pixels)
                            setDraftHotspotX(tpl.hotspotX)
                            setDraftHotspotY(tpl.hotspotY)
                          }}
                          className="pixel-btn min-h-[30px] px-2 text-[11px] font-bold"
                        >
                          {t('customCursorTemplateArrow')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const tpl = createCrossCursorTemplate(draftGridSize)
                            setDraftPixels(tpl.pixels)
                            setDraftHotspotX(tpl.hotspotX)
                            setDraftHotspotY(tpl.hotspotY)
                          }}
                          className="pixel-btn min-h-[30px] px-2 text-[11px] font-bold"
                        >
                          {t('customCursorTemplateCross')}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDraftPixels(
                              new Array<string>(
                                draftGridSize * draftGridSize
                              ).fill('')
                            )
                          }
                          className="pixel-btn min-h-[30px] px-2 text-[11px] font-bold"
                        >
                          {t('customCursorClearBtn')}
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={handleSaveCustomCursor}
                        className="pixel-btn pixel-btn-teal min-h-[34px] px-3 text-xs font-bold flex items-center gap-1"
                        data-testid="save-custom-cursor-btn"
                      >
                        <PixelIcon name="check" size={13} />
                        <span>{t('customCursorSaveApplyBtn')}</span>
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  {t('cursorPcNote')}
                </p>
              </section>

              {/* 4. Shared Double-Tap Eyedropper Setting */}
              <section className="pixel-card p-3 space-y-1.5">
                <div className="text-xs font-bold text-[var(--text-primary)]">
                  {t('inputSectionTitle')}
                </div>
                <PixelCheckbox
                  checked={settings.eyedropperDoubleTap}
                  onChange={(next) =>
                    void updateSettings({ eyedropperDoubleTap: next })
                  }
                  label={t('eyedropperDoubleTapLabel')}
                  testId="global-toggle-eyedropper-doubletap"
                />
                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  {t('eyedropperDoubleTapDesc')}
                </p>
              </section>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
