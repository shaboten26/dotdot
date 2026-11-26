import { useEffect, useMemo, useRef, useState } from 'react'
import {
  downscaleByIntegerBlock,
  extractPaletteColorsFromRgba,
  inspectPngForImport,
  type PngResolutionInspection,
} from '../../engine/pngImport'
import { MAX_CANVAS_SIZE } from '../../engine/pixelBuffer'
import { createImportedProject, generateId } from '../../db/database'
import type { ProjectRecord } from '../../types'
import { Modal } from './Modal'
import { PixelIcon } from './PixelIcon'
import { PixelSelect } from './PixelSelect'
import { getCheckerboardStyle } from './PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

interface ImportPngModalProps {
  open: boolean
  onClose: () => void
  checkerDark?: boolean
  /** When inside Editor, allow importing as a new layer in addition to creating a new artwork */
  allowImportAsLayer?: boolean
  defaultTarget?: 'new-project' | 'new-layer'
  onImportAsLayer?: (params: {
    name: string
    width: number
    height: number
    data: Uint8ClampedArray
  }) => boolean
  onCreatedProject?: (project: ProjectRecord) => void
  onError?: (msg: string) => void
}

function RgbaCanvasPreview({
  data,
  width,
  height,
  checkerDark,
}: {
  data: Uint8ClampedArray
  width: number
  height: number
  checkerDark: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    if (typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(width * height * 4)
      copy.set(data.subarray(0, copy.length))
      ctx.putImageData(new ImageData(copy, width, height), 0, 0)
    } else {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          const a = data[i + 3]!
          if (a === 0) continue
          ctx.fillStyle = `rgba(${data[i]},${data[i + 1]},${data[i + 2]},${(a / 255).toFixed(3)})`
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }, [data, width, height])

  return (
    <div
      style={getCheckerboardStyle(checkerDark, 10)}
      className="w-full h-36 border-2 border-[var(--border-pixel)] p-2 flex items-center justify-center overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="max-w-full max-h-full object-contain pixelated"
        style={{
          aspectRatio: `${width} / ${height}`,
          width: width >= height ? '100%' : 'auto',
          height: height > width ? '100%' : 'auto',
        }}
      />
    </div>
  )
}

