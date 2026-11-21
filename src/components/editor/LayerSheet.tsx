import { useState } from 'react'
import type { BlendMode, LayerRuntime } from '../../types'
import { MAX_LAYERS } from '../../engine/compositor'
import { ALL_BLEND_MODES } from '../../state/useEditorController'
import { Modal } from '../common/Modal'
import { PixelIcon } from '../common/PixelIcon'
import { PixelCheckbox } from '../common/PixelCheckbox'
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
  layers: LayerRuntime[]
  activeLayerId: string
  onSelectLayer: (id: string) => void
  onAddLayer: () => void
  onDuplicateLayer: (id: string) => void
  onDeleteLayer: (id: string) => void
  onMergeDown: (id: string) => void
  onUpdateLayer: (
    id: string,
    patch: Partial<Pick<LayerRuntime, 'name' | 'visible' | 'opacity' | 'blendMode' | 'clipping'>>
  ) => void
  onReorderLayers: (orderedBottomToTopIds: string[]) => void
  onClearLayer: (id: string) => void
  onCopyLayer: (id: string) => void
  onFlipLayer: (id: string, dir: 'horizontal' | 'vertical') => void
  onMoveLayer: (id: string, dx: number, dy: number) => void
}

export function LayerSheet({
  open,
  onClose,
  layers,
  activeLayerId,
  onSelectLayer,
  onAddLayer,
  onDuplicateLayer,
  onDeleteLayer,
  onMergeDown,
  onUpdateLayer,
  onReorderLayers,
  onClearLayer,
  onCopyLayer,
  onFlipLayer,
  onMoveLayer,
}: LayerSheetProps) {
  const { t } = useI18n()
  const [dragLayerId, setDragLayerId] = useState<string | null>(null)
  const [showMovePad, setShowMovePad] = useState(false)

  const displayLayers = [...layers].reverse()
  const activeIndexBottomUp = layers.findIndex((l) => l.id === activeLayerId)
  const activeLayer = layers[activeIndexBottomUp] ?? layers[0]
  const isBottomLayer = activeIndexBottomUp <= 0
  const atMaxLayers = layers.length >= MAX_LAYERS

  const moveLayerOrderByStep = (layerId: string, deltaBottomUp: 1 | -1) => {
    const idx = layers.findIndex((l) => l.id === layerId)
    const target = idx + deltaBottomUp
    if (idx < 0 || target < 0 || target >= layers.length) return
    const ids = layers.map((l) => l.id)
    const [moved] = ids.splice(idx, 1)
    ids.splice(target, 0, moved)
    onReorderLayers(ids)
  }

  return (
    <Modal
      open={open}
      title={`${t('layersTitle')} (${layers.length}/${MAX_LAYERS})`}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3">
        {/* Layer Primary Actions (>= 44px touch targets) */}
        <div className="grid grid-cols-4 gap-1.5">
          <button
            type="button"
            disabled={atMaxLayers}
            onClick={onAddLayer}
            className="pixel-btn pixel-btn-active min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1"
            data-testid="add-layer-btn"
          >
            <PixelIcon name="plus" size={14} />
            <span className="truncate">{t('addLayer')}</span>
          </button>

          <button
            type="button"
            disabled={atMaxLayers || !activeLayer}
            onClick={() => activeLayer && onDuplicateLayer(activeLayer.id)}
            className="pixel-btn min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1"
            data-testid="dup-layer-btn"
          >
            <PixelIcon name="copy" size={14} />
            <span className="truncate">{t('duplicateLayer')}</span>
          </button>

          <button
            type="button"
            disabled={isBottomLayer || !activeLayer}
            onClick={() => activeLayer && onMergeDown(activeLayer.id)}
            className="pixel-btn min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1"
            data-testid="merge-down-btn"
          >
            <PixelIcon name="merge" size={14} />
            <span className="truncate">{t('mergeDown')}</span>
          </button>

          <button
            type="button"
            disabled={layers.length <= 1 || !activeLayer}
            onClick={() => activeLayer && onDeleteLayer(activeLayer.id)}
            className="pixel-btn pixel-btn-danger min-h-[44px] px-2 text-xs font-bold flex items-center justify-center gap-1"
            data-testid="del-layer-btn"
          >
            <PixelIcon name="trash" size={14} />
            <span className="truncate">{t('deleteLayer')}</span>
          </button>
        </div>

        {atMaxLayers && (
          <p className="text-xs font-bold text-[var(--accent-rose)]">
            {t('layerMaxReached')}
          </p>
        )}

        {/* Active Layer Settings */}
        {activeLayer && (
          <div className="p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <input
                type="text"
                value={activeLayer.name}
                onChange={(e) =>
                  onUpdateLayer(activeLayer.id, { name: e.target.value })
                }
                className="flex-1 min-w-[120px] min-h-[36px] px-2.5 text-xs font-bold pixel-input"
                aria-label={t('rename')}
              />

              <PixelCheckbox
                checked={activeLayer.clipping}
                disabled={isBottomLayer}
                onChange={(next) =>
                  onUpdateLayer(activeLayer.id, { clipping: next })
                }
                label={t('clipping')}
                testId="toggle-clipping-btn"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-[160px]">
                <span className="text-xs shrink-0">
                  {t('opacity')}: <strong>{activeLayer.opacity}%</strong>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={activeLayer.opacity}
                  onChange={(e) =>
                    onUpdateLayer(activeLayer.id, { opacity: Number(e.target.value) })
                  }
                  className="flex-1 accent-[var(--accent-primary)]"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[var(--text-secondary)]">
                  {t('blendMode')}:
                </span>
                <select
                  value={activeLayer.blendMode}
                  onChange={(e) =>
                    onUpdateLayer(activeLayer.id, {
                      blendMode: e.target.value as BlendMode,
                    })
                  }
                  className="min-h-[34px] px-2 text-xs font-bold pixel-input"
                  data-testid="blend-mode-select"
                >
                  {ALL_BLEND_MODES.map((bm) => (
                    <option key={bm} value={bm}>
                      {t(BLEND_LABEL_KEYS[bm])}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 pt-1.5 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => onClearLayer(activeLayer.id)}
                className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
              >
                <PixelIcon name="eraser" size={14} />
                {t('clearLayer')}
              </button>
              <button
                type="button"
                onClick={() => onCopyLayer(activeLayer.id)}
                className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
              >
                <PixelIcon name="copy" size={14} />
                {t('copy')}
              </button>
              <button
                type="button"
                onClick={() => onFlipLayer(activeLayer.id, 'horizontal')}
                className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
              >
                <PixelIcon name="flipH" size={14} />
                {t('flipH')}
              </button>
              <button
                type="button"
                onClick={() => onFlipLayer(activeLayer.id, 'vertical')}
                className="pixel-btn min-h-[36px] px-2 text-xs font-bold flex items-center gap-1"
              >
                <PixelIcon name="flipV" size={14} />
                {t('flipV')}
              </button>
              <button
                type="button"
                onClick={() => setShowMovePad((v) => !v)}
                className={`min-h-[36px] px-2 text-xs font-bold flex items-center gap-1 ${
                  showMovePad ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                }`}
              >
                <PixelIcon name="move" size={14} />
                {t('moveLayer')}
              </button>
            </div>

            {showMovePad && (
              <div className="flex items-center justify-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => onMoveLayer(activeLayer.id, -1, 0)}
                  className="pixel-btn min-h-[36px] px-2.5 flex items-center gap-1 text-xs font-bold"
                >
                  <PixelIcon name="arrowLeft" size={14} /> -1X
                </button>
                <button
                  type="button"
                  onClick={() => onMoveLayer(activeLayer.id, 0, -1)}
                  className="pixel-btn min-h-[36px] px-2.5 flex items-center gap-1 text-xs font-bold"
                >
                  <PixelIcon name="arrowUp" size={14} /> -1Y
                </button>
                <button
                  type="button"
                  onClick={() => onMoveLayer(activeLayer.id, 0, 1)}
                  className="pixel-btn min-h-[36px] px-2.5 flex items-center gap-1 text-xs font-bold"
                >
                  <PixelIcon name="arrowDown" size={14} /> +1Y
                </button>
                <button
                  type="button"
                  onClick={() => onMoveLayer(activeLayer.id, 1, 0)}
                  className="pixel-btn min-h-[36px] px-2.5 flex items-center gap-1 text-xs font-bold"
                >
                  <PixelIcon name="arrowRight" size={14} /> +1X
                </button>
              </div>
            )}
          </div>
        )}

        {/* Layer Stack List */}
        <div className="space-y-1.5 max-h-60 overflow-y-auto pr-0.5">
          {displayLayers.map((layer) => {
            const isSelected = layer.id === activeLayer?.id
            const bottomUpIdx = layers.findIndex((l) => l.id === layer.id)

            return (
              <div
                key={layer.id}
                draggable
                onDragStart={() => setDragLayerId(layer.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragLayerId || dragLayerId === layer.id) return
                  const ids = layers.map((l) => l.id)
                  const fromIdx = ids.indexOf(dragLayerId)
                  const toIdx = ids.indexOf(layer.id)
                  if (fromIdx < 0 || toIdx < 0) return
                  ids.splice(fromIdx, 1)
                  ids.splice(toIdx, 0, dragLayerId)
                  setDragLayerId(null)
                  onReorderLayers(ids)
                }}
                onClick={() => onSelectLayer(layer.id)}
                className={`flex items-center gap-2 px-2.5 py-2 cursor-pointer border-2 ${
                  isSelected
                    ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)] shadow-[2px_2px_0px_var(--accent-primary-shadow)]'
                    : 'bg-[var(--bg-elevated)] border-[var(--border-pixel)]'
                }`}
                data-testid={`layer-row-${layer.id}`}
              >
                {/* Selection marker square (not relying on color alone) */}
                <span
                  className={`w-2.5 h-2.5 border border-[var(--border-pixel)] shrink-0 ${
                    isSelected ? 'bg-[var(--accent-primary)]' : 'bg-transparent'
                  }`}
                  aria-hidden="true"
                />

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUpdateLayer(layer.id, { visible: !layer.visible })
                  }}
                  className="pixel-btn min-w-[36px] min-h-[36px] flex items-center justify-center shrink-0"
                  aria-label={layer.visible ? t('layerVisible') : t('layerHidden')}
                  data-testid={`layer-vis-${layer.id}`}
                >
                  <PixelIcon
                    name={layer.visible ? 'eye' : 'eyeOff'}
                    size={16}
                  />
                </button>

                {layer.clipping && (
                  <PixelIcon
                    name="clip"
                    size={14}
                    className="text-[var(--accent-primary)]"
                  />
                )}

                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold truncate">{layer.name}</div>
                  <div className="text-[10px] text-[var(--text-secondary)]">
                    {t(BLEND_LABEL_KEYS[layer.blendMode])} · {layer.opacity}%
                  </div>
                </div>

                <div
                  className="flex items-center gap-1 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    disabled={bottomUpIdx >= layers.length - 1}
                    onClick={() => moveLayerOrderByStep(layer.id, 1)}
                    title={t('moveUp')}
                    className="pixel-btn min-w-[34px] min-h-[34px] flex items-center justify-center"
                  >
                    <PixelIcon name="arrowUp" size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={bottomUpIdx <= 0}
                    onClick={() => moveLayerOrderByStep(layer.id, -1)}
                    title={t('moveDown')}
                    className="pixel-btn min-w-[34px] min-h-[34px] flex items-center justify-center"
                  >
                    <PixelIcon name="arrowDown" size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
