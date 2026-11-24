import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { BlendMode, LayerRuntime } from '../../types'
import { MAX_LAYERS } from '../../engine/compositor'
import { ALL_BLEND_MODES } from '../../state/useEditorController'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
import { PixelSlider } from '../common/PixelSlider'
import { PixelSelect } from '../common/PixelSelect'
import { LayerBufferThumbnail } from '../common/PixelThumbnail'
import { useLongPressReorder } from '../../utils/useLongPressReorder'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

const BLEND_LABEL_KEYS: Record<BlendMode, TranslationKey> = {
  normal: 'blendNormal',
  multiply: 'blendMultiply',
  screen: 'blendScreen',
  overlay: 'blendOverlay',
  darken: 'blendDarken',
  lighten: 'blendLighten',
  add: 'blendAdd',
  difference: 'blendDifference',
}

interface LayerSheetProps {
  open: boolean
  onClose: () => void
  canvasWidth: number
  canvasHeight: number
  checkerDark?: boolean
  layers: LayerRuntime[]
  activeLayerId: string
  selectedLayerIds: string[]
  onSelectLayer: (id: string) => void
  onToggleLayerSelected: (id: string) => void
  onClearLayerSelection: () => void
  onStartMultiLayerMoveOnCanvas: () => void
  onDuplicateSelectedLayers: () => void
  onMergeSelectedLayers: () => void
  onDeleteSelectedLayers: () => void
  onAddLayer: () => void
  onDuplicateLayer: (id: string) => void
  onDeleteLayer: (id: string) => void
  onMergeDown: (id: string) => void
  onUpdateLayer: (
    id: string,
    patch: Partial<
      Pick<
        LayerRuntime,
        'name' | 'visible' | 'locked' | 'opacity' | 'blendMode' | 'clipping'
      >
    >
  ) => void
  onReorderLayers: (orderedBottomToTopIds: string[]) => void
  onClearLayer: (id: string) => void
  onCopyLayer: (id: string) => void
  onFlipLayer: (id: string, dir: 'horizontal' | 'vertical') => void
  onStartLayerMoveOnCanvas: (id: string) => void
  /** Optional hook in 1-frame mode to add a 2nd frame and transition smoothly into Timeline mode */
  onAddFirstAnimationFrame?: () => void
}

/**
 * Redesigned Layer Panel:
 * - Independent per-layer checkbox selection (`selectedLayerIds`) that NEVER changes `activeLayerId`
 * - Conditional Batch Action Bar when >=1 layer is checked (Count + Clear + Batch Move + compact Batch More menu)
 * - Layer rename input auto-selects full existing text on focus (`select()`), saves on Enter, cancels on Escape, rejects empty names
 * - Long-press & drag reordering with drop placeholder
 */
export type LayerPanelContentProps = Omit<LayerSheetProps, 'open' | 'onClose'> & {
  onClose?: () => void
  compactInline?: boolean
}

