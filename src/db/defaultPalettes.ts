import type { PaletteData } from '../types'

export interface SeedPaletteTemplate {
  id: string
  name: string
  colors: string[]
}

export const DEFAULT_PALETTE_TEMPLATES: readonly SeedPaletteTemplate[] = [
  {
    id: 'pal-lavender-atelier-24',
    name: 'Lavender Atelier 24',
    colors: [
      '#24192E', '#3D2C4D', '#5F4975', '#876FA3',
      '#B49FD1', '#DACDF0', '#F4EFFA', '#FDF9F2',
      '#4E3242', '#7D4E68', '#AD728F', '#D9A5BC',
      '#8F4B53', '#C46D72', '#E69F9B', '#F7D3C4',
      '#304D42', '#4E7A68', '#78A890', '#B3D6C2',
      '#6E533B', '#A37D56', '#D4B07B', '#F2DFB6',
    ],
  },
  {
    id: 'pal-standard-32',
    name: 'dotdot Standard 32',
    colors: [
      '#000000', '#1D2B53', '#7E2553', '#008751',
      '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
      '#FF004D', '#FFA300', '#FFEC27', '#00E436',
      '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
      '#291814', '#111D35', '#422136', '#125359',
      '#742F29', '#49333B', '#A28879', '#F3EF7D',
      '#BE1250', '#FF6C24', '#A8E72E', '#00B543',
      '#065AB5', '#754665', '#FF6E59', '#FF9D81',
    ],
  },
  {
    id: 'pal-pastel-16',
    name: 'Pastel Candy 16',
    colors: [
      '#2B2635', '#564D65', '#9B8FB0', '#F7F3FF',
      '#FFB3C6', '#FF8FAB', '#FB6F92', '#FFC6FF',
      '#FFD6A5', '#FDFFB6', '#CAFFBF', '#9BF6FF',
      '#A0C4FF', '#BDB2FF', '#E2AFFF', '#FFF0F3',
    ],
  },
  {
    id: 'pal-retro-16',
    name: 'Retro 8-Bit 16',
    colors: [
      '#140C1C', '#442434', '#30346D', '#4E4A4E',
      '#854C30', '#346524', '#D04648', '#757161',
      '#597DCE', '#D27D2C', '#8595A1', '#6DAA2C',
      '#D2AA99', '#6DC2CA', '#DAD45E', '#DEEED6',
    ],
  },
  {
    id: 'pal-gameboy-4',
    name: 'Pocket Green 4',
    colors: [
      '#0F380F', '#306230', '#8BAC0F', '#9BBC0F',
    ],
  },
  {
    id: 'pal-earth-16',
    name: 'Forest & Earth 16',
    colors: [
      '#1B1A17', '#3D2C2E', '#634133', '#8C5E3C',
      '#B88B58', '#DFB78C', '#F4E3C1', '#FFFDF7',
      '#1E352F', '#335C45', '#528250', '#82A861',
      '#B5CA77', '#4B6B78', '#769BA8', '#B3D0D6',
    ],
  },
]

export function buildInitialPalettes(now = Date.now()): PaletteData[] {
  return DEFAULT_PALETTE_TEMPLATES.map((tpl, idx) => ({
    id: tpl.id,
    name: tpl.name,
    colors: [...tpl.colors],
    order: idx,
    createdAt: now,
    updatedAt: now,
  }))
}
