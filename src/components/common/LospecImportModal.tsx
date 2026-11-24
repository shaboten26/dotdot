import { useState } from 'react'
import {
  fetchLospecPalette,
  LospecFetchError,
  type LospecApplyMode,
  type LospecFetchedPalette,
} from '../../db/lospec'
import { Modal } from './Modal'
import { PixelIcon } from './PixelIcon'
import { PixelCheckbox } from './PixelCheckbox'
import { useI18n } from '../../i18n/I18nContext'

interface LospecImportModalProps {
  open: boolean
  onClose: () => void
  /** When false (e.g. importing directly into Settings Palette Library), only adds to library without Replace/Append toggle */
  allowAppendReplace?: boolean
  onConfirmImport: (
    fetched: LospecFetchedPalette,
    mode: LospecApplyMode,
    alsoSaveToLibrary: boolean
  ) => Promise<void> | void
}

const SAMPLE_SLUGS = ['pico-8', 'oil-6', 'sweetie-16', 'endesga-32'] as const

export function LospecImportModal({
  open,
  onClose,
  allowAppendReplace = true,
  onConfirmImport,
}: LospecImportModalProps) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<LospecFetchedPalette | null>(null)
  const [mode, setMode] = useState<LospecApplyMode>('replace')
  const [alsoSaveToLib, setAlsoSaveToLib] = useState(true)

  const handleFetch = async (targetInput?: string) => {
    const query = (targetInput ?? input).trim()
    if (!query) return
    setLoading(true)
    setErrorMsg(null)
    try {
      const result = await fetchLospecPalette(query)
      setPreview(result)
    } catch (err) {
      setPreview(null)
      if (err instanceof LospecFetchError) {
        if (err.code === 'OFFLINE') {
          setErrorMsg(t('lospecOfflineError'))
        } else {
          setErrorMsg(t('lospecNotFoundError'))
        }
      } else {
        setErrorMsg(t('lospecNotFoundError'))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleApply = async () => {
    if (!preview) return
    await onConfirmImport(
      preview,
      allowAppendReplace ? mode : 'replace',
      allowAppendReplace ? alsoSaveToLib : true
    )
    onClose()
  }

  return (
    <Modal
      open={open}
      title={t('lospecModalTitle')}
      onClose={onClose}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-3.5">
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-[var(--text-secondary)] block">
            {t('lospecInputLabel')}
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleFetch()
                }
              }}
              placeholder={t('lospecInputPlaceholder')}
              className="flex-1 min-h-[40px] px-2.5 text-xs pixel-input select-text"
              data-testid="lospec-slug-input"
            />
            <button
              type="button"
              disabled={loading || !input.trim()}
              onClick={() => void handleFetch()}
              className="pixel-btn pixel-btn-teal min-h-[40px] px-3 text-xs font-bold shrink-0 flex items-center gap-1"
              data-testid="lospec-fetch-btn"
            >
              <PixelIcon name="download" size={14} />
              <span>{loading ? t('lospecFetching') : t('lospecFetchBtn')}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {SAMPLE_SLUGS.map((slug) => (
              <button
                key={slug}
                type="button"
                onClick={() => {
                  setInput(slug)
                  void handleFetch(slug)
                }}
                className="pixel-btn min-h-[28px] px-2 text-[11px] font-mono"
                data-testid={`lospec-sample-${slug}`}
              >
                {slug}
              </button>
            ))}
          </div>
        </div>

        {errorMsg && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-danger)] text-xs text-[var(--accent-danger)] font-bold"
            data-testid="lospec-error-msg"
          >
            {errorMsg}
          </div>
        )}

        {preview && (
          <div
            className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2.5"
            data-testid="lospec-preview-card"
          >
            <div className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-[var(--text-primary)]">
                  {preview.name}
                </span>
                <span className="text-xs font-bold text-[var(--text-secondary)]">
                  {preview.colors.length} {t('colorsCount')}
                </span>
              </div>
              {preview.author && (
                <div className="text-[11px] text-[var(--text-secondary)]">
                  {t('lospecAuthorLabel')}: <span className="font-bold">{preview.author}</span>
                </div>
              )}
              <div className="text-[11px] text-[var(--text-secondary)] truncate">
                {t('lospecSourceLabel')}:{' '}
                <a
                  href={preview.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-[var(--accent-teal)]"
                >
                  {preview.sourceUrl}
                </a>
              </div>
            </div>

            {preview.truncated && (
              <div className="text-[11px] text-[var(--accent-amber)] font-bold">
                {t('lospecTruncatedWarning')}
              </div>
            )}

            <div className="grid grid-cols-8 gap-1 max-h-32 overflow-y-auto p-1.5 bg-[var(--bg-surface)] border border-[var(--border-pixel)]">
              {preview.colors.map((hex, idx) => (
                <span
                  key={`${idx}-${hex}`}
                  style={{ backgroundColor: hex }}
                  title={hex}
                  className="aspect-square border border-[var(--border-pixel)]"
                />
              ))}
            </div>

            {allowAppendReplace && (
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMode('replace')}
                    className={`min-h-[38px] px-2 text-xs font-bold ${
                      mode === 'replace' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid="lospec-mode-replace"
                  >
                    {t('lospecReplaceMode')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('append')}
                    className={`min-h-[38px] px-2 text-xs font-bold ${
                      mode === 'append' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid="lospec-mode-append"
                  >
                    {t('lospecAppendMode')}
                  </button>
                </div>

                <PixelCheckbox
                  checked={alsoSaveToLib}
                  onChange={setAlsoSaveToLib}
                  label={t('lospecSaveToLibraryCheck')}
                  testId="lospec-save-to-lib-checkbox"
                />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="pixel-btn min-h-[40px] px-3 text-xs font-bold"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleApply()}
                className="pixel-btn pixel-btn-active min-h-[40px] px-4 text-xs font-bold flex items-center gap-1.5"
                data-testid="lospec-confirm-import-btn"
              >
                <PixelIcon name="check" size={14} />
                <span>{t('apply')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
