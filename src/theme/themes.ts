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
  // 1. Gentle Default: Lavender Cream (優しい・ラベンダークリーム)
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
  // 2. Gentle Pastel: Peach Cotton (優しい・桃色コットンペーパー)
  {
    id: 'peach-cotton',
    mode: 'light',
    previewColors: ['#fff7f2', '#f7dfd4', '#d46b5c', '#549682'],
    tokens: {
      '--bg-app': '#faeae2',
      '--bg-surface': '#fff7f2',
      '--bg-elevated': '#f7dfd4',
      '--bg-panel': '#fffbfa',
      '--text-primary': '#422624',
      '--text-secondary': '#7d5650',
      '--text-on-accent': '#fff9f7',
      '--border-pixel': '#875c55',
      '--border-subtle': '#e6c5ba',
      '--border-strong': '#3d201d',
      '--accent-primary': '#d46b5c',
      '--accent-primary-hover': '#bf594b',
      '--accent-primary-fg': '#fff9f7',
      '--accent-primary-border': '#8c382c',
      '--accent-teal': '#549682',
      '--accent-teal-hover': '#45826f',
      '--accent-teal-fg': '#f6fcfa',
      '--accent-teal-border': '#2e594c',
      '--accent-rose': '#c95376',
      '--accent-rose-hover': '#b34264',
      '--accent-rose-fg': '#fff8fa',
      '--accent-rose-border': '#7d2842',
      '--accent-amber': '#cf8f3a',
      '--canvas-well': '#edd2c7',
    },
  },
  // 3. Refreshing Handheld Retro: Mint Pocket (爽やか・レトロ携帯ゲーム機ミント)
  {
    id: 'mint-pocket',
    mode: 'light',
    previewColors: ['#f1f8f3', '#d4e8dc', '#2d8574', '#4b7aa8'],
    tokens: {
      '--bg-app': '#e1efe6',
      '--bg-surface': '#f1f8f3',
      '--bg-elevated': '#d4e8dc',
      '--bg-panel': '#f8fcf9',
      '--text-primary': '#1a332d',
      '--text-secondary': '#45695f',
      '--text-on-accent': '#f5fcfa',
      '--border-pixel': '#426b60',
      '--border-subtle': '#b2cfc0',
      '--border-strong': '#142924',
      '--accent-primary': '#2d8574',
      '--accent-primary-hover': '#237061',
      '--accent-primary-fg': '#f5fcfa',
      '--accent-primary-border': '#184f44',
      '--accent-teal': '#4b7aa8',
      '--accent-teal-hover': '#3d6894',
      '--accent-teal-fg': '#f5f9fc',
      '--accent-teal-border': '#274869',
      '--accent-rose': '#c45b62',
      '--accent-rose-hover': '#ad4a51',
      '--accent-rose-fg': '#fdf7f7',
      '--accent-rose-border': '#7a3035',
      '--accent-amber': '#bd8833',
      '--canvas-well': '#c5ded0',
    },
  },
  // 4. Rich Classical: Antique Brass (リッチ・アンティーク真鍮＆ボルドー羊皮紙)
  {
    id: 'antique-brass',
    mode: 'light',
    previewColors: ['#f8f1e3', '#eadbc0', '#8f3042', '#9e7428'],
    tokens: {
      '--bg-app': '#ede2cc',
      '--bg-surface': '#f8f1e3',
      '--bg-elevated': '#eadbc0',
      '--bg-panel': '#fcf8ef',
      '--text-primary': '#2e2118',
      '--text-secondary': '#695341',
      '--text-on-accent': '#fcf8f2',
      '--border-pixel': '#73583f',
      '--border-subtle': '#d1be9d',
      '--border-strong': '#291c12',
      '--accent-primary': '#8f3042',
      '--accent-primary-hover': '#782535',
      '--accent-primary-fg': '#fcf7f8',
      '--accent-primary-border': '#541622',
      '--accent-teal': '#9e7428',
      '--accent-teal-hover': '#87611e',
      '--accent-teal-fg': '#fcfaf5',
      '--accent-teal-border': '#593e10',
      '--accent-rose': '#b84637',
      '--accent-rose-hover': '#9e382b',
      '--accent-rose-fg': '#fdf7f6',
      '--accent-rose-border': '#6e2218',
      '--accent-amber': '#bf7c24',
      '--canvas-well': '#dfd0b4',
    },
  },
  // 5. Urban Cool: Urban Concrete (都会的・アーバンコンクリート＆コバルトブルー)
  {
    id: 'urban-concrete',
    mode: 'light',
    previewColors: ['#f2f4f7', '#dce2eb', '#3362a8', '#2a8c8f'],
    tokens: {
      '--bg-app': '#e4e8ef',
      '--bg-surface': '#f2f4f7',
      '--bg-elevated': '#dce2eb',
      '--bg-panel': '#f9fafc',
      '--text-primary': '#1b2432',
      '--text-secondary': '#4f5d73',
      '--text-on-accent': '#f7f9fc',
      '--border-pixel': '#4c5b73',
      '--border-subtle': '#bcc6d6',
      '--border-strong': '#151d29',
      '--accent-primary': '#3362a8',
      '--accent-primary-hover': '#285191',
      '--accent-primary-fg': '#f7f9fc',
      '--accent-primary-border': '#1b3969',
      '--accent-teal': '#2a8c8f',
      '--accent-teal-hover': '#217678',
      '--accent-teal-fg': '#f5fbfb',
      '--accent-teal-border': '#154f52',
      '--accent-rose': '#c44d61',
      '--accent-rose-hover': '#ab3d50',
      '--accent-rose-fg': '#fdf7f8',
      '--accent-rose-border': '#782534',
      '--accent-amber': '#c7832c',
      '--canvas-well': '#cfd7e3',
    },
  },
  // 6. Retro Cafe: Retro Kissaten (レトロ純喫茶・琥珀珈琲とマスタード)
  {
    id: 'retro-kissaten',
    mode: 'light',
    previewColors: ['#f7efe2', '#e8d7be', '#a6522b', '#417a58'],
    tokens: {
      '--bg-app': '#ecdfca',
      '--bg-surface': '#f7efe2',
      '--bg-elevated': '#e8d7be',
      '--bg-panel': '#fcf7ef',
      '--text-primary': '#332115',
      '--text-secondary': '#6e503b',
      '--text-on-accent': '#fcf8f2',
      '--border-pixel': '#6e4e37',
      '--border-subtle': '#cfb99b',
      '--border-strong': '#2b1b10',
      '--accent-primary': '#a6522b',
      '--accent-primary-hover': '#8f4320',
      '--accent-primary-fg': '#fcf8f5',
      '--accent-primary-border': '#612b12',
      '--accent-teal': '#417a58',
      '--accent-teal-hover': '#346648',
      '--accent-teal-fg': '#f6fbf8',
      '--accent-teal-border': '#224731',
      '--accent-rose': '#b84747',
      '--accent-rose-hover': '#9e3838',
      '--accent-rose-fg': '#fdf7f7',
      '--accent-rose-border': '#6e2222',
      '--accent-amber': '#c48a25',
      '--canvas-well': '#dec9ab',
    },
  },
]

