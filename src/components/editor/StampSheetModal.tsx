import { useEffect, useRef, useState } from 'react'
import type { StampAsset } from '../../types'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

interface StampMiniThumbProps {
  stamp: StampAsset
  checkerDark?: boolean
  size?: number
}

export function StampMiniThumb({
  stamp,
  checkerDark = false,
  size = 44,
}: StampMiniThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = stamp.width
    canvas.height = stamp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, stamp.width, stamp.height)
    const rgba = new Uint8ClampedArray(stamp.width * stamp.height * 4)
    rgba.set(stamp.data.subarray(0, rgba.length))
    if (typeof ImageData !== 'undefined') {
      const img = new ImageData(rgba, stamp.width, stamp.height)
      ctx.putImageData(img, 0, 0)
    } else {
      for (let y = 0; y < stamp.height; y++) {
        for (let x = 0; x < stamp.width; x++) {
          const i = (y * stamp.width + x) * 4
          const a = rgba[i + 3]!
          if (a === 0) continue
          ctx.fillStyle = `rgba(${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${(a / 255).toFixed(3)})`
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }, [stamp])

  return (
    <div
      style={{
        ...getCheckerboardStyle(checkerDark, 8),
        width: size,
        height: size,
      }}
      className="border-2 border-[var(--border-pixel)] flex items-center justify-center p-1 shrink-0 overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="max-w-full max-h-full object-contain pixelated"
        style={{
          aspectRatio: `${stamp.width} / ${stamp.height}`,
          width: stamp.width >= stamp.height ? '100%' : 'auto',
          height: stamp.height > stamp.width ? '100%' : 'auto',
        }}
      />
    </div>
  )
}

interface StampSheetModalProps {
  open: boolean
  onClose: () => void
  stamps: readonly StampAsset[]
  checkerDark?: boolean
  hasSelection?: boolean
  activePatternStampId?: string | null
  onExtractSelection?: () => {
    width: number
    height: number
    data: Uint8Array | Uint8ClampedArray
  } | null
  onCreateStamp: (
    name: string,
    width: number,
    height: number,
    data: Uint8Array | Uint8ClampedArray
  ) => Promise<StampAsset>
  onRenameStamp: (id: string, nextName: string) => Promise<boolean>
  onDeleteStamp: (id: string) => Promise<boolean>
  onPlaceStamp?: (stamp: StampAsset) => void
  onTogglePatternStamp?: (stampId: string | null) => void
}

