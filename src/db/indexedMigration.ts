import {
  MAX_OPAQUE_PALETTE_COLORS,
  TRANSPARENT_COLOR_INDEX,
  TRANSPARENT_INDEX,
  type CanvasSnapshot,
  type CelBufferRecord,
  type CelBufferRuntime,
  type CelMap,
  type FrameMeta,
  type LayerMeta,
  type LayerPixelRecord,
  type LayerRuntime,
  type MigrationStateRecord,
  type ProjectHistoryRecord,
  type ProjectMigrationReport,
  type ProjectPalette,
  type ProjectRecord,
  type SerializedHistoryEntry,
  type SerializedPixelPatch,
  type TimelineSnapshot,
} from '../types'
import {
  clampFrameDurationMs,
  countCelReferences,
  DEFAULT_FRAME_DURATION_MS,
  makeCellKey,
  projectFrameLayers,
} from '../engine/animation'
import { blendChannel, encodeRgbaToPng, exportCompositePngBytes } from '../engine/compositor'
import { clampByte, hexToRgba, normalizeHex, rgbaToHex } from '../engine/color'
import {
  BAYER_4X4,
  convertRgbaBuffersToIndexed,
  findExactFixedIndex,
  findNearestFixedIndex,
  normalizeProjectPalette,
  type QuantizeRgbaSourceInput,
} from '../engine/indexedPalette'
import { createPixelBuffer, normalizeLayerGeometry } from '../engine/pixelBuffer'

/**
 * Composite legacy 4-byte RGBA layers purely in memory to capture `beforePreviewPng` prior to migration.
 */
function renderLegacyRgbaPreviewPng(
  width: number,
  height: number,
  layerMetas: readonly LayerMeta[],
  rgbaByLayerId: ReadonlyMap<
    string,
    { offsetX: number; offsetY: number; dataWidth: number; dataHeight: number; rgba: Uint8Array }
  >
): Uint8Array {
  const out = new Uint8ClampedArray(width * height * 4)

  const sampleView = (
    item: {
      offsetX: number
      offsetY: number
      dataWidth: number
      dataHeight: number
      rgba: Uint8Array
    }
  ): Uint8ClampedArray => {
    const view = new Uint8ClampedArray(width * height * 4)
    const startCx = Math.max(0, item.offsetX)
    const endCx = Math.min(width, item.offsetX + item.dataWidth)
    const startCy = Math.max(0, item.offsetY)
    const endCy = Math.min(height, item.offsetY + item.dataHeight)
    if (startCx >= endCx || startCy >= endCy) return view
    const spanBytes = (endCx - startCx) * 4
    for (let cy = startCy; cy < endCy; cy++) {
      const ly = cy - item.offsetY
      const lx = startCx - item.offsetX
      const sOff = (ly * item.dataWidth + lx) * 4
      const dOff = (cy * width + startCx) * 4
      if (sOff + spanBytes <= item.rgba.length) {
        view.set(item.rgba.subarray(sOff, sOff + spanBytes), dOff)
      }
    }
    return view
  }

  for (const meta of layerMetas) {
    if (!meta.visible || meta.opacity <= 0) continue
    const bufInfo = rgbaByLayerId.get(meta.id)
    if (!bufInfo) continue
    const view = sampleView(bufInfo)
    const opNorm = Math.max(0, Math.min(100, meta.opacity)) / 100

    for (let p = 0; p < width * height; p++) {
      const idx = p * 4
      const rawA = view[idx + 3]!
      if (rawA === 0) continue
      const saNorm = (rawA / 255) * opNorm
      const daNorm = out[idx + 3]! / 255
      if (daNorm <= 0) {
        out[idx] = view[idx]!
        out[idx + 1] = view[idx + 1]!
        out[idx + 2] = view[idx + 2]!
        out[idx + 3] = clampByte(saNorm * 255)
        continue
      }
      const br = out[idx]! / 255
      const bg = out[idx + 1]! / 255
      const bb = out[idx + 2]! / 255
      const srN = view[idx]! / 255
      const sgN = view[idx + 1]! / 255
      const sbN = view[idx + 2]! / 255
      const cr =
        meta.blendMode === 'normal'
          ? srN
          : (1 - daNorm) * srN + daNorm * blendChannel(meta.blendMode, br, srN)
      const cg =
        meta.blendMode === 'normal'
          ? sgN
          : (1 - daNorm) * sgN + daNorm * blendChannel(meta.blendMode, bg, sgN)
      const cb =
        meta.blendMode === 'normal'
          ? sbN
          : (1 - daNorm) * sbN + daNorm * blendChannel(meta.blendMode, bb, sbN)
      const outA = saNorm + daNorm * (1 - saNorm)
      if (outA <= 0) continue
      out[idx] = clampByte(((saNorm * cr + daNorm * br * (1 - saNorm)) / outA) * 255)
      out[idx + 1] = clampByte(((saNorm * cg + daNorm * bg * (1 - saNorm)) / outA) * 255)
      out[idx + 2] = clampByte(((saNorm * cb + daNorm * bb * (1 - saNorm)) / outA) * 255)
      out[idx + 3] = clampByte(outA * 255)
    }
  }

  return encodeRgbaToPng(out, width, height)
}