export const DARK_THEME_VARIANTS: ReadonlyArray<
  ThemeVariantDefinition<DarkThemeVariantId>
> = [
  // 1. Gentle Night Default: Dusk Plum (優しい夜・ダスクプラム)
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
  // 2. Rich Luxury: Royal Velvet (リッチ・深紅ベルベット＆アンティークゴールド)
  {
    id: 'royal-velvet',
    mode: 'dark',
    previewColors: ['#2b1820', '#3d222d', '#e0b354', '#d96b84'],
    tokens: {
      '--bg-app': '#1e1016',
      '--bg-surface': '#2b1820',
      '--bg-elevated': '#3d222d',
      '--bg-panel': '#331c26',
      '--text-primary': '#faefe6',
      '--text-secondary': '#c9ad9f',
      '--text-on-accent': '#241608',
      '--border-pixel': '#8f6558',
      '--border-subtle': '#54333d',
      '--border-strong': '#faefe6',
      '--accent-primary': '#e0b354',
      '--accent-primary-hover': '#ebc36e',
      '--accent-primary-fg': '#241608',
      '--accent-primary-border': '#fae3ad',
      '--accent-teal': '#68b59b',
      '--accent-teal-hover': '#7cc4ac',
      '--accent-teal-fg': '#10241d',
      '--accent-teal-border': '#b8ebd9',
      '--accent-rose': '#e37488',
      '--accent-rose-hover': '#eb889a',
      '--accent-rose-fg': '#291016',
      '--accent-rose-border': '#f7c3cd',
      '--accent-amber': '#e8a848',
      '--canvas-well': '#160b10',
    },
  },
  // 3. Urban City-Pop: Tokyo Neon (都会的・80sシティポップ夜景＆レトロネオン)
  {
    id: 'tokyo-neon',
    mode: 'dark',
    previewColors: ['#182038', '#232f52', '#f0719f', '#4fd1cf'],
    tokens: {
      '--bg-app': '#111729',
      '--bg-surface': '#182038',
      '--bg-elevated': '#232f52',
      '--bg-panel': '#1d2745',
      '--text-primary': '#edf2fc',
      '--text-secondary': '#9aa9cc',
      '--text-on-accent': '#240d18',
      '--border-pixel': '#566b9e',
      '--border-subtle': '#303f6b',
      '--border-strong': '#edf2fc',
      '--accent-primary': '#f0719f',
      '--accent-primary-hover': '#f589b0',
      '--accent-primary-fg': '#240d18',
      '--accent-primary-border': '#fcc7da',
      '--accent-teal': '#4fd1cf',
      '--accent-teal-hover': '#6bdbd9',
      '--accent-teal-fg': '#0b2424',
      '--accent-teal-border': '#b6f2f1',
      '--accent-rose': '#f26d6d',
      '--accent-rose-hover': '#f78383',
      '--accent-rose-fg': '#290e0e',
      '--accent-rose-border': '#fcc2c2',
      '--accent-amber': '#f2c157',
      '--canvas-well': '#0c101d',
    },
  },
  // 4. Urban Minimalist: Urban Graphite (都会的・無機質グラファイト＆スカイシアン)
  {
    id: 'urban-graphite',
    mode: 'dark',
    previewColors: ['#21252b', '#2d333b', '#6cb6ff', '#5ec4a7'],
    tokens: {
      '--bg-app': '#171a1f',
      '--bg-surface': '#21252b',
      '--bg-elevated': '#2d333b',
      '--bg-panel': '#262b33',
      '--text-primary': '#eceff4',
      '--text-secondary': '#9aa3b2',
      '--text-on-accent': '#0d1b2a',
      '--border-pixel': '#5d6778',
      '--border-subtle': '#39414d',
      '--border-strong': '#eceff4',
      '--accent-primary': '#6cb6ff',
      '--accent-primary-hover': '#87c4ff',
      '--accent-primary-fg': '#0d1b2a',
      '--accent-primary-border': '#cae5ff',
      '--accent-teal': '#5ec4a7',
      '--accent-teal-hover': '#75d1b7',
      '--accent-teal-fg': '#0d241d',
      '--accent-teal-border': '#b8f0df',
      '--accent-rose': '#e67782',
      '--accent-rose-hover': '#ed8c96',
      '--accent-rose-fg': '#291114',
      '--accent-rose-border': '#f7c6cb',
      '--accent-amber': '#e5b55c',
      '--canvas-well': '#121418',
    },
  },
  // 5. Gentle Botanical: Forest Apothecary (優しい深緑・深い森と薬草棚)
  {
    id: 'forest-apothecary',
    mode: 'dark',
    previewColors: ['#1c2b24', '#273b32', '#8ccf9e', '#dbb06b'],
    tokens: {
      '--bg-app': '#141f1a',
      '--bg-surface': '#1c2b24',
      '--bg-elevated': '#273b32',
      '--bg-panel': '#21332b',
      '--text-primary': '#ebf2ec',
      '--text-secondary': '#9eb5a5',
      '--text-on-accent': '#102416',
      '--border-pixel': '#567865',
      '--border-subtle': '#324d3f',
      '--border-strong': '#ebf2ec',
      '--accent-primary': '#8ccf9e',
      '--accent-primary-hover': '#a1dbb1',
      '--accent-primary-fg': '#102416',
      '--accent-primary-border': '#cef0d7',
      '--accent-teal': '#dbb06b',
      '--accent-teal-hover': '#e5bf82',
      '--accent-teal-fg': '#241a0b',
      '--accent-teal-border': '#f5e0bd',
      '--accent-rose': '#de8178',
      '--accent-rose-hover': '#e6948c',
      '--accent-rose-fg': '#261210',
      '--accent-rose-border': '#f5c6c1',
      '--accent-amber': '#e3b559',
      '--canvas-well': '#0f1713',
    },
  },
  // 6. Retro Terminal: Amber CRT (レトロ端末・80年代アンバーブラウン管モニター)
  {
    id: 'amber-crt',
    mode: 'dark',
    previewColors: ['#241d14', '#33281b', '#f0a93e', '#85c47c'],
    tokens: {
      '--bg-app': '#19140d',
      '--bg-surface': '#241d14',
      '--bg-elevated': '#33281b',
      '--bg-panel': '#2b2217',
      '--text-primary': '#faeacc',
      '--text-secondary': '#bfa67a',
      '--text-on-accent': '#241604',
      '--border-pixel': '#876b3d',
      '--border-subtle': '#4d3c23',
      '--border-strong': '#faeacc',
      '--accent-primary': '#f0a93e',
      '--accent-primary-hover': '#f5ba5d',
      '--accent-primary-fg': '#241604',
      '--accent-primary-border': '#fce0b3',
      '--accent-teal': '#85c47c',
      '--accent-teal-hover': '#98d190',
      '--accent-teal-fg': '#122410',
      '--accent-teal-border': '#c8ebc3',
      '--accent-rose': '#e37464',
      '--accent-rose-hover': '#eb887a',
      '--accent-rose-fg': '#29110d',
      '--accent-rose-border': '#f7c5be',
      '--accent-amber': '#f5bf4f',
      '--canvas-well': '#120e09',
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
