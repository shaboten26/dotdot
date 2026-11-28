import React, { useRef } from 'react'
import { motion } from 'motion/react'
import type {
  ActiveMoveSession,
  FloatingShapeState,
  ToolId,
  ToolSettings,
} from '../../types'
import type { MultiStepPhase } from '../../state/useEditorController'
import { PixelIcon } from '../common/PixelIcon'
import { getCheckerboardStyle } from '../common/PixelThumbnail'
import { useApp } from '../../state/AppContext'
import { useI18n } from '../../i18n/I18nContext'

interface DrawButtonProps {
  tool: ToolId
  toolSettings: ToolSettings
  stepPhase: MultiStepPhase
  floatingShape: FloatingShapeState | null
  moveSession: ActiveMoveSession | null
  isContinuousDrawing: boolean
  activeHexColor: string
  isTransparentColor?: boolean
  checkerDark?: boolean
  onBeginDraw: () => void
  onEndDraw: () => void
  onCancelStep: () => void
  onCommitShape: () => void
  onCommitMove: () => void
}

/**
 * Large, Flat Retro Pixel Draw / Push Button at the bottom of the Editor:
 * - Zero shadows; press state shown via flat border shift & color feedback
 * - Shows transparent checkerboard + slash icon when Transparent Color Slot is active
 * - Cancel / Abort button is placed on the RIGHTMOST edge with spacing to prevent mis-taps
 * - Respects iPhone & Android safe-area-inset-bottom
 */
export function DrawButton({
  tool,
  toolSettings,
  stepPhase,
  floatingShape,
  moveSession,
  isContinuousDrawing,
  activeHexColor,
  isTransparentColor = false,
  checkerDark = false,
  onBeginDraw,
  onEndDraw,
  onCancelStep,
  onCommitShape,
  onCommitMove,
}: DrawButtonProps) {
  const { t } = useI18n()
  const { reducedMotion } = useApp()
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
    if (moveSession) {
      onCommitMove()
      return
    }
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

  if (moveSession) {
    primaryLabel = t('commitMoveBtn')
  } else if (floatingShape) {
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

  const isConfirmState = floatingShape !== null || moveSession !== null
  const showAbort =
    stepPhase.kind !== 'idle' || floatingShape !== null || moveSession !== null
  const showTransparentSwatch = tool === 'eraser' || isTransparentColor

  return (
    <div
      style={{ gap: 'max(8px, var(--ui-gap, 6px))' }}
      className="flex items-stretch px-2.5 pt-1.5 pb-3 pb-safe bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
    >
      <motion.button
        type="button"
        whileTap={reducedMotion ? undefined : { y: 2 }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        data-holding={isContinuousDrawing ? 'true' : 'false'}
        style={{
          touchAction: 'none',
          height: 'clamp(44px, var(--draw-btn-vh, 12dvh), 136px)',
        }}
        className={`flex-1 w-full flex items-center justify-center gap-3 select-none ${
          isConfirmState ? 'pixel-draw-btn pixel-draw-btn-confirm' : 'pixel-draw-btn'
        }`}
        data-testid="draw-button"
      >
        {isConfirmState ? (
          <PixelIcon name="check" size={22} />
        ) : showTransparentSwatch ? (
          <span
            className="w-5 h-5 border-2 border-[var(--accent-primary-fg)] shrink-0 flex items-center justify-center"
            style={getCheckerboardStyle(checkerDark, 6)}
          >
            <PixelIcon
              name="transparent"
              size={13}
              className="text-[var(--accent-rose)]"
            />
          </span>
        ) : (
          <span
            className="w-5 h-5 border-2 border-[var(--accent-primary-fg)] shrink-0"
            style={{ backgroundColor: activeHexColor }}
          />
        )}
        <div className="flex flex-col items-center leading-tight">
          <span className="text-xl sm:text-2xl font-bold tracking-widest">
            {primaryLabel}
          </span>
          {subHint && (
            <span className="text-[11px] opacity-90 mt-0.5">{subHint}</span>
          )}
        </div>
      </motion.button>

      {/* Cancel / Discard uncommitted preview placed at RIGHTMOST edge */}
      {showAbort && (
        <button
          type="button"
          onClick={onCancelStep}
          className="pixel-btn pixel-btn-danger min-w-[74px] px-3 flex flex-col items-center justify-center gap-1 text-xs font-bold shrink-0"
          data-testid="cancel-step-btn"
        >
          <PixelIcon name="close" size={16} />
          <span>
            {moveSession
              ? t('cancelMoveBtn')
              : floatingShape
                ? t('discardTransform')
                : t('cancelStep')}
          </span>
        </button>
      )}
    </div>
  )
}
