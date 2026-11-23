import React, { useCallback, useEffect, useRef, useState } from 'react'

export interface UseLongPressReorderOptions {
  ids: readonly string[]
  enabled?: boolean
  /** Hold threshold in ms for touch on scrollable body (drag handles start immediately) */
  longPressMs?: number
  /** Movement threshold in px for mouse / immediate-touch drag activation */
  dragThresholdPx?: number
  /** If true, touch starts dragging as soon as pointer moves along primary axis (for non-scrolling / orthogonal strips) */
  immediateTouchDrag?: boolean
  axis?: 'vertical' | 'horizontal' | 'both'
  /** Optional custom attribute name to resolve drop targets when multiple lists coexist */
  scopeId?: string
  onReorder: (nextIds: string[]) => void
  scrollContainerRef?: React.RefObject<HTMLElement | null>
}

export interface LongPressDragState {
  draggingId: string
  overId: string
}

/**
 * Unified Pointer-Event Reorder Hook for PC Mouse & Smartphone Touch (Section 4-3)
 * - PC Mouse (`pointerType === 'mouse'`): NO long-press required! Starts dragging naturally as soon as pointer moves >= `dragThresholdPx` (default 5px). Stationary click fires normal click / double-click cleanly.
 * - Drag Handle (`[data-drag-handle="true"]`): Starts dragging immediately on move (both mouse and touch, zero hold delay).
 * - Touch on scrollable item body: Distinguishes scroll vs drag via responsive hold (`longPressMs`, default 150ms) OR immediate drag when `immediateTouchDrag` is enabled.
 * - Uses `setPointerCapture` + global pointer listeners + `document.elementFromPoint` so dragging stays smooth even outside item bounds, auto-scrolls vertical/horizontal containers, clearly exposes `draggingId` & `overId`, and rolls back cleanly on `pointercancel` or `Escape`.
 */
