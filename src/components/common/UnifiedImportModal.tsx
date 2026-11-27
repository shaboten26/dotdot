import { useEffect, useMemo, useRef, useState } from 'react'
import {
  downscaleByIntegerBlock,
  inspectPngForImport,
  prepareImportedPngAsIndexed,
  type PngResolutionInspection,
} from '../../engine/pngImport'
import {
  inspectGifForImport,
  prepareImportedGifAsIndexed,
  type GifImportWarning,
  type GifResolutionInspection,
} from '../../engine/gifImport'
import {
  parseAsepriteBytes,
  type AsepriteWarningItem,
  type ParsedAsepriteDocument,
} from '../../engine/aseprite'
import { MAX_CANVAS_SIZE } from '../../engine/pixelBuffer'
import { createImportedProject, generateId } from '../../db/database'
import type { ProjectRecord } from '../../types'
import { Modal } from './Modal'
import { PixelIcon } from './PixelIcon'
import { PixelSelect } from './PixelSelect'
import { getCheckerboardStyle } from './PixelThumbnail'
import { useI18n } from '../../i18n/I18nContext'

export interface UnifiedImportModalProps {
  open: boolean
  onClose: () => void
  checkerDark?: boolean
  onCreatedProject?: (
    project: ProjectRecord,
    detectedKind: 'png' | 'gif' | 'aseprite'
  ) => void
  onError?: (msg: string) => void
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result))
      } else {
        reject(new Error('Failed to read file bytes'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('File read error'))
    reader.readAsArrayBuffer(file)
  })
}

export function detectArtworkFileKind(
  fileName: string,
  bytes: Uint8Array
): 'png' | 'gif' | 'aseprite' | null {
  // 1. Magic byte header signature (most reliable even if file was renamed!)
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png'
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif'
  }
  // Aseprite header magic number at offset 4..5 is `0xA5E0` (LE: `[0xE0, 0xA5]`)
  if (bytes.length >= 128 && bytes[4] === 0xe0 && bytes[5] === 0xa5) {
    return 'aseprite'
  }

  // 2. Fallback to file extension
  const lower = fileName.trim().toLowerCase()
  if (lower.endsWith('.png')) return 'png'
  if (lower.endsWith('.gif')) return 'gif'
  if (lower.endsWith('.ase') || lower.endsWith('.aseprite')) return 'aseprite'

  return null
}

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

function RgbaPreviewStage({
  framesRgba,
  durationsMs,
  width,
  height,
  checkerDark,
  testIdCanvas,
}: {
  framesRgba: readonly Uint8ClampedArray[]
  durationsMs?: readonly number[]
  width: number
  height: number
  checkerDark: boolean
  testIdCanvas?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [frameIdx, setFrameIdx] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    setFrameIdx(0)
    setPlaying(framesRgba.length > 1)
  }, [framesRgba.length, width, height])

  useEffect(() => {
    if (!playing || framesRgba.length <= 1) return
    const safeIdx = frameIdx % framesRgba.length
    const delay = Math.max(20, durationsMs?.[safeIdx] ?? 100)
    const id = window.setTimeout(() => {
      setFrameIdx((prev) => (prev + 1) % framesRgba.length)
    }, delay)
    return () => window.clearTimeout(id)
  }, [playing, frameIdx, framesRgba.length, durationsMs])

  const activeData = framesRgba[frameIdx % Math.max(1, framesRgba.length)]

  useEffect(() => {
    const c = canvasRef.current
    if (!c || !activeData) return
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    if (typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(width * height * 4)
      copy.set(activeData.subarray(0, copy.length))
      ctx.putImageData(new ImageData(copy, width, height), 0, 0)
    } else {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          const a = activeData[i + 3]!
          if (a === 0) continue
          ctx.fillStyle = `rgba(${activeData[i]},${activeData[i + 1]},${activeData[i + 2]},${(a / 255).toFixed(3)})`
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }
  }, [activeData, width, height])

  return (
    <div
      style={getCheckerboardStyle(checkerDark, 10)}
      className="relative w-full h-40 border-2 border-[var(--border-pixel)] p-2 flex items-center justify-center overflow-hidden"
    >
      <canvas
        ref={canvasRef}
        className="max-w-full max-h-full object-contain pixelated"
        style={{
          aspectRatio: `${width} / ${height}`,
          width: width >= height ? '100%' : 'auto',
          height: height > width ? '100%' : 'auto',
        }}
        data-testid={testIdCanvas}
      />
      {framesRgba.length > 1 && (
        <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1 bg-[var(--bg-surface)] border border-[var(--border-pixel)] px-1.5 py-0.5 text-[10px] font-bold">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="px-1 cursor-pointer hover:text-[var(--accent-primary)]"
          >
            <PixelIcon name={playing ? 'pause' : 'play'} size={11} />
          </button>
          <span>
            {(frameIdx % framesRgba.length) + 1}/{framesRgba.length}
          </span>
        </div>
      )}
    </div>
  )
}

