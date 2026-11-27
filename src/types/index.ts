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

export type SymmetryMode = 'none' | 'horizontal' | 'vertical' | 'quad'

export type TilePreviewGrid = 'off' | '3x3' | '5x5'

export type SeamlessWrapMode = 'none' | 'horizontal' | 'vertical' | 'both'

export interface StampAsset {
  id: string
  name: string
  width: number // 1..256
  height: number // 1..256
  /** Raw RGBA bytes of length `width * height * 4` */
  data: Uint8Array
  order: number
  createdAt: number
  updatedAt: number
  builtIn?: boolean
}

export interface StampPlacementSession {
  stampId: string
  name: string
  width: number
  height: number
  data: Uint8ClampedArray
  x: number
  y: number
  flipX: boolean
  flipY: boolean
}

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
 * Special UI slot index representing the dedicated leftmost Transparent drawing slot.
 * In 1-byte indexed pixel buffers, transparent pixels are stored as `TRANSPARENT_INDEX` (`255`),
 * while opaque palette colors occupy fixed indices `0 .. 254` (max 255 opaque colors).
 */
export const TRANSPARENT_COLOR_INDEX = -1
export const TRANSPARENT_INDEX = 255
export const MAX_OPAQUE_PALETTE_COLORS = 255

export type LightThemeVariantId =
  | 'lavender-cream'
  | 'peach-cotton'
  | 'mint-pocket'
  | 'antique-brass'
  | 'urban-concrete'
  | 'retro-kissaten'

export type DarkThemeVariantId =
  | 'dusk-plum'
  | 'royal-velvet'
  | 'tokyo-neon'
  | 'urban-graphite'
  | 'forest-apothecary'
  | 'amber-crt'

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
  /**
   * 1-byte per pixel Indexed Color buffer of length `dataWidth * dataHeight`!
   * - `0 .. 254`: Fixed palette index in `project.palette.colorTable`
   * - `255` (`TRANSPARENT_INDEX`): Transparent pixel
   */
  data: Uint8Array
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
  /** 1-byte per pixel Indexed Color buffer (`0..254` fixed palette index, `255` transparent) */
  data: Uint8Array
}

export interface CelBufferRecord {
  key: string // `${projectId}:${celId}`
  projectId: string
  celId: string
  offsetX: number
  offsetY: number
  dataWidth: number
  dataHeight: number
  /** 1-byte per pixel Indexed Color buffer (`dataWidth * dataHeight` bytes) */
  data: Uint8Array
  format?: 'indexed-v1'
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
  /** UI display-ordered opaque `#RRGGBB` colors (max 255 colors; transparent is fixed at left slot `-1` / pixel `255`) */
  colors: string[]
  /**
   * Fixed index table (`0 .. 254` -> `'#RRGGBB' | null`).
   * Pixel buffers reference these immutable indices so reordering `displayOrder` NEVER alters artwork colors!
   */
  colorTable?: Array<string | null>
  /** Visual UI order of active fixed indices (`0 .. 254`), length `1 .. 255` */
  displayOrder?: number[]
  /** Snapshot of `displayOrder` prior to automatic sorting so "元の順番へ戻す" restores display order cleanly */
  originalDisplayOrder?: number[]
  /** Legacy snapshot field retained for backward compatibility */
  originalColors?: string[]
  sourcePaletteId?: string
  author?: string
  sourceUrl?: string
}

export interface ProjectMigrationReport {
  migratedAt: number
  originalOpaqueColorCount: number
  finalOpaqueColorCount: number
  wasQuantized: boolean
  hadSemiTransparentPixels: boolean
  semiTransparentPixelCount: number
  beforePreviewPng?: Uint8Array
  afterPreviewPng?: Uint8Array
}

export interface ProjectRecord {
  id: string
  name: string
  width: number // 1..256
  height: number // 1..256
  /** Storage pixel format: `'indexed-v1'` (1 byte/pixel `0..254` opaque + `255` transparent); undefined on pre-migration RGBA records */
  pixelFormat?: 'indexed-v1'
  migrationReport?: ProjectMigrationReport
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
  /** 1-byte per pixel Indexed Color bytes (`length = dataWidth * dataHeight`) in `indexed-v1` */
  data: Uint8Array
  format?: 'indexed-v1'
  offsetX?: number
  offsetY?: number
  dataWidth?: number
  dataHeight?: number
}

export type ProjectMigrationStage =
  | 'pending'
  | 'backing-up'
  | 'converting'
  | 'verifying'
  | 'completed'
  | 'failed'

