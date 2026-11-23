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

export type GradientType = 'linear' | 'radial'

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
 * 9-directional anchor for Canvas Resize.
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
  locked?: boolean
  opacity: number // 0 - 100
  blendMode: BlendMode
  clipping: boolean
  /**
   * Non-destructive layer origin & backing buffer dimensions relative to canvas top-left (0,0).
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

/**
 * Unified Still (1-frame) & Animation (N-frame) Timeline Types (Phase 5–8)
 * - Still image is simply `frames.length === 1`!
 * - Cels support Empty (`null` / `{ kind: 'empty' }`), Independent (unique `celId`), and Linked (shared `celId` across multiple frames of a layer).
 */
export type PlaybackDirection = 'forward' | 'reverse' | 'pingpong'

export interface FrameMeta {
  id: string
  /** Display duration in milliseconds (default 100ms; rounded to 10ms / 1cs on GIF export) */
  durationMs: number
}

export type CelRef = { kind: 'empty' } | { kind: 'cel'; celId: string }

/** Map keyed by `${layerId}:${frameId}` */
export type CelMap = Record<string, CelRef>

export interface CelBufferRuntime {
  id: string
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
  data: Uint8ClampedArray
}

export interface CelBufferRecord {
  key: string // `${projectId}:${celId}`
  projectId: string
  celId: string
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
  data: Uint8Array
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
  /** Optional Lospec / attribution metadata preserved locally in IndexedDB */
  author?: string
  sourceUrl?: string
  lospecSlug?: string
  licenseNote?: string
}

export interface ProjectPalette {
  name: string
  colors: string[] // Independent copy for this project (max 256)
  sourcePaletteId?: string
  author?: string
  sourceUrl?: string
}

export interface ProjectRecord {
  id: string
  name: string
  width: number // 1..256
  height: number // 1..256
  layers: LayerMeta[]
  activeLayerId: string
  /** Unified frame timeline: 1 frame = Still artwork, >=2 frames = Animation */
  frames?: FrameMeta[]
  /** Keyed by `${layerId}:${frameId}` */
  cels?: CelMap
  activeFrameId?: string
  defaultFrameDurationMs?: number
  playbackDirection?: PlaybackDirection
  loopPlayback?: boolean
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
  overallScale: number
  toolIconSize: number
  toolButtonHeight: number
  toolLabelSize: number
  swatchSize: number
  checkboxSize: number
  uiGap: number
  drawButtonVh: number
}

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
  /** True when user explicitly selected a history limit in Settings (distinguishes legacy default 100 from user choice) */
  historyLimitCustomized?: boolean
  /** Optional snooze timestamp for Origin low-storage warning */
  lowStorageSnoozedUntil?: number | null
  showGrid: boolean
  checkerboardDark: boolean
  confirmDestructive: boolean
  soundEnabled: boolean
  eyedropperDoubleTap: boolean
  activeProjectId: string | null
  gallerySortMode: 'manual' | 'newest' | 'oldest' | 'updated' | 'name'
  uiSize: UiSizeConfig
  customCanvasPresets: CanvasSizePreset[]
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

export interface ActiveMoveSession {
  mode: 'selection' | 'layer' | 'multi-layer'
  layerId: string
  layerIds: string[]
  initialLayerOffsets: Record<string, { offsetX: number; offsetY: number }>
  dx: number
  dy: number
  initialMask: Uint8Array | null
  clearedLayer: LayerRuntime | null
  extractedBuffer: Uint8ClampedArray | null
  extractedWidth: number
  extractedHeight: number
  extractedOriginX: number
  extractedOriginY: number
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
  gradientType: GradientType
  gradientFixedRatio: boolean
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
  /** Optional shared celBuffer ID for multi-frame / linked-cel sparse Undo/Redo */
  celId?: string
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
  celId?: string
  beforeOffsetX: number
  beforeOffsetY: number
  afterOffsetX: number
  afterOffsetY: number
}

export interface TimelineSnapshot {
  frames: FrameMeta[]
  cels: CelMap
  activeFrameId: string
  celBuffers: Array<{
    id: string
    offsetX: number
    offsetY: number
    dataWidth: number
    dataHeight: number
    data: Uint8Array
  }>
}

export interface CanvasSnapshot {
  width: number
  height: number
  layers: Array<{
    meta: LayerMeta
    data: Uint8Array
  }>
  activeLayerId: string
  timeline?: TimelineSnapshot
}

export interface HistoryEntry {
  id: string
  label: string
  timestamp: number
  kind: 'pixel-diff' | 'structure' | 'selection' | 'palette' | 'layer-offset'
  frameId?: string
  /** If an empty cel was auto-allocated during a stroke, record the cel transition */
  celAllocation?: {
    cellKey: string
    allocatedCelId: string
  }
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
  celId?: string
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
  frameId?: string
  celAllocation?: {
    cellKey: string
    allocatedCelId: string
  }
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
