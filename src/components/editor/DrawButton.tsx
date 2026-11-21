import React, { useRef } from 'react'
import type { FloatingShapeState, ToolId, ToolSettings } from '../../types'
import type { MultiStepPhase } from '../../state/useEditorController'
import { PixelIcon } from '../common/PixelIcon'
import { useI18n } from '../../i18n/I18nContext'

interface DrawButtonProps {
  tool: ToolId
  toolSettings: ToolSettings
  stepPhase: MultiStepPhase
  floatingShape: FloatingShapeState | null
  isContinuousDrawing: boolean
  activeHexColor: string
  onBeginDraw: () => void
  onEndDraw: () => void
  onCancelStep: () => void
  onCommitShape: () => void
}

/**
 * Spec v2 Section 6:
 * Large, unmistakable Retro Pixel Draw / Push Button at the bottom of the Editor:
 * - Approx 14-16% of viewport height by default (customizable via --draw-btn-vh)
 * - Crisp pixel border + offset shadow + physical press sink (`data-holding`)
 * - Respects iPhone & Android safe-area-inset-bottom
 */
export function DrawButton({
  tool,
  toolSettings,
  stepPhase,
  floatingShape,
  isContinuousDrawing,
  activeHexColor,
  onBeginDraw,
  onEndDraw,
  onCancelStep,
  onCommitShape,
}: DrawButtonProps) {
  const { t } = useI18n()
  const heldPointerIdRef = useRef<number | null>(null)

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignore synthetic event capture errors
      }
    }
    heldPointerIdRef.current = e.pointerId
    if (floatingShape) {
      onCommitShape()
      return
    }
    onBeginDraw()
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (heldPointerIdRef.current === e.pointerId) {
      heldPointerIdRef.current = null
      onEndDraw()
    }
  }

  let primaryLabel = t('draw')
  let subHint = ''

  if (floatingShape) {
    primaryLabel = t('commitTransform')
  } else if (tool === 'pen' || tool === 'eraser') {
    subHint = t('drawHold')
  } else if (tool === 'fill' && toolSettings.fillMode === 'gradient') {
    primaryLabel =
      stepPhase.kind === 'gradient-end' ? t('drawEndPoint') : t('drawStartPoint')
  } else if (tool === 'line') {
    if (toolSettings.lineType === 'line') {
      primaryLabel =
        stepPhase.kind === 'line-end' ? t('drawEndPoint') : t('drawStartPoint')
    } else {
      if (stepPhase.kind === 'idle') primaryLabel = `${t('drawStartPoint')} (P0)`
      else if (stepPhase.kind === 'bezier-p3') primaryLabel = `${t('drawEndPoint')} (P3)`
      else if (stepPhase.kind === 'bezier-p1') primaryLabel = t('drawControl1')
      else if (stepPhase.kind === 'bezier-p2') primaryLabel = t('drawControl2')
    }
  } else if (tool === 'shape') {
    primaryLabel =
      stepPhase.kind === 'shape-end' ? t('drawShapePlace') : t('drawStartPoint')
  } else if (tool === 'select' && toolSettings.selectType !== 'wand') {
    primaryLabel =
      stepPhase.kind === 'select-end' ? t('drawEndPoint') : t('drawStartPoint')
  }

  const showAbort = stepPhase.kind !== 'idle' || floatingShape !== null

  return (
    <div
      style={{ gap: 'var(--ui-gap, 6px)' }}
      className="flex items-stretch px-2.5 pt-1.5 pb-3 pb-safe bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
    >
      {showAbort && (
        <button
          type="button"
          onClick={onCancelStep}
          className="pixel-btn pixel-btn-danger min-w-[68px] px-3 flex flex-col items-center justify-center gap-1 text-xs font-bold shrink-0"
          data-testid="cancel-step-btn"
        >
          <PixelIcon name="close" size={18} />
          <span>{floatingShape ? t('discardTransform') : t('cancelStep')}</span>
        </button>
      )}

      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        data-holding={isContinuousDrawing ? 'true' : 'false'}
        style={{
          touchAction: 'none',
          height: 'clamp(64px, var(--draw-btn-vh, 15dvh), 136px)',
        }}
        className={`flex-1 w-full flex items-center justify-center gap-3 select-none ${
          floatingShape ? 'pixel-draw-btn pixel-draw-btn-confirm' : 'pixel-draw-btn'
        }`}
        data-testid="draw-button"
      >
        {floatingShape ? (
          <PixelIcon name="check" size={24} />
        ) : (
          <span
            className="w-5 h-5 border-2 border-[var(--accent-primary-fg)] shrink-0"
            style={{
              backgroundColor:
                tool === 'eraser' ? 'var(--bg-surface)' : activeHexColor,
            }}
          />
        )}
        <div className="flex flex-col items-center leading-tight">
          <span className="text-xl sm:text-2xl font-bold tracking-widest">
            {primaryLabel}
          </span>
          {subHint && (
            <span className="text-[11px] opacity-85 mt-0.5">{subHint}</span>
          )}
        </div>
      </button>
    </div>
  )
}
