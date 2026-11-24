import { normalizeHex } from '../engine/color'

export type LospecApplyMode = 'replace' | 'append'

export type LospecErrorCode =
  | 'EMPTY_INPUT'
  | 'INVALID_SLUG'
  | 'OFFLINE'
  | 'NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'

export class LospecFetchError extends Error {
  readonly code: LospecErrorCode

  constructor(code: LospecErrorCode, message: string) {
    super(message)
    this.name = 'LospecFetchError'
    this.code = code
  }
}

export interface LospecFetchedPalette {
  slug: string
  name: string
  author: string
  colors: string[] // #RRGGBB uppercase, 1..256
  sourceUrl: string
  truncated: boolean
  originalColorCount: number
}

/**
 * Extract a canonical Lospec palette slug from either:
 * - A full or partial Lospec URL (`https://lospec.com/palette-list/pico-8`, `lospec.com/palette-list/oil-6.json`, etc.)
 * - A raw slug or palette name (`pico-8`, `Sweetie 16` -> `sweetie-16`)
 */
export function parseLospecInputToSlug(rawInput: string): string {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    throw new LospecFetchError('EMPTY_INPUT', 'Lospec URL or slug is empty')
  }

  let candidate = trimmed

  // Handle full or protocol-less Lospec URLs
  if (/^(https?:\/\/)?(www\.)?lospec\.com\//i.test(candidate)) {
    const withProto = /^https?:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`
    try {
      const parsed = new URL(withProto)
      const segments = parsed.pathname.split('/').filter(Boolean)
      const listIdx = segments.findIndex(
        (s) => s.toLowerCase() === 'palette-list'
      )
      if (listIdx >= 0 && segments[listIdx + 1]) {
        candidate = decodeURIComponent(segments[listIdx + 1]!)
      } else if (segments.length > 0) {
        candidate = decodeURIComponent(segments[segments.length - 1]!)
      } else {
        throw new LospecFetchError('INVALID_SLUG', 'Missing palette slug in URL')
      }
    } catch (err) {
      if (err instanceof LospecFetchError) throw err
      throw new LospecFetchError('INVALID_SLUG', 'Malformed Lospec URL')
    }
  }

  // Strip optional `.json`, `.pal`, `.png`, `.hex` extensions or query/hash fragments
  candidate = candidate
    .split(/[?#]/)[0]!
    .replace(/\.(json|pal|png|hex|gpl|ase)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(candidate)) {
    throw new LospecFetchError('INVALID_SLUG', `Invalid Lospec slug: ${candidate}`)
  }

  return candidate
}

export function buildLospecApiUrl(slug: string): string {
  return `https://lospec.com/palette-list/${encodeURIComponent(slug)}.json`
}

export function buildLospecPageUrl(slug: string): string {
  return `https://lospec.com/palette-list/${encodeURIComponent(slug)}`
}

export interface FetchLospecOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Fetch a palette from the official Lospec JSON endpoint (`https://lospec.com/palette-list/<slug>.json`),
 * normalizing hex colors to `#RRGGBB` and enforcing the 256-color studio limit.
 */
export async function fetchLospecPalette(
  rawInput: string,
  options?: FetchLospecOptions
): Promise<LospecFetchedPalette> {
  const slug = parseLospecInputToSlug(rawInput)

  if (
    typeof navigator !== 'undefined' &&
    'onLine' in navigator &&
    navigator.onLine === false
  ) {
    throw new LospecFetchError(
      'OFFLINE',
      'Device is offline; cannot fetch palette from Lospec'
    )
  }

  const fetchFn = options?.fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new LospecFetchError('NETWORK_ERROR', 'Fetch API is unavailable')
  }

  const apiUrl = buildLospecApiUrl(slug)
  let response: Response
  try {
    response = await fetchFn(apiUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw err
    }
    throw new LospecFetchError(
      'NETWORK_ERROR',
      'Failed to reach Lospec API'
    )
  }

  if (response.status === 404) {
    throw new LospecFetchError(
      'NOT_FOUND',
      `Lospec palette "${slug}" was not found`
    )
  }
  if (!response.ok) {
    throw new LospecFetchError(
      'NETWORK_ERROR',
      `Lospec API returned HTTP ${response.status}`
    )
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new LospecFetchError(
      'INVALID_RESPONSE',
      'Lospec response is not valid JSON'
    )
  }

  if (!json || typeof json !== 'object') {
    throw new LospecFetchError(
      'INVALID_RESPONSE',
      'Unexpected Lospec JSON payload'
    )
  }

  const record = json as {
    name?: unknown
    author?: unknown
    colors?: unknown
    error?: unknown
  }

  if (typeof record.error === 'string' && record.error) {
    throw new LospecFetchError('NOT_FOUND', record.error)
  }

  if (!Array.isArray(record.colors) || record.colors.length === 0) {
    throw new LospecFetchError(
      'INVALID_RESPONSE',
      'Lospec palette contains no colors'
    )
  }

  const normalizedAll: string[] = []
  for (const rawHex of record.colors) {
    if (typeof rawHex !== 'string') continue
    const clean = rawHex.trim().startsWith('#')
      ? rawHex.trim()
      : `#${rawHex.trim()}`
    const norm = normalizeHex(clean)
    if (norm) {
      normalizedAll.push(norm)
    }
  }

  if (normalizedAll.length === 0) {
    throw new LospecFetchError(
      'INVALID_RESPONSE',
      'No valid RGB hex colors found in Lospec palette'
    )
  }

  const originalColorCount = normalizedAll.length
  const truncated = originalColorCount > 256
  const colors = normalizedAll.slice(0, 256)
  const name =
    typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : slug
  const author =
    typeof record.author === 'string' && record.author.trim()
      ? record.author.trim()
      : ''

  return {
    slug,
    name,
    author,
    colors,
    sourceUrl: buildLospecPageUrl(slug),
    truncated,
    originalColorCount,
  }
}

/**
 * Apply an imported Lospec color list onto an existing palette in either `'replace'` or `'append'` mode
 * while strictly respecting the 256-color maximum.
 */
export function mergeLospecPaletteColors(
  existingColors: readonly string[],
  incomingColors: readonly string[],
  mode: LospecApplyMode
): { colors: string[]; truncated: boolean } {
  if (mode === 'replace') {
    const sliced = incomingColors.slice(0, 256)
    return {
      colors: sliced.length > 0 ? [...sliced] : ['#000000'],
      truncated: incomingColors.length > 256,
    }
  }

  const combined = [...existingColors, ...incomingColors]
  return {
    colors: combined.slice(0, 256),
    truncated: combined.length > 256,
  }
}
