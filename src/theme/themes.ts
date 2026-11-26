import type { DarkThemeVariantId, LightThemeVariantId } from '../types'

export interface ThemeTokenSet {
  '--bg-app': string
  '--bg-surface': string
  '--bg-elevated': string
  '--bg-panel': string
  '--text-primary': string
  '--text-secondary': string
  '--text-on-accent': string
  '--border-pixel': string
  '--border-subtle': string
  '--border-strong': string
  '--accent-primary': string
  '--accent-primary-hover': string
  '--accent-primary-fg': string
  '--accent-primary-border': string
  '--accent-teal': string
  '--accent-teal-hover': string
  '--accent-teal-fg': string
  '--accent-teal-border': string
  '--accent-rose': string
  '--accent-rose-hover': string
  '--accent-rose-fg': string
  '--accent-rose-border': string
  '--accent-amber': string
  '--canvas-well': string
}

export interface ThemeVariantDefinition<Id extends string> {
  id: Id
  mode: 'light' | 'dark'
  /** Swatch preview chips shown in detailed theme selector */
  previewColors: readonly [string, string, string, string]
  tokens: ThemeTokenSet
}

export const LIGHT_THEME_VARIANTS: ReadonlyArray<
  ThemeVariantDefinition<LightThemeVariantId>
> = [
  {
    id: 'lavender-cream',
    mode: 'light',
    previewColors: ['#faf6f0', '#e8dfed', '#7b62ad', '#578a75'],
    tokens: {
      '--bg-app': '#f3ede4',
      '--bg-surface': '#faf6f0',
      '--bg-elevated': '#e8dfed',
      '--bg-panel': '#fdfaf6',
      '--text-primary': '#31253d',
      '--text-secondary': '#685978',
      '--text-on-accent': '#fcfaf8',
      '--border-pixel': '#66547a',
      '--border-subtle': '#cfc3d8',
      '--border-strong': '#2d2138',
      '--accent-primary': '#7b62ad',
      '--accent-primary-hover': '#6a529c',
      '--accent-primary-fg': '#fcfaf8',
      '--accent-primary-border': '#4c3975',
      '--accent-teal': '#578a75',
      '--accent-teal-hover': '#497864',
      '--accent-teal-fg': '#f7fbf9',
      '--accent-teal-border': '#35594a',
      '--accent-rose': '#be626c',
      '--accent-rose-hover': '#aa525c',
      '--accent-rose-fg': '#fdf8f8',
      '--accent-rose-border': '#78363e',
      '--accent-amber': '#bf8744',
      '--canvas-well': '#dfd6e4',
    },
  },
  {
    id: 'milk-lilac',
    mode: 'light',
    previewColors: ['#f8f5fc', '#e3dbf0', '#765db3', '#53887b'],
    tokens: {
      '--bg-app': '#efeaf5',
      '--bg-surface': '#f8f5fc',
      '--bg-elevated': '#e3dbf0',
      '--bg-panel': '#fcfaff',
      '--text-primary': '#2d233b',
      '--text-secondary': '#645778',
      '--text-on-accent': '#fcfaff',
      '--border-pixel': '#62527c',
      '--border-subtle': '#cac0dc',
      '--border-strong': '#281e36',
      '--accent-primary': '#765db3',
      '--accent-primary-hover': '#654ca1',
      '--accent-primary-fg': '#fcfaff',
      '--accent-primary-border': '#473478',
      '--accent-teal': '#53887b',
      '--accent-teal-hover': '#457569',
      '--accent-teal-fg': '#f6fbfa',
      '--accent-teal-border': '#31574e',
      '--accent-rose': '#b86173',
      '--accent-rose-hover': '#a45062',
      '--accent-rose-fg': '#fdf8f9',
      '--accent-rose-border': '#733543',
      '--accent-amber': '#bd8648',
      '--canvas-well': '#dbd2ea',
    },
  },
  {
    id: 'sage-ivory',
    mode: 'light',
    previewColors: ['#f6f7f1', '#dfe4da', '#6e639e', '#4f876c'],
    tokens: {
      '--bg-app': '#eceee6',
      '--bg-surface': '#f6f7f1',
      '--bg-elevated': '#dfe4da',
      '--bg-panel': '#fbfcf8',
      '--text-primary': '#2b2c35',
      '--text-secondary': '#5d616b',
      '--text-on-accent': '#fafaf7',
      '--border-pixel': '#585d68',
      '--border-subtle': '#c3c9bd',
      '--border-strong': '#252730',
      '--accent-primary': '#6e639e',
      '--accent-primary-hover': '#5e538d',
      '--accent-primary-fg': '#fafaf7',
      '--accent-primary-border': '#433a6b',
      '--accent-teal': '#4f876c',
      '--accent-teal-hover': '#41745b',
      '--accent-teal-fg': '#f6fbf8',
      '--accent-teal-border': '#2e5442',
      '--accent-rose': '#ba655e',
      '--accent-rose-hover': '#a5544d',
      '--accent-rose-fg': '#fdf8f7',
      '--accent-rose-border': '#753934',
      '--accent-amber': '#b8853f',
      '--canvas-well': '#d5dcd0',
    },
  },
  {
    id: 'berry-paper',
    mode: 'light',
    previewColors: ['#fbf4f2', '#eadcdf', '#8c5c84', '#5a8770'],
    tokens: {
      '--bg-app': '#f4ebe9',
      '--bg-surface': '#fbf4f2',
      '--bg-elevated': '#eadcdf',
      '--bg-panel': '#fffaf8',
      '--text-primary': '#362433',
      '--text-secondary': '#6e5669',
      '--text-on-accent': '#fdf9fa',
      '--border-pixel': '#70536a',
      '--border-subtle': '#d4c1c8',
      '--border-strong': '#301f2d',
      '--accent-primary': '#8c5c84',
      '--accent-primary-hover': '#794c72',
      '--accent-primary-fg': '#fdf9fa',
      '--accent-primary-border': '#573351',
      '--accent-teal': '#5a8770',
      '--accent-teal-hover': '#4b7560',
      '--accent-teal-fg': '#f7fbf9',
      '--accent-teal-border': '#375747',
      '--accent-rose': '#c0625d',
      '--accent-rose-hover': '#ab514c',
      '--accent-rose-fg': '#fdf8f7',
      '--accent-rose-border': '#7a3733',
      '--accent-amber': '#c18642',
      '--canvas-well': '#e3d3d7',
    },
  },
]

