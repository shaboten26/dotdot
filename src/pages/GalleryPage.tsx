import { ViewTransition, useMemo, useRef, useState } from 'react'
import type { AppSettings, ProjectRecord } from '../types'
import { createNewProject, db } from '../db/database'
import { exportEnvironmentPackZip } from '../db/envPack'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../engine/pixelBuffer'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { Modal } from '../components/common/Modal'
import {
  PixelEmptyCanvasArt,
  PixelIcon,
  PixelLoadingIndicator,
} from '../components/common/PixelIcon'
import { PixelSelect } from '../components/common/PixelSelect'
import { PixelThumbnail } from '../components/common/PixelThumbnail'
import { CanvasSizePresetsPicker } from '../components/common/CanvasSizePresetsPicker'
import { useLongPressReorder } from '../utils/useLongPressReorder'
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
    backupReminderDue,
    updateSettings,
    refreshProjects,
    reorderProjectsManual,
    markEnvPackExported,
    snoozeBackupReminder,
    showToast,
  } = useApp()
  const { t } = useI18n()
  const vtNavigate = useViewTransitionNavigate()

  const [newModalOpen, setNewModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newW, setNewW] = useState(32)
  const [newH, setNewH] = useState(32)
  const [selectedPaletteId, setSelectedPaletteId] = useState<string>(
    () => palettes[0]?.id ?? ''
  )
  const [reorderMode, setReorderMode] = useState(false)
  const gridContainerRef = useRef<HTMLDivElement | null>(null)

  const sortedProjects = useMemo((): ProjectRecord[] => {
    const list = [...projects]
    switch (settings.gallerySortMode) {
      case 'newest':
        return list.sort((a, b) => b.createdAt - a.createdAt)
      case 'oldest':
        return list.sort((a, b) => a.createdAt - b.createdAt)
      case 'updated':
        return list.sort((a, b) => b.updatedAt - a.updatedAt)
      case 'name':
        return list.sort((a, b) => a.name.localeCompare(b.name))
      case 'manual':
      default:
        return list.sort((a, b) => a.order - b.order)
    }
  }, [projects, settings.gallerySortMode])

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
      <div className="h-dvh w-full flex items-center justify-center bg-[var(--bg-app)]">
        <PixelLoadingIndicator label={t('loading')} />
      </div>
    )
  }

  return (
    <ViewTransition>
      <div className="min-h-dvh w-full flex flex-col bg-[var(--bg-app)] pl-safe pr-safe">
        {/* Retro Pixel Header */}
        <header className="sticky top-0 z-20 px-3.5 py-2.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className="w-3.5 h-3.5 bg-[var(--accent-primary)] border-2 border-[var(--border-pixel)] shrink-0"
              aria-hidden="true"
            />
            <div>
              <h1 className="text-base sm:text-lg font-bold tracking-wider leading-none">
                {t('appName')}
              </h1>
              <span className="text-[10px] text-[var(--text-secondary)]">
                {t('galleryTitle')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openNewProjectModal}
              className="pixel-btn pixel-btn-active min-h-[44px] px-3.5 text-xs font-bold flex items-center gap-1.5"
              data-testid="new-artwork-btn"
            >
              <PixelIcon name="plus" size={16} />
              <span>{t('newArtwork')}</span>
            </button>

            <VTButtonLink
              to="/settings"
              title={t('navSettings')}
              className="pixel-btn min-w-[44px] min-h-[44px] flex items-center justify-center"
              data-testid="gallery-settings-btn"
            >
              <PixelIcon name="settings" size={18} />
            </VTButtonLink>
          </div>
        </header>

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
                    <div
                      key={proj.id}
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

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs font-bold text-[var(--text-secondary)]">
                  {t('widthPx')}
                </span>
                <input
                  type="number"
                  min={MIN_CANVAS_SIZE}
                  max={MAX_CANVAS_SIZE}
                  value={newW}
                  onChange={(e) => setNewW(Number(e.target.value))}
                  className="w-full min-h-[42px] px-3 text-sm pixel-input"
                  data-testid="new-project-width-input"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-bold text-[var(--text-secondary)]">
                  {t('heightPx')}
                </span>
                <input
                  type="number"
                  min={MIN_CANVAS_SIZE}
                  max={MAX_CANVAS_SIZE}
                  value={newH}
                  onChange={(e) => setNewH(Number(e.target.value))}
                  className="w-full min-h-[42px] px-3 text-sm pixel-input"
                  data-testid="new-project-height-input"
                />
              </label>
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
      </div>
    </ViewTransition>
  )
}