export function UnifiedImportModal({
  open,
  onClose,
  checkerDark = false,
  onCreatedProject,
  onError,
}: UnifiedImportModalProps) {
  const { t } = useI18n()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const [fileName, setFileName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [detectedKind, setDetectedKind] = useState<
    'png' | 'gif' | 'aseprite' | null
  >(null)

  const [pngInspection, setPngInspection] =
    useState<PngResolutionInspection | null>(null)
  const [gifInspection, setGifInspection] =
    useState<GifResolutionInspection | null>(null)
  const [aseParsed, setAseParsed] = useState<ParsedAsepriteDocument | null>(
    null
  )

  const [selectedScale, setSelectedScale] = useState<number>(1)
  const [decoding, setDecoding] = useState(false)
  const [decodedFrameCount, setDecodedFrameCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setFileName('')
      setProjectName('')
      setDetectedKind(null)
      setPngInspection(null)
      setGifInspection(null)
      setAseParsed(null)
      setSelectedScale(1)
      setDecoding(false)
      setDecodedFrameCount(0)
      setBusy(false)
      setErrorMsg(null)
    } else {
      abortRef.current?.abort()
      abortRef.current = null
      setDecoding(false)
      setBusy(false)
    }
  }, [open])

  const handleCancelOperation = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setDecoding(false)
    setBusy(false)
  }

  const handleFileSelected = async (file: File | null) => {
    if (!file) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setErrorMsg(null)
    setPngInspection(null)
    setGifInspection(null)
    setAseParsed(null)
    setDetectedKind(null)
    setDecoding(true)
    setDecodedFrameCount(0)

    try {
      const bytes = await readFileBytes(file)
      if (ctrl.signal.aborted) return

      const kind = detectArtworkFileKind(file.name, bytes)
      if (!kind) {
        const msg = t('unifiedImportUnsupportedErr')
        setErrorMsg(msg)
        onError?.(msg)
        return
      }

      const cleanBaseName =
        file.name
          .replace(/\.(png|gif|aseprite|ase)$/i, '')
          .trim() || 'Imported Artwork'

      if (kind === 'png') {
        const res = inspectPngForImport(bytes, MAX_CANVAS_SIZE)
        setFileName(file.name)
        setProjectName(cleanBaseName.slice(0, 48))
        setDetectedKind('png')
        setPngInspection(res)
        setSelectedScale(res.recommendedScale)
      } else if (kind === 'gif') {
        const res = await inspectGifForImport(bytes, MAX_CANVAS_SIZE, {
          signal: ctrl.signal,
          onProgress: (done) => setDecodedFrameCount(done),
        })
        if (ctrl.signal.aborted) return
        setFileName(file.name)
        setProjectName(cleanBaseName.slice(0, 48))
        setDetectedKind('gif')
        setGifInspection(res)
        if (res.confidence === 'metadata') {
          setSelectedScale(res.recommendedScale)
        } else if (res.exceedsCanvasAt1x && res.recommendedScale > 1) {
          setSelectedScale(res.recommendedScale)
        } else {
          setSelectedScale(1)
        }
      } else {
        const doc = parseAsepriteBytes(bytes)
        setFileName(file.name)
        setProjectName(cleanBaseName.slice(0, 48))
        setDetectedKind('aseprite')
        setAseParsed(doc)
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMsg(t('importGifCancelledMsg'))
        return
      }
      const msg =
        err instanceof Error ? err.message : t('unifiedImportUnsupportedErr')
      setErrorMsg(msg)
      onError?.(msg)
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null
      }
      setDecoding(false)
    }
  }

  // PNG derived state
  const restoredPng = useMemo(() => {
    if (!pngInspection) return null
    return downscaleByIntegerBlock(
      pngInspection.decoded.data,
      pngInspection.decoded.width,
      pngInspection.decoded.height,
      selectedScale
    )
  }, [pngInspection, selectedScale])

  const preparedPng = useMemo(() => {
    if (!restoredPng) return null
    if (
      restoredPng.width > MAX_CANVAS_SIZE ||
      restoredPng.height > MAX_CANVAS_SIZE
    ) {
      return null
    }
    return prepareImportedPngAsIndexed(
      restoredPng.data,
      restoredPng.width,
      restoredPng.height,
      {
        name: `${projectName.trim() || 'PNG'} Palette`,
        colors: [],
      }
    )
  }, [restoredPng, projectName])

  // GIF derived state
  const targetGifDims = useMemo(() => {
    if (!gifInspection) return null
    return {
      width: Math.max(1, Math.floor(gifInspection.decoded.width / selectedScale)),
      height: Math.max(
        1,
        Math.floor(gifInspection.decoded.height / selectedScale)
      ),
    }
  }, [gifInspection, selectedScale])

  const preparedGif = useMemo(() => {
    if (!gifInspection || !targetGifDims) return null
    if (
      targetGifDims.width > MAX_CANVAS_SIZE ||
      targetGifDims.height > MAX_CANVAS_SIZE
    ) {
      return null
    }
    try {
      return prepareImportedGifAsIndexed(gifInspection.decoded, selectedScale, {
        paletteName: `${projectName.trim() || 'GIF'} Palette`,
        layerName:
          gifInspection.decoded.frames.length > 1
            ? t('importGifLayerDefaultName')
            : 'Layer 1',
      })
    } catch {
      return null
    }
  }, [gifInspection, targetGifDims, selectedScale, projectName, t])

  const exceedsCanvasLimit = useMemo(() => {
    if (detectedKind === 'png' && restoredPng) {
      return (
        restoredPng.width > MAX_CANVAS_SIZE ||
        restoredPng.height > MAX_CANVAS_SIZE
      )
    }
    if (detectedKind === 'gif' && targetGifDims) {
      return (
        targetGifDims.width > MAX_CANVAS_SIZE ||
        targetGifDims.height > MAX_CANVAS_SIZE
      )
    }
    if (detectedKind === 'aseprite' && aseParsed) {
      return !aseParsed.fitsCanvasLimit
    }
    return false
  }, [detectedKind, restoredPng, targetGifDims, aseParsed])

  const handleConfirmImport = async () => {
    if (busy || decoding || exceedsCanvasLimit || !detectedKind) return
    setBusy(true)
    setErrorMsg(null)
    try {
      if (detectedKind === 'png' && restoredPng && preparedPng) {
        const layerId = generateId('layer')
        const created = await createImportedProject({
          name: projectName.trim() || 'Imported PNG',
          width: restoredPng.width,
          height: restoredPng.height,
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
              dataWidth: restoredPng.width,
              dataHeight: restoredPng.height,
              data: preparedPng.indexedData,
            },
          ],
          activeLayerId: layerId,
          palette: preparedPng.palette,
        })
        onCreatedProject?.(created, 'png')
        onClose()
      } else if (detectedKind === 'gif' && preparedGif) {
        const created = await createImportedProject({
          name: projectName.trim() || 'Imported GIF',
          width: preparedGif.width,
          height: preparedGif.height,
          layers: [preparedGif.layer],
          activeLayerId: preparedGif.layer.id,
          timeline: {
            frames: preparedGif.frames,
            cels: preparedGif.cels,
            celBuffers: preparedGif.celBuffers,
            activeFrameId: preparedGif.frames[0]?.id,
            loopPlayback: preparedGif.loopPlayback,
            playbackDirection: 'forward',
          },
          palette: preparedGif.palette,
        })
        onCreatedProject?.(created, 'gif')
        onClose()
      } else if (detectedKind === 'aseprite' && aseParsed) {
        const created = await createImportedProject({
          name: projectName.trim() || 'Aseprite Artwork',
          width: aseParsed.width,
          height: aseParsed.height,
          layers: aseParsed.layers,
          activeLayerId: aseParsed.layers[aseParsed.layers.length - 1]?.id,
          timeline: {
            frames: aseParsed.frames,
            cels: aseParsed.cels,
            celBuffers: aseParsed.celBuffers,
            activeFrameId: aseParsed.frames[0]?.id,
          },
          palette: {
            ...aseParsed.palette,
            name: `${projectName.trim() || 'Aseprite'} Palette`,
          },
        })
        onCreatedProject?.(created, 'aseprite')
        onClose()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed.'
      setErrorMsg(msg)
      onError?.(msg)
    } finally {
      setBusy(false)
    }
  }

  const formatGifWarning = (w: GifImportWarning): string => {
    switch (w.code) {
      case 'large-dimensions':
        return `${t('importGifWarnLargeDimensions')} (${w.detail ?? ''})`
      case 'many-frames':
        return `${t('importGifWarnManyFrames')} (${w.detail ?? ''}f)`
      case 'very-short-delays':
        return `${t('importGifWarnShortDelays')} (${w.detail ?? ''}f)`
      case 'finite-loop-approximated':
        return `${t('importGifWarnFiniteLoop')} (×${w.detail ?? ''})`
      case 'metadata-mismatch':
        return t('importGifMetaMismatchWarn')
    }
  }

  return (
    <Modal
      open={open}
      title={t('unifiedImportTitle')}
      onClose={() => {
        handleCancelOperation()
        onClose()
      }}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3.5" data-testid="unified-import-modal">
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          {t('unifiedImportHint')}
        </p>

        {/* Single Unified File Picker */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/gif,.png,.gif,.ase,.aseprite"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              void handleFileSelected(f)
              e.currentTarget.value = ''
            }}
            className="hidden"
            data-testid="unified-import-file-input"
          />
          <button
            type="button"
            disabled={decoding || busy}
            onClick={() => fileInputRef.current?.click()}
            className="pixel-btn pixel-btn-teal min-h-[42px] px-3.5 text-xs font-bold flex items-center gap-2"
            data-testid="unified-import-choose-btn"
          >
            <PixelIcon name="upload" size={15} />
            <span>{t('unifiedImportSelectFile')}</span>
          </button>
          {fileName && (
            <span className="text-xs font-mono truncate max-w-[220px] text-[var(--text-secondary)]">
              {fileName}
            </span>
          )}
        </div>

        {decoding && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] flex items-center justify-between gap-2 text-xs font-bold"
            data-testid="import-gif-decoding-box"
          >
            <span>
              {t('importGifDecodingProgress')} ({decodedFrameCount}f)
            </span>
            <button
              type="button"
              onClick={handleCancelOperation}
              className="pixel-btn pixel-btn-danger min-h-[32px] px-3 text-xs font-bold"
            >
              {t('importGifCancelBtn')}
            </button>
          </div>
        )}

        {errorMsg && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)]"
            data-testid="unified-import-error"
          >
            {errorMsg}
          </div>
        )}

        {/* ==================== PNG DETECTED ==================== */}
        {detectedKind === 'png' && pngInspection && restoredPng && !decoding && (
          <div className="space-y-3" data-testid="import-png-modal">
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              maxLength={48}
              className="w-full min-h-[38px] px-2.5 text-xs font-bold pixel-input select-text"
              data-testid="import-png-name-input"
            />

            {pngInspection.confidence === 'metadata' && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] text-xs font-bold text-[var(--accent-teal)] flex items-center gap-1.5"
                data-testid="import-png-meta-badge"
              >
                <PixelIcon name="check" size={13} />
                <span>
                  {t('importPngDetectedMeta')} (
                  {pngInspection.metadata?.originalWidth}×
                  {pngInspection.metadata?.originalHeight}px /{' '}
                  {pngInspection.metadata?.scale}×)
                </span>
              </div>
            )}

            {pngInspection.confidence === 'heuristic' && (
              <div
                className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] text-xs font-bold text-[var(--accent-primary)] flex items-center gap-1.5"
                data-testid="import-png-heuristic-badge"
              >
                <PixelIcon name="sparkle" size={13} />
                <span>
                  {t('importPngDetectedBlock')} (1/
                  {pngInspection.recommendedScale} →{' '}
                  {pngInspection.decoded.width / pngInspection.recommendedScale}
                  ×
                  {pngInspection.decoded.height / pngInspection.recommendedScale}
                  px)
                </span>
              </div>
            )}

            <RgbaPreviewStage
              framesRgba={[preparedPng?.previewRgba ?? restoredPng.data]}
              width={restoredPng.width}
              height={restoredPng.height}
              checkerDark={checkerDark}
            />

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importPngBeforeSize')}
                </div>
                <div className="font-bold mt-0.5" data-testid="import-png-before-size">
                  {pngInspection.decoded.width} × {pngInspection.decoded.height}{' '}
                  px
                </div>
              </div>
              <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                <div className="text-[10px] text-[var(--text-secondary)]">
                  {t('importPngAfterSize')}
                </div>
                <div
                  className={`font-bold mt-0.5 ${
                    exceedsCanvasLimit
                      ? 'text-[var(--accent-rose)]'
                      : 'text-[var(--accent-teal)]'
                  }`}
                  data-testid="import-png-after-size"
                >
                  {restoredPng.width} × {restoredPng.height} px
                </div>
              </div>
            </div>

            {pngInspection.candidates.length > 1 && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedScale(
                        pngInspection.recommendedScale > 1
                          ? pngInspection.recommendedScale
                          : pngInspection.candidates[
                              pngInspection.candidates.length - 1
                            ]!.scale
                      )
                    }
                    className={`min-h-[38px] px-2.5 text-xs font-bold ${
                      selectedScale > 1
                        ? 'pixel-btn pixel-btn-teal'
                        : 'pixel-btn'
                    }`}
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
                  >
                    {t('importPngKeepOriginalSize')}
                  </button>
                </div>

                <PixelSelect<number>
                  value={selectedScale}
                  options={pngInspection.candidates.map((c) => ({
                    value: c.scale,
                    label:
                      c.scale === 1
                        ? `1× — ${c.restoredWidth}×${c.restoredHeight}px (${t('importPngKeepOriginalSize')})`
                        : `1/${c.scale} (${c.scale}×) → ${c.restoredWidth}×${c.restoredHeight}px`,
                  }))}
                  onChange={setSelectedScale}
                  ariaLabel={t('importPngScaleCandidate')}
                  direction="up"
                  className="w-full"
                  testId="import-png-scale-select"
                />
              </div>
            )}

            {exceedsCanvasLimit && (
              <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)]">
                {t('importPngTooLargeError')}
              </div>
            )}
          </div>
        )}

        {/* ==================== GIF DETECTED ==================== */}
        {detectedKind === 'gif' &&
          gifInspection &&
          targetGifDims &&
          !decoding && (
            <div className="space-y-3" data-testid="import-gif-modal">
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                maxLength={48}
                className="w-full min-h-[38px] px-2.5 text-xs font-bold pixel-input select-text"
                data-testid="import-gif-name-input"
              />

              {gifInspection.confidence === 'metadata' && (
                <div
                  className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] text-xs font-bold text-[var(--accent-teal)] flex items-center gap-1.5"
                  data-testid="import-gif-meta-badge"
                >
                  <PixelIcon name="check" size={13} />
                  <span>
                    {t('importGifDetectedMeta')} (
                    {gifInspection.metadata?.originalWidth}×
                    {gifInspection.metadata?.originalHeight}px /{' '}
                    {gifInspection.metadata?.scale}×)
                  </span>
                </div>
              )}

              {gifInspection.confidence === 'heuristic' && (
                <div
                  className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-primary)] text-xs font-bold text-[var(--accent-primary)] flex items-center gap-1.5"
                  data-testid="import-gif-heuristic-badge"
                >
                  <PixelIcon name="sparkle" size={13} />
                  <span>
                    {t('importGifDetectedHeuristic')} (1/
                    {gifInspection.recommendedScale} →{' '}
                    {gifInspection.decoded.width /
                      gifInspection.recommendedScale}
                    ×
                    {gifInspection.decoded.height /
                      gifInspection.recommendedScale}
                    px)
                  </span>
                </div>
              )}

              <RgbaPreviewStage
                framesRgba={
                  preparedGif?.previewFramesRgba ??
                  gifInspection.decoded.frames.map((f) => f.rgba)
                }
                durationsMs={gifInspection.decoded.frames.map(
                  (f) => f.durationMs
                )}
                width={preparedGif?.width ?? gifInspection.decoded.width}
                height={preparedGif?.height ?? gifInspection.decoded.height}
                checkerDark={checkerDark}
                testIdCanvas="import-gif-preview-canvas"
              />

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                  <div className="text-[10px] text-[var(--text-secondary)]">
                    {t('importGifRawSize')}
                  </div>
                  <div className="font-bold mt-0.5" data-testid="import-gif-raw-size">
                    {gifInspection.decoded.width} ×{' '}
                    {gifInspection.decoded.height} px
                  </div>
                </div>
                <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                  <div className="text-[10px] text-[var(--text-secondary)]">
                    {t('importGifCanvasSizeAfter')}
                  </div>
                  <div
                    className={`font-bold mt-0.5 ${
                      exceedsCanvasLimit
                        ? 'text-[var(--accent-rose)]'
                        : 'text-[var(--accent-teal)]'
                    }`}
                    data-testid="import-gif-after-size"
                  >
                    {targetGifDims.width} × {targetGifDims.height} px (1/
                    {selectedScale})
                  </div>
                </div>
                {gifInspection.decoded.frames.length > 1 && (
                  <>
                    <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                      <div className="text-[10px] text-[var(--text-secondary)]">
                        {t('importGifFrameCount')}
                      </div>
                      <div
                        className="font-bold mt-0.5"
                        data-testid="import-gif-frame-count"
                      >
                        {gifInspection.decoded.frames.length} f
                      </div>
                    </div>
                    <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                      <div className="text-[10px] text-[var(--text-secondary)]">
                        {t('importGifTotalDuration')}
                      </div>
                      <div
                        className="font-bold mt-0.5"
                        data-testid="import-gif-total-duration"
                      >
                        {gifInspection.decoded.totalDurationMs} ms
                      </div>
                    </div>
                  </>
                )}
              </div>

              {preparedGif && (
                <div
                  className={`p-2 bg-[var(--bg-elevated)] border-2 ${
                    preparedGif.wasQuantized
                      ? 'border-[var(--accent-amber)]'
                      : 'border-[var(--border-pixel)]'
                  } flex flex-wrap items-center justify-between gap-2 text-xs`}
                >
                  <div>
                    <span className="text-[var(--text-secondary)] mr-1.5">
                      {t('importGifColorSummary')}:
                    </span>
                    <span className="font-bold">
                      {preparedGif.wasQuantized
                        ? `${preparedGif.originalOpaqueColorCount} → ${preparedGif.finalOpaqueColorCount}`
                        : `${preparedGif.finalOpaqueColorCount}`}
                    </span>
                  </div>
                  <span
                    className={`font-bold ${
                      preparedGif.wasQuantized
                        ? 'text-[var(--accent-amber)]'
                        : 'text-[var(--accent-teal)]'
                    }`}
                  >
                    {preparedGif.wasQuantized
                      ? t('importGifQuantizedYes')
                      : t('importGifQuantizedNo')}
                  </span>
                </div>
              )}

              {gifInspection.candidates.length > 1 && (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedScale(
                          gifInspection.recommendedScale > 1
                            ? gifInspection.recommendedScale
                            : gifInspection.candidates[
                                gifInspection.candidates.length - 1
                              ]!.scale
                        )
                      }
                      className={`min-h-[38px] px-2.5 text-xs font-bold ${
                        selectedScale > 1
                          ? 'pixel-btn pixel-btn-teal'
                          : 'pixel-btn'
                      }`}
                      data-testid="import-gif-restore-btn"
                    >
                      {gifInspection.confidence === 'metadata'
                        ? t('importGifRestoreMetaBtn')
                        : t('importGifRestoreEstimatedBtn')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedScale(1)}
                      className={`min-h-[38px] px-2.5 text-xs font-bold ${
                        selectedScale === 1
                          ? 'pixel-btn pixel-btn-teal'
                          : 'pixel-btn'
                      }`}
                      data-testid="import-gif-keep-raw-btn"
                    >
                      {t('importGifKeepRawSizeBtn')}
                    </button>
                  </div>

                  <PixelSelect<number>
                    value={selectedScale}
                    options={gifInspection.candidates.map((c) => ({
                      value: c.scale,
                      label:
                        c.scale === 1
                          ? `1× — ${c.restoredWidth}×${c.restoredHeight}px (${t('importGifKeepRawSizeBtn')})`
                          : `1/${c.scale} (${c.scale}×) → ${c.restoredWidth}×${c.restoredHeight}px`,
                    }))}
                    onChange={setSelectedScale}
                    ariaLabel={t('importGifScaleCandidateLabel')}
                    direction="up"
                    className="w-full"
                    testId="import-gif-scale-select"
                  />
                </div>
              )}

              {gifInspection.warnings.length > 0 && (
                <div className="p-2 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] space-y-1 text-[11px] leading-relaxed">
                  {gifInspection.warnings.map((w, i) => (
                    <div key={`${w.code}-${i}`}>• {formatGifWarning(w)}</div>
                  ))}
                </div>
              )}

              {exceedsCanvasLimit && (
                <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-rose)] text-xs font-bold text-[var(--accent-rose)]">
                  {t('importGifTooLargeError')}
                </div>
              )}
            </div>
          )}

        {/* ==================== ASEPRITE DETECTED ==================== */}
        {detectedKind === 'aseprite' && aseParsed && !decoding && (
          <div className="space-y-3" data-testid="import-aseprite-modal">
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
                    {aseParsed.width} × {aseParsed.height} px
                  </strong>{' '}
                  ({aseParsed.colorDepth}bpp)
                </div>
                <div>
                  レイヤー数: <strong>{aseParsed.layerCount}</strong>
                </div>
                {aseParsed.frameCount > 1 && (
                  <div>
                    フレーム数: <strong>{aseParsed.frameCount}</strong>
                  </div>
                )}
                <div>
                  パレット色数: <strong>{aseParsed.palette.colors.length}</strong>
                </div>
              </div>
            </div>
            {aseParsed.warnings.length > 0 && (
              <div className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-amber)] space-y-1.5 text-xs">
                <ul className="list-disc pl-4 space-y-1 text-[11px]">
                  {aseParsed.warnings.map((w, idx) => (
                    <li key={`${w.code}-${idx}`}>{formatAseWarning(w)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Confirm / Cancel Footer */}
        {detectedKind && !decoding && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                handleCancelOperation()
                onClose()
              }}
              className="pixel-btn min-h-[42px] px-4 text-xs font-bold"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              disabled={
                exceedsCanvasLimit ||
                busy ||
                (detectedKind === 'png' && !preparedPng) ||
                (detectedKind === 'gif' && !preparedGif)
              }
              onClick={() => void handleConfirmImport()}
              className="pixel-btn pixel-btn-active min-h-[42px] px-4 text-xs font-bold flex items-center gap-1.5"
              data-testid="unified-import-confirm-btn"
            >
              <PixelIcon name="check" size={14} />
              <span>{t('confirm')}</span>
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
