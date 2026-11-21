import { ViewTransition, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import type { LayerRuntime, ProjectRecord } from '../types'
import {
  db,
  deleteProjectById,
  loadProjectFull,
  saveProjectFull,
} from '../db/database'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { ConfirmDialog } from '../components/common/Modal'
import { PixelIcon, PixelLoadingIndicator } from '../components/common/PixelIcon'
import { PixelThumbnail } from '../components/common/PixelThumbnail'
import { ExportPngModal } from '../components/editor/EditorModals'
import {
  useViewTransitionNavigate,
  VTButtonLink,
} from '../components/common/ViewTransitionNav'

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const {
    settings,
    updateSettings,
    refreshProjects,
    showToast,
  } = useApp()
  const { t, language } = useI18n()
  const vtNavigate = useViewTransitionNavigate()

  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [layers, setLayers] = useState<LayerRuntime[]>([])
  const [loading, setLoading] = useState(true)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      const full = await loadProjectFull(id, db)
      if (cancelled) return
      if (full) {
        setProject(full.project)
        setLayers(full.layers)
        setNameDraft(full.project.name)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [id])

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
    await saveProjectFull({ project: updated, layers }, db)
    setProject(updated)
    await refreshProjects()
  }

  const handleOpenInEditor = async () => {
    if (!project) return
    await updateSettings({ activeProjectId: project.id })
    vtNavigate(`/editor/${project.id}`)
  }

  const handleDeleteArtwork = async () => {
    if (!project) return
    await deleteProjectById(project.id, db)
    await refreshProjects()
    setConfirmDeleteOpen(false)
    vtNavigate('/', { replace: true })
  }

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-[var(--bg-app)]">
        <PixelLoadingIndicator label={t('loading')} />
      </div>
    )
  }

  if (!project) {
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

  return (
    <ViewTransition>
      <div className="min-h-dvh w-full flex flex-col bg-[var(--bg-app)] pl-safe pr-safe">
        <header className="sticky top-0 z-20 px-3.5 py-2.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] flex items-center justify-between gap-2">
          <VTButtonLink
            to="/"
            className="pixel-btn min-h-[44px] px-3 text-xs font-bold flex items-center gap-1.5"
            data-testid="detail-back-btn"
          >
            <PixelIcon name="back" size={16} />
            <span>{t('back')}</span>
          </VTButtonLink>

          <h1 className="text-sm font-bold truncate">{t('artworkDetail')}</h1>

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

        <main className="flex-1 max-w-2xl w-full mx-auto p-4 pb-12 pb-safe space-y-5">
          {/* Large Pixel-Art Preview */}
          <div className="aspect-square max-h-[50dvh] w-full mx-auto pixel-card overflow-hidden">
            <ViewTransition name={`artwork-${project.id}`}>
              <PixelThumbnail
                pngBytes={project.thumbnailPng}
                alt={project.name}
                checkerDark={settings.checkerboardDark}
                className="w-full h-full p-4"
              />
            </ViewTransition>
          </div>

          {/* Large Primary Actions (>= 48px) */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => void handleOpenInEditor()}
              className="min-h-[50px] px-4 pixel-btn pixel-btn-active text-sm font-bold flex items-center justify-center gap-2"
              data-testid="detail-open-editor-btn"
            >
              <PixelIcon name="pen" size={18} />
              <span>{t('openInEditor')}</span>
            </button>

            <button
              type="button"
              onClick={() => setExportOpen(true)}
              className="min-h-[50px] px-4 pixel-btn pixel-btn-teal text-sm font-bold flex items-center justify-center gap-2"
              data-testid="detail-export-png-btn"
            >
              <PixelIcon name="download" size={18} />
              <span>{t('exportPng')}</span>
            </button>
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
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => void handleSaveRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveRename()
                  }}
                  className="min-h-[34px] px-2.5 text-sm font-bold pixel-input text-right"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  className="flex items-center gap-1.5 text-sm font-bold cursor-pointer hover:text-[var(--accent-primary)]"
                  data-testid="detail-rename-btn"
                >
                  <span>{project.name}</span>
                  <PixelIcon name="edit" size={14} />
                </button>
              )}
            </div>

            <MetaRow
              label={t('canvasSize')}
              value={`${project.width} × ${project.height} px`}
            />
            <MetaRow
              label={t('layerCount')}
              value={`${project.layers.length}`}
            />
            <MetaRow
              label={t('createdAt')}
              value={formatDateTime(project.createdAt)}
            />
            <MetaRow
              label={t('updatedAt')}
              value={formatDateTime(project.updatedAt)}
            />

            <div className="p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)]">
                  {t('usedPalette')}
                </span>
                <span className="text-xs font-bold">
                  {project.palette.name} ({project.palette.colors.length}{' '}
                  {t('colorsCount')})
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {project.palette.colors.slice(0, 48).map((hex, idx) => (
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

        <ExportPngModal
          open={exportOpen}
          projectName={project.name}
          width={project.width}
          height={project.height}
          layers={layers}
          checkerDark={settings.checkerboardDark}
          onClose={() => setExportOpen(false)}
          onExported={() => showToast(t('toastExportedPng'), 'success')}
        />

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

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3.5 flex items-center justify-between gap-3">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="text-xs font-bold">{value}</span>
    </div>
  )
}
