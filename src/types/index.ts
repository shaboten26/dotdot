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

export interface AppSettings {
  id: 'app-settings'
  theme: ThemeMode
  language: LanguageCode
  historyLimit: number | 'unlimited' // e.g., 50, 100, 200, 'unlimited'
  showGrid: boolean
  checkerboardDark: boolean
  confirmDestructive: boolean
  soundEnabled: boolean
  activeProjectId: string | null
  gallerySortMode: 'manual' | 'newest' | 'oldest' | 'updated' | 'name'
}

export interface FloatingShapeState {
  /** Original rasterized shape buffer (untransformed, relative to originWidth x originHeight) */
  sourceBuffer: Uint8ClampedArray
  sourceWidth: number
  sourceHeight: number
  /** Center position on canvas (can be fractional by 0.5 depending on parity, offset tracked in ints) */
  offsetX: number
  offsetY: number
  /** Cumulative rotation in degrees (multiples of 5 or 90, computed from original buffer every time) */
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

/** Compact diff entry for history */
export interface PixelPatch {
  layerId: string
  /** Packed indices (pixel index = y * width + x) */
  indices: Uint32Array
  /** Packed before RGBA (4 bytes per index) */
  before: Uint8Array
  /** Packed after RGBA (4 bytes per index) */
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