export function isProjectAlreadyIndexed(
  project: ProjectRecord,
  layerPixels: readonly LayerPixelRecord[],
  celBuffers: readonly CelBufferRecord[]
): boolean {
  if (project.pixelFormat !== 'indexed-v1') return false
  for (const c of celBuffers) {
    if (c.data.byteLength !== c.dataWidth * c.dataHeight) return false
  }
  for (const l of layerPixels) {
    const meta = project.layers.find((m) => m.id === l.layerId)
    const w = l.dataWidth ?? meta?.dataWidth ?? project.width
    const h = l.dataHeight ?? meta?.dataHeight ?? project.height
    if (l.data.byteLength !== w * h) return false
  }
  return true
}

function mapSingleRgbaToIndex(
  r: number,
  g: number,
  b: number,
  a: number,
  x: number,
  y: number,
  palette: ProjectPalette,
  cache: Map<string, number>
): number {
  if (a === 0) return TRANSPARENT_INDEX
  if (a < 255) {
    const threshold = (BAYER_4X4[(y & 3) * 4 + (x & 3)]! + 0.5) * (255 / 16)
    if (a < threshold) return TRANSPARENT_INDEX
  }
  const hex = rgbaToHex({ r, g, b }).toUpperCase()
  const hit = cache.get(hex)
  if (hit !== undefined) return hit
  const exact = findExactFixedIndex(palette, hex)
  const resolved =
    exact >= 0 ? exact : findNearestFixedIndex(palette, r, g, b)
  cache.set(hex, resolved)
  return resolved
}

function convertBufferBytesIfRgba(
  raw: Uint8Array,
  w: number,
  h: number,
  palette: ProjectPalette,
  cache: Map<string, number>
): Uint8Array {
  const expectedIndexed = w * h
  if (raw.byteLength === expectedIndexed) {
    return new Uint8Array(raw)
  }
  const out = createPixelBuffer(w, h)
  const maxPx = Math.min(expectedIndexed, Math.floor(raw.byteLength / 4))
  for (let p = 0; p < maxPx; p++) {
    const off = p * 4
    const x = p % w
    const y = (p - x) / w
    out[p] = mapSingleRgbaToIndex(
      raw[off]!,
      raw[off + 1]!,
      raw[off + 2]!,
      raw[off + 3]!,
      x,
      y,
      palette,
      cache
    )
  }
  return out
}

function convertHistorySnapshotToIndexed(
  snap: CanvasSnapshot | undefined,
  palette: ProjectPalette,
  cache: Map<string, number>
): CanvasSnapshot | undefined {
  if (!snap) return undefined
  const layers = snap.layers.map((l) => {
    const w = l.meta.dataWidth ?? snap.width
    const h = l.meta.dataHeight ?? snap.height
    return {
      meta: { ...l.meta, dataWidth: w, dataHeight: h },
      data: convertBufferBytesIfRgba(l.data, w, h, palette, cache),
    }
  })
  const timeline: TimelineSnapshot | undefined = snap.timeline
    ? {
        frames: snap.timeline.frames.map((f) => ({ ...f })),
        cels: { ...snap.timeline.cels },
        activeFrameId: snap.timeline.activeFrameId,
        celBuffers: snap.timeline.celBuffers.map((cb) => ({
          ...cb,
          data: convertBufferBytesIfRgba(
            cb.data,
            cb.dataWidth,
            cb.dataHeight,
            palette,
            cache
          ),
        })),
      }
    : undefined
  return {
    width: snap.width,
    height: snap.height,
    activeLayerId: snap.activeLayerId,
    layers,
    ...(timeline ? { timeline } : {}),
  }
}