export const DARK_THEME_VARIANTS: ReadonlyArray<
  ThemeVariantDefinition<DarkThemeVariantId>
> = [
  {
    id: 'dusk-plum',
    mode: 'dark',
    previewColors: ['#292133', '#362c43', '#ab94de', '#72b59b'],
    tokens: {
      '--bg-app': '#1f1926',
      '--bg-surface': '#292133',
      '--bg-elevated': '#362c43',
      '--bg-panel': '#2f263b',
      '--text-primary': '#f3edf7',
      '--text-secondary': '#b2a5c2',
      '--text-on-accent': '#1e1726',
      '--border-pixel': '#74648a',
      '--border-subtle': '#463a57',
      '--border-strong': '#f3edf7',
      '--accent-primary': '#ab94de',
      '--accent-primary-hover': '#b9a5e6',
      '--accent-primary-fg': '#1e1726',
      '--accent-primary-border': '#dfd5f7',
      '--accent-teal': '#72b59b',
      '--accent-teal-hover': '#83c2aa',
      '--accent-teal-fg': '#13221c',
      '--accent-teal-border': '#bce6d6',
      '--accent-rose': '#db8089',
      '--accent-rose-hover': '#e49199',
      '--accent-rose-fg': '#261316',
      '--accent-rose-border': '#f5c6cb',
      '--accent-amber': '#deb062',
      '--canvas-well': '#18131e',
    },
  },
  {
    id: 'midnight-lavender',
    mode: 'dark',
    previewColors: ['#242134', '#312d46', '#a495e6', '#6eb5a4'],
    tokens: {
      '--bg-app': '#1a1826',
      '--bg-surface': '#242134',
      '--bg-elevated': '#312d46',
      '--bg-panel': '#2a263d',
      '--text-primary': '#f0ecf8',
      '--text-secondary': '#aba4c4',
      '--text-on-accent': '#191726',
      '--border-pixel': '#6d668c',
      '--border-subtle': '#403b59',
      '--border-strong': '#f0ecf8',
      '--accent-primary': '#a495e6',
      '--accent-primary-hover': '#b4a7ee',
      '--accent-primary-fg': '#191726',
      '--accent-primary-border': '#dad4f9',
      '--accent-teal': '#6eb5a4',
      '--accent-teal-hover': '#80c2b2',
      '--accent-teal-fg': '#12221e',
      '--accent-teal-border': '#b8e6db',
      '--accent-rose': '#d9818f',
      '--accent-rose-hover': '#e3929f',
      '--accent-rose-fg': '#261317',
      '--accent-rose-border': '#f5c6ce',
      '--accent-amber': '#ddb165',
      '--canvas-well': '#14121e',
    },
  },
  {
    id: 'moss-grape',
    mode: 'dark',
    previewColors: ['#24282e', '#30363e', '#a38fd6', '#74b38e'],
    tokens: {
      '--bg-app': '#1b1e22',
      '--bg-surface': '#24282e',
      '--bg-elevated': '#30363e',
      '--bg-panel': '#292e36',
      '--text-primary': '#efeae2',
      '--text-secondary': '#a8aeb5',
      '--text-on-accent': '#191b20',
      '--border-pixel': '#67707a',
      '--border-subtle': '#3d444e',
      '--border-strong': '#efeae2',
      '--accent-primary': '#a38fd6',
      '--accent-primary-hover': '#b3a1e0',
      '--accent-primary-fg': '#1c1726',
      '--accent-primary-border': '#dcd3f4',
      '--accent-teal': '#74b38e',
      '--accent-teal-hover': '#85c09d',
      '--accent-teal-fg': '#132219',
      '--accent-teal-border': '#bce4cc',
      '--accent-rose': '#d68278',
      '--accent-rose-hover': '#e09289',
      '--accent-rose-fg': '#261412',
      '--accent-rose-border': '#f3c6c0',
      '--accent-amber': '#dcaf60',
      '--canvas-well': '#15171b',
    },
  },
  {
    id: 'velvet-fig',
    mode: 'dark',
    previewColors: ['#2e212a', '#3d2c38', '#bc93c4', '#75b398'],
    tokens: {
      '--bg-app': '#231920',
      '--bg-surface': '#2e212a',
      '--bg-elevated': '#3d2c38',
      '--bg-panel': '#352631',
      '--text-primary': '#f5ecee',
      '--text-secondary': '#bba4af',
      '--text-on-accent': '#23161f',
      '--border-pixel': '#7e6274',
      '--border-subtle': '#4d3846',
      '--border-strong': '#f5ecee',
      '--accent-primary': '#bc93c4',
      '--accent-primary-hover': '#caa5d1',
      '--accent-primary-fg': '#23161f',
      '--accent-primary-border': '#ead6ee',
      '--accent-teal': '#75b398',
      '--accent-teal-hover': '#86c0a7',
      '--accent-teal-fg': '#13221b',
      '--accent-teal-border': '#bee5d4',
      '--accent-rose': '#de847d',
      '--accent-rose-hover': '#e6958f',
      '--accent-rose-fg': '#281412',
      '--accent-rose-border': '#f6c8c4',
      '--accent-amber': '#e0b063',
      '--canvas-well': '#1b1318',
    },
  },
]

export function resolveActiveThemeTokens(
  isDark: boolean,
  lightVariant: LightThemeVariantId = 'lavender-cream',
  darkVariant: DarkThemeVariantId = 'dusk-plum'
): ThemeTokenSet {
  if (isDark) {
    const found =
      DARK_THEME_VARIANTS.find((v) => v.id === darkVariant) ??
      DARK_THEME_VARIANTS[0]!
    return found.tokens
  }
  const found =
    LIGHT_THEME_VARIANTS.find((v) => v.id === lightVariant) ??
    LIGHT_THEME_VARIANTS[0]!
  return found.tokens
}
