import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CelBufferRuntime,
  CelMap,
  FrameMeta,
  LayerMeta,
  LayerRuntime,
  ProjectPalette,
  ProjectRecord,
} from '../../types'
import {
  encodeAsepriteBytes,
  parseAsepriteBytes,
  type AsepriteWarningItem,
  type ParsedAsepriteDocument,
} from '../../engine/aseprite'
import { createImportedProject } from '../../db/database'
import { Modal } from './Modal'
import { PixelIcon } from './PixelIcon'
import { useI18n } from '../../i18n/I18nContext'

function formatAseWarning(item: AsepriteWarningItem): string {
  switch (item.code) {
    case 'layer-groups-flattened':
      return `レイヤーグループ (${item.detail}件) は順序と表示状態を維持したままフラット展開されます。`
    case 'tilemap-layers-skipped':
      return `タイルマップチャンク (${item.detail}件) はスキップされます。`
    case 'unsupported-blend-mode':
      return `未対応の合成モード (${item.detail}レイヤー) は通常 (Normal) として読み込まれます。`
    case 'cel-opacity-baked':
      return `セル単位の不透明度 (${item.detail}セル) は画素アルファへ反映されます。`
    case 'tags-ignored':
      return `アニメーションタグ (${item.detail}) はdotdot非対応のため読み込まれません。`
    case 'slices-ignored':
      return `スライス情報 (${item.detail}件) は読み込まれません。`
    case 'icc-profile-ignored':
      return `埋め込みICCプロファイルはsRGBとして扱われます。`
    case 'non-square-pixel-aspect':
      return `非正方形ピクセル比率 (${item.detail}) は1:1ピクセルとして表示されます。`
    case 'layer-limit-truncated':
      return `レイヤー数が上限を超えるため (${item.detail}) 上限枚数まで読み込まれます。`
    case 'canvas-size-exceeded':
      return `キャンバスサイズ (${item.detail}) がdotdotの上限 (256×256) を超えているため読み込めません。`
    case 'clipping-note':
      return item.detail
    case 'colors-quantized':
      return `不透明色数が255色を超えているため (${item.detail}) 知覚的な255色インデックスパレットへ減色されます。`
  }
}

interface ImportAsepriteModalProps {
  open: boolean
  onClose: () => void
  onImportedProject?: (project: ProjectRecord) => void
  onError?: (msg: string) => void
}

