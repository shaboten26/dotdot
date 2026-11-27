import { ViewTransition, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { AppSettings, ProjectRecord } from '../types'
import { createNewProject, db } from '../db/database'
import { exportEnvironmentPackZip } from '../db/envPack'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../engine/pixelBuffer'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { Modal } from '../components/common/Modal'
import { UnifiedImportModal } from '../components/common/UnifiedImportModal'
import { CameraCaptureModal } from '../components/common/CameraCaptureModal'
import {
  PixelEmptyCanvasArt,
  PixelIcon,
  PixelLoadingIndicator,
} from '../components/common/PixelIcon'
import {
  DotDotAppIcon,
  DotDotWordmark,
} from '../components/common/DotDotBrand'
import { PixelSelect } from '../components/common/PixelSelect'
import { PixelSlider } from '../components/common/PixelSlider'
import { PixelThumbnail } from '../components/common/PixelThumbnail'
import { CanvasSizePresetsPicker } from '../components/common/CanvasSizePresetsPicker'
import { useLongPressReorder } from '../utils/useLongPressReorder'
import { sortProjectsByGalleryMode } from '../utils/gallerySort'
import {
  useViewTransitionNavigate,
  VTButtonLink,
} from '../components/common/ViewTransitionNav'

/**
 * GalleryPage (`/`):
 * - Standard home screen on app startup (never auto-opens an empty canvas).
 * - Section 10: Tapping an artwork tile MUST open the Project Viewing Screen (`/project/:id`), NEVER directly `/editor/:id`!
 * - Uses shared 5 standard + custom `CanvasSizePresetsPicker` in New Artwork modal.
 * - Uses `PixelSelect` for sort order & `useLongPressReorder` for manual reordering.
 * - Section 11: Non-intrusive 30-day / 7-day Environment Pack Backup Reminder banner.
 */
export function GalleryPage() {
  const {
    ready,
    projects,
    palettes,
    settings,
    reducedMotion,
    backupReminderDue,
    originStorageStatus,
    lowStorageWarningDue,
    migrationProgress,
    updateSettings,
    refreshProjects,
    reorderProjectsManual,
    markEnvPackExported,
    snoozeBackupReminder,
    snoozeLowStorageWarning,
    showToast,
  } = useApp()
  const { t } = useI18n()
  const vtNavigate = useViewTransitionNavigate()

  const [newModalOpen, setNewModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [cameraCaptureOpen, setCameraCaptureOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newW, setNewW] = useState(32)
  const [newH, setNewH] = useState(32)
  const [selectedPaletteId, setSelectedPaletteId] = useState<string>(
    () => palettes[0]?.id ?? ''
  )
  const [reorderMode, setReorderMode] = useState(false)
  const gridContainerRef = useRef<HTMLDivElement | null>(null)

  const sortedProjects = useMemo(
    (): ProjectRecord[] =>
      sortProjectsByGalleryMode(projects, settings.gallerySortMode),
    [projects, settings.gallerySortMode]
  )

  const sortedIds = useMemo(
    () => sortedProjects.map((p) => p.id),
    [sortedProjects]
  )

  const { dragState, getItemProps, shouldSuppressClick } = useLongPressReorder({
    ids: sortedIds,
    enabled: settings.gallerySortMode === 'manual' && sortedProjects.length > 1,
    onReorder: (nextIds) => {
      void reorderProjectsManual(nextIds)
    },
    scrollContainerRef: gridContainerRef,
  })

  const openNewProjectModal = () => {
    setSelectedPaletteId(palettes[0]?.id ?? '')
    setNewModalOpen(true)
  }

  const handleCreateArtwork = async () => {
    const chosenPal =
      palettes.find((p) => p.id === selectedPaletteId) ?? palettes[0]
    const w = Math.max(
      MIN_CANVAS_SIZE,
      Math.min(MAX_CANVAS_SIZE, Math.round(newW || 32))
    )
    const h = Math.max(
      MIN_CANVAS_SIZE,
      Math.min(MAX_CANVAS_SIZE, Math.round(newH || 32))
    )
    const title =
      newName.trim() ||
      `${t('untitled')} ${String(projects.length + 1).padStart(2, '0')}`

    const created = await createNewProject(
      {
        name: title,
        width: w,
        height: h,
        palette: {
          name: chosenPal?.name ?? 'Standard',
          colors: chosenPal ? [...chosenPal.colors] : ['#000000', '#FFFFFF'],
          sourcePaletteId: chosenPal?.id,
        },
      },
      db
    )
    await updateSettings({ activeProjectId: created.project.id })
    await refreshProjects()
    setNewModalOpen(false)
    setNewName('')
    vtNavigate(`/editor/${created.project.id}`)
  }

  const moveManualStep = async (projectId: string, delta: -1 | 1) => {
    const manualList = [...projects].sort((a, b) => a.order - b.order)
    const idx = manualList.findIndex((p) => p.id === projectId)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= manualList.length) return
    const ids = manualList.map((p) => p.id)
    const [moved] = ids.splice(idx, 1)
    ids.splice(target, 0, moved)
    await updateSettings({ gallerySortMode: 'manual' })
    await reorderProjectsManual(ids)
  }

  const handleBackupNow = async () => {
    const zipBytes = await exportEnvironmentPackZip()
    const blob = new Blob([zipBytes.slice().buffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const dateStr = new Date().toISOString().slice(0, 10)
    const a = document.createElement('a')
    a.href = url
    a.download = `dotdot-environment-pack-${dateStr}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    await markEnvPackExported()
    showToast(t('toastExportedZip'), 'success')
  }

  const handleRemindLater = async () => {
    await snoozeBackupReminder()
    showToast(t('toastBackupSnoozed'), 'info')
  }

  const sortOptions: Array<{
    value: AppSettings['gallerySortMode']
    label: string
  }> = [
    { value: 'manual', label: t('sortManual') },
    { value: 'newest', label: t('sortNewest') },
    { value: 'oldest', label: t('sortOldest') },
    { value: 'updated', label: t('sortUpdated') },
    { value: 'name', label: t('sortName') },
  ]

  if (!ready) {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center gap-3 px-6 bg-[var(--bg-app)]">
        <PixelLoadingIndicator
          label={
            migrationProgress
              ? `${t('migrationRunningTitle')} (${migrationProgress.completedProjects}/${migrationProgress.totalProjects})`
              : t('loading')
          }
        />
        {migrationProgress?.currentProjectName && (
          <span
            className="text-xs text-[var(--text-secondary)] truncate max-w-xs"
            data-testid="migration-progress-project-name"
          >
            {migrationProgress.currentProjectName}
          </span>
        )}
      </div>
    )
  }

  return (
    <ViewTransition>
      <div className="min-h-dvh w-full flex flex-col bg-[var(--bg-app)] pl-safe pr-safe">
        {/* Retro Pixel Header */}
        <header className="sticky top-0 z-20 px-3.5 py-2.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <DotDotAppIcon
              size={32}
              className="border-2 border-[var(--border-pixel)]"
              testId="gallery-header-app-icon"
            />
            <div className="flex flex-col justify-center gap-0.5">
              <h1 className="m-0 leading-none flex items-center">
                <span className="sr-only">{t('appName')}</span>
                <DotDotWordmark
                  height={15}
                  color="var(--accent-rose)"
                  testId="gallery-header-wordmark"
                />
              </h1>
              <span className="text-[10px] text-[var(--text-secondary)] leading-none">
                {t('galleryTitle')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 relative">
            <button
              type="button"
              onClick={openNewProjectModal}
              className="pixel-btn pixel-btn-active min-h-[44px] px-3.5 text-xs font-bold flex items-center gap-1.5"
              data-testid="new-artwork-btn"
            >
              <PixelIcon name="plus" size={16} />
              <span>{t('newArtwork')}</span>
            </button>

            <button
              type="button"
              onClick={() => setCameraCaptureOpen(true)}
              title={t('cameraCaptureMenuBtn')}
              className="pixel-btn pixel-btn-teal min-h-[44px] px-2.5 text-xs font-bold flex items-center gap-1.5"
              data-testid="gallery-camera-capture-btn"
            >
              <PixelIcon name="camera" size={16} />
              <span className="hidden md:inline">{t('cameraCaptureMenuBtn')}</span>
            </button>

            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              title={t('importArtworkBtn')}
              className="pixel-btn min-h-[44px] px-2.5 text-xs font-bold flex items-center gap-1.5"
              data-testid="gallery-import-menu-btn"
            >
              <PixelIcon name="upload" size={15} />
              <span className="hidden sm:inline">{t('importArtworkBtn')}</span>
            </button>

            <VTButtonLink
              to="/settings"
              title={t('navSettings')}
              className="pixel-btn w-[44px] h-[44px] min-w-[44px] min-h-[44px] p-0 aspect-square shrink-0 flex items-center justify-center"
              data-testid="gallery-settings-btn"
            >
              <PixelIcon name="settings" size={18} />
            </VTButtonLink>
          </div>
        </header>

        {/* Section 12: Origin Low-Storage Backup Warning Banner */}
        {lowStorageWarningDue && (
          <section
            className={`mx-3.5 mt-3 max-w-5xl self-center w-[calc(100%-1.75rem)] p-3.5 pixel-card space-y-2.5 ${
              originStorageStatus.level === 'critical'
                ? 'border-[var(--accent-danger)]'
                : 'border-[var(--accent-amber)]'
            }`}
            data-testid="origin-low-storage-banner"
          >
            <div className="flex items-start gap-2.5">
              <PixelIcon
                name="storage"
                size={18}
                className={`${
                  originStorageStatus.level === 'critical'
                    ? 'text-[var(--accent-danger)]'
                    : 'text-[var(--accent-amber)]'
                } mt-0.5 shrink-0`}
              />
              <div className="space-y-1 flex-1 min-w-0">
                <h2 className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                  {originStorageStatus.level === 'critical'
                    ? t('originLowStorageCriticalTitle')
                    : t('originLowStorageTitle')}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {t('originLowStorageDesc')}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleBackupNow()}
                className="pixel-btn pixel-btn-active min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
                data-testid="origin-low-storage-backup-btn"
              >
                <PixelIcon name="download" size={14} />
                <span>{t('backupNowBtn')}</span>
              </button>
              <button
                type="button"
                onClick={() => void snoozeLowStorageWarning()}
                className="pixel-btn min-h-[38px] px-3 text-xs font-bold"
                data-testid="origin-low-storage-snooze-btn"
              >
                {t('originLowStorageSnoozeBtn')}
              </button>
            </div>
          </section>
        )}

        {/* Section 11: Non-intrusive 30-day / 7-day Environment Pack Backup Reminder */}
        {backupReminderDue && (
          <section
            className="mx-3.5 mt-3 max-w-5xl self-center w-[calc(100%-1.75rem)] p-3.5 pixel-card border-[var(--accent-amber)] space-y-2.5"
            data-testid="backup-reminder-banner"
          >
            <div className="flex items-start gap-2.5">
              <PixelIcon
                name="shield"
                size={18}
                className="text-[var(--accent-amber)] mt-0.5 shrink-0"
              />
              <div className="space-y-1 flex-1 min-w-0">
                <h2 className="text-xs sm:text-sm font-bold text-[var(--text-primary)]">
                  {t('backupReminderTitle')}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {t('backupReminderDesc')}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleBackupNow()}
                className="pixel-btn pixel-btn-active min-h-[38px] px-3 text-xs font-bold flex items-center gap-1.5"
                data-testid="backup-now-btn"
              >
                <PixelIcon name="download" size={14} />
                <span>{t('backupNowBtn')}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleRemindLater()}
                className="pixel-btn min-h-[38px] px-3 text-xs font-bold"
                data-testid="backup-snooze-btn"
              >
                {t('backupRemindLaterBtn')}
              </button>
            </div>
          </section>
        )}

        {sortedProjects.length === 0 ? (
          <main className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
            <div className="pixel-card p-6 sm:p-8 max-w-sm w-full flex flex-col items-center gap-4">
              <DotDotWordmark
                height={20}
                color="var(--accent-rose)"
                testId="empty-gallery-wordmark"
              />
              <PixelEmptyCanvasArt size={108} />
              <div className="space-y-1.5">
                <h2 className="text-base font-bold text-[var(--text-primary)]">
                  {t('emptyGalleryTitle')}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {t('emptyGalleryDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={openNewProjectModal}
                className="w-full min-h-[52px] pixel-btn pixel-btn-active text-sm font-bold flex items-center justify-center gap-2 mt-1"
                data-testid="empty-create-artwork-btn"
              >
                <PixelIcon name="pen" size={18} />
                <span>{t('newArtwork')}</span>
              </button>
            </div>
          </main>
        ) : (
          <>
            {/* Sort & Manual Reorder Bar */}
            <div className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 max-w-5xl w-full mx-auto">
              <div className="flex items-center gap-2">
                <PixelIcon
                  name="sort"
                  size={16}
                  className="text-[var(--text-secondary)]"
                />
                <PixelSelect<AppSettings['gallerySortMode']>
                  value={settings.gallerySortMode}
                  options={sortOptions}
                  onChange={(mode) =>
                    void updateSettings({ gallerySortMode: mode })
                  }
                  ariaLabel={t('sortManual')}
                  className="min-w-[165px]"
                  testId="gallery-sort-select"
                />

                {settings.gallerySortMode === 'manual' && sortedProjects.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setReorderMode((v) => !v)}
                    className={`min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      reorderMode ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
                    data-testid="gallery-toggle-reorder-btn"
                  >
                    <PixelIcon name="move" size={14} />
                    <span>{t('sortManual')}</span>
                  </button>
                )}
              </div>

              {settings.gallerySortMode === 'manual' && (
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {t('dragReorderHint')}
                </span>
              )}
            </div>

            {/* Image-Centric Artwork Grid -> Tapping opens Viewing Screen `/project/:id`! */}
            <main
              ref={gridContainerRef}
              className="flex-1 px-3 sm:px-4 pb-10 pb-safe max-w-5xl w-full mx-auto"
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {sortedProjects.map((proj, idx) => {
                  const isActive = proj.id === settings.activeProjectId
                  const isDraggingThis = dragState?.draggingId === proj.id
                  const isDropTarget =
                    dragState !== null &&
                    dragState.overId === proj.id &&
                    dragState.draggingId !== proj.id

                  return (
                    <motion.div
                      key={proj.id}
                      layout={!reducedMotion && dragState === null}
                      initial={
                        reducedMotion
                          ? false
                          : { opacity: 0, y: 10, scale: 0.98 }
                      }
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      whileHover={
                        reducedMotion || dragState !== null
                          ? undefined
                          : { y: -2 }
                      }
                      whileTap={
                        reducedMotion || dragState !== null
                          ? undefined
                          : { scale: 0.98 }
                      }
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : {
                              type: 'spring',
                              stiffness: 460,
                              damping: 32,
                              mass: 0.8,
                            }
                      }
                    >
                      <div
                        {...getItemProps(proj.id)}
                        onClick={() => {
                          if (shouldSuppressClick()) return
                          if (!reorderMode) {
                            void updateSettings({ activeProjectId: proj.id })
                            // Section 10: Always navigate to Project Viewing Screen (`/project/:id`) first!
                            vtNavigate(`/project/${proj.id}`)
                          }
                        }}
                        className={`group relative flex flex-col pixel-card overflow-hidden cursor-pointer select-none ${
                          isDropTarget
                            ? 'outline-2 outline-dashed outline-[var(--accent-teal)]'
                            : isActive
                              ? 'outline-2 outline-offset-2 outline-[var(--accent-primary)]'
                              : ''
                        } ${isDraggingThis ? 'opacity-65' : ''}`}
                        data-testid={`gallery-tile-${proj.id}`}
                      >
                      <div className="aspect-square w-full overflow-hidden">
                        <ViewTransition name={`artwork-${proj.id}`}>
                          <PixelThumbnail
                            pngBytes={proj.thumbnailPng}
                            alt={proj.name}
                            checkerDark={settings.checkerboardDark}
                            transparentBg={true}
                            className="w-full h-full p-2.5"
                          />
                        </ViewTransition>
                      </div>

                      <div className="px-2.5 py-1.5 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] flex items-center justify-between gap-1.5">
                        <span className="text-xs font-bold truncate">
                          {proj.name}
                        </span>
                        <span className="text-[10px] text-[var(--text-secondary)] shrink-0">
                          {proj.width}×{proj.height}
                        </span>
                      </div>

                      {reorderMode && settings.gallerySortMode === 'manual' && (
                        <div
                          data-no-reorder="true"
                          className="absolute inset-x-1.5 top-1.5 flex items-center justify-between bg-[var(--bg-surface)] border-2 border-[var(--border-pixel)] px-1.5 py-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => void moveManualStep(proj.id, -1)}
                            className="pixel-btn min-w-[34px] min-h-[34px] flex items-center justify-center"
                          >
                            <PixelIcon name="arrowLeft" size={14} />
                          </button>
                          <span className="text-xs font-bold">#{idx + 1}</span>
                          <button
                            type="button"
                            disabled={idx === sortedProjects.length - 1}
                            onClick={() => void moveManualStep(proj.id, 1)}
                            className="pixel-btn min-w-[34px] min-h-[34px] flex items-center justify-center"
                          >
                            <PixelIcon name="arrowRight" size={14} />
                          </button>
                        </div>
                      )}
                      </div>
                    </motion.div>
                  )
                })}
              </div>
            </main>
          </>
        )}

        {/* New Artwork Creation Modal (Unified 5 Standard + Custom Presets!) */}
        <Modal
          open={newModalOpen}
          title={t('newArtwork')}
          onClose={() => setNewModalOpen(false)}
          maxWidthClass="max-w-md"
        >
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => {
                setNewModalOpen(false)
                setCameraCaptureOpen(true)
              }}
              className="w-full min-h-[40px] px-3 pixel-btn pixel-btn-teal text-xs font-bold flex items-center justify-center gap-2"
              data-testid="new-modal-open-camera-btn"
            >
              <PixelIcon name="camera" size={15} />
              <span>{t('cameraCaptureMenuBtn')}</span>
            </button>

            <label className="block space-y-1">
              <span className="text-xs font-bold text-[var(--text-secondary)]">
                {t('artworkName')}
              </span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`${t('untitled')} ${String(projects.length + 1).padStart(2, '0')}`}
                className="w-full min-h-[42px] px-3 text-sm pixel-input"
                data-testid="new-project-name-input"
              />
            </label>

            {/* Section 4-8: Independent Width & Height PixelSliders (1-256px with +-1 step buttons & live numeric display) */}
            <div className="space-y-3 p-3 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">
                    {t('widthPx')}:{' '}
                    <strong className="text-[var(--text-primary)]">{newW}px</strong>
                  </span>
                  <input
                    type="number"
                    min={MIN_CANVAS_SIZE}
                    max={MAX_CANVAS_SIZE}
                    value={newW}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isNaN(v)) {
                        setNewW(
                          Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(v)))
                        )
                      }
                    }}
                    className="w-20 min-h-[34px] px-2 text-xs font-bold text-right pixel-input"
                    data-testid="new-project-width-input"
                  />
                </div>
                <PixelSlider
                  min={MIN_CANVAS_SIZE}
                  max={MAX_CANVAS_SIZE}
                  step={1}
                  value={newW}
                  unit="px"
                  ariaLabel={t('widthPx')}
                  onChange={setNewW}
                  testId="new-project-width-slider"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-[var(--text-secondary)]">
                    {t('heightPx')}:{' '}
                    <strong className="text-[var(--text-primary)]">{newH}px</strong>
                  </span>
                  <input
                    type="number"
                    min={MIN_CANVAS_SIZE}
                    max={MAX_CANVAS_SIZE}
                    value={newH}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isNaN(v)) {
                        setNewH(
                          Math.max(MIN_CANVAS_SIZE, Math.min(MAX_CANVAS_SIZE, Math.round(v)))
                        )
                      }
                    }}
                    className="w-20 min-h-[34px] px-2 text-xs font-bold text-right pixel-input"
                    data-testid="new-project-height-input"
                  />
                </div>
                <PixelSlider
                  min={MIN_CANVAS_SIZE}
                  max={MAX_CANVAS_SIZE}
                  step={1}
                  value={newH}
                  unit="px"
                  ariaLabel={t('heightPx')}
                  onChange={setNewH}
                  testId="new-project-height-slider"
                />
              </div>
            </div>

            <CanvasSizePresetsPicker
              selectedWidth={newW}
              selectedHeight={newH}
              onSelectDimensions={(w, h) => {
                setNewW(w)
                setNewH(h)
              }}
            />

            <div className="space-y-1.5">
              <span className="text-xs font-bold text-[var(--text-secondary)]">
                {t('selectInitialPalette')}
              </span>
              <div className="space-y-1.5 max-h-40 overflow-y-auto p-2 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                {palettes.map((pal) => {
                  const active = pal.id === selectedPaletteId
                  return (
                    <button
                      key={pal.id}
                      type="button"
                      onClick={() => setSelectedPaletteId(pal.id)}
                      className={`w-full p-2 flex items-center justify-between gap-2 text-left border-2 cursor-pointer ${
                        active
                          ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)]'
                          : 'bg-[var(--bg-surface)] border-[var(--border-pixel)]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {active && (
                          <PixelIcon
                            name="check"
                            size={12}
                            className="text-[var(--accent-primary)]"
                          />
                        )}
                        <span className="text-xs font-bold truncate">{pal.name}</span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {pal.colors.slice(0, 8).map((hex, i) => (
                          <span
                            key={i}
                            style={{ backgroundColor: hex }}
                            className="w-3.5 h-3.5 border border-[var(--border-pixel)]"
                          />
                        ))}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => void handleCreateArtwork()}
                className="flex-1 min-h-[48px] pixel-btn pixel-btn-active text-sm font-bold flex items-center justify-center gap-2"
                data-testid="confirm-create-artwork-btn"
              >
                <PixelIcon name="pen" size={18} />
                <span>{t('create')}</span>
              </button>
              <button
                type="button"
                onClick={() => setNewModalOpen(false)}
                className="min-h-[48px] px-4 pixel-btn text-xs font-bold"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </Modal>

        <UnifiedImportModal
          open={importModalOpen}
          onClose={() => setImportModalOpen(false)}
          checkerDark={settings.checkerboardDark}
          onCreatedProject={async (proj, kind) => {
            await refreshProjects()
            if (kind === 'gif') {
              showToast(t('toastImportedGif'), 'success')
            } else if (kind === 'aseprite') {
              showToast(t('toastImportedAseprite'), 'success')
            } else {
              showToast(t('importPngSuccessProject'), 'success')
            }
            vtNavigate(`/editor/${proj.id}`)
          }}
          onError={(msg) => showToast(msg, 'error')}
        />

        <CameraCaptureModal
          open={cameraCaptureOpen}
          onClose={() => setCameraCaptureOpen(false)}
          palettes={palettes}
          checkerDark={settings.checkerboardDark}
          onCreatedProject={async (proj) => {
            await refreshProjects()
            showToast(t('toastCapturedCameraArtwork'), 'success')
            vtNavigate(`/editor/${proj.id}`)
          }}
          onError={(msg) => showToast(msg, 'error')}
        />
      </div>
    </ViewTransition>
  )
}
