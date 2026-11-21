import type { DitherPatternId, GradientSteps } from '../types'

export interface DitherPatternDefinition {
  id: DitherPatternId
  density: number // percentage 12.5 - 100
  width: number
  height: number
  rows: readonly string[]
  mask: ReadonlyArray<ReadonlyArray<boolean>>
}

function buildPattern(
  id: DitherPatternId,
  density: number,
  rows: readonly string[]
): DitherPatternDefinition {
  const height = rows.length
  const width = rows[0].length
  const mask = rows.map((row) => {
    if (row.length !== width) {
      throw new Error(`Invalid dither mask row width in pattern ${id}`)
    }
    return Array.from(row).map((ch) => ch === '#')
  })
  return { id, density, width, height, rows, mask }
}

/**
 * Exact 8 dithering patterns as specified in Section 16:
 * '#' = draw with selected color
 * '.' = do not draw (keep existing pixel untouched)
 * Anchor is always fixed to canvas top-left (0, 0).
 */
export const DITHER_PATTERNS: Record<DitherPatternId, DitherPatternDefinition> = {
  // Pattern 1: Solid (100%)
  1: buildPattern(1, 100, ['#']),

  // Pattern 2: High density (87.5%) 4x4
  2: buildPattern(2, 87.5, [
    '#.##',
    '####',
    '###.',
    '####',
  ]),

  // Pattern 3: High density (75%) 2x2
  3: buildPattern(3, 75, [
    '#.',
    '##',
  ]),

  // Pattern 4: Medium-high density (62.5%) 4x4
  4: buildPattern(4, 62.5, [
    '#.#.',
    '##.#',
    '#.#.',
    '.###',
  ]),

  // Pattern 5: Medium density checkerboard (50%) 2x2
  5: buildPattern(5, 50, [
    '#.',
    '.#',
  ]),

  // Pattern 6: Low density (37.5%) 4x4
  6: buildPattern(6, 37.5, [
    '#.#.',
    '...#',
    '#.#.',
    '.#..',
  ]),

  // Pattern 7: Low density (25%) 2x2
  7: buildPattern(7, 25, [
    '#.',
    '..',
  ]),

  // Pattern 8: Lowest density (12.5%) 4x4
  8: buildPattern(8, 12.5, [
    '#...',
    '....',
    '..#.',
    '....',
  ]),
}

export const ALL_DITHER_PATTERN_IDS: readonly DitherPatternId[] = [1, 2, 3, 4, 5, 6, 7, 8]

/**
 * Gradient dithering step pattern sequences (Section 4-3):
 * - 4-step gradient uses patterns 1, 4, 6, 8 (highest density at start -> lowest at end)
 * - 8-step gradient uses patterns 1..8 (highest density at start -> lowest at end)
 */
export const GRADIENT_PATTERN_STEPS: Record<GradientSteps, readonly DitherPatternId[]> = {
  4: [1, 4, 6, 8],
  8: [1, 2, 3, 4, 5, 6, 7, 8],
}

/**
 * Positive modulo so even negative coordinates wrap cleanly relative to (0, 0).
 */
function posMod(n: number, m: number): number {
  return ((Math.trunc(n) % m) + m) % m
}

/**
 * Determine whether pixel at canvas coordinate (x, y) should be painted for patternId.
 * Always anchored to canvas top-left (0, 0).
 */
export function shouldDrawWithDither(
  patternId: DitherPatternId,
  x: number,
  y: number
): boolean {
  if (patternId === 1) return true
  const def = DITHER_PATTERNS[patternId]
  const mx = posMod(x, def.width)
  const my = posMod(y, def.height)
  return def.mask[my][mx]
}