export function LayerPanelContent({
  onClose,
  compactInline = false,
  canvasWidth,
  canvasHeight,
  checkerDark = false,
  layers,
  activeLayerId,
  selectedLayerIds,
  onSelectLayer,
  onToggleLayerSelected,
  onClearLayerSelection,
  onStartMultiLayerMoveOnCanvas,
  onDuplicateSelectedLayers,
  onMergeSelectedLayers,
  onDeleteSelectedLayers,
  onAddLayer,
  onDuplicateLayer,
  onDeleteLayer,
  onMergeDown,
  onUpdateLayer,
  onReorderLayers,
  onClearLayer,
  onCopyLayer,
  onFlipLayer,
  onStartLayerMoveOnCanvas,
  onAddFirstAnimationFrame,
}: LayerPanelContentProps) {
  const { t } = useI18n()
  const { reducedMotion } = useApp()

  const displayLayers = [...layers].reverse()
  const displayIds = displayLayers.map((l) => l.id)
  const atMaxLayers = layers.length >= MAX_LAYERS
  const selectedSet = new Set(selectedLayerIds)
  const checkedCount = displayLayers.filter((l) => selectedSet.has(l.id)).length

  const [menuLayerId, setMenuLayerId] = useState<string | null>(null)
  const [batchMenuOpen, setBatchMenuOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const listScrollRef = useRef<HTMLDivElement | null>(null)
  const lastNameTapRef = useRef<{ layerId: string; time: number } | null>(null)

  // Auto-focus and select full layer name whenever inline rename opens
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      const el = renameInputRef.current
      el.focus()
      el.select()
    }
  }, [renamingId])

  const { dragState, getItemProps, getHandleProps, shouldSuppressClick } =
    useLongPressReorder({
      ids: displayIds,
      enabled: menuLayerId === null && renamingId === null && layers.length > 1,
      axis: 'vertical',
      scopeId: compactInline ? 'inline-layers' : 'modal-layers',
      onReorder: (nextTopToBottomIds) => {
        onReorderLayers([...nextTopToBottomIds].reverse())
      },
      scrollContainerRef: listScrollRef,
    })

  const blendOptions = ALL_BLEND_MODES.map((bm) => ({
    value: bm,
    label: t(BLEND_LABEL_KEYS[bm]),
  }))

  const beginInlineRename = (layerId: string, currentName: string) => {
    setMenuLayerId(null)
    setRenameDraft(currentName)
    setRenamingId(layerId)
  }

  const commitInlineRename = (layerId: string, originalName: string) => {
    const trimmed = renameDraft.trim()
    setRenamingId(null)
    if (trimmed.length > 0 && trimmed !== originalName) {
      onUpdateLayer(layerId, { name: trimmed })
    } else {
      setRenameDraft(originalName)
    }
  }

  return (
    <div className="space-y-2.5">
      {/* Clean Top Bar: Add Layer + Optional Add Frame (1-frame -> Animation) + Drag Reorder Hint */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={atMaxLayers}
            onClick={onAddLayer}
            className="pixel-btn pixel-btn-active min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
            data-testid="add-layer-btn"
          >
            <PixelIcon name="plus" size={14} />
            <span>
              {t('addLayer')} ({layers.length}/{MAX_LAYERS})
            </span>
          </button>

          {onAddFirstAnimationFrame && (
            <button
              type="button"
              onClick={onAddFirstAnimationFrame}
              className="pixel-btn pixel-btn-teal min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
              data-testid="add-first-frame-btn"
            >
              <PixelIcon name="film" size={14} />
              <span>+ フレーム追加</span>
            </button>
          )}
        </div>

        <span className="text-[11px] text-[var(--text-secondary)]">
          {t('layerReorderHint')}
        </span>
      </div>

        {/* Multi-Layer Batch Action Bar (shown ONLY when >=1 layer is checked) */}
        {checkedCount > 0 && (
          <div
            className="p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--accent-teal)] space-y-2"
            data-testid="layer-batch-bar"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className="font-bold text-[var(--accent-teal)]"
                  data-testid="layer-selected-count"
                >
                  {t('selectedLayersCount')}: {checkedCount}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setBatchMenuOpen(false)
                    onClearLayerSelection()
                  }}
                  className="pixel-btn min-h-[30px] px-2 text-[11px] font-bold"
                  data-testid="clear-layer-selection-btn"
                >
                  {t('clearLayerSelection')}
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setBatchMenuOpen(false)
                    onClose?.()
                    onStartMultiLayerMoveOnCanvas()
                  }}
                  className="pixel-btn pixel-btn-teal min-h-[36px] px-3 text-xs font-bold flex items-center gap-1.5"
                  data-testid="batch-move-layers-btn"
                >
                  <PixelIcon name="move" size={14} />
                  <span>{t('batchMoveLayers')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setBatchMenuOpen((v) => !v)}
                  aria-expanded={batchMenuOpen}
                  aria-label={t('batchMoreActions')}
                  className={`min-w-[36px] min-h-[36px] flex items-center justify-center ${
                    batchMenuOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                  }`}
                  data-testid="batch-more-btn"
                >
                  <PixelIcon name="more" size={15} />
                </button>
              </div>
            </div>

            {batchMenuOpen && (
              <div
                className="grid grid-cols-3 gap-1.5 pt-2 border-t border-[var(--border-subtle)]"
                data-testid="batch-more-menu"
              >
                <button
                  type="button"
                  disabled={layers.length + checkedCount > MAX_LAYERS}
                  onClick={() => {
                    setBatchMenuOpen(false)
                    onDuplicateSelectedLayers()
                  }}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center justify-center gap-1"
                  data-testid="batch-duplicate-btn"
                >
                  <PixelIcon name="copy" size={13} />
                  <span className="truncate">{t('duplicateLayer')}</span>
                </button>

                <button
                  type="button"
                  disabled={checkedCount < 2}
                  onClick={() => {
                    setBatchMenuOpen(false)
                    onMergeSelectedLayers()
                  }}
                  className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center justify-center gap-1"
                  data-testid="batch-merge-btn"
                >
                  <PixelIcon name="merge" size={13} />
                  <span className="truncate">{t('batchMergeLayers')}</span>
                </button>

                <button
                  type="button"
                  disabled={layers.length - checkedCount < 1}
                  onClick={() => {
                    setBatchMenuOpen(false)
                    onDeleteSelectedLayers()
                  }}
                  className="pixel-btn pixel-btn-danger min-h-[36px] px-2 text-xs font-bold flex items-center justify-center gap-1"
                  data-testid="batch-delete-btn"
                >
                  <PixelIcon name="trash" size={13} />
                  <span className="truncate">{t('deleteLayer')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {atMaxLayers && (
          <p className="text-xs font-bold text-[var(--accent-rose)]">
            {t('layerMaxReached')}
          </p>
        )}

        {/* Layer Stack List (Top layer at top) */}
        <div
          ref={listScrollRef}
          className={`space-y-1.5 overflow-y-auto pr-0.5 ${
            compactInline ? 'max-h-[26dvh]' : 'max-h-[60dvh]'
          }`}
          data-testid="layer-list-container"
        >
          {displayLayers.map((layer) => {
            const isSelected = layer.id === activeLayerId
            const isChecked = selectedSet.has(layer.id)
            const bottomUpIdx = layers.findIndex((l) => l.id === layer.id)
            const isBottomLayer = bottomUpIdx <= 0
            const menuOpen = menuLayerId === layer.id
            const isDraggingThis = dragState?.draggingId === layer.id
            const isDropTarget =
              dragState !== null &&
              dragState.overId === layer.id &&
              dragState.draggingId !== layer.id
            const hasOffset =
              (layer.offsetX ?? 0) !== 0 || (layer.offsetY ?? 0) !== 0

            return (
              <div
                key={layer.id}
                {...getItemProps(layer.id)}
                className={`relative border-2 transition-colors ${
                  isDropTarget
                    ? 'border-[var(--accent-teal)] outline-2 outline-dashed outline-[var(--accent-teal)] bg-[var(--bg-panel)]'
                    : isSelected
                      ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)]'
                      : 'bg-[var(--bg-elevated)] border-[var(--border-pixel)]'
                } ${isDraggingThis ? 'opacity-65' : ''}`}
                data-testid={`layer-row-${layer.id}`}
              >
                {isDropTarget && (
                  <div
                    className="h-1.5 w-full bg-[var(--accent-teal)]"
                    data-testid={`layer-drop-indicator-${layer.id}`}
                  />
                )}

                <div
                  onClick={() => {
                    if (shouldSuppressClick()) return
                    onSelectLayer(layer.id)
                  }}
                  className="flex items-center gap-2 px-2 py-2 cursor-pointer select-none"
                >
                  {/* Drag Handle for instant touch/mouse reordering without hold delay */}
                  {layers.length > 1 && (
                    <span
                      {...getHandleProps()}
                      title={t('layerReorderHint')}
                      className="w-5 h-9 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-grab active:cursor-grabbing shrink-0"
                      data-testid={`layer-drag-handle-${layer.id}`}
                    >
                      <PixelIcon name="drag" size={13} />
                    </span>
                  )}

                  {/* 0. Independent Multi-Select Checkbox (NEVER changes activeLayerId!) */}
                  <div
                    data-no-reorder="true"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    <PixelCheckbox
                      checked={isChecked}
                      onChange={() => onToggleLayerSelected(layer.id)}
                      ariaLabel={`Select ${layer.name}`}
                      testId={`layer-check-${layer.id}`}
                    />
                  </div>

                  {/* 1. Real Pixel Data Thumbnail */}
                  <div className="relative shrink-0">
                    <LayerBufferThumbnail
                      layer={layer}
                      canvasWidth={canvasWidth}
                      canvasHeight={canvasHeight}
                      checkerDark={checkerDark}
                      size={compactInline ? 38 : 46}
                    />
                    {isSelected && (
                      <span
                        className="absolute -top-1 -left-1 w-3.5 h-3.5 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] border border-[var(--border-strong)] flex items-center justify-center"
                        aria-hidden="true"
                      >
                        <PixelIcon name="check" size={9} />
                      </span>
                    )}
                  </div>

                  {/* 2 & 3. Layer Name (Double-click on PC / Double-tap on Touch starts inline rename — NEVER starts drag!) + Auxiliary Metadata */}
                  <div className="flex-1 min-w-0 space-y-0.5">
                    {renamingId === layer.id ? (
                      <input
                        ref={renameInputRef}
                        type="text"
                        autoFocus
                        data-no-reorder="true"
                        value={renameDraft}
                        onFocus={(e) => e.currentTarget.select()}
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerMove={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitInlineRename(layer.id, layer.name)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitInlineRename(layer.id, layer.name)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setRenameDraft(layer.name)
                            setRenamingId(null)
                          }
                        }}
                        className="w-full min-h-[32px] px-2 text-xs font-bold pixel-input select-text"
                        data-testid={`layer-rename-input-${layer.id}`}
                      />
                    ) : (
                      <div className="flex items-center gap-1.5 min-w-0">
                        {layer.clipping && (
                          <PixelIcon
                            name="clip"
                            size={12}
                            className="text-[var(--accent-primary)]"
                          />
                        )}
                        {layer.locked && (
                          <PixelIcon
                            name="lock"
                            size={12}
                            className="text-[var(--accent-rose)]"
                          />
                        )}
                        <span
                          data-no-reorder="true"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            beginInlineRename(layer.id, layer.name)
                          }}
                          onPointerUp={(e) => {
                            if (e.pointerType !== 'touch' && e.pointerType !== 'pen') {
                              return
                            }
                            const now = performance.now()
                            const prev = lastNameTapRef.current
                            if (
                              prev &&
                              prev.layerId === layer.id &&
                              now - prev.time <= 350
                            ) {
                              e.stopPropagation()
                              lastNameTapRef.current = null
                              beginInlineRename(layer.id, layer.name)
                            } else {
                              lastNameTapRef.current = {
                                layerId: layer.id,
                                time: now,
                              }
                            }
                          }}
                          className="text-xs font-bold truncate py-0.5 cursor-text"
                          title={t('rename')}
                          data-testid={`layer-name-label-${layer.id}`}
                        >
                          {layer.name}
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--text-secondary)]">
                      <span>{t(BLEND_LABEL_KEYS[layer.blendMode])}</span>
                      <span>·</span>
                      <span>{layer.opacity}%</span>
                      {hasOffset && (
                        <>
                          <span>·</span>
                          <span className="text-[var(--accent-teal)]">
                            {t('layerOffsetBadge')}: {layer.offsetX},{layer.offsetY}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 4. Direct Visibility Toggle */}
                  <button
                    type="button"
                    data-no-reorder="true"
                    onClick={(e) => {
                      e.stopPropagation()
                      onUpdateLayer(layer.id, { visible: !layer.visible })
                    }}
                    className={`min-w-[40px] min-h-[40px] flex items-center justify-center shrink-0 ${
                      layer.visible ? 'pixel-btn' : 'pixel-btn opacity-75'
                    }`}
                    aria-label={layer.visible ? t('layerVisible') : t('layerHidden')}
                    title={layer.visible ? t('layerVisible') : t('layerHidden')}
                    data-testid={`layer-vis-${layer.id}`}
                  >
                    <PixelIcon
                      name={layer.visible ? 'eye' : 'eyeOff'}
                      size={16}
                    />
                  </button>

                  {/* 4b. Direct Lock Toggle */}
                  <button
                    type="button"
                    data-no-reorder="true"
                    onClick={(e) => {
                      e.stopPropagation()
                      onUpdateLayer(layer.id, { locked: !layer.locked })
                    }}
                    className={`min-w-[36px] min-h-[36px] flex items-center justify-center shrink-0 ${
                      layer.locked ? 'pixel-btn pixel-btn-danger' : 'pixel-btn opacity-80'
                    }`}
                    aria-label={layer.locked ? 'ロック解除' : 'レイヤーロック'}
                    title={layer.locked ? 'ロック解除' : 'レイヤーロック'}
                    data-testid={`layer-lock-${layer.id}`}
                  >
                    <PixelIcon
                      name={layer.locked ? 'lock' : 'unlock'}
                      size={14}
                    />
                  </button>

                  {/* 5. Three-Dots Menu Button (Rightmost edge) */}
                  <button
                    type="button"
                    data-no-reorder="true"
                    aria-expanded={menuOpen}
                    aria-label={t('moreActions')}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectLayer(layer.id)
                      setMenuLayerId((prev) => (prev === layer.id ? null : layer.id))
                    }}
                    className={`min-w-[40px] min-h-[40px] flex items-center justify-center shrink-0 ${
                      menuOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid={`layer-more-${layer.id}`}
                  >
                    <PixelIcon name="more" size={16} />
                  </button>
                </div>

                {/* Grouped Three-Dots Layer Action Drawer */}
                <AnimatePresence>
                  {menuOpen && (
                    <motion.div
                      data-no-reorder="true"
                      onClick={(e) => e.stopPropagation()}
                      initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                      transition={{ duration: reducedMotion ? 0 : 0.1 }}
                      className="px-3 py-3 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] space-y-3"
                      data-testid={`layer-menu-${layer.id}`}
                    >
                      {/* Group A: Opacity, Blend Mode & Clipping */}
                      <div className="space-y-2.5 pb-2.5 border-b border-[var(--border-subtle)]">
                        <div className="text-[10px] font-bold text-[var(--text-secondary)]">
                          {t('layerMenuBlend')}
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-bold text-[var(--text-secondary)]">
                              {t('opacity')}
                            </span>
                            <span className="font-bold text-[var(--text-primary)]">
                              {layer.opacity}%
                            </span>
                          </div>
                          <PixelSlider
                            min={0}
                            max={100}
                            value={layer.opacity}
                            unit="%"
                            ariaLabel={t('opacity')}
                            onChange={(val) =>
                              onUpdateLayer(layer.id, { opacity: val })
                            }
                            testId="layer-opacity-slider"
                          />
                        </div>

                        <div className="space-y-1">
                          <span className="block text-xs font-bold text-[var(--text-secondary)]">
                            {t('blendMode')}
                          </span>
                          <PixelSelect<BlendMode>
                            value={layer.blendMode}
                            options={blendOptions}
                            onChange={(bm) =>
                              onUpdateLayer(layer.id, { blendMode: bm })
                            }
                            ariaLabel={t('blendMode')}
                            className="w-full"
                            testId="blend-mode-select"
                          />
                        </div>

                        <PixelCheckbox
                          checked={layer.clipping}
                          disabled={isBottomLayer}
                          onChange={(next) =>
                            onUpdateLayer(layer.id, { clipping: next })
                          }
                          label={t('clipping')}
                          testId="toggle-clipping-btn"
                        />
                      </div>

                      {/* Group B: Rename / Duplicate / Copy / Merge Down */}
                      <div className="space-y-1.5 pb-2.5 border-b border-[var(--border-subtle)]">
                        <div className="text-[10px] font-bold text-[var(--text-secondary)]">
                          {t('layerMenuBasic')}
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setRenameDraft(layer.name)
                              setRenamingId(layer.id)
                              setMenuLayerId(null)
                            }}
                            className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                            data-testid="layer-action-rename"
                          >
                            <PixelIcon name="edit" size={14} />
                            <span className="truncate">{t('rename')}</span>
                          </button>

                          <button
                            type="button"
                            disabled={atMaxLayers}
                            onClick={() => {
                              onDuplicateLayer(layer.id)
                              setMenuLayerId(null)
                            }}
                            className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                            data-testid="dup-layer-btn"
                          >
                            <PixelIcon name="copy" size={14} />
                            <span className="truncate">{t('duplicateLayer')}</span>
                          </button>

                          <button
                            type="button"
                            disabled={isBottomLayer}
                            onClick={() => {
                              onMergeDown(layer.id)
                              setMenuLayerId(null)
                            }}
                            className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                            data-testid="merge-down-btn"
                          >
                            <PixelIcon name="merge" size={14} />
                            <span className="truncate">{t('mergeDown')}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              onCopyLayer(layer.id)
                              setMenuLayerId(null)
                            }}
                            className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1.5"
                          >
                            <PixelIcon name="paste" size={14} />
                            <span className="truncate">{t('copyLayer')}</span>
                          </button>
                        </div>
                      </div>

                      {/* Group C: Transform & Canvas Move */}
                      <div className="space-y-1.5 pb-2.5 border-b border-[var(--border-subtle)]">
                        <div className="text-[10px] font-bold text-[var(--text-secondary)]">
                          {t('layerMenuTransform')}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuLayerId(null)
                            onClose?.()
                            onStartLayerMoveOnCanvas(layer.id)
                          }}
                          className="w-full pixel-btn pixel-btn-teal min-h-[40px] px-3 text-xs font-bold flex items-center justify-center gap-2"
                          data-testid="start-layer-move-btn"
                        >
                          <PixelIcon name="move" size={14} />
                          <span>{t('moveLayerCanvas')}</span>
                        </button>
                        <div className="grid grid-cols-2 gap-1.5">
                          <button
                            type="button"
                            onClick={() => onFlipLayer(layer.id, 'horizontal')}
                            className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center justify-center gap-1.5"
                            data-testid="layer-flip-h-btn"
                          >
                            <PixelIcon name="flipH" size={14} />
                            <span className="truncate">{t('flipH')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onFlipLayer(layer.id, 'vertical')}
                            className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center justify-center gap-1.5"
                            data-testid="layer-flip-v-btn"
                          >
                            <PixelIcon name="flipV" size={14} />
                            <span className="truncate">{t('flipV')}</span>
                          </button>
                        </div>
                      </div>

                      {/* Group D: Clear & Delete */}
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            onClearLayer(layer.id)
                            setMenuLayerId(null)
                          }}
                          className="pixel-btn min-h-[38px] px-2.5 text-xs font-bold flex items-center justify-center gap-1.5"
                          data-testid="clear-layer-btn"
                        >
                          <PixelIcon name="eraser" size={14} />
                          <span className="truncate">{t('clearLayer')}</span>
                        </button>

                        <button
                          type="button"
                          disabled={layers.length <= 1}
                          onClick={() => {
                            setMenuLayerId(null)
                            onDeleteLayer(layer.id)
                          }}
                          className="pixel-btn pixel-btn-danger min-h-[38px] px-2.5 text-xs font-bold flex items-center justify-center gap-1.5"
                          data-testid="del-layer-btn"
                        >
                          <PixelIcon name="trash" size={14} />
                          <span className="truncate">{t('deleteLayer')}</span>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </div>
    </div>
  )
}

export function LayerSheet({ open, onClose, ...rest }: LayerSheetProps) {
  const { t } = useI18n()
  return (
    <Modal
      open={open}
      title={`${t('layersTitle')} (${rest.layers.length}/${MAX_LAYERS})`}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <LayerPanelContent onClose={onClose} {...rest} />
    </Modal>
  )
}
