import { ViewTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { motion } from 'motion/react'
import type { LayerRuntime, ProjectRecord } from '../types'
import {
  db,
  deleteProjectById,
  duplicateProjectById,
  estimateSingleProjectStorageBytes,
  formatByteSize,
  loadProjectFull,
  saveProjectFull,
  type SingleProjectSizeEstimate,
} from '../db/database'

type LoadedProjectFull = NonNullable<Awaited<ReturnType<typeof loadProjectFull>>>
import { exportCompositePngBytes } from '../engine/compositor'
import { computePlaybackFrameIndices, projectFrameLayers, type TimelineState } from '../engine/animation'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { ConfirmDialog } from '../components/common/Modal'
import { PixelIcon, PixelLoadingIndicator } from '../components/common/PixelIcon'
import { UnifiedExportModal } from '../components/editor/UnifiedExportModal'
import { ExportSpriteSheetModal } from '../components/editor/ExportSpriteSheetModal'
import { ExportAsepriteModal } from '../components/common/AsepriteModals'
import { sortProjectsByGalleryMode } from '../utils/gallerySort'
import {
  useViewTransitionNavigate,
  VTButtonLink,
} from '../components/common/ViewTransitionNav'

interface CachedArtworkPayload {
  full: LoadedProjectFull
  est: SingleProjectSizeEstimate | null
}

/**
 * Project Viewing Screen (`/project/:id`):
 * - Official destination when tapping an artwork in the Gallery!
 * - Supports left/right horizontal swipe to switch to next/previous artwork
 *   strictly following the active Gallery sort order (`settings.gallerySortMode`),
 *   with neighbor prefetching and guards against vertical scroll / pinch-zoom / multi-touch.
 * - GIF Export is shown ONLY for animation artworks (`frameCount >= 2`).
 */
export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const {
    projects,
    settings,
    reducedMotion,
    updateSettings,
    refreshProjects,
    showToast,
  } = useApp()
  const { t, language } = useI18n()
  const vtNavigate = useViewTransitionNavigate()

  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [layers, setLayers] = useState<LayerRuntime[]>([])
  const [timeline, setTimeline] = useState<TimelineState | null>(null)
  const [sizeEstimate, setSizeEstimate] = useState<SingleProjectSizeEstimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportSpriteOpen, setExportSpriteOpen] = useState(false)
  const [exportAseOpen, setExportAseOpen] = useState(false)
  const [animStepIdx, setAnimStepIdx] = useState(0)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [swipeDir, setSwipeDir] = useState<-1 | 0 | 1>(0)
  const [swipeDragX, setSwipeDragX] = useState(0)

  // Prefetch cache for neighbor artworks so horizontal swipe transitions feel instant
  const prefetchCacheRef = useRef<Map<string, CachedArtworkPayload>>(new Map())

  const sortedProjects = useMemo(
    () => sortProjectsByGalleryMode(projects, settings.gallerySortMode),
    [projects, settings.gallerySortMode]
  )

  // Immediate synchronous fallback from AppContext.projects so ViewTransition snapshots
  // always capture `artwork-${id}` on the very first synchronous frame (`flushSync`)!
  const summaryProject = useMemo(
    () => (id ? projects.find((p) => p.id === id) ?? null : null),
    [projects, id]
  )
  const displayProject = project ?? summaryProject

  const currentIndex = useMemo(
    () => (id ? sortedProjects.findIndex((p) => p.id === id) : -1),
    [sortedProjects, id]
  )

  const prevProject =
    currentIndex > 0 ? sortedProjects[currentIndex - 1] ?? null : null
  const nextProject =
    currentIndex >= 0 && currentIndex < sortedProjects.length - 1
      ? sortedProjects[currentIndex + 1] ?? null
      : null

  // Load current project (using prefetched cache immediately when available)
  useEffect(() => {
    if (!id) return
    let cancelled = false

    const cached = prefetchCacheRef.current.get(id)
    if (cached) {
      setProject(cached.full.project)
      setLayers(cached.full.layers)
      setTimeline(cached.full.timeline)
      setNameDraft(cached.full.project.name)
      setSizeEstimate(cached.est)
      setLoading(false)
    } else {
      setProject(null)
      setLayers([])
      setTimeline(null)
      if (summaryProject) {
        setNameDraft(summaryProject.name)
      }
      setLoading(true)
    }

    void (async () => {
      const [full, est] = await Promise.all([
        loadProjectFull(id, db),
        estimateSingleProjectStorageBytes(id, db),
      ])
      if (cancelled) return
      if (full) {
        prefetchCacheRef.current.set(id, { full, est })
        setProject(full.project)
        setLayers(full.layers)
        setTimeline(full.timeline)
        setNameDraft(full.project.name)
      } else if (!cached) {
        setProject(null)
      }
      setSizeEstimate(est)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [id])

  // Prefetch previous & next artworks in gallery order
  useEffect(() => {
    let cancelled = false
    const neighbors = [prevProject?.id, nextProject?.id].filter(
      (nid): nid is string => Boolean(nid && !prefetchCacheRef.current.has(nid))
    )
    if (neighbors.length === 0) return

    void (async () => {
      for (const nid of neighbors) {
        const [full, est] = await Promise.all([
          loadProjectFull(nid, db),
          estimateSingleProjectStorageBytes(nid, db),
        ])
        if (cancelled) return
        if (full) {
          if (prefetchCacheRef.current.size >= 8) {
            const oldestKey = prefetchCacheRef.current.keys().next().value
            if (oldestKey) prefetchCacheRef.current.delete(oldestKey)
          }
          prefetchCacheRef.current.set(nid, { full, est })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [prevProject?.id, nextProject?.id])

  const goToNeighbor = useCallback(
    (target: ProjectRecord | null, dir: -1 | 1 = 1) => {
      if (!target) return
      setSwipeDragX(0)
      setSwipeDir(dir)
      setEditingName(false)
      setExportOpen(false)
      setExportSpriteOpen(false)
      setExportAseOpen(false)
      setConfirmDeleteOpen(false)
      vtNavigate(`/project/${target.id}`)
    },
    [vtNavigate]
  )

  // Optional keyboard ArrowLeft / ArrowRight navigation when not editing inputs or modals
  useEffect(() => {
    if (sortedProjects.length <= 1) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        editingName ||
        exportOpen ||
        exportSpriteOpen ||
        exportAseOpen ||
        confirmDeleteOpen
      ) {
        return
      }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft' && prevProject) {
        e.preventDefault()
        goToNeighbor(prevProject, -1)
      } else if (e.key === 'ArrowRight' && nextProject) {
        e.preventDefault()
        goToNeighbor(nextProject, 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    sortedProjects.length,
    editingName,
    exportOpen,
    exportSpriteOpen,
    exportAseOpen,
    confirmDeleteOpen,
    prevProject,
    nextProject,
    goToNeighbor,
  ])

  // Horizontal swipe gesture tracking (strictly separated from vertical scroll, multi-touch, and pinch-zoom)
  const activePointersRef = useRef<Set<number>>(new Set())
  const swipeStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    lockedAxis: 'none' | 'horizontal' | 'vertical'
    aborted: boolean
  } | null>(null)

  const isViewportZoomed = () => {
    if (typeof window === 'undefined') return false
    const vv = window.visualViewport
    return Boolean(vv && vv.scale > 1.05)
  }

  const handleSwipePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.add(e.pointerId)

    // Multi-touch or pinch-zoom -> immediately abort any swipe tracking
    if (
      activePointersRef.current.size > 1 ||
      sortedProjects.length <= 1 ||
      editingName ||
      exportOpen ||
      exportSpriteOpen ||
      exportAseOpen ||
      confirmDeleteOpen ||
      isViewportZoomed()
    ) {
      if (swipeStateRef.current) {
        swipeStateRef.current.aborted = true
      }
      swipeStateRef.current = null
      return
    }

    if (e.pointerType === 'mouse' && e.button !== 0) return

    // Ignore interactive controls so buttons/inputs never trigger swipe
    const targetEl = e.target as HTMLElement | null
    if (
      targetEl?.closest(
        'button, a, input, textarea, select, [role="button"], [data-no-artwork-swipe="true"]'
      )
    ) {
      return
    }

    // Avoid browser OS screen-edge back/forward swipe zone (left/right 18px)
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0
    if (vw > 120 && (e.clientX < 18 || e.clientX > vw - 18)) {
      return
    }

    swipeStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lockedAxis: 'none',
      aborted: false,
    }
  }

  const handleSwipePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = swipeStateRef.current
    if (!st || st.pointerId !== e.pointerId || st.aborted) return

    if (activePointersRef.current.size > 1 || isViewportZoomed()) {
      st.aborted = true
      swipeStateRef.current = null
      return
    }

    st.lastX = e.clientX
    st.lastY = e.clientY
    const dx = st.lastX - st.startX
    const dy = st.lastY - st.startY
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)

    if (st.lockedAxis === 'none' && (absX >= 12 || absY >= 12)) {
      if (absY >= absX * 0.8) {
        // User is scrolling vertically -> cancel horizontal swipe cleanly
        st.lockedAxis = 'vertical'
        st.aborted = true
        swipeStateRef.current = null
        setSwipeDragX(0)
        return
      }
      st.lockedAxis = 'horizontal'
    }

    if (st.lockedAxis === 'horizontal' && !reducedMotion) {
      const canGoDirection = (dx < 0 && nextProject) || (dx > 0 && prevProject)
      const damped = canGoDirection
        ? Math.max(-44, Math.min(44, Math.round(dx * 0.28)))
        : Math.max(-14, Math.min(14, Math.round(dx * 0.1)))
      setSwipeDragX(damped)
    }
  }

  const handleSwipePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId)
    const st = swipeStateRef.current
    swipeStateRef.current = null
    setSwipeDragX(0)

    if (
      !st ||
      st.pointerId !== e.pointerId ||
      st.aborted ||
      activePointersRef.current.size > 0 ||
      isViewportZoomed()
    ) {
      return
    }

    const dx = (e.clientX ?? st.lastX) - st.startX
    const dy = (e.clientY ?? st.lastY) - st.startY
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)

    // Require intentional horizontal swipe (>= 48px and clearly horizontal)
    if (absX < 48 || absX <= absY * 1.35) return

    if (dx < 0 && nextProject) {
      // Left swipe -> Next artwork in Gallery order
      goToNeighbor(nextProject, 1)
    } else if (dx > 0 && prevProject) {
      // Right swipe -> Previous artwork in Gallery order
      goToNeighbor(prevProject, -1)
    }
  }

  const handleSwipePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId)
    swipeStateRef.current = null
    setSwipeDragX(0)
  }

  // Precompute crisp base64 PNG frames for multi-frame artworks so the viewing screen animates smoothly!
  const animatedPreviewFrames = useMemo(() => {
    if (!project || !timeline || timeline.frames.length < 2 || layers.length === 0) {
      return null
    }
    const previewScale = Math.max(
      1,
      Math.min(16, Math.floor(1024 / Math.max(1, project.width, project.height)))
    )
    const indices = computePlaybackFrameIndices(
      timeline.frames.length,
      timeline.playbackDirection,
      !timeline.loopPlayback
    )
    if (indices.length === 0) return null

    const frameUrlByRawIdx = new Map<number, string>()
    return indices.map((rawIdx) => {
      const f = timeline.frames[rawIdx]!
      let dataUrl = frameUrlByRawIdx.get(rawIdx)
      if (!dataUrl) {
        const projected = projectFrameLayers(
          layers,
          timeline.cels,
          timeline.celBuffers,
          f.id,
          project.width,
          project.height
        )
        const pngBytes = exportCompositePngBytes(
          projected,
          project.width,
          project.height,
          previewScale,
          { palette: project.palette }
        ).png
        let binary = ''
        const chunk = 0x8000
        for (let i = 0; i < pngBytes.length; i += chunk) {
          binary += String.fromCharCode(...pngBytes.subarray(i, i + chunk))
        }
        dataUrl = `data:image/png;base64,${btoa(binary)}`
        frameUrlByRawIdx.set(rawIdx, dataUrl)
      }
      return {
        url: dataUrl,
        durationMs: Math.max(20, f.durationMs || 100),
      }
    })
  }, [project, timeline, layers])

  useEffect(() => {
    setAnimStepIdx(0)
  }, [id, animatedPreviewFrames])

  useEffect(() => {
    if (!animatedPreviewFrames || animatedPreviewFrames.length < 2) return
    const loopEnabled = timeline?.loopPlayback ?? true
    if (!loopEnabled && animStepIdx >= animatedPreviewFrames.length - 1) {
      return
    }
    const currentFrame = animatedPreviewFrames[animStepIdx] ?? animatedPreviewFrames[0]!
    const timer = window.setTimeout(() => {
      setAnimStepIdx((prev) => {
        const next = prev + 1
        if (next >= animatedPreviewFrames.length) {
          return loopEnabled ? 0 : animatedPreviewFrames.length - 1
        }
        return next
      })
    }, currentFrame.durationMs)
    return () => window.clearTimeout(timer)
  }, [animatedPreviewFrames, animStepIdx, timeline?.loopPlayback])

  // Generate crisp preview PNG URL (long-press friendly on iOS Safari / PWA),
  // using summaryProject.thumbnailPng immediately before full layers finish hydrating!
  const previewPngBytes = useMemo(() => {
    if (!displayProject) return null
    if (!project || layers.length === 0) {
      return displayProject.thumbnailPng ?? null
    }
    const previewScale = Math.max(
      1,
      Math.min(16, Math.floor(1024 / Math.max(1, project.width, project.height)))
    )
    return exportCompositePngBytes(
      layers,
      project.width,
      project.height,
      previewScale,
      { palette: project.palette }
    ).png
  }, [displayProject, project, layers])

  // Synchronous data/object URL fallback so the very first render inside startViewTransition has real pixels
  const previewUrl = useMemo(() => {
    if (animatedPreviewFrames && animatedPreviewFrames.length >= 2) {
      const safeIdx = Math.min(animStepIdx, animatedPreviewFrames.length - 1)
      return animatedPreviewFrames[safeIdx]?.url ?? animatedPreviewFrames[0]!.url
    }
    if (!previewPngBytes || previewPngBytes.length === 0) return null
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < previewPngBytes.length; i += chunk) {
      binary += String.fromCharCode(...previewPngBytes.subarray(i, i + chunk))
    }
    return `data:image/png;base64,${btoa(binary)}`
  }, [animatedPreviewFrames, animStepIdx, previewPngBytes])

  const formatDateTime = (ms: number) => {
    try {
      return new Intl.DateTimeFormat(
        language === 'ja' ? 'ja-JP' : language === 'ko' ? 'ko-KR' : 'en-US',
        {
          dateStyle: 'medium',
          timeStyle: 'short',
        }
      ).format(new Date(ms))
    } catch {
      return new Date(ms).toLocaleString()
    }
  }

  const handleSaveRename = async () => {
    setEditingName(false)
    if (!project) return
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === project.name) {
      setNameDraft(project.name)
      return
    }
    const updated: ProjectRecord = { ...project, name: trimmed }
    await saveProjectFull({ project: updated, layers, timeline: timeline ?? undefined }, db)
    setProject(updated)
    prefetchCacheRef.current.delete(updated.id)
    await refreshProjects()
  }

  const handleOpenInEditor = async () => {
    const target = project ?? displayProject
    if (!target) return
    void updateSettings({ activeProjectId: target.id })
    vtNavigate(`/editor/${target.id}`)
  }

  const handleDuplicateArtwork = async () => {
    const target = project ?? displayProject
    if (!target) return
    const duplicated = await duplicateProjectById(target.id, undefined, db)
    if (!duplicated) return
    await refreshProjects()
    showToast(t('toastDuplicatedArtwork'), 'success')
    vtNavigate(`/project/${duplicated.id}`)
  }

  const handleDeleteArtwork = async () => {
    const target = project ?? displayProject
    if (!target) return
    prefetchCacheRef.current.delete(target.id)
    await deleteProjectById(target.id, db)
    await refreshProjects()
    setConfirmDeleteOpen(false)
    vtNavigate('/', { replace: true })
  }

  if (loading && !displayProject) {
    return (
      <div className="h-dvh flex items-center justify-center bg-[var(--bg-app)]">
        <PixelLoadingIndicator label={t('loading')} />
      </div>
    )
  }

  if (!displayProject) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center gap-4 bg-[var(--bg-app)]">
        <VTButtonLink
          to="/"
          className="min-h-[44px] px-5 pixel-btn pixel-btn-active text-xs font-bold flex items-center gap-2"
        >
          <PixelIcon name="back" size={16} />
          <span>{t('back')}</span>
        </VTButtonLink>
      </div>
    )
  }

  const activeProject = displayProject
  const frameCount = timeline?.frames.length ?? activeProject.frames?.length ?? 1
  const isAnimationArtwork = frameCount >= 2

  return (
    <ViewTransition>
      <div
        className="min-h-dvh w-full flex flex-col bg-[var(--bg-app)] pl-safe pr-safe touch-pan-y"
        onPointerDown={handleSwipePointerDown}
        onPointerMove={handleSwipePointerMove}
        onPointerUp={handleSwipePointerUp}
        onPointerCancel={handleSwipePointerCancel}
        data-testid="project-detail-swipe-surface"
      >
        <header className="sticky top-0 z-20 px-3.5 py-2.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2">
          <VTButtonLink
            to="/"
            className="pixel-btn min-h-[44px] px-3 text-xs font-bold flex items-center gap-1.5"
            data-testid="detail-back-btn"
          >
            <PixelIcon name="back" size={16} />
            <span>{t('back')}</span>
          </VTButtonLink>

          <h1 className="text-sm font-bold truncate" data-testid="detail-header-title">
            {activeProject.name}
          </h1>

          <button
            type="button"
            onClick={() => {
              if (settings.confirmDestructive) {
                setConfirmDeleteOpen(true)
              } else {
                void handleDeleteArtwork()
              }
            }}
            className="pixel-btn pixel-btn-danger min-h-[44px] px-3 text-xs font-bold flex items-center gap-1.5"
            data-testid="detail-delete-btn"
          >
            <PixelIcon name="trash" size={16} />
            <span>{t('delete')}</span>
          </button>
        </header>

        <main className="flex-1 max-w-2xl w-full mx-auto p-4 pb-12 pb-safe space-y-4">
          {/* Large Pixel-Art Preview (Long-pressable native <img> + ViewTransition + directional swipe motion, solid background matching page --bg-app).
              Uses explicit `min(100%, 50dvh)` height so portrait (`height > width`) and landscape (`width > height`) artworks ALWAYS fit completely inside the frame! */}
          <motion.div
            key={activeProject.id}
            initial={
              reducedMotion || swipeDir === 0
                ? { opacity: 1, x: 0 }
                : { opacity: 0.72, x: swipeDir * 24 }
            }
            animate={{ opacity: 1, x: swipeDragX }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 36, mass: 0.85 }
            }
            style={{
              height: 'min(50dvh, calc(100vw - 2rem))',
            }}
            className="aspect-square max-h-[50dvh] w-full max-w-[50dvh] mx-auto border-2 border-[var(--border-pixel)] bg-[var(--bg-app)] overflow-hidden flex items-center justify-center p-4"
            data-testid="detail-preview-card"
          >
            <div className="w-full h-full min-w-0 min-h-0 flex items-center justify-center">
              <ViewTransition name={`artwork-${activeProject.id}`}>
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={activeProject.name}
                    draggable={false}
                    style={{
                      aspectRatio: `${activeProject.width} / ${activeProject.height}`,
                    }}
                    className="w-full h-full max-w-full max-h-full object-contain pixelated block select-none"
                    data-testid="detail-preview-img"
                    data-animated={isAnimationArtwork ? 'true' : 'false'}
                    data-anim-step={isAnimationArtwork ? String(animStepIdx) : undefined}
                  />
                ) : (
                  <div className="w-full h-full" />
                )}
              </ViewTransition>
            </div>
          </motion.div>

          {/* Neighbor Navigation Indicator (shown when gallery has >= 2 artworks) */}
          {sortedProjects.length > 1 && currentIndex >= 0 && (
            <div
              className="flex items-center justify-between gap-2 px-2.5 py-1.5 pixel-card text-xs"
              data-testid="detail-neighbor-nav"
            >
              <button
                type="button"
                disabled={!prevProject}
                onClick={() => goToNeighbor(prevProject, -1)}
                className="pixel-btn min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="detail-prev-artwork-btn"
              >
                <PixelIcon name="arrowLeft" size={13} />
                <span className="truncate max-w-[110px]">
                  {prevProject ? prevProject.name : '—'}
                </span>
              </button>

              <span
                className="text-xs font-bold text-[var(--text-secondary)] shrink-0"
                data-testid="detail-artwork-position"
              >
                {currentIndex + 1} / {sortedProjects.length}
              </span>

              <button
                type="button"
                disabled={!nextProject}
                onClick={() => goToNeighbor(nextProject, 1)}
                className="pixel-btn min-h-[34px] px-2.5 text-xs font-bold flex items-center gap-1"
                data-testid="detail-next-artwork-btn"
              >
                <span className="truncate max-w-[110px]">
                  {nextProject ? nextProject.name : '—'}
                </span>
                <PixelIcon name="arrowRight" size={13} />
              </button>
            </div>
          )}

          {/* Primary Edit Button + Unified Export Button (`画像を出力` / `アニメーションを出力`) + Duplicate + Secondary Exports */}
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => void handleOpenInEditor()}
              className="w-full min-h-[52px] px-4 pixel-btn pixel-btn-active text-sm font-bold flex items-center justify-center gap-2"
              data-testid="detail-open-editor-btn"
            >
              <PixelIcon name="pen" size={18} />
              <span>{t('openInEditor')}</span>
            </button>

            <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setExportOpen(true)}
                className="min-h-[48px] px-2.5 pixel-btn pixel-btn-teal text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 min-w-0"
                data-testid="detail-export-btn"
              >
                <PixelIcon
                  name={isAnimationArtwork ? 'film' : 'download'}
                  size={15}
                />
                <span className="truncate">
                  {isAnimationArtwork
                    ? t('exportAnimationBtn')
                    : t('exportImageBtn')}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleDuplicateArtwork()}
                className="min-h-[48px] px-2.5 pixel-btn text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5 min-w-0"
                data-testid="detail-duplicate-btn"
              >
                <PixelIcon name="copy" size={15} />
                <span className="truncate">{t('duplicate')}</span>
              </button>
            </div>

            <div
              className={`grid gap-2.5 ${
                isAnimationArtwork
                  ? 'grid-cols-1 min-[420px]:grid-cols-2'
                  : 'grid-cols-1'
              }`}
            >
              {isAnimationArtwork && (
                <button
                  type="button"
                  disabled={!timeline || layers.length === 0}
                  onClick={() => setExportSpriteOpen(true)}
                  className="min-h-[42px] px-2.5 pixel-btn text-xs font-bold flex items-center justify-center gap-1.5 min-w-0"
                  data-testid="detail-export-spritesheet-btn"
                >
                  <PixelIcon name="sheet" size={14} />
                  <span className="truncate">{t('exportSpriteSheet')}</span>
                </button>
              )}

              <button
                type="button"
                disabled={!timeline || layers.length === 0}
                onClick={() => setExportAseOpen(true)}
                className="min-h-[42px] px-2.5 pixel-btn text-xs font-bold flex items-center justify-center gap-1.5 min-w-0"
                data-testid="detail-export-aseprite-btn"
              >
                <PixelIcon name="aseprite" size={14} />
                <span className="truncate">{t('exportAseprite')}</span>
              </button>
            </div>
          </div>

          {/* Metadata Card */}
          <section className="pixel-card divide-y-2 divide-[var(--border-subtle)]">
            <div className="p-3.5 flex items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-secondary)] shrink-0">
                {t('artworkName')}
              </span>
              {editingName ? (
                <input
                  type="text"
                  autoFocus
                  value={nameDraft}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => void handleSaveRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveRename()
                    else if (e.key === 'Escape') {
                      setEditingName(false)
                      setNameDraft(activeProject.name)
                    }
                  }}
                  className="min-h-[34px] px-2.5 text-sm font-bold pixel-input text-right"
                  data-testid="detail-rename-input"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  disabled={!project}
                  className="flex items-center gap-1.5 text-sm font-bold cursor-pointer hover:text-[var(--accent-primary)]"
                  data-testid="detail-rename-btn"
                >
                  <span>{activeProject.name}</span>
                  <PixelIcon name="edit" size={14} />
                </button>
              )}
            </div>

            <MetaRow
              label={t('canvasSize')}
              value={`${activeProject.width} × ${activeProject.height} px`}
            />
            <MetaRow
              label={t('layerCount')}
              value={`${activeProject.layers.length}`}
            />
            {isAnimationArtwork && (
              <MetaRow
                label={t('frameCount')}
                value={`${frameCount}`}
                testId="detail-frame-count"
              />
            )}
            <MetaRow
              label={t('artworkDataSizeLabel')}
              value={formatByteSize(sizeEstimate?.totalBytes ?? null)}
              testId="detail-project-size"
            />
            <MetaRow
              label={t('createdAt')}
              value={formatDateTime(activeProject.createdAt)}
            />
            <MetaRow
              label={t('updatedAt')}
              value={formatDateTime(activeProject.updatedAt)}
            />

            <div className="p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)]">
                  {t('usedPalette')}
                </span>
                <span className="text-xs font-bold">
                  {activeProject.palette.name} ({activeProject.palette.colors.length}{' '}
                  {t('colorsCount')})
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {activeProject.palette.colors.slice(0, 48).map((hex, idx) => (
                  <span
                    key={idx}
                    style={{ backgroundColor: hex }}
                    className="w-5 h-5 border-2 border-[var(--border-pixel)]"
                    title={hex}
                  />
                ))}
              </div>
            </div>
          </section>
        </main>

        <UnifiedExportModal
          open={exportOpen}
          mode={isAnimationArtwork ? 'animation' : 'still'}
          projectName={activeProject.name}
          width={activeProject.width}
          height={activeProject.height}
          palette={activeProject.palette}
          layers={layers}
          layerMetas={layers}
          frames={timeline?.frames}
          cels={timeline?.cels}
          celBuffers={timeline?.celBuffers}
          defaultDirection={timeline?.playbackDirection}
          defaultLoop={timeline?.loopPlayback}
          checkerDark={settings.checkerboardDark}
          onClose={() => setExportOpen(false)}
          onDownloaded={() => showToast(t('toastExportedFile'), 'success')}
          onShared={() => showToast(t('toastSharedFile'), 'success')}
        />

        {timeline && layers.length > 0 && (
          <>
            {isAnimationArtwork && (
              <ExportSpriteSheetModal
                open={exportSpriteOpen}
                onClose={() => setExportSpriteOpen(false)}
                projectName={activeProject.name}
                width={activeProject.width}
                height={activeProject.height}
                palette={activeProject.palette}
                layerMetas={layers}
                frames={timeline.frames}
                cels={timeline.cels}
                celBuffers={timeline.celBuffers}
                fallbackSingleFrameLayers={layers}
                defaultDirection={timeline.playbackDirection}
                checkerDark={settings.checkerboardDark}
                onExportedPng={() => showToast(t('toastExportedSpriteSheet'), 'success')}
                onExportedJson={() => showToast(t('toastExportedSpriteJson'), 'success')}
              />
            )}

            <ExportAsepriteModal
              open={exportAseOpen}
              onClose={() => setExportAseOpen(false)}
              projectName={activeProject.name}
              width={activeProject.width}
              height={activeProject.height}
              layerMetas={layers}
              frames={timeline.frames}
              cels={timeline.cels}
              celBuffers={timeline.celBuffers}
              fallbackSingleFrameLayers={layers}
              palette={activeProject.palette}
              paletteColors={activeProject.palette.colors}
              onExported={() => showToast(t('toastExportedAseprite'), 'success')}
            />
          </>
        )}

        <ConfirmDialog
          open={confirmDeleteOpen}
          title={t('delete')}
          message={t('deleteArtworkConfirm')}
          confirmLabel={t('delete')}
          destructive
          onConfirm={() => void handleDeleteArtwork()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      </div>
    </ViewTransition>
  )
}

function MetaRow({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId?: string
}) {
  return (
    <div className="p-3.5 flex items-center justify-between gap-3">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="text-xs font-bold" data-testid={testId}>
        {value}
      </span>
    </div>
  )
}