function convertHistoryEntryToIndexed(
  entry: SerializedHistoryEntry,
  canvasWidth: number,
  palette: ProjectPalette,
  cache: Map<string, number>
): SerializedHistoryEntry {
  const pixelPatches: SerializedPixelPatch[] | undefined = entry.pixelPatches?.map(
    (p) => {
      const n = p.indices.length
      if (p.before.byteLength === n && p.after.byteLength === n) {
        return {
          ...p,
          indices: new Uint32Array(p.indices),
          before: new Uint8Array(p.before),
          after: new Uint8Array(p.after),
        }
      }
      const strideW =
        p.afterGeometry && p.beforeGeometry
          ? Math.max(
              1,
              Math.max(
                p.beforeGeometry.offsetX + p.beforeGeometry.dataWidth,
                p.afterGeometry.offsetX + p.afterGeometry.dataWidth
              ) - Math.min(p.beforeGeometry.offsetX, p.afterGeometry.offsetX)
            )
          : p.afterGeometry?.dataWidth ?? canvasWidth

      const before = new Uint8Array(n)
      const after = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        const pxPos = p.indices[i]!
        const x = pxPos % Math.max(1, strideW)
        const y = Math.floor(pxPos / Math.max(1, strideW))
        const off = i * 4
        before[i] =
          off + 3 < p.before.length
            ? mapSingleRgbaToIndex(
                p.before[off]!,
                p.before[off + 1]!,
                p.before[off + 2]!,
                p.before[off + 3]!,
                x,
                y,
                palette,
                cache
              )
            : TRANSPARENT_INDEX
        after[i] =
          off + 3 < p.after.length
            ? mapSingleRgbaToIndex(
                p.after[off]!,
                p.after[off + 1]!,
                p.after[off + 2]!,
                p.after[off + 3]!,
                x,
                y,
                palette,
                cache
              )
            : TRANSPARENT_INDEX
      }
      return {
        ...p,
        indices: new Uint32Array(p.indices),
        before,
        after,
      }
    }
  )

  return {
    ...entry,
    ...(pixelPatches ? { pixelPatches } : {}),
    beforeStructure: convertHistorySnapshotToIndexed(
      entry.beforeStructure,
      palette,
      cache
    ),
    afterStructure: convertHistorySnapshotToIndexed(
      entry.afterStructure,
      palette,
      cache
    ),
    beforePalette: entry.beforePalette
      ? normalizeProjectPalette({
          ...entry.beforePalette,
          colors: entry.beforePalette.colors.slice(0, MAX_OPAQUE_PALETTE_COLORS),
        })
      : undefined,
    afterPalette: entry.afterPalette
      ? normalizeProjectPalette({
          ...entry.afterPalette,
          colors: entry.afterPalette.colors.slice(0, MAX_OPAQUE_PALETTE_COLORS),
        })
      : undefined,
  }
}

export interface ConvertedProjectBundle {
  project: ProjectRecord
  layerPixels: LayerPixelRecord[]
  celBuffers: CelBufferRecord[]
  history: ProjectHistoryRecord
  report: ProjectMigrationReport
}

/**
 * Convert a single project's legacy RGBA records (`celBuffers`, `layerPixels`, `history`, `palette`)
 * into verified 1-byte Indexed Color records (`pixelFormat: 'indexed-v1'`).
 * - Preserves Linked Cel sharing (`celId` deduplication — never duplicates shared buffers!)
 * - Preserves existing palette colors when total unique opaque colors <= 255
 * - Uses CIELAB perceptual quantization when unique opaque colors > 255
 * - Approximates semi-transparent pixels (`0 < a < 255`) with 4x4 Ordered Bayer alpha dithering
 * - Generates `beforePreviewPng` & `afterPreviewPng` whenever quantization or semi-transparent approximation occurs!
 */
