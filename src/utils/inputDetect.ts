export type InputModality = 'touch' | 'mouse'

/**
 * Detect initial input modality using Pointer Media Queries & device capabilities
 * rather than relying solely on User-Agent strings (Section 2-1 & 3-1).
 * - On real PC browsers (`(any-pointer: fine)` matches and `(pointer: coarse)` does NOT match), returns `'mouse'`
 *   so the Draw button & virtual cursor are hidden immediately.
 * - On smartphones / tablets / headless environments without fine pointer media queries, defaults to `'touch'`
 *   (thumb-first mode with Draw button).
 * - Dynamically switches at runtime whenever actual PointerEvents (`'mouse'` vs `'touch'`) arrive!
 */
export function detectInitialInputModality(): InputModality {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'touch'
  }

  const coarseQuery = window.matchMedia('(pointer: coarse)')
  const fineQuery = window.matchMedia('(any-pointer: fine)')

  if (coarseQuery.matches && !fineQuery.matches) {
    return 'touch'
  }

  if (navigator.maxTouchPoints > 0 && window.innerWidth < 768) {
    return 'touch'
  }

  if (fineQuery.matches && !coarseQuery.matches) {
    return 'mouse'
  }

  return 'touch'
}

export function modalityFromPointerType(pointerType: string): InputModality {
  if (pointerType === 'touch') return 'touch'
  return 'mouse'
}
