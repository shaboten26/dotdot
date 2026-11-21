import { ViewTransition, useMemo, useState } from 'react'
import type { AppSettings, ProjectRecord } from '../types'
import { createNewProject, db } from '../db/database'
import { MAX_CANVAS_SIZE, MIN_CANVAS_SIZE } from '../engine/pixelBuffer'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { Modal } from '../components/common/Modal'
import {
  PixelEmptyCanvasArt,
  PixelIcon,
  PixelLoadingIndicator,
} from '../components/common/PixelIcon'
import { PixelThumbnail } from '../components/common/PixelThumbnail'
import {
  useViewTransitionNavigate,
  VTButtonLink,
} from '../components/common/ViewTransitionNav'

const SIZE_PRESETS = [
  { w: 16, h: 16 },
  { w: 24, h: 24 },
  { w: 32, h: 32 },
  { w: 48, h: 48 },
  { w: 64, h: 64 },
  { w: 128, h: 128 },
  { w: 256, h: 256 },
]

/**
 * Spec v2 Section 5-1:
 * Standard home screen on app startup is the Artwork Gallery (`/`).
 * - Does NOT auto-open an empty canvas on startup.
 * - Shows a clear pixel-art empty state when 0 artworks exist.
 * - Selecting an artwork opens it directly in the Editor (`/editor/:id`),
 *   while an explicit Info button on each tile opens the Artwork Detail view (`/project/:id`).
 */
export function GalleryPage() {
  const {
    ready,
    projects,
    palettes,
    settings,
    updateSettings,
    refreshProjects,
    reorderProjectsManual,
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
  const [dragId, setDragId] = useState<string | null>(null)
  const [reorderMode, setReorderMode] = useState(false)

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
        {/* Retro Pixel Header with >=44px Action Buttons */}
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

        {sortedProjects.length === 0 ? (
          /* Spec v2 Section 5-1: Empty Gallery state with custom pixel-art illustration & clear CTA */
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
                <select
                  value={settings.gallerySortMode}
                  onChange={(e) =>
                    void updateSettings({
                      gallerySortMode: e.target
                        .value as AppSettings['gallerySortMode'],
                    })
                  }
                  className="min-h-[38px] px-2.5 text-xs font-bold pixel-input"
                  data-testid="gallery-sort-select"
                >
                  <option value="manual">{t('sortManual')}</option>
                  <option value="newest">{t('sortNewest')}</option>
                  <option value="oldest">{t('sortOldest')}</option>
                  <option value="updated">{t('sortUpdated')}</option>
                  <option value="name">{t('sortName')}</option>
                </select>

                {settings.gallerySortMode === 'manual' && sortedProjects.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setReorderMode((v) => !v)}
                    className={`min-h-[38px] px-2.5 text-xs font-bold flex items-center gap-1 ${
                      reorderMode ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                    }`}
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

            {/* Image-Centric Artwork Grid */}
            <main className="flex-1 px-3 sm:px-4 pb-10 pb-safe max-w-5xl w-full mx-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {sortedProjects.map((proj, idx) => {
                  const isActive = proj.id === settings.activeProjectId
                  return (
                    <div
                      key={proj.id}
                      draggable={settings.gallerySortMode === 'manual'}
                      onDragStart={() => setDragId(proj.id)}
                      onDragOver={(e) => {
                        if (settings.gallerySortMode === 'manual') e.preventDefault()
                      }}
                      onDrop={() => {
                        if (
                          settings.gallerySortMode !== 'manual' ||
                          !dragId ||
                          dragId === proj.id
                        ) {
                          return
                        }
                        const ids = sortedProjects.map((p) => p.id)
                        const from = ids.indexOf(dragId)
                        const to = ids.indexOf(proj.id)
                        if (from < 0 || to < 0) return
                        ids.splice(from, 1)
                        ids.splice(to, 0, dragId)
                        setDragId(null)
                        void reorderProjectsManual(ids)
                      }}
                      onClick={() => {
                        if (!reorderMode) {
                          void updateSettings({ activeProjectId: proj.id })
                          vtNavigate(`/editor/${proj.id}`)
                        }
                      }}
                      className={`group relative aspect-square pixel-card overflow-hidden cursor-pointer ${
                        isActive
                          ? 'outline-2 outline-offset-2 outline-[var(--accent-primary)]'
                          : ''
                      }`}
                      data-testid={`gallery-tile-${proj.id}`}
                    >
                      <ViewTransition name={`artwork-${proj.id}`}>
                        <PixelThumbnail
                          pngBytes={proj.thumbnailPng}
                          alt={proj.name}
                          checkerDark={settings.checkerboardDark}
                          className="w-full h-full p-2.5"
                        />
                      </ViewTransition>

                      {/* Detail Info Button in top-right corner */}
                      {!reorderMode && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            vtNavigate(`/project/${proj.id}`)
                          }}
                          title={t('artworkDetail')}
                          className="absolute top-1.5 right-1.5 min-w-[36px] min-h-[36px] px-1.5 pixel-btn flex items-center justify-center opacity-90 hover:opacity-100"
                          data-testid={`gallery-detail-${proj.id}`}
                        >
                          <PixelIcon name="menu" size={14} />
                        </button>
                      )}

                      {reorderMode && settings.gallerySortMode === 'manual' && (
                        <div
                          className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between bg-[var(--bg-surface)] border-2 border-[var(--border-pixel)] px-1.5 py-1"
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

        {/* New Artwork Creation Modal */}
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
                  min={1}
                  max={256}
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
                  min={1}
                  max={256}
                  value={newH}
                  onChange={(e) => setNewH(Number(e.target.value))}
                  className="w-full min-h-[42px] px-3 text-sm pixel-input"
                  data-testid="new-project-height-input"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-bold text-[var(--text-secondary)]">
                {t('presetSizes')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {SIZE_PRESETS.map((preset) => {
                  const active = newW === preset.w && newH === preset.h
                  return (
                    <button
                      key={`${preset.w}x${preset.h}`}
                      type="button"
                      onClick={() => {
                        setNewW(preset.w)
                        setNewH(preset.h)
                      }}
                      className={`min-h-[36px] px-2.5 text-xs font-bold ${
                        active ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
                      }`}
                    >
                      {preset.w}×{preset.h}
                    </button>
                  )
                })}
              </div>
            </div>

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
                          ? 'bg-[var(--bg-panel)] border-[var(--accent-primary)] shadow-[2px_2px_0px_var(--accent-primary-shadow)]'
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

            <button
              type="button"
              onClick={() => void handleCreateArtwork()}
              className="w-full min-h-[50px] pixel-btn pixel-btn-active text-sm font-bold flex items-center justify-center gap-2"
              data-testid="confirm-create-artwork-btn"
            >
              <PixelIcon name="pen" size={18} />
              <span>{t('create')}</span>
            </button>
          </div>
        </Modal>
      </div>
    </ViewTransition>
  )
}