export function convertLegacyProjectDataToIndexed(params: {
  project: ProjectRecord
  layerPixels: readonly LayerPixelRecord[]
  celBuffers: readonly CelBufferRecord[]
  history?: ProjectHistoryRecord | null
}): ConvertedProjectBundle {
  const { project, layerPixels, celBuffers, history } = params
  const now = Date.now()

  if (isProjectAlreadyIndexed(project, layerPixels, celBuffers)) {
    const normPal = normalizeProjectPalette(project.palette)
    const report: ProjectMigrationReport = project.migrationReport ?? {
      migratedAt: now,
      originalOpaqueColorCount: normPal.colors.length,
      finalOpaqueColorCount: normPal.colors.length,
      wasQuantized: false,
      hadSemiTransparentPixels: false,
      semiTransparentPixelCount: 0,
    }
    return {
      project: {
        ...project,
        pixelFormat: 'indexed-v1',
        palette: normPal,
      },
      layerPixels: layerPixels.map((l) => ({
        ...l,
        format: 'indexed-v1',
        data: new Uint8Array(l.data),
      })),
      celBuffers: celBuffers.map((c) => ({
        ...c,
        format: 'indexed-v1',
        data: new Uint8Array(c.data),
      })),
      history: history
        ? {
            ...history,
            undoStack: [...history.undoStack],
            redoStack: [...history.redoStack],
          }
        : {
            projectId: project.id,
            undoStack: [],
            redoStack: [],
            updatedAt: project.updatedAt,
          },
      report,
    }
  }

  // Normalize layer geometries & map raw RGBA buffers
  const layerRowById = new Map<string, LayerPixelRecord>()
  for (const r of layerPixels) {
    layerRowById.set(r.layerId, r)
  }

  const celRowById = new Map<string, CelBufferRecord>()
  for (const r of celBuffers) {
    celRowById.set(r.celId, r)
  }

  const hasTimelineCels =
    Array.isArray(project.frames) &&
    project.frames.length >= 1 &&
    project.cels &&
    (celBuffers.length > 0 ||
      Object.values(project.cels).every((ref) => ref.kind === 'empty'))

  const frames: FrameMeta[] =
    Array.isArray(project.frames) && project.frames.length >= 1
      ? project.frames.map((f) => ({
          id: f.id,
          durationMs: clampFrameDurationMs(f.durationMs),
        }))
      : [
          {
            id: 'frame-1',
            durationMs: clampFrameDurationMs(
              project.defaultFrameDurationMs ?? DEFAULT_FRAME_DURATION_MS
            ),
          },
        ]

  const firstFrameId = frames[0]!.id
  const activeFrameId =
    project.activeFrameId && frames.some((f) => f.id === project.activeFrameId)
      ? project.activeFrameId
      : firstFrameId

  // Build unique quantization sources without duplicating shared Linked Cels!
  const quantSources: QuantizeRgbaSourceInput[] = []
  let resolvedCels: CelMap = {}
  const celGeometries = new Map<
    string,
    { offsetX: number; offsetY: number; dataWidth: number; dataHeight: number }
  >()

  // Also build Frame 1 legacy RGBA map for accurate `beforePreviewPng`
  const frame1LegacyRgba = new Map<
    string,
    { offsetX: number; offsetY: number; dataWidth: number; dataHeight: number; rgba: Uint8Array }
  >()

  if (hasTimelineCels && project.cels) {
    resolvedCels = { ...project.cels }
    const referencedCelIds = new Set<string>()
    for (const ref of Object.values(resolvedCels)) {
      if (ref?.kind === 'cel') referencedCelIds.add(ref.celId)
    }

    for (const celId of referencedCelIds) {
      const row = celRowById.get(celId)
      if (!row) continue
      const geo = normalizeLayerGeometry(
        {
          offsetX: row.offsetX,
          offsetY: row.offsetY,
          dataWidth: row.dataWidth,
          dataHeight: row.dataHeight,
        },
        project.width,
        project.height
      )
      celGeometries.set(celId, geo)
      if (row.data.byteLength === geo.dataWidth * geo.dataHeight) {
        // Already 1-byte indexed buffer (e.g. mixed fallback): expand temporarily with current palette for unified palette build
        const tmpPal = normalizeProjectPalette(project.palette)
        const rgba = new Uint8Array(geo.dataWidth * geo.dataHeight * 4)
        for (let p = 0; p < row.data.length; p++) {
          const idx = row.data[p]!
          if (idx === TRANSPARENT_INDEX) continue
          const hex = tmpPal.colorTable![idx]
          if (!hex) continue
          const c = hexToRgba(hex)
          rgba[p * 4] = c.r
          rgba[p * 4 + 1] = c.g
          rgba[p * 4 + 2] = c.b
          rgba[p * 4 + 3] = 255
        }
        quantSources.push({
          id: `cel:${celId}`,
          width: geo.dataWidth,
          height: geo.dataHeight,
          rgba,
        })
      } else {
        const safeRgba = new Uint8Array(geo.dataWidth * geo.dataHeight * 4)
        safeRgba.set(row.data.subarray(0, Math.min(row.data.length, safeRgba.length)))
        quantSources.push({
          id: `cel:${celId}`,
          width: geo.dataWidth,
          height: geo.dataHeight,
          rgba: safeRgba,
        })
      }
    }

    for (const layerMeta of project.layers) {
      const ref = resolvedCels[makeCellKey(layerMeta.id, firstFrameId)]
      if (ref?.kind === 'cel') {
        const src = quantSources.find((q) => q.id === `cel:${ref.celId}`)
        const geo = celGeometries.get(ref.celId)
        if (src && geo) {
          frame1LegacyRgba.set(layerMeta.id, {
            ...geo,
            rgba: new Uint8Array(src.rgba),
          })
        }
      }
    }
  } else {
    // Legacy v1/v2 project stored only in `layerPixels`
    for (let i = 0; i < project.layers.length; i++) {
      const meta = project.layers[i]!
      const row = layerRowById.get(meta.id)
      const geo = normalizeLayerGeometry(
        {
          offsetX: meta.offsetX ?? row?.offsetX,
          offsetY: meta.offsetY ?? row?.offsetY,
          dataWidth: meta.dataWidth ?? row?.dataWidth,
          dataHeight: meta.dataHeight ?? row?.dataHeight,
        },
        project.width,
        project.height
      )
      const celId = `cel-${meta.id}`
      celGeometries.set(celId, geo)
      resolvedCels[makeCellKey(meta.id, firstFrameId)] = { kind: 'cel', celId }

      const safeRgba = new Uint8Array(geo.dataWidth * geo.dataHeight * 4)
      if (row?.data) {
        if (row.data.byteLength === geo.dataWidth * geo.dataHeight) {
          const tmpPal = normalizeProjectPalette(project.palette)
          for (let p = 0; p < row.data.length; p++) {
            const idx = row.data[p]!
            if (idx === TRANSPARENT_INDEX) continue
            const hex = tmpPal.colorTable![idx]
            if (!hex) continue
            const c = hexToRgba(hex)
            safeRgba[p * 4] = c.r
            safeRgba[p * 4 + 1] = c.g
            safeRgba[p * 4 + 2] = c.b
            safeRgba[p * 4 + 3] = 255
          }
        } else {
          safeRgba.set(row.data.subarray(0, Math.min(row.data.length, safeRgba.length)))
        }
      }
      quantSources.push({
        id: `cel:${celId}`,
        width: geo.dataWidth,
        height: geo.dataHeight,
        rgba: safeRgba,
      })
      frame1LegacyRgba.set(meta.id, { ...geo, rgba: safeRgba })
    }
  }

  const beforePreviewPng = renderLegacyRgbaPreviewPng(
    project.width,
    project.height,
    project.layers,
    frame1LegacyRgba
  )

  // Convert all unique cel buffers at once using a shared perceptual 255-color palette
  const converted = convertRgbaBuffersToIndexed(quantSources, project.palette)
  const nextPalette = converted.palette

  // Preserve `selectedColorIndex` pointing to the same color in `nextPalette`
  let nextSelectedColorIndex = project.selectedColorIndex
  if (project.selectedColorIndex === TRANSPARENT_COLOR_INDEX) {
    nextSelectedColorIndex = TRANSPARENT_COLOR_INDEX
  } else {
    const prevHex = normalizeHex(
      project.palette.colors[project.selectedColorIndex] ?? ''
    )
    if (prevHex) {
      const fIdx = findExactFixedIndex(nextPalette, prevHex)
      if (fIdx >= 0) {
        nextSelectedColorIndex = Math.max(0, nextPalette.displayOrder!.indexOf(fIdx))
      } else {
        const c = hexToRgba(prevHex)
        const nearFixed = findNearestFixedIndex(nextPalette, c.r, c.g, c.b)
        nextSelectedColorIndex = Math.max(0, nextPalette.displayOrder!.indexOf(nearFixed))
      }
    } else {
      nextSelectedColorIndex = 0
    }
  }

  const nextCelRecords: CelBufferRecord[] = []
  const runtimeCelBuffers: Record<string, CelBufferRuntime> = {}

  for (const [celId, geo] of celGeometries.entries()) {
    const indexedBuf =
      converted.buffers.get(`cel:${celId}`) ??
      createPixelBuffer(geo.dataWidth, geo.dataHeight)
    nextCelRecords.push({
      key: `${project.id}:${celId}`,
      projectId: project.id,
      celId,
      offsetX: geo.offsetX,
      offsetY: geo.offsetY,
      dataWidth: geo.dataWidth,
      dataHeight: geo.dataHeight,
      data: new Uint8Array(indexedBuf),
      format: 'indexed-v1',
    })
    runtimeCelBuffers[celId] = {
      id: celId,
      offsetX: geo.offsetX,
      offsetY: geo.offsetY,
      dataWidth: geo.dataWidth,
      dataHeight: geo.dataHeight,
      data: new Uint8Array(indexedBuf),
    }
  }

  // Project active frame layers & Frame 1 layers for `layerPixels` and `afterPreviewPng`
  const activeLayers = projectFrameLayers(
    project.layers,
    resolvedCels,
    runtimeCelBuffers,
    activeFrameId,
    project.width,
    project.height
  )
  const frame1Layers = projectFrameLayers(
    project.layers,
    resolvedCels,
    runtimeCelBuffers,
    firstFrameId,
    project.width,
    project.height
  )

  const nextLayerRecords: LayerPixelRecord[] = activeLayers.map((l) => ({
    key: `${project.id}:${l.id}`,
    projectId: project.id,
    layerId: l.id,
    data: new Uint8Array(l.data),
    format: 'indexed-v1',
    offsetX: l.offsetX,
    offsetY: l.offsetY,
    dataWidth: l.dataWidth,
    dataHeight: l.dataHeight,
  }))

  const { png: afterPreviewPng } = exportCompositePngBytes(
    frame1Layers,
    project.width,
    project.height,
    1,
    { palette: nextPalette }
  )

  const colorCache = new Map<string, number>()
  const nextHistory: ProjectHistoryRecord = {
    projectId: project.id,
    undoStack: (history?.undoStack ?? []).map((e) =>
      convertHistoryEntryToIndexed(e, project.width, nextPalette, colorCache)
    ),
    redoStack: (history?.redoStack ?? []).map((e) =>
      convertHistoryEntryToIndexed(e, project.width, nextPalette, colorCache)
    ),
    updatedAt: history?.updatedAt ?? project.updatedAt,
  }

  const hasVisualApproximation =
    converted.wasQuantized || converted.hadSemiTransparentPixels

  const report: ProjectMigrationReport = {
    migratedAt: now,
    originalOpaqueColorCount: converted.originalOpaqueColorCount,
    finalOpaqueColorCount: converted.finalOpaqueColorCount,
    wasQuantized: converted.wasQuantized,
    hadSemiTransparentPixels: converted.hadSemiTransparentPixels,
    semiTransparentPixelCount: converted.semiTransparentPixelCount,
    ...(hasVisualApproximation
      ? { beforePreviewPng, afterPreviewPng }
      : {}),
  }

  const nextProject: ProjectRecord = {
    ...project,
    pixelFormat: 'indexed-v1',
    migrationReport: report,
    layers: project.layers.map((m) => {
      const projL = activeLayers.find((al) => al.id === m.id)
      return {
        ...m,
        offsetX: projL?.offsetX ?? m.offsetX ?? 0,
        offsetY: projL?.offsetY ?? m.offsetY ?? 0,
        dataWidth: projL?.dataWidth ?? m.dataWidth ?? project.width,
        dataHeight: projL?.dataHeight ?? m.dataHeight ?? project.height,
      }
    }),
    frames,
    cels: resolvedCels,
    activeFrameId,
    palette: nextPalette,
    selectedColorIndex: nextSelectedColorIndex,
    thumbnailPng: afterPreviewPng,
  }

  verifyConvertedProjectBundle({
    originalProject: project,
    originalCels: hasTimelineCels && project.cels ? project.cels : resolvedCels,
    bundle: {
      project: nextProject,
      layerPixels: nextLayerRecords,
      celBuffers: nextCelRecords,
      history: nextHistory,
      report,
    },
  })

  return {
    project: nextProject,
    layerPixels: nextLayerRecords,
    celBuffers: nextCelRecords,
    history: nextHistory,
    report,
  }
}

