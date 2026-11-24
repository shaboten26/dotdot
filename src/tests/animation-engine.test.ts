import { describe, expect, it } from 'vitest'
import { createPixelBuffer, getPixel, setPixel } from '../engine/pixelBuffer'
import {
  applyBatchFrameDuration,
  computePlaybackFrameIndices,
  copyCellAsIndependent,
  createSingleFrameTimelineFromLayers,
  deleteFrameFromTimeline,
  getCellStateKind,
  getLinkedFrameIdsForCell,
  insertNewFrame,
  linkCellToSourceCell,
  makeCellKey,
  projectFrameLayers,
  reorderTimelineFrames,
  resolveBatchDurationTargetFrameIds,
  roundDurationToGifMs,
  setCellToEmpty,
  unlinkCellToIndependent,
} from '../engine/animation'
import { estimateProjectLoad } from '../engine/loadEstimator'
import type { LayerRuntime } from '../types'

describe('Unified 1-Frame Still & N-Frame Animation Engine + Load Estimator', () => {
  it('migrates legacy 1-frame layers, links/unlinks/copies/empties cels, and reflects linked edits immediately', () => {
    const buf = createPixelBuffer(8, 8)
    setPixel(buf, 8, 8, 2, 3, { r: 255, g: 0, b: 0, a: 255 })
    const layer: LayerRuntime = {
      id: 'layer-1',
      name: 'Layer 1',
      visible: true,
      opacity: 100,
      blendMode: 'normal',
      clipping: false,
      offsetX: 0,
      offsetY: 0,
      dataWidth: 8,
      dataHeight: 8,
      data: buf,
    }

    let timeline = createSingleFrameTimelineFromLayers([layer], {
      frameId: 'f1',
      defaultFrameDurationMs: 120,
    })
    expect(timeline.frames).toEqual([{ id: 'f1', durationMs: 120 }])
    expect(
      getCellStateKind(timeline.cels, timeline.celBuffers, 'layer-1', 'f1')
    ).toBe('independent')

    // Duplicate frame 1 as Linked cel -> frame 2 shares exact celId!
    timeline = insertNewFrame(timeline, [layer], 'duplicate-linked', 'f1')
    const f2Id = timeline.frames[1]!.id
    expect(timeline.frames[1]!.durationMs).toBe(120)
    expect(
      getCellStateKind(timeline.cels, timeline.celBuffers, 'layer-1', 'f1')
    ).toBe('linked')
    expect(
      getCellStateKind(timeline.cels, timeline.celBuffers, 'layer-1', f2Id)
    ).toBe('linked')
    expect(
      getLinkedFrameIdsForCell(timeline.frames, timeline.cels, 'layer-1', 'f1')
    ).toEqual(['f1', f2Id])

    // Editing shared buffer updates both f1 and f2 immediately
    const sharedRef = timeline.cels[makeCellKey('layer-1', 'f1')]
    expect(sharedRef?.kind).toBe('cel')
    if (sharedRef?.kind === 'cel') {
      setPixel(timeline.celBuffers[sharedRef.celId]!.data, 8, 8, 4, 4, {
        r: 0,
        g: 255,
        b: 0,
        a: 255,
      })
    }
    const f2Projected = projectFrameLayers(
      [layer],
      timeline.cels,
      timeline.celBuffers,
      f2Id,
      8,
      8
    )
    expect(getPixel(f2Projected[0]!.data, 8, 8, 4, 4)).toEqual({
      r: 0,
      g: 255,
      b: 0,
      a: 255,
    })

    // Load estimator counts shared linked cel ONCE and empty cel as 0 bytes!
    timeline = insertNewFrame(timeline, [layer], 'empty', f2Id)
    const f3Id = timeline.frames[2]!.id
    const load = estimateProjectLoad({
      canvasWidth: 8,
      canvasHeight: 8,
      layers: [layer],
      frames: timeline.frames,
      cels: timeline.cels,
      celBuffers: timeline.celBuffers,
    })
    expect(load.emptyCellCount).toBe(1)
    expect(load.linkedCellCount).toBe(2)
    expect(load.uniqueCelBufferCount).toBe(1)
    expect(load.actualCelMemoryBytes).toBe(8 * 8 * 4)

    // Unlink f2 -> becomes independent, further edits do NOT affect f1
    const unlinked = unlinkCellToIndependent(
      timeline.cels,
      timeline.celBuffers,
      'layer-1',
      f2Id
    )
    expect(unlinked.changed).toBe(true)
    timeline = {
      ...timeline,
      cels: unlinked.cels,
      celBuffers: unlinked.celBuffers,
    }
    expect(
      getCellStateKind(timeline.cels, timeline.celBuffers, 'layer-1', 'f1')
    ).toBe('independent')
    expect(
      getCellStateKind(timeline.cels, timeline.celBuffers, 'layer-1', f2Id)
    ).toBe('independent')

    // Copy as independent into empty f3, then link, then set empty
    const copied = copyCellAsIndependent(
      timeline.cels,
      timeline.celBuffers,
      'layer-1',
      'f1',
      f3Id
    )
    expect(copied.changed).toBe(true)
    const relinked = linkCellToSourceCell(
      copied.cels,
      copied.celBuffers,
      'layer-1',
      'f1',
      f3Id
    )
    expect(relinked.changed).toBe(true)
    const emptied = setCellToEmpty(
      relinked.cels,
      relinked.celBuffers,
      'layer-1',
      f3Id
    )
    expect(
      getCellStateKind(emptied.cels, emptied.celBuffers, 'layer-1', f3Id)
    ).toBe('empty')

    // Reorder & delete frames safely (never deletes last remaining frame)
    timeline = reorderTimelineFrames(timeline, [f3Id, 'f1', f2Id])
    expect(timeline.frames.map((f) => f.id)).toEqual([f3Id, 'f1', f2Id])
    timeline = deleteFrameFromTimeline(timeline, f3Id)!
    timeline = deleteFrameFromTimeline(timeline, f2Id)!
    expect(timeline.frames).toHaveLength(1)
    expect(deleteFrameFromTimeline(timeline, 'f1')).toBeNull()
  })

  it('computes forward, reverse, pingpong playback without endpoint double-hold and batch durations', () => {
    expect(computePlaybackFrameIndices(4, 'forward')).toEqual([0, 1, 2, 3])
    expect(computePlaybackFrameIndices(4, 'reverse')).toEqual([3, 2, 1, 0])
    expect(computePlaybackFrameIndices(4, 'pingpong', false)).toEqual([
      0, 1, 2, 3, 2, 1,
    ])
    expect(computePlaybackFrameIndices(4, 'pingpong', true)).toEqual([
      0, 1, 2, 3, 2, 1, 0,
    ])
    expect(computePlaybackFrameIndices(2, 'pingpong', false)).toEqual([0, 1])

    const frames = [
      { id: 'f1', durationMs: 100 },
      { id: 'f2', durationMs: 100 },
      { id: 'f3', durationMs: 100 },
      { id: 'f4', durationMs: 100 },
    ]
    const rangeIds = resolveBatchDurationTargetFrameIds(frames, {
      mode: 'range',
      fromFrameNumber: 2,
      toFrameNumber: 3,
    })
    const updated = applyBatchFrameDuration(frames, rangeIds, 250)
    expect(updated.map((f) => f.durationMs)).toEqual([100, 250, 250, 100])
    expect(roundDurationToGifMs(15)).toEqual({
      centiseconds: 2,
      roundedMs: 20,
      isVeryShort: true,
    })
  })
})
