import React, { useCallback, useEffect, useRef, useState } from 'react'

export interface UseLongPressReorderOptions {
  ids: readonly string[]
  enabled?: boolean
  longPressMs?: number
  onReorder: (nextIds: string[]) => void
  scrollContainerRef?: React.RefObject<HTMLElement | null>
}

export interface LongPressDragState {
  draggingId: string
  overId: string
}

/**
 * Shared Long-Press & Drag Reorder Hook (Sections 11 & 19)
 * - Short tap (< `longPressMs` and small movement) does NOT trigger drag so normal click/tap works reliably!
 * - Holding `longPressMs` (default 260ms) enters reorder drag mode on touch/pen; mouse also supports immediate HTML5 drag or pointer hold.
 * - Live insertion indicator via `dragState.overId`, auto-scroll near container/window edges, and clean commit on pointer release.
 */
export function useLongPressReorder({
  ids,
  enabled = true,
  longPressMs = 260,
  onReorder,
  scrollContainerRef,
}: UseLongPressReorderOptions) {
  const [dragState, setDragState] = useState<LongPressDragState | null>(null)
  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const suppressClickRef = useRef(false)
  const idsRef = useRef(ids)
  idsRef.current = ids

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => clearPendingTimer()
  }, [clearPendingTimer])

  useEffect(() => {
    if (!dragState) return

    const handleGlobalMove = (e: PointerEvent) => {
      e.preventDefault()

      // Auto-scroll container or window near edges
      const scroller = scrollContainerRef?.current
      if (scroller) {
        const rect = scroller.getBoundingClientRect()
        const edge = 44
        if (e.clientY < rect.top + edge) {
          scroller.scrollTop -= 8
        } else if (e.clientY > rect.bottom - edge) {
          scroller.scrollTop += 8
        }
      } else {
        const edge = 56
        if (e.clientY < edge) {
          window.scrollBy(0, -10)
        } else if (e.clientY > window.innerHeight - edge) {
          window.scrollBy(0, 10)
        }
      }

      if (typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(e.clientX, e.clientY)
        const itemEl = hit?.closest('[data-reorder-id]') as HTMLElement | null
        const targetId = itemEl?.dataset.reorderId
        if (targetId && idsRef.current.includes(targetId)) {
          setDragState((prev) =>
            prev && prev.overId !== targetId
              ? { ...prev, overId: targetId }
              : prev
          )
        }
      }
    }

    const finishDrag = () => {
      setDragState((curr) => {
        if (curr && curr.draggingId !== curr.overId) {
          const list = [...idsRef.current]
          const from = list.indexOf(curr.draggingId)
          const to = list.indexOf(curr.overId)
          if (from >= 0 && to >= 0) {
            list.splice(from, 1)
            list.splice(to, 0, curr.draggingId)
            onReorder(list)
          }
        }
        return null
      })
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 60)
    }

    window.addEventListener('pointermove', handleGlobalMove, { passive: false })
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', handleGlobalMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [dragState, onReorder, scrollContainerRef])

  const getItemProps = useCallback(
    (id: string) => {
      if (!enabled) {
        return { 'data-reorder-id': id }
      }

      return {
        'data-reorder-id': id,
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.effectAllowed = 'move'
          setDragState({ draggingId: id, overId: id })
        },
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault()
          setDragState((prev) =>
            prev && prev.overId !== id ? { ...prev, overId: id } : prev
          )
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          setDragState((curr) => {
            if (curr && curr.draggingId !== id) {
              const list = [...idsRef.current]
              const from = list.indexOf(curr.draggingId)
              const to = list.indexOf(id)
              if (from >= 0 && to >= 0) {
                list.splice(from, 1)
                list.splice(to, 0, curr.draggingId)
                onReorder(list)
              }
            }
            return null
          })
        },
        onDragEnd: () => {
          setDragState(null)
        },
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          // Ignore presses originating inside nested action buttons
          const target = e.target as HTMLElement | null
          if (target?.closest('[data-no-reorder="true"]')) return

          clearPendingTimer()
          pendingRef.current = {
            id,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
          }

          if (e.pointerType !== 'mouse') {
            timerRef.current = window.setTimeout(() => {
              timerRef.current = null
              suppressClickRef.current = true
              setDragState({ draggingId: id, overId: id })
            }, longPressMs)
          }
        },
        onPointerMove: (e: React.PointerEvent) => {
          const p = pendingRef.current
          if (!p || p.pointerId !== e.pointerId) return
          const dist = Math.hypot(e.clientX - p.startX, e.clientY - p.startY)
          // Cancel pending long-press if user started scrolling before threshold
          if (dist > 10 && timerRef.current !== null) {
            clearPendingTimer()
            pendingRef.current = null
          }
        },
        onPointerUp: () => {
          clearPendingTimer()
          pendingRef.current = null
        },
        onPointerCancel: () => {
          clearPendingTimer()
          pendingRef.current = null
        },
      }
    },
    [clearPendingTimer, enabled, longPressMs, onReorder]
  )

  const shouldSuppressClick = useCallback(() => {
    return suppressClickRef.current || dragState !== null
  }, [dragState])

  return {
    dragState,
    getItemProps,
    shouldSuppressClick,
  }
}