/**
 * Strict Structural & Byte-Length Invariant Verifier (Section 8-5):
 * Throws immediately BEFORE any legacy data is discarded if any layer, frame, linked-cel reference,
 * palette slot limit, or 1-byte buffer size fails validation!
 */
export function verifyConvertedProjectBundle(params: {
  originalProject: ProjectRecord
  originalCels: CelMap
  bundle: ConvertedProjectBundle
}): void {
  const { originalProject, originalCels, bundle } = params
  const { project, layerPixels, celBuffers } = bundle

  if (project.pixelFormat !== 'indexed-v1') {
    throw new Error('MIGRATION_VERIFY_FAILED: Missing indexed-v1 pixelFormat tag')
  }
  if (project.layers.length !== originalProject.layers.length) {
    throw new Error('MIGRATION_VERIFY_FAILED: Layer count mismatch')
  }
  const origFrameCount = Math.max(1, originalProject.frames?.length ?? 1)
  if ((project.frames?.length ?? 0) !== origFrameCount) {
    throw new Error('MIGRATION_VERIFY_FAILED: Frame count mismatch')
  }
  if (
    !project.palette.colors.length ||
    project.palette.colors.length > MAX_OPAQUE_PALETTE_COLORS
  ) {
    throw new Error(
      `MIGRATION_VERIFY_FAILED: Palette color count ${project.palette.colors.length} out of bounds (1..255)`
    )
  }

  // Verify Linked Cel sharing topology is 100% preserved
  const origRefCounts = countCelReferences(originalCels)
  const newRefCounts = countCelReferences(project.cels ?? {})
  const celMap = new Map(celBuffers.map((c) => [c.celId, c]))

  for (const [celId, expectedRefs] of Object.entries(origRefCounts)) {
    if (newRefCounts[celId] !== expectedRefs) {
      throw new Error(
        `MIGRATION_VERIFY_FAILED: Linked cel reference count changed for ${celId}`
      )
    }
    const buf = celMap.get(celId)
    if (!buf) {
      throw new Error(`MIGRATION_VERIFY_FAILED: Missing converted celBuffer ${celId}`)
    }
    if (buf.data.byteLength !== buf.dataWidth * buf.dataHeight) {
      throw new Error(
        `MIGRATION_VERIFY_FAILED: Invalid 1-byte celBuffer size for ${celId}`
      )
    }
  }

  if (layerPixels.length !== project.layers.length) {
    throw new Error('MIGRATION_VERIFY_FAILED: layerPixels count mismatch')
  }
  for (const lp of layerPixels) {
    const w = lp.dataWidth ?? project.width
    const h = lp.dataHeight ?? project.height
    if (lp.data.byteLength !== w * h) {
      throw new Error(
        `MIGRATION_VERIFY_FAILED: Invalid 1-byte layerPixel size for ${lp.layerId}`
      )
    }
  }
}