export function ImportAsepriteModal({
  open,
  onClose,
  onImportedProject,
  onError,
}: ImportAsepriteModalProps) {
  const { t } = useI18n()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [fileName, setFileName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [parsed, setParsed] = useState<ParsedAsepriteDocument | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setFileName('')
      setProjectName('')
      setParsed(null)
      setErrorMsg(null)
      setBusy(false)
    }
  }, [open])

  const handleFile = async (file: File | null) => {
    if (!file) return
    setErrorMsg(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const doc = parseAsepriteBytes(bytes)
      const baseName =
        file.name.replace(/\.(aseprite|ase)$/i, '').trim() || 'Aseprite Artwork'
      setFileName(file.name)
      setProjectName(baseName.slice(0, 48))
      setParsed(doc)
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Invalid Aseprite (.ase/.aseprite) file.'
      setParsed(null)
      setErrorMsg(msg)
      onError?.(msg)
    }
  }

  const handleConfirmImport = async () => {
    if (!parsed || !parsed.fitsCanvasLimit || busy) return
    setBusy(true)
    try {
      const created = await createImportedProject({
        name: projectName.trim() || 'Aseprite Artwork',
        width: parsed.width,
        height: parsed.height,
        layers: parsed.layers,
        activeLayerId: parsed.layers[parsed.layers.length - 1]?.id,
        timeline: {
          frames: parsed.frames,
          cels: parsed.cels,
          celBuffers: parsed.celBuffers,
          activeFrameId: parsed.frames[0]?.id,
        },
        palette: {
          ...parsed.palette,
          name: `${projectName.trim() || 'Aseprite'} Palette`,
        },
      })
      onImportedProject?.(created)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import Aseprite file.'
      setErrorMsg(msg)
      onError?.(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('importAsepriteTitle')}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3.5" data-testid="import-aseprite-modal">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".ase,.aseprite,application/octet-stream"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              void handleFile(f)
              e.currentTarget.value = ''
            }}
            className="hidden"
            data-testid="import-aseprite-file-input"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="pixel-btn pixel-btn-teal min-h-[40px] px-3.5 text-xs font-bold flex items-center gap-2"
            data-testid="import-aseprite-choose-btn"
          >
            <PixelIcon name="aseprite" size={14} />
            <span>{t('asepriteSelectFile')}</span>
          </button>
          {fileName && (
            <span className="text-xs font-mono truncate max-w-[220px] text-[var(--text-secondary)]">
              {fileName}
            </span>
          )}
        </div>

        {errorMsg && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)]"
            data-testid="import-aseprite-error"
          >
            {errorMsg}
          </div>
        )}

        {parsed && (
          <>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              maxLength={48}
              className="w-full min-h-[38px] px-2.5 text-xs font-bold pixel-input select-text"
              data-testid="import-aseprite-name-input"
            />

            <div
              className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1.5 text-xs"
              data-testid="import-aseprite-summary"
            >
              <div className="font-bold text-[var(--accent-teal)]">
                {t('asepriteImportSummary')}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <div>
                  サイズ:{' '}
                  <strong>
                    {parsed.width} × {parsed.height} px
                  </strong>{' '}
                  ({parsed.colorDepth}bpp)
                </div>
                <div>
                  レイヤー数: <strong>{parsed.layerCount}</strong>
                </div>
                <div>
                  フレーム数: <strong>{parsed.frameCount}</strong>
                </div>
                <div>
                  リンクセル数: <strong>{parsed.linkedCelCount}</strong>
                </div>
                <div>
                  パレット色数: <strong>{parsed.palette.colors.length}</strong>
                </div>
              </div>
              {parsed.linkedCelCount > 0 && (
                <div className="text-[11px] text-[var(--text-secondary)] pt-1">
                  {t('asepriteLinkedCelsNote')}
                </div>
              )}
            </div>

            {parsed.warnings.length === 0 ? (
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] text-xs font-bold text-[var(--accent-teal)] flex items-center gap-1.5">
                <PixelIcon name="check" size={13} />
                <span>{t('asepriteNoWarnings')}</span>
              </div>
            ) : (
              <div
                className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] space-y-1.5 text-xs"
                data-testid="import-aseprite-warnings"
              >
                <div className="font-bold text-[var(--accent-amber)]">
                  {t('asepriteWarningsTitle')} ({parsed.warnings.length})
                </div>
                <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                  {parsed.warnings.map((w, idx) => (
                    <li key={`${w.code}-${idx}`}>{formatAseWarning(w)}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="pixel-btn min-h-[42px] px-4 text-xs font-bold"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={!parsed.fitsCanvasLimit || busy}
                onClick={() => void handleConfirmImport()}
                className="pixel-btn pixel-btn-active min-h-[42px] px-4 text-xs font-bold flex items-center gap-1.5"
                data-testid="import-aseprite-confirm-btn"
              >
                <PixelIcon name="check" size={14} />
                <span>{t('confirm')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

interface ExportAsepriteModalProps {
  open: boolean
  onClose: () => void
  projectName: string
  width: number
  height: number
  layerMetas: readonly LayerMeta[]
  frames: readonly FrameMeta[]
  cels: CelMap
  celBuffers: Readonly<Record<string, CelBufferRuntime>>
  fallbackSingleFrameLayers?: readonly LayerRuntime[]
  palette?: ProjectPalette
  paletteColors: readonly string[]
  onExported?: () => void
}

export function ExportAsepriteModal({
  open,
  onClose,
  projectName,
  width,
  height,
  layerMetas,
  frames,
  cels,
  celBuffers,
  fallbackSingleFrameLayers,
  palette,
  paletteColors,
  onExported,
}: ExportAsepriteModalProps) {
  const { t } = useI18n()

  const encoded = useMemo(() => {
    if (!open || width <= 0 || height <= 0) return null
    return encodeAsepriteBytes({
      width,
      height,
      layerMetas,
      frames,
      cels,
      celBuffers,
      fallbackSingleFrameLayers,
      palette,
      paletteColors,
    })
  }, [
    open,
    width,
    height,
    layerMetas,
    frames,
    cels,
    celBuffers,
    fallbackSingleFrameLayers,
    palette,
    paletteColors,
  ])

  const safeBaseName =
    projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'dotdot-artwork'

  const handleDownload = () => {
    if (!encoded) return
    const blob = new Blob([encoded.bytes.slice().buffer], {
      type: 'application/octet-stream',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeBaseName}.aseprite`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    onExported?.()
    onClose()
  }

  return (
    <Modal
      open={open}
      title={t('exportAsepriteTitle')}
      onClose={onClose}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-3.5" data-testid="export-aseprite-modal">
        {encoded && (
          <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-1 text-xs">
            <div className="font-bold text-[var(--accent-teal)]">
              {safeBaseName}.aseprite
            </div>
            <div className="grid grid-cols-2 gap-1 text-[11px] text-[var(--text-secondary)]">
              <div>
                サイズ: <strong className="text-[var(--text-primary)]">{width}×{height}px</strong>
              </div>
              <div>
                レイヤー: <strong className="text-[var(--text-primary)]">{encoded.layerCount}</strong>
              </div>
              <div>
                フレーム: <strong className="text-[var(--text-primary)]">{encoded.frameCount}</strong>
              </div>
              <div>
                リンクセル: <strong className="text-[var(--text-primary)]">{encoded.linkedCelCount}</strong>
              </div>
            </div>
          </div>
        )}

        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {t('asepriteExportNotes')}
        </p>

        {encoded?.hasClippingWarning && (
          <div
            className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-[11px] leading-relaxed"
            data-testid="export-aseprite-clipping-note"
          >
            ※ Aseprite形式はクリッピングマスク属性を持たないため、クリッピング設定レイヤーは通常レイヤーとして保存されます（画素データはそのまま保持されます）。
          </div>
        )}

        <button
          type="button"
          onClick={handleDownload}
          className="w-full pixel-btn pixel-btn-active min-h-[46px] px-4 text-xs sm:text-sm font-bold flex items-center justify-center gap-2"
          data-testid="download-aseprite-btn"
        >
          <PixelIcon name="aseprite" size={15} />
          <span>{t('asepriteDownloadBtn')}</span>
        </button>
      </div>
    </Modal>
  )
}
