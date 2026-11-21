import type { HSV, RGBA } from '../types'

export function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const clean = hex.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = parseInt(clean[0] + clean[0], 16)
    const g = parseInt(clean[1] + clean[1], 16)
    const b = parseInt(clean[2] + clean[2], 16)
    return { r, g, b, a: clampByte(alpha) }
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16)
    const g = parseInt(clean.slice(2, 4), 16)
    const b = parseInt(clean.slice(4, 6), 16)
    return { r, g, b, a: clampByte(alpha) }
  }
  if (/^[0-9a-fA-F]{8}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16)
    const g = parseInt(clean.slice(2, 4), 16)
    const b = parseInt(clean.slice(4, 6), 16)
    const a = parseInt(clean.slice(6, 8), 16)
    return { r, g, b, a }
  }
  return { r: 0, g: 0, b: 0, a: clampByte(alpha) }
}

export function rgbaToHex(rgba: Pick<RGBA, 'r' | 'g' | 'b'>): string {
  const to2 = (n: number) => clampByte(n).toString(16).padStart(2, '0').toUpperCase()
  return `#${to2(rgba.r)}${to2(rgba.g)}${to2(rgba.b)}`
}

export function normalizeHex(input: string): string | null {
  const clean = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return `#${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`.toUpperCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`
  }
  return null
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  const rn = clampByte(r) / 255
  const gn = clampByte(g) / 255
  const bn = clampByte(b) / 255

  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min

  let h = 0
  if (d !== 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / d) % 6)
    } else if (max === gn) {
      h = 60 * ((bn - rn) / d + 2)
    } else {
      h = 60 * ((rn - gn) / d + 4)
    }
  }
  if (h < 0) h += 360

  const s = max === 0 ? 0 : (d / max) * 100
  const v = max * 100

  return {
    h: Math.round(h) % 360,
    s: Math.round(s),
    v: Math.round(v),
  }
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hn = ((h % 360) + 360) % 360
  const sn = Math.max(0, Math.min(100, s)) / 100
  const vn = Math.max(0, Math.min(100, v)) / 100

  const c = vn * sn
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1))
  const m = vn - c

  let r1 = 0
  let g1 = 0
  let b1 = 0

  if (hn < 60) {
    r1 = c
    g1 = x
  } else if (hn < 120) {
    r1 = x
    g1 = c
  } else if (hn < 180) {
    g1 = c
    b1 = x
  } else if (hn < 240) {
    g1 = x
    b1 = c
  } else if (hn < 300) {
    r1 = x
    b1 = c
  } else {
    r1 = c
    b1 = x
  }

  return {
    r: clampByte((r1 + m) * 255),
    g: clampByte((g1 + m) * 255),
    b: clampByte((b1 + m) * 255),
  }
}

export function hsvToHex(h: number, s: number, v: number): string {
  return rgbaToHex(hsvToRgb(h, s, v))
}

export function hexToHsv(hex: string): HSV {
  const { r, g, b } = hexToRgba(hex)
  return rgbToHsv(r, g, b)
}

export function rgbaEquals(a: RGBA, b: RGBA): boolean {
  if (a.a === 0 && b.a === 0) return true
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
}

export const TRANSPARENT_RGBA: RGBA = { r: 0, g: 0, b: 0, a: 0 }