export function StampSheetModal({
  open,
  onClose,
  stamps,
  checkerDark = false,
  hasSelection = false,
  activePatternStampId = null,
  onExtractSelection,
  onCreateStamp,
  onRenameStamp,
  onDeleteStamp,
  onPlaceStamp,
  onTogglePatternStamp,
}: StampSheetModalProps) {
  const { t } = useI18n()
  const [newStampName, setNewStampName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setNewStampName(`Stamp ${stamps.length + 1}`)
      setEditingId(null)
    }
  }, [open, stamps.length])

  const handleRegisterFromSelection = async () => {
    if (!onExtractSelection || busy) return
    const extracted = onExtractSelection()
    if (!extracted) return
    setBusy(true)
    try {
      await onCreateStamp(
        newStampName.trim() || `Stamp ${stamps.length + 1}`,
        extracted.width,
        extracted.height,
        extracted.data
      )
      setNewStampName(`Stamp ${stamps.length + 2}`)
    } finally {
      setBusy(false)
    }
  }

  const commitRename = async (id: string) => {
    const trimmed = editingName.trim()
    setEditingId(null)
    if (!trimmed) return
    await onRenameStamp(id, trimmed)
  }

  return (
    <Modal
      open={open}
      title={t('stampTitle')}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3.5" data-testid="stamp-sheet-modal">
        {/* Register Current Selection as Stamp */}
        {hasSelection && onExtractSelection && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] space-y-2"
            data-testid="stamp-register-box"
          >
            <div className="text-xs font-bold text-[var(--accent-teal)] flex items-center gap-1.5">
              <PixelIcon name="stamp" size={14} />
              <span>{t('stampRegisterPrompt')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newStampName}
                onChange={(e) => setNewStampName(e.target.value)}
                placeholder={t('stampNamePlaceholder')}
                maxLength={40}
                className="flex-1 min-w-0 min-h-[38px] px-2.5 text-xs font-bold pixel-input select-text"
                data-testid="stamp-register-name-input"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRegisterFromSelection()}
                className="pixel-btn pixel-btn-teal min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5 shrink-0"
                data-testid="stamp-register-submit-btn"
              >
                <PixelIcon name="plus" size={13} />
                <span>{t('stampRegisterBtn')}</span>
              </button>
            </div>
          </div>
        )}

        {/* Active Pattern Brush Banner */}
        {activePatternStampId && onTogglePatternStamp && (
          <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] flex items-center justify-between gap-2 text-xs">
            <span className="font-bold text-[var(--accent-primary)] truncate">
              {t('stampPatternActive')}:{' '}
              {stamps.find((s) => s.id === activePatternStampId)?.name ?? ''}
            </span>
            <button
              type="button"
              onClick={() => onTogglePatternStamp(null)}
              className="pixel-btn min-h-[32px] px-2.5 text-xs font-bold shrink-0"
              data-testid="stamp-disable-pattern-btn"
            >
              {t('stampPatternOff')}
            </button>
          </div>
        )}

        {/* Stamp Library List */}
        {stamps.length === 0 ? (
          <div className="p-4 text-center text-xs text-[var(--text-secondary)] bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
            {t('stampEmptyMsg')}
          </div>
        ) : (
          <div
            className="space-y-1.5 max-h-[50dvh] overflow-y-auto pr-0.5"
            data-testid="stamp-list"
          >
            {stamps.map((stamp) => {
              const isPatternActive = activePatternStampId === stamp.id
              const isEditing = editingId === stamp.id
              return (
                <div
                  key={stamp.id}
                  className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] flex flex-wrap items-center gap-2.5"
                  data-testid={`stamp-item-${stamp.id}`}
                >
                  <StampMiniThumb stamp={stamp} checkerDark={checkerDark} size={42} />

                  <div className="flex-1 min-w-[110px]">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingName}
                        autoFocus
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => void commitRename(stamp.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commitRename(stamp.id)
                          } else if (e.key === 'Escape') {
                            setEditingId(null)
                          }
                        }}
                        className="w-full min-h-[30px] px-2 text-xs font-bold pixel-input select-text"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold truncate text-[var(--text-primary)]">
                          {stamp.name}
                        </span>
                        {stamp.builtIn && (
                          <span className="text-[10px] px-1 py-0.5 bg-[var(--bg-panel)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                            {t('stampStarterBadge')}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-[11px] font-mono text-[var(--text-secondary)] mt-0.5">
                      {stamp.width} × {stamp.height} px
                    </div>
                  </div>

                  <div className="flex items-center gap-1 ml-auto">
                    {onPlaceStamp && (
                      <button
                        type="button"
                        onClick={() => {
                          onPlaceStamp(stamp)
                          onClose()
                        }}
                        className="pixel-btn pixel-btn-teal min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
                        data-testid={`stamp-place-${stamp.id}`}
                      >
                        <PixelIcon name="stamp" size={13} />
                        <span>{t('stampPlaceBtn')}</span>
                      </button>
                    )}

                    {onTogglePatternStamp && (
                      <button
                        type="button"
                        onClick={() =>
                          onTogglePatternStamp(isPatternActive ? null : stamp.id)
                        }
                        className={`min-h-[34px] px-2 text-xs font-bold flex items-center gap-1 ${
                          isPatternActive ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                        }`}
                        data-testid={`stamp-pattern-${stamp.id}`}
                      >
                        <PixelIcon name="pen" size={12} />
                        <span>
                          {isPatternActive
                            ? t('stampPatternActive')
                            : t('stampPatternUseBtn')}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(stamp.id)
                        setEditingName(stamp.name)
                      }}
                      title={t('rename')}
                      aria-label={t('rename')}
                      className="pixel-btn min-w-[34px] min-h-[34px] flex items-center justify-center"
                      data-testid={`stamp-rename-${stamp.id}`}
                    >
                      <PixelIcon name="edit" size={13} />
                    </button>

                    <button
                      type="button"
                      onClick={() => void onDeleteStamp(stamp.id)}
                      title={t('delete')}
                      aria-label={t('delete')}
                      className="pixel-btn pixel-btn-danger min-w-[34px] min-h-[34px] flex items-center justify-center"
                      data-testid={`stamp-delete-${stamp.id}`}
                    >
                      <PixelIcon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
