import type { StampAsset } from '../types'
import { hexToRgba } from '../engine/color'

function parsePixelArtStamp(
  id: string,
  name: string,
  rows: readonly string[],
  legend: Record<string, string>,
  order: number,
  now: number
): StampAsset {
  const height = rows.length
  const width = rows[0]?.length ?? 1
  const data = new Uint8Array(width * height * 4)

  for (let y = 0; y < height; y++) {
    const row = rows[y] ?? ''
    for (let x = 0; x < width; x++) {
      const ch = row[x] ?? '.'
      const hex = legend[ch]
      if (!hex) continue
      const rgba = hexToRgba(hex)
      const idx = (y * width + x) * 4
      data[idx] = rgba.r
      data[idx + 1] = rgba.g
      data[idx + 2] = rgba.b
      data[idx + 3] = 255
    }
  }

  return {
    id,
    name,
    width,
    height,
    data,
    order,
    createdAt: now,
    updatedAt: now,
    builtIn: true,
  }
}

/**
 * Starter pixel-art stamps & tileable small motifs (grass, stone cobble, water ripple, brick wall, sparkle).
 * Stored independently in IndexedDB `stamps` table so deleting projects never deletes registered stamps.
 */
export function buildInitialStamps(now = Date.now()): StampAsset[] {
  return [
    parsePixelArtStamp(
      'stamp-builtin-grass',
      '草むら (8×8)',
      [
        '..g...G.',
        '.gGg..g.',
        'gGdg.gGg',
        '.gdg..gd',
        '..d...d.',
        '.G...g..',
        'gGg.gGg.',
        '.d...d..',
      ],
      {
        G: '#78C268',
        g: '#4E9A51',
        d: '#2E6940',
      },
      0,
      now
    ),
    parsePixelArtStamp(
      'stamp-builtin-cobble',
      '石畳 (8×8)',
      [
        'dhhhhddh',
        'hssssdhs',
        'hssssdhs',
        'ddddddhd',
        'dhssssdd',
        'shsssshs',
        'shddddhs',
        'hddddddh',
      ],
      {
        h: '#B8C0CC',
        s: '#8892A4',
        d: '#4C5565',
      },
      1,
      now
    ),
    parsePixelArtStamp(
      'stamp-builtin-water',
      '水面 (8×8)',
      [
        'wwwwwwww',
        'wllwwlww',
        'wwllwwww',
        'wwwwddww',
        'wwwwwwww',
        'wlwwwwll',
        'wwllwlww',
        'ddwwwwww',
      ],
      {
        w: '#4A89C8',
        l: '#9CD4F7',
        d: '#2E6299',
      },
      2,
      now
    ),
    parsePixelArtStamp(
      'stamp-builtin-brick',
      'レンガ壁 (8×8)',
      [
        'mmmmmmmm',
        'bbrrrbbm',
        'rrrrrrbm',
        'dddddddm',
        'mmmmmmmm',
        'rbmmbbrr',
        'rbmmrrrr',
        'ddmmdddd',
      ],
      {
        m: '#D9CFC1',
        b: '#C96D5B',
        r: '#A84E40',
        d: '#733128',
      },
      3,
      now
    ),
    parsePixelArtStamp(
      'stamp-builtin-star',
      'きらめき (7×7)',
      [
        '...y...',
        '...y...',
        '..ywy..',
        'yywwwyy',
        '..ywy..',
        '...y...',
        '...y...',
      ],
      {
        y: '#F2C94C',
        w: '#FFF9DB',
      },
      4,
      now
    ),
  ]
}