export function ImportPngModal({
  open,
  onClose,
  checkerDark = false,
  allowImportAsLayer = false,
  defaultTarget = 'new-project',
  onImportAsLayer,
  onCreatedProject,
  onError,
}: ImportPngModalProps) {
  const { t } = useI18n()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [fileName, setFileName] = useState<string>('')
  const [projectName, setProjectName] = useState<string>('')
  const [inspection, setInspection] = useState<PngResolutionInspection | null>(
    null
  )
  const [selectedScale, setSelectedScale] = useState<number>(1)
  const [targetMode, setTargetMode] = useState<'new-project' | 'new-layer'>(
    defaultTarget
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setInspection(null)
      setFileName('')
      setProjectName('')
      setSelectedScale(1)
      setTargetMode(allowImportAsLayer ? defaultTarget : 'new-project')
      setErrorMsg(null)
      setBusy(false)
    }
  }, [open, allowImportAsLayer, defaultTarget])

  const handleFileChange = async (file: File | null) => {
    if (!file) return
    setErrorMsg(null)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const result = inspectPngForImport(buf, MAX_CANVAS_SIZE)
      const baseName = file.name.replace(/\.png$/i, '').trim() || 'Imported PNG'
      setFileName(file.name)
      setProjectName(baseName.slice(0, 48))
      setInspection(result)
      setSelectedScale(result.recommendedScale)
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Invalid or corrupted PNG file.'
      setInspection(null)
      setErrorMsg(msg)
      onError?.(msg)
    }
  }

  const restored = useMemo(() => {
    if (!inspection) return null
    return downscaleByIntegerBlock(
      inspection.decoded.data,
      inspection.decoded.width,
      inspection.decoded.height,
      selectedScale
    )
  }, [inspection, selectedScale])

  const exceedsNewProjectLimit = Boolean(
    restored &&
      targetMode === 'new-project' &&
      (restored.width > MAX_CANVAS_SIZE || restored.height > MAX_CANVAS_SIZE)
  )

  const handleConfirmImport = async () => {
    if (!inspection || !restored || busy) return
    if (exceedsNewProjectLimit) return

    setBusy(true)
    try {
      if (targetMode === 'new-layer' && allowImportAsLayer && onImportAsLayer) {
        const ok = onImportAsLayer({
          name: projectName.trim() || 'PNG Layer',
          width: restored.width,
          height: restored.height,
          data: restored.data,
        })
        if (ok) {
          onClose()
        }
        return
      }

      const colors = extractPaletteColorsFromRgba(
        restored.data,
        ['#000000', '#FFFFFF'],
        256
      )
      const layerId = generateId('layer')
      const created = await createImportedProject({
        name: projectName.trim() || 'Imported PNG',
        width: restored.width,
        height: restored.height,
        layers: [
          {
            id: layerId,
            name: 'Layer 1',
            visible: true,
            locked: false,
            opacity: 100,
            blendMode: 'normal',
            clipping: false,
            offsetX: 0,
            offsetY: 0,
            dataWidth: restored.width,
            dataHeight: restored.height,
            data: restored.data,
          },
        ],
        activeLayerId: layerId,
        palette: {
          name: `${projectName.trim() || 'PNG'} Palette`,
          colors,
        },
      })
      onCreatedProject?.(created)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed.'
      setErrorMsg(msg)
      onError?.(msg)
    } finally {
      setBusy(false)
    }
  }

  const scaleSelectOptions = useMemo(() => {
    if (!inspection) return []
    return inspection.candidates.map((c) => ({
      value: c.scale,
      label:
        c.scale === 1
          ? `1× — ${c.restoredWidth}×${c.restoredHeight}px (${t('importPngKeepOriginalSize')})`
          : `1/${c.scale} (${c.scale}× block) → ${c.restoredWidth}×${c.restoredHeight}px`,
    }))
  }, [inspection, t])

  return (
    <Modal
      open={open}
      title={t('importPngTitle')}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3.5" data-testid="import-png-modal">
        {/* File Picker */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,.png"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              void handleFileChange(f)
              e.currentTarget.value = ''
            }}
            className="hidden"
            data-testid="import-png-file-input"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="pixel-btn pixel-btn-teal min-h-[40px] px-3.5 text-xs font-bold flex items-center gap-2"
            data-testid="import-png-choose-btn"
          >
            <PixelIcon name="upload" size={14} />
            <span>{t('importPngSelectFile')}</span>
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
            data-testid="import-png-error"
          >
            {errorMsg}
          </div>
        )}

        {inspection && restored && (
          <>
            {/* Import Destination Selector (when inside Editor) */}
            {allowImportAsLayer && onImportAsLayer && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setTargetMode('new-project')}
                  className={`min-h-[38px] px-2.5 text-xs font-bold ${
                    targetMode === 'new-project'
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                  data-testid="import-png-target-project"
                >
                  {t('importPngTargetNewProject')}
                </button>
                <button
                  type="button"
                  onClick={() => setTargetMode('new-layer')}
                  className={`min-h-[38px] px-2.5 text-xs font-bold ${
                    targetMode === 'new-layer'
                      ? 'pixel-btn pixel-btn-active'
                      : 'pixel-btn'
                  }`}
                  data-testid="import-png-target-layer"
                >
                  {t('importPngTargetNewLayer')}
                </button>
              </div>
            )}

            {/* Name Input */}
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              maxLength={48}
              className="w-full min-h-[38px] px-2.5 text-xs font-bold pixel-input select-text"
              data-testid="import-png-name-input"
            />

            {/* Detection Status Badge */}
            {inspection.confidence === 'metadata' && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] text-xs font-bold text-[var(--accent-teal)] flex items-center gap-1.5"
                data-testid="import-png-meta-badge"
              >
                <PixelIcon name="check" size={13} />
                <span>
                  {t('importPngDetectedMeta')} ({inspection.metadata?.originalWidth}×
                  {inspection.metadata?.originalHeight}px / {inspection.metadata?.scale}×)
                </span>
              </div>
            )}

            {inspection.confidence === 'heuristic' && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] text-xs font-bold text-[var(--accent-primary)] flex items-center gap-1.5"
                data-testid="import-png-heuristic-badge"
              >
                <PixelIcon name="sparkle" size={13} />
                <span>
                  {t('importPngDetectedBlock')} (1/{inspection.recommendedScale} →{' '}
                  {inspection.decoded.width / inspection.recommendedScale}×
                  {inspection.decoded.height / inspection.recommendedScale}px)
                </span>
              </div>
            )}

            {inspection.metadataMismatchWarning && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] text-xs leading-relaxed"
                data-testid="import-png-mismatch-warning"
              >
                {t('importPngMetaMismatchWarn')}
              </div>
            )}

            {/* Preview & Before / After Dimensions */}
            <RgbaCanvasPreview
              data={restored.data}
              width={restored.width}
              height={restored.height}
              checkerDark={checkerDark}
            />

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importPngBeforeSize')}
                </div>
                <div className="font-bold mt-0.5" data-testid="import-png-before-size">
                  {inspection.decoded.width} × {inspection.decoded.height} px
                </div>
              </div>
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importPngAfterSize')}
                </div>
                <div
                  className={`font-bold mt-0.5 ${
                    exceedsNewProjectLimit
                      ? 'text-[var(--accent-rose)]'
                      : 'text-[var(--accent-teal)]'
                  }`}
                  data-testid="import-png-after-size"
                >
                  {restored.width} × {restored.height} px
                </div>
              </div>
            </div>

            {/* Quick Toggle Buttons + Candidate Scale Picker */}
            {inspection.candidates.length > 1 && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedScale(
                        inspection.recommendedScale > 1
                          ? inspection.recommendedScale
                          : inspection.candidates[inspection.candidates.length - 1]!.scale
                      )
                    }
                    className={`min-h-[38px] px-2.5 text-xs font-bold ${
                      selectedScale > 1
                        ? 'pixel-btn pixel-btn-teal'
                        : 'pixel-btn'
                    }`}
                    data-testid="import-png-restore-btn"
                  >
                    {t('importPngRestoreOriginalSize')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedScale(1)}
                    className={`min-h-[38px] px-2.5 text-xs font-bold ${
                      selectedScale === 1
                        ? 'pixel-btn pixel-btn-teal'
                        : 'pixel-btn'
                    }`}
                    data-testid="import-png-keep-raw-btn"
                  >
                    {t('importPngKeepOriginalSize')}
                  </button>
                </div>

                <div className="space-y-1">
                  <span className="text-xs font-bold text-[var(--text-secondary)] block">
                    {t('importPngScaleCandidate')}
                  </span>
                  <PixelSelect<number>
                    value={selectedScale}
                    options={scaleSelectOptions}
                    onChange={(s) => setSelectedScale(s)}
                    ariaLabel={t('importPngScaleCandidate')}
                    direction="up"
                    className="w-full"
                    testId="import-png-scale-select"
                  />
                </div>
              </div>
            )}

            {exceedsNewProjectLimit && (
              <div
                className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)] leading-relaxed"
                data-testid="import-png-size-limit-error"
              >
                {t('importPngTooLargeError')}
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
                disabled={exceedsNewProjectLimit || busy}
                onClick={() => void handleConfirmImport()}
                className="pixel-btn pixel-btn-active min-h-[42px] px-4 text-xs font-bold flex items-center gap-1.5"
                data-testid="import-png-confirm-btn"
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
