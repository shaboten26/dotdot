export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export interface HSV {
  h: number // 0 - 360
  s: number // 0 - 100
  v: number // 0 - 100
}

export interface Point {
  x: number
  y: number
}

export type DitherPatternId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export type BrushShape = 'square' | 'circle'

export type Connectivity = 4 | 8

export type FillMode = 'normal' | 'gradient'

export type GradientSteps = 4 | 8

export type LineSubTool = 'line' | 'bezier'

export type ShapeSubTool = 'rect' | 'ellipse'

export type SelectSubTool = 'wand' | 'rect' | 'ellipse'

export type OutlineMode = 'normal' | 'pixelPerfect'

export type ToolId =
  | 'pen'
  | 'eraser'
  | 'fill'
  | 'line'
  | 'shape'
  | 'select'
  | 'eyedropper'

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add'
  | 'difference'

export interface LayerMeta {
  id: string
  name: string
  visible: boolean
  opacity: number // 0 - 100
  blendMode: BlendMode
  clipping: boolean
}

export interface LayerRuntime extends LayerMeta {
  data: Uint8ClampedArray // length = width * height * 4
}

export interface PaletteData {
  id: string
  name: string
  colors: string[] // #RRGGBB uppercase hex, 1..256 colors
  order: number
  createdAt: number
  updatedAt: number
}

export interface ProjectPalette {
  name: string
  colors: string[] // Independent copy for this project (max 256)
  sourcePaletteId?: string
}

export interface ProjectRecord {
  id: string
  name: string
  width: number // 1..256
  height: number // 1..256
  layers: LayerMeta[]
  activeLayerId: string
  palette: ProjectPalette
  selectedColorIndex: number
  order: number
  thumbnailPng?: Uint8Array
  createdAt: number
  updatedAt: number
}

export interface LayerPixelRecord {
  key: string // `${projectId}:${layerId}`
  projectId: string
  layerId: string
  data: Uint8Array // raw RGBA bytes
}

export type ThemeMode = 'light' | 'dark' | 'system'

export type LanguageCode = 'ja' | 'en' | 'ko'

export type UiSizePreset = 'compact' | 'standard' | 'large' | 'custom'

export interface UiSizeConfig {
  preset: UiSizePreset
  /** Overall UI scale percentage (85 - 125) */
  overallScale: number
  /** Pixel icon size in CSS px (integer multiple of 8/16 preferred: 16, 20, 24, 32) */
  toolIconSize: number
  /** Tool button minimum height in CSS px (44 - 68) */
  toolButtonHeight: number
  /** Tool short label font size in CSS px (10 - 15) */
  toolLabelSize: number
  /** Palette color swatch size in CSS px (28 - 48) */
  swatchSize: number
  /** Pixel checkbox size in CSS px (16 - 28) */
  checkboxSize: number
  /** Spacing gap between UI elements in CSS px (4 - 12) */
  uiGap: number
  /** Draw button height percentage of viewport height (10 - 20, default 15%) */
  drawButtonVh: number
}

export interface AppSettings {
  id: 'app-settings'
  theme: ThemeMode
  language: LanguageCode
  historyLimit: number | 'unlimited'
  showGrid: boolean
  checkerboardDark: boolean
  confirmDestructive: boolean
  soundEnabled: boolean
  activeProjectId: string | null
  gallerySortMode: 'manual' | 'newest' | 'oldest' | 'updated' | 'name'
  uiSize: UiSizeConfig
}

export interface FloatingShapeState {
  sourceBuffer: Uint8ClampedArray
  sourceWidth: number
  sourceHeight: number
  offsetX: number
  offsetY: number
  rotationDeg: number
}

export interface ClipboardBuffer {
  width: number
  height: number
  offsetX: number
  offsetY: number
  data: Uint8ClampedArray
}

export interface ToolSettings {
  penSize: number
  penShape: BrushShape
  penDither: DitherPatternId
  pixelPerfect: boolean

  eraserSize: number
  eraserShape: BrushShape

  fillConnectivity: Connectivity
  fillDither: DitherPatternId
  fillMode: FillMode
  gradientSteps: GradientSteps

  lineType: LineSubTool
  lineSize: number
  lineShape: BrushShape
  lineDither: DitherPatternId

  shapeType: ShapeSubTool
  shapeFilled: boolean
  shapeFixedRatio: boolean
  shapeSize: number
  shapeDither: DitherPatternId

  selectType: SelectSubTool
  selectConnectivity: Connectivity
  outlineMode: OutlineMode
  outlineSize: number
  outlineColor: string
}

export interface PixelPatch {
  layerId: string
  indices: Uint32Array
  before: Uint8Array
  after: Uint8Array
}

export interface CanvasSnapshot {
  width: number
  height: number
  layers: Array<{
    meta: LayerMeta
    data: Uint8Array
  }>
  activeLayerId: string
}

export interface HistoryEntry {
  id: string
  label: string
  timestamp: number
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette'
  pixelPatches?: PixelPatch[]
  beforeStructure?: CanvasSnapshot
  afterStructure?: CanvasSnapshot
  beforeSelection?: Uint8Array | null
  afterSelection?: Uint8Array | null
  beforePalette?: ProjectPalette
  afterPalette?: ProjectPalette
}

export interface ProjectHistoryRecord {
  projectId: string
  undoStack: SerializedHistoryEntry[]
  redoStack: SerializedHistoryEntry[]
  updatedAt: number
}

export interface SerializedPixelPatch {
  layerId: string
  indices: Uint32Array
  before: Uint8Array
  after: Uint8Array
}

export interface SerializedHistoryEntry {
  id: string
  label: string
  timestamp: number
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette'
  pixelPatches?: SerializedPixelPatch[]
  beforeStructure?: CanvasSnapshot
  afterStructure?: CanvasSnapshot
  beforeSelection?: Uint8Array | null
  afterSelection?: Uint8Array | null
  beforePalette?: ProjectPalette
  afterPalette?: ProjectPalette
}