export interface MigrationProgressInfo {
  completedProjects: number
  totalProjects: number
  currentProjectId: string
  currentProjectName: string
}

export interface DatabaseMigrationSummary {
  totalChecked: number
  migratedCount: number
  alreadyIndexedCount: number
  quantizedProjectIds: string[]
  semiTransparentProjectIds: string[]
  failedProjectIds: Array<{ projectId: string; error: string }>
}

export interface MigrationCapableDb {
  projects: {
    toArray(): Promise<ProjectRecord[]>
    get(id: string): Promise<ProjectRecord | undefined>
    put(record: ProjectRecord): Promise<unknown>
  }
  layerPixels: {
    where(index: string): {
      equals(val: string): {
        toArray(): Promise<LayerPixelRecord[]>
        delete(): Promise<unknown>
      }
    }
    bulkPut(records: LayerPixelRecord[]): Promise<unknown>
  }
  celBuffers: {
    where(index: string): {
      equals(val: string): {
        toArray(): Promise<CelBufferRecord[]>
        delete(): Promise<unknown>
      }
    }
    bulkPut(records: CelBufferRecord[]): Promise<unknown>
  }
  histories: {
    get(id: string): Promise<ProjectHistoryRecord | undefined>
    put(record: ProjectHistoryRecord): Promise<unknown>
  }
  migrationStates: {
    get(id: string): Promise<MigrationStateRecord | undefined>
    put(record: MigrationStateRecord): Promise<unknown>
    toArray(): Promise<MigrationStateRecord[]>
  }
  transaction<T>(
    mode: 'rw' | 'r',
    tables: unknown[],
    scope: () => Promise<T>
  ): Promise<T>
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Restore a project from its preserved `MigrationStateRecord` backup if an error or quota failure occurred!
 */
export async function rollbackProjectFromMigrationBackup(
  targetDb: MigrationCapableDb,
  projectId: string
): Promise<boolean> {
  const state = await targetDb.migrationStates.get(projectId)
  if (!state || !state.backupProject) return false

  await targetDb.transaction(
    'rw',
    [
      targetDb.projects,
      targetDb.layerPixels,
      targetDb.celBuffers,
      targetDb.histories,
      targetDb.migrationStates,
    ],
    async () => {
      await targetDb.projects.put(state.backupProject!)
      await targetDb.layerPixels.where('projectId').equals(projectId).delete()
      if (state.backupLayerPixels && state.backupLayerPixels.length > 0) {
        await targetDb.layerPixels.bulkPut(state.backupLayerPixels)
      }
      await targetDb.celBuffers.where('projectId').equals(projectId).delete()
      if (state.backupCelBuffers && state.backupCelBuffers.length > 0) {
        await targetDb.celBuffers.bulkPut(state.backupCelBuffers)
      }
      if (state.backupHistory) {
        await targetDb.histories.put(state.backupHistory)
      }
      await targetDb.migrationStates.put({
        ...state,
        stage: 'failed',
        updatedAt: Date.now(),
      })
    }
  )
  return true
}

/**
 * Staged, Resumable, Quota-Safe Database Migration to 1-byte Indexed Color (Section 8-5 & 8-6):
 * - Processes projects ONE BY ONE (never loads all RGBA buffers into RAM at once).
 * - Saves a full per-project backup in `migrationStates` BEFORE touching project data,
 *   so an interrupted browser close or crash resumes cleanly from the pristine backup!
 * - Never deletes old data on `QuotaExceededError`; rolls back cleanly from backup on any failure.
 */
export async function migrateDatabaseToIndexedColor(
  targetDb: MigrationCapableDb,
  options?: {
    onProgress?: (info: MigrationProgressInfo) => void
    yieldBetweenProjects?: boolean
  }
): Promise<DatabaseMigrationSummary> {
  const allProjects = await targetDb.projects.toArray()
  const summary: DatabaseMigrationSummary = {
    totalChecked: allProjects.length,
    migratedCount: 0,
    alreadyIndexedCount: 0,
    quantizedProjectIds: [],
    semiTransparentProjectIds: [],
    failedProjectIds: [],
  }

  if (allProjects.length === 0) return summary

  // Identify projects requiring migration or recovery from an interrupted in-flight state
  const pendingIds: Array<{ id: string; name: string }> = []
  for (const proj of allProjects) {
    const existingState = await targetDb.migrationStates.get(proj.id)
    if (
      existingState &&
      (existingState.stage === 'backing-up' ||
        existingState.stage === 'converting' ||
        existingState.stage === 'verifying')
    ) {
      pendingIds.push({ id: proj.id, name: proj.name })
      continue
    }

    const lRows = await targetDb.layerPixels
      .where('projectId')
      .equals(proj.id)
      .toArray()
    const cRows = await targetDb.celBuffers
      .where('projectId')
      .equals(proj.id)
      .toArray()

    if (isProjectAlreadyIndexed(proj, lRows, cRows)) {
      summary.alreadyIndexedCount++
      if (proj.migrationReport?.wasQuantized) {
        summary.quantizedProjectIds.push(proj.id)
      }
      if (proj.migrationReport?.hadSemiTransparentPixels) {
        summary.semiTransparentProjectIds.push(proj.id)
      }
    } else {
      pendingIds.push({ id: proj.id, name: proj.name })
    }
  }

  for (let i = 0; i < pendingIds.length; i++) {
    const item = pendingIds[i]!
    options?.onProgress?.({
      completedProjects: i,
      totalProjects: pendingIds.length,
      currentProjectId: item.id,
      currentProjectName: item.name,
    })

    if (options?.yieldBetweenProjects) {
      await yieldEventLoop()
    }

    let backupRecord: MigrationStateRecord | undefined
    try {
      const existingState = await targetDb.migrationStates.get(item.id)

      let srcProject: ProjectRecord
      let srcLayerPixels: LayerPixelRecord[]
      let srcCelBuffers: CelBufferRecord[]
      let srcHistory: ProjectHistoryRecord | undefined

      if (existingState?.backupProject) {
        // Resuming from an interrupted run -> use pristine pre-migration backup!
        srcProject = existingState.backupProject
        srcLayerPixels = existingState.backupLayerPixels ?? []
        srcCelBuffers = existingState.backupCelBuffers ?? []
        srcHistory = existingState.backupHistory
        backupRecord = existingState
      } else {
        const loadedProj = await targetDb.projects.get(item.id)
        if (!loadedProj) continue
        srcProject = loadedProj
        srcLayerPixels = await targetDb.layerPixels
          .where('projectId')
          .equals(item.id)
          .toArray()
        srcCelBuffers = await targetDb.celBuffers
          .where('projectId')
          .equals(item.id)
          .toArray()
        srcHistory = await targetDb.histories.get(item.id)

        // Stage 1: Persist safe rollback snapshot BEFORE mutating any project store!
        backupRecord = {
          projectId: item.id,
          stage: 'backing-up',
          updatedAt: Date.now(),
          backupProject: {
            ...srcProject,
            layers: srcProject.layers.map((l) => ({ ...l })),
            palette: {
              ...srcProject.palette,
              colors: [...srcProject.palette.colors],
            },
          },
          backupLayerPixels: srcLayerPixels.map((r) => ({
            ...r,
            data: new Uint8Array(r.data),
          })),
          backupCelBuffers: srcCelBuffers.map((r) => ({
            ...r,
            data: new Uint8Array(r.data),
          })),
          ...(srcHistory ? { backupHistory: srcHistory } : {}),
        }
        await targetDb.migrationStates.put(backupRecord)
      }

      // Stage 2: Convert in memory & verify structural/byte invariants
      await targetDb.migrationStates.put({
        ...backupRecord,
        stage: 'converting',
        updatedAt: Date.now(),
      })

      const bundle = convertLegacyProjectDataToIndexed({
        project: srcProject,
        layerPixels: srcLayerPixels,
        celBuffers: srcCelBuffers,
        history: srcHistory ?? null,
      })

      await targetDb.migrationStates.put({
        ...backupRecord,
        stage: 'verifying',
        updatedAt: Date.now(),
        report: bundle.report,
      })

      // Stage 3: Atomically commit verified 1-byte Indexed Color records
      await targetDb.transaction(
        'rw',
        [
          targetDb.projects,
          targetDb.layerPixels,
          targetDb.celBuffers,
          targetDb.histories,
        ],
        async () => {
          await targetDb.projects.put(bundle.project)
          await targetDb.layerPixels.where('projectId').equals(item.id).delete()
          if (bundle.layerPixels.length > 0) {
            await targetDb.layerPixels.bulkPut(bundle.layerPixels)
          }
          await targetDb.celBuffers.where('projectId').equals(item.id).delete()
          if (bundle.celBuffers.length > 0) {
            await targetDb.celBuffers.bulkPut(bundle.celBuffers)
          }
          await targetDb.histories.put(bundle.history)
        }
      )

      // Post-write read-back verification before releasing backup payload!
      const verifyProj = await targetDb.projects.get(item.id)
      const verifyCels = await targetDb.celBuffers
        .where('projectId')
        .equals(item.id)
        .toArray()
      const verifyLayers = await targetDb.layerPixels
        .where('projectId')
        .equals(item.id)
        .toArray()

      if (
        !verifyProj ||
        !isProjectAlreadyIndexed(verifyProj, verifyLayers, verifyCels)
      ) {
        throw new Error('POST_WRITE_VERIFY_FAILED: Stored records failed indexed check')
      }

      // Stage 4: Release heavy RGBA backup bytes now that new data is verified safely on disk
      await targetDb.migrationStates.put({
        projectId: item.id,
        stage: 'completed',
        updatedAt: Date.now(),
        report: bundle.report,
      })

      summary.migratedCount++
      if (bundle.report.wasQuantized) {
        summary.quantizedProjectIds.push(item.id)
      }
      if (bundle.report.hadSemiTransparentPixels) {
        summary.semiTransparentProjectIds.push(item.id)
      }
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Unknown migration error'
      summary.failedProjectIds.push({ projectId: item.id, error: errMsg })

      // Roll back from backup so user's original artwork is NEVER corrupted or deleted!
      try {
        if (backupRecord?.backupProject) {
          await rollbackProjectFromMigrationBackup(targetDb, item.id)
          const st = await targetDb.migrationStates.get(item.id)
          if (st) {
            await targetDb.migrationStates.put({
              ...st,
              stage: 'failed',
              errorMessage: errMsg,
              updatedAt: Date.now(),
            })
          }
        } else {
          await targetDb.migrationStates.put({
            projectId: item.id,
            stage: 'failed',
            errorMessage: errMsg,
            updatedAt: Date.now(),
          })
        }
      } catch {
        // Keep backup untouched in migrationStates for manual retry
      }
    }
  }

  return summary
}