export function useLongPressReorder({
  ids,
  enabled = true,
  longPressMs = 150,
  dragThresholdPx = 5,
  immediateTouchDrag = false,
  axis = 'vertical',
  scopeId = 'default',
  onReorder,
  scrollContainerRef,
}: UseLongPressReorderOptions) {
  const [dragState, setDragState] = useState<LongPressDragState | null>(null)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<{
    id: string
    pointerId: number
    pointerType: string
    fromHandle: boolean
    startX: number
    startY: number
    captureTarget: Element | null
  } | null>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)
  const idsRef = useRef(ids)
  idsRef.current = ids
  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => clearPendingTimer()
  }, [clearPendingTimer])

  const activateDrag = useCallback(
    (id: string, pointerId: number, captureTarget: Element | null) => {
      clearPendingTimer()
      pendingRef.current = null
      activePointerIdRef.current = pointerId
      suppressClickRef.current = true
      if (
        captureTarget &&
        typeof (captureTarget as HTMLElement).setPointerCapture === 'function'
      ) {
        try {
          ;(captureTarget as HTMLElement).setPointerCapture(pointerId)
        } catch {
          // ignore synthetic event capture failures in jsdom
        }
      }
      setDragState({ draggingId: id, overId: id })
    },
    [clearPendingTimer]
  )

  useEffect(() => {
    if (!dragState) return

    const resolveTargetIdAt = (clientX: number, clientY: number): string | null => {
      if (typeof document.elementFromPoint !== 'function') return null
      const hit = document.elementFromPoint(clientX, clientY)
      if (!hit) return null
      const itemEl = hit.closest(
        `[data-reorder-id][data-reorder-scope="${scopeId}"]`
      ) as HTMLElement | null
      const fallbackEl =
        itemEl ?? (hit.closest('[data-reorder-id]') as HTMLElement | null)
      const targetId = fallbackEl?.dataset.reorderId ?? null
      if (targetId && idsRef.current.includes(targetId)) {
        return targetId
      }
      return null
    }

    const handleGlobalMove = (e: PointerEvent) => {
      if (
        activePointerIdRef.current !== null &&
        e.pointerId !== activePointerIdRef.current
      ) {
        return
      }
      if (e.cancelable) {
        e.preventDefault()
      }

      const scroller = scrollContainerRef?.current
      if (scroller) {
        const rect = scroller.getBoundingClientRect()
        const edge = 40
        if (axis === 'vertical' || axis === 'both') {
          if (e.clientY < rect.top + edge) {
            scroller.scrollTop -= 10
          } else if (e.clientY > rect.bottom - edge) {
            scroller.scrollTop += 10
          }
        }
        if (axis === 'horizontal' || axis === 'both') {
          if (e.clientX < rect.left + edge) {
            scroller.scrollLeft -= 10
          } else if (e.clientX > rect.right - edge) {
            scroller.scrollLeft += 10
          }
        }
      } else if (axis === 'vertical' || axis === 'both') {
        const edge = 52
        if (e.clientY < edge) {
          window.scrollBy(0, -10)
        } else if (e.clientY > window.innerHeight - edge) {
          window.scrollBy(0, 10)
        }
      }

      const targetId = resolveTargetIdAt(e.clientX, e.clientY)
      if (targetId) {
        setDragState((prev) =>
          prev && prev.overId !== targetId ? { ...prev, overId: targetId } : prev
        )
      }
    }

    const finishDrag = (e: PointerEvent, cancelled: boolean) => {
      if (
        activePointerIdRef.current !== null &&
        e.pointerId !== activePointerIdRef.current
      ) {
        return
      }
      activePointerIdRef.current = null

      // Also check final drop point on pointerup in case tests dispatch pointerup directly on target coordinates
      const finalHoverId = !cancelled
        ? resolveTargetIdAt(e.clientX, e.clientY)
        : null

      setDragState((curr) => {
        if (!cancelled && curr) {
          const effectiveOverId = finalHoverId ?? curr.overId
          if (curr.draggingId !== effectiveOverId) {
            const list = [...idsRef.current]
            const from = list.indexOf(curr.draggingId)
            const to = list.indexOf(effectiveOverId)
            if (from >= 0 && to >= 0) {
              list.splice(from, 1)
              list.splice(to, 0, curr.draggingId)
              onReorderRef.current(list)
            }
          }
        }
        return null
      })

      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 80)
    }

    const onUp = (e: PointerEvent) => finishDrag(e, false)
    const onCancel = (e: PointerEvent) => finishDrag(e, true)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        activePointerIdRef.current = null
        setDragState(null)
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 80)
      }
    }

    window.addEventListener('pointermove', handleGlobalMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', handleGlobalMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [axis, dragState, scopeId, scrollContainerRef])

  const getItemProps = useCallback(
    (id: string) => {
      if (!enabled) {
        return {
          'data-reorder-id': id,
          'data-reorder-scope': scopeId,
        }
      }

      return {
        'data-reorder-id': id,
        'data-reorder-scope': scopeId,
        onDragStart: (e: React.DragEvent) => {
          // Prevent native browser ghost-image HTML5 drag from hijacking Pointer Event dragging
          e.preventDefault()
        },
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          const target = e.target as HTMLElement | null
          if (target?.closest('[data-no-reorder="true"]')) return
          if (
            target &&
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
          ) {
            return
          }

          const fromHandle = Boolean(target?.closest('[data-drag-handle="true"]'))
          clearPendingTimer()
          pendingRef.current = {
            id,
            pointerId: e.pointerId,
            pointerType: e.pointerType || 'mouse',
            fromHandle,
            startX: e.clientX,
            startY: e.clientY,
            captureTarget: e.currentTarget,
          }

          if (fromHandle) {
            // Dedicated handle: enter drag immediately with zero delay
            e.stopPropagation()
            activateDrag(id, e.pointerId, e.currentTarget)
            return
          }

          if (e.pointerType === 'touch' && !immediateTouchDrag) {
            const capturedTarget = e.currentTarget
            const pId = e.pointerId
            timerRef.current = window.setTimeout(() => {
              timerRef.current = null
              if (pendingRef.current && pendingRef.current.pointerId === pId) {
                activateDrag(id, pId, capturedTarget)
              }
            }, longPressMs)
          }
        },
        onPointerMove: (e: React.PointerEvent) => {
          const p = pendingRef.current
          if (!p || p.pointerId !== e.pointerId) return

          const dx = e.clientX - p.startX
          const dy = e.clientY - p.startY
          const dist = Math.hypot(dx, dy)

          if (p.pointerType === 'mouse' || p.pointerType === 'pen' || immediateTouchDrag) {
            if (dist >= dragThresholdPx) {
              if (
                immediateTouchDrag &&
                p.pointerType === 'touch' &&
                axis !== 'both'
              ) {
                // If orthogonal movement dominates, let the container scroll naturally
                const primaryDelta = axis === 'horizontal' ? Math.abs(dx) : Math.abs(dy)
                const crossDelta = axis === 'horizontal' ? Math.abs(dy) : Math.abs(dx)
                if (crossDelta > primaryDelta * 1.25) {
                  clearPendingTimer()
                  pendingRef.current = null
                  return
                }
              }
              activateDrag(p.id, p.pointerId, p.captureTarget)
            }
            return
          }

          // Touch with hold timer: cancel pending drag if user started scrolling container before hold completes
          if (dist > 9 && timerRef.current !== null) {
            clearPendingTimer()
            pendingRef.current = null
          }
        },
        onPointerUp: (e: React.PointerEvent) => {
          if (pendingRef.current?.pointerId === e.pointerId) {
            clearPendingTimer()
            pendingRef.current = null
          }
        },
        onPointerCancel: (e: React.PointerEvent) => {
          if (pendingRef.current?.pointerId === e.pointerId) {
            clearPendingTimer()
            pendingRef.current = null
          }
        },
      }
    },
    [
      activateDrag,
      axis,
      clearPendingTimer,
      dragThresholdPx,
      enabled,
      immediateTouchDrag,
      longPressMs,
      scopeId,
    ]
  )

  const getHandleProps = useCallback(
    () => ({
      'data-drag-handle': 'true',
      style: { touchAction: 'none' } as React.CSSProperties,
    }),
    []
  )

  const shouldSuppressClick = useCallback(() => {
    return suppressClickRef.current || dragState !== null
  }, [dragState])

  return {
    dragState,
    getItemProps,
    getHandleProps,
    shouldSuppressClick,
  }
}