export interface MigrationStateRecord {
  projectId: string
  stage: ProjectMigrationStage
  updatedAt: number
  errorMessage?: string
  report?: ProjectMigrationReport
  /** Preserved raw pre-migration snapshot for safe rollback & resumable recovery until verified! */
  backupProject?: ProjectRecord
  backupLayerPixels?: LayerPixelRecord[]
  backupCelBuffers?: CelBufferRecord[]
  backupHistory?: ProjectHistoryRecord
}

export type ThemeMode = 'light' | 'dark' | 'system'

export type LanguageCode = 'ja' | 'en' | 'ko'

export type UiSizePreset = 'compact' | 'standard' | 'large' | 'custom'

export type CursorDisplaySize = 'small' | 'standard' | 'large'

export type CustomCursorGridSize = 8 | 16

export interface CustomCursorData {
  id: string
  name: string
  gridSize: CustomCursorGridSize
  hotspotX: number
  hotspotY: number
  /** Row-major length `gridSize * gridSize` array (`''` = transparent, `'#rrggbb'` = pixel color) */
  pixels: string[]
}

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
  /** Selected light-mode palette variant (hidden behind detailed theme toggle in `/settings`) */
  lightThemeVariant?: LightThemeVariantId
  /** Selected dark-mode palette variant (hidden behind detailed theme toggle in `/settings`) */
  darkThemeVariant?: DarkThemeVariantId
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
  cursorSpeed: number
  cursorSize: CursorDisplaySize
  /** `'standard'` for built-in tool-aware pixel cursor, or a saved `CustomCursorData.id` */
  activeCursorId: string
  customCursors: CustomCursorData[]
  activeProjectId: string | null
  gallerySortMode: 'manual' | 'newest' | 'oldest' | 'updated' | 'name'
  uiSize: UiSizeConfig
  customCanvasPresets: CanvasSizePreset[]
  backupMeta: BackupReminderMeta
  /** Advanced feature defaults & preferences */
  stampsInitialized?: boolean
  defaultSymmetryMode?: SymmetryMode
  showSymmetryGuide?: boolean
  defaultTilePreviewGrid?: TilePreviewGrid
  defaultSeamlessWrapMode?: SeamlessWrapMode
  embedPngMetadata?: boolean
  defaultSpriteSheetScale?: number
  defaultSpriteSheetPadding?: number
  /** Explicit user-selected default selection sub-tool (`'wand' | 'rect' | 'ellipse'`). Unset defaults to `'wand'`. */
  preferredSelectType?: SelectSubTool
  /** True only when the user explicitly chose `preferredSelectType` (prevents legacy implicit `'rect'` defaults from overriding `'wand'`). */
  preferredSelectTypeCustomized?: boolean
}

export interface FloatingShapeState {
  /** 1-byte per pixel Indexed Color buffer (`sourceWidth * sourceHeight`) */
  sourceBuffer: Uint8Array
  sourceWidth: number
  sourceHeight: number
  offsetX: number
  offsetY: number
  rotationDeg: number
}

/**
 * World-space selection mask (`[originX..originX+width-1, originY..originY+height-1]`).
 * Allows selections and selected pixels to move partially or completely outside `[0..canvasW-1, 0..canvasH-1]`
 * without losing selection state or pixel data, and recover cleanly when dragged back inside or undone!
 */
export interface WorldSelectionMask {
  originX: number
  originY: number
  width: number
  height: number
  /** Local binary mask of length `width * height` (`1` = selected, `0` = unselected) */
  mask: Uint8Array
}

export interface ActiveMoveSession {
  mode: 'selection' | 'layer' | 'multi-layer'
  layerId: string
  layerIds: string[]
  initialLayerOffsets: Record<string, { offsetX: number; offsetY: number }>
  dx: number
  dy: number
  initialMask: Uint8Array | null
  initialWorldSelection?: WorldSelectionMask | null
  clearedLayer: LayerRuntime | null
  extractedBuffer: Uint8Array | null
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
  /** 1-byte per pixel Indexed Color buffer (`width * height`; `255` = transparent) */
  data: Uint8Array
  /** Source project ID & fixed-index -> `#RRGGBB` map for seamless cross-project paste */
  sourceProjectId?: string
  sourceColorMap?: Record<number, string>
}

export interface ToolSettings {
  penSize: number
  penShape: BrushShape
  penDither: DitherPatternId
  pixelPerfect: boolean
  /** Optional StampAsset ID tiled as a repeating Pattern Brush during pen strokes */
  patternStampId?: string | null

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
  beforeWorldSelection?: WorldSelectionMask | null
  afterWorldSelection?: WorldSelectionMask | null
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
  beforeWorldSelection?: WorldSelectionMask | null
  afterWorldSelection?: WorldSelectionMask | null
  beforePalette?: ProjectPalette
  afterPalette?: ProjectPalette
}
