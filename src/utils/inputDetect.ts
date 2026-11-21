export type InputModality = 'touch' | 'mouse'

/**
 * Detect initial input modality using Pointer Media Queries & device capabilities
 * rather than relying solely on User-Agent strings (Section 2-1).
 * Dynamically switches at runtime when actual PointerEvents arrive on hybrid touch+mouse devices.
 */
export function detectInitialInputModality(): InputModality {
  if (typeof window === 'undefined') return 'mouse'

  const coarseQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)')
      : null
  const fineQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(any-pointer: fine)')
      : null

  // Pure coarse pointer (smartphones / tablets without mouse)
  if (coarseQuery?.matches && !fineQuery?.matches) {
    return 'touch'
  }

  // Narrow mobile viewport with touch points (e.g. mobile emulation or handheld)
  if (navigator.maxTouchPoints > 0 && window.innerWidth < 768) {
    return 'touch'
  }

  return 'mouse'
}

export function modalityFromPointerType(pointerType: string): InputModality {
  if (pointerType === 'touch') return 'touch'
  // Stylus ('pen') or 'mouse' operates directly at pointer location unless user uses touch
  return 'mouse'
}
