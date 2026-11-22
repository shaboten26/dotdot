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

/**
 * Special color slot index representing the dedicated Transparent drawing color (`RGBA(0,0,0,0)`).
 * Displayed at the leftmost position of the palette bar/sheet and NOT counted toward the 256-color limit.
 */
export const TRANSPARENT_COLOR_INDEX = -1

/**
 * 9-directional anchor for Canvas Resize (Section 5).
 * Default selection is `'center'`.
 */
export type ResizeAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export interface LayerMeta {
  id: string
  name: string
  visible: boolean
  opacity: number // 0 - 100
  blendMode: BlendMode
  clipping: boolean
  /**
   * Non-destructive layer origin & backing buffer dimensions relative to canvas top-left (0,0).
   * When omitted on legacy v1 projects, defaults to offsetX=0, offsetY=0, dataWidth=project.width, dataHeight=project.height.
   */
  offsetX?: number
  offsetY?: number
  dataWidth?: number
  dataHeight?: number
}

export interface LayerRuntime extends LayerMeta {
  /** Layer origin X in canvas coordinates (can be negative or >= canvasWidth) */
  offsetX: number
  offsetY: number
  /** Width of `data` backing buffer in pixels */
  dataWidth: number
  /** Height of `data` backing buffer in pixels */
  dataHeight: number
  /** RGBA byte buffer of length `dataWidth * dataHeight * 4` */
  data: Uint8ClampedArray
}

export interface CanvasSizePreset {
  id: string
  name: string
  width: number
  height: number
  builtIn?: boolean
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
  selectedColorIndex: number // -1 for Transparent slot, or 0..colors.length-1
  order: number
  thumbnailPng?: Uint8Array
  createdAt: number
  updatedAt: number
}

export interface LayerPixelRecord {
  key: string // `${projectId}:${layerId}`
  projectId: string
  layerId: string
  data: Uint8Array // raw RGBA bytes (length = dataWidth * dataHeight * 4)
  offsetX?: number
  offsetY?: number
  dataWidth?: number
  dataHeight?: number
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

/**
 * Backup reminder timestamps stored in IndexedDB (`AppSettings.backupMeta`, Section 11).
 */
export interface BackupReminderMeta {
  lastExportAt: number | null
  lastNotifiedAt: number | null
  nextNotifyAt: number | null
  firstProjectCreatedAt: number | null
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
  /** Section 9: Double-tap same canvas pixel to pick color & restore previous tool (default ON) */
  eyedropperDoubleTap: boolean
  activeProjectId: string | null
  gallerySortMode: 'manual' | 'newest' | 'oldest' | 'updated' | 'name'
  uiSize: UiSizeConfig
  /** User-created custom canvas size presets (persisted in IndexedDB & Environment Pack) */
  customCanvasPresets: CanvasSizePreset[]
  /** Backup reminder tracking metadata (Section 11) */
  backupMeta: BackupReminderMeta
}

export interface FloatingShapeState {
  sourceBuffer: Uint8ClampedArray
  sourceWidth: number
  sourceHeight: number
  offsetX: number
  offsetY: number
  rotationDeg: number
}

/**
 * Interactive Move Session shared by Selection Move (Section 7), Single-Layer Move, and Multi-Layer Batch Move (Section 8).
 * Moving never destroys off-canvas pixels!
 */
export interface ActiveMoveSession {
  mode: 'selection' | 'layer' | 'multi-layer'
  layerId: string
  /** Target layer IDs when moving one or multiple layers (`mode === 'layer' | 'multi-layer'`) */
  layerIds: string[]
  /** Initial world offsets per layer ID before drag started */
  initialLayerOffsets: Record<string, { offsetX: number; offsetY: number }>
  dx: number
  dy: number
  /** For 'selection': initial canvas-space selection mask before drag */
  initialMask: Uint8Array | null
  /** For 'selection': active layer with originally selected pixels cleared */
  clearedLayer: LayerRuntime | null
  /** For 'selection': extracted RGBA buffer of selected pixels */
  extractedBuffer: Uint8ClampedArray | null
  extractedWidth: number
  extractedHeight: number
  extractedOriginX: number
  extractedOriginY: number
  /** For 'layer' / 'multi-layer': bounding box origin & dimensions of moving layer(s) before drag */
  initialLayerOffsetX: number
  initialLayerOffsetY: number
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
  linePixelPerfect: boolean

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
  beforeGeometry?: {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
  }
  afterGeometry?: {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
  }
}

export interface LayerOffsetTransition {
  layerId: string
  beforeOffsetX: number
  beforeOffsetY: number
  afterOffsetX: number
  afterOffsetY: number
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
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette' | 'layer-offset'
  pixelPatches?: PixelPatch[]
  layerOffsetChange?: LayerOffsetTransition
  layerOffsetChanges?: LayerOffsetTransition[]
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
  beforeGeometry?: {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
  }
  afterGeometry?: {
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
  }
}

export interface SerializedHistoryEntry {
  id: string
  label: string
  timestamp: number
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette' | 'layer-offset'
  pixelPatches?: SerializedPixelPatch[]
  layerOffsetChange?: LayerOffsetTransition
  layerOffsetChanges?: LayerOffsetTransition[]
  beforeStructure?: CanvasSnapshot
  afterStructure?: CanvasSnapshot
  beforeSelection?: Uint8Array | null
  afterSelection?: Uint8Array | null
  beforePalette?: ProjectPalette
  afterPalette?: ProjectPalette
}
