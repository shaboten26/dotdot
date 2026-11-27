import { ViewTransition, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import type { ToolId } from '../types'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import { useEditorController } from '../state/useEditorController'
import { InteractiveViewport } from '../components/editor/InteractiveViewport'
import { DrawButton } from '../components/editor/DrawButton'
import {
  ActiveMoveBar,
  FloatingTransformBar,
  MultiRowToolGrid,
  PaletteBar,
  SelectionReadyBar,
  ToolDetailPopover,
} from '../components/editor/ToolPanels'
import { PaletteSheet } from '../components/editor/PaletteSheet'
import { LayerPanelContent, LayerSheet } from '../components/editor/LayerSheet'
import { TimelinePanel } from '../components/editor/TimelinePanel'
import { ExportSpriteSheetModal } from '../components/editor/ExportSpriteSheetModal'
import { GlobalEditorSettingsModal } from '../components/editor/GlobalEditorSettingsModal'
import { CanvasResizeModal } from '../components/editor/EditorModals'
import {
  UnifiedExportModal,
  type UnifiedExportMode,
} from '../components/editor/UnifiedExportModal'
import { ExportAsepriteModal } from '../components/common/AsepriteModals'
import {
  detectInitialInputModality,
  type InputModality,
} from '../utils/inputDetect'
import { PixelIcon, PixelLoadingIndicator } from '../components/common/PixelIcon'
import { PixelThumbnail } from '../components/common/PixelThumbnail'
import { PixelCheckbox } from '../components/common/PixelCheckbox'
import {
  useViewTransitionNavigate,
  VTButtonLink,
} from '../components/common/ViewTransitionNav'

export function EditorPage() {
  const { id: routeProjectId } = useParams<{ id?: string }>()
  const {
    ready,
    projects,
    settings,
    reducedMotion,
    palettes,
    sharedClipboard,
    setSharedClipboard,
    updateSettings,
    refreshProjects,
    addLibraryPalette,
    showToast,
  } = useApp()
  const { t } = useI18n()
  const vtNavigate = useViewTransitionNavigate()

  const targetProjectId = routeProjectId ?? settings.activeProjectId

  const [optionsOpen, setOptionsOpen] = useState(false)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [resizeOpen, setResizeOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMode, setExportMode] = useState<UnifiedExportMode>('still')
  const [exportSpriteOpen, setExportSpriteOpen] = useState(false)
  const [exportAseOpen, setExportAseOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [previewFlipX, setPreviewFlipX] = useState(false)
  const [previewFlipY, setPreviewFlipY] = useState(false)
  const [workspaceTab, setWorkspaceTab] = useState<'tools' | 'frames'>('tools')
  const [inputModality, setInputModality] = useState<InputModality>(() =>
    detectInitialInputModality()
  )
  const [loadWarningDismissed, setLoadWarningDismissed] = useState(false)
  const [fitTrigger, setFitTrigger] = useState(0)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  useEffect(() => {
    setPreviewFlipX(false)
    setPreviewFlipY(false)
  }, [targetProjectId])

  const editor = useEditorController({
    projectId: targetProjectId,
    historyLimit: settings.historyLimit,
    soundEnabled: settings.soundEnabled,
    defaultSymmetryMode: settings.defaultSymmetryMode,
    defaultSeamlessWrapMode: settings.defaultSeamlessWrapMode,
    defaultTilePreviewGrid: settings.defaultTilePreviewGrid,
    preferredSelectType: settings.preferredSelectTypeCustomized
      ? settings.preferredSelectType
      : 'wand',
    onSelectTypeChanged: (nextType) => {
      void updateSettings({
        preferredSelectType: nextType,
        preferredSelectTypeCustomized: true,
      })
    },
    sharedClipboard,
    onUpdateSharedClipboard: setSharedClipboard,
    onSaved: () => {
      void refreshProjects()
    },
    onQuotaTrimmed: () => {
      showToast(t('toastQuotaTrimmed'), 'warning')
    },
    onSaveError: () => {
      showToast(t('toastSaveError'), 'error')
    },
    onColorPicked: (isTransparent) => {
      showToast(
        isTransparent ? t('toastTransparentPicked') : t('toastColorPicked'),
        'info'
      )
    },
    onPaletteLimitReached: () => {
      showToast(t('paletteLimitEyedropperMsg'), 'info')
    },
  })

  useEffect(() => {
    if (routeProjectId && settings.activeProjectId !== routeProjectId) {
      void updateSettings({ activeProjectId: routeProjectId })
    }
  }, [routeProjectId, settings.activeProjectId, updateSettings])

  useEffect(() => {
    if (editor.project) {
      setTitleDraft(editor.project.name)
    }
  }, [editor.project?.id, editor.project?.name])

  const handleTapTool = (clickedTool: ToolId) => {
    setHeaderMenuOpen(false)
    if (clickedTool === editor.tool) {
      setOptionsOpen((prev) => !prev)
    } else {
      setOptionsOpen(false)
      editor.selectTool(clickedTool)
    }
  }

  // PC Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          editor.redo()
        } else {
          editor.undo()
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        editor.redo()
        return
      }
      if (e.key === 'Enter') {
        if (editor.moveSession) {
          e.preventDefault()
          editor.commitActiveMove()
          return
        }
        if (editor.floatingShape) {
          e.preventDefault()
          editor.commitFloatingShape()
          return
        }
      }
      if (e.key === 'Escape') {
        setOptionsOpen(false)
        setHeaderMenuOpen(false)
        editor.cancelMultiStep()
        return
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'b') handleTapTool('pen')
        else if (k === 'e') handleTapTool('eraser')
        else if (k === 'g') handleTapTool('fill')
        else if (k === 'l') handleTapTool('line')
        else if (k === 'u') handleTapTool('shape')
        else if (k === 'm') handleTapTool('select')
        else if (k === 'i') handleTapTool('eyedropper')
        else if (e.key === ',' || e.key === '<') {
          e.preventDefault()
          editor.stepFrame(-1)
        } else if (e.key === '.' || e.key === '>') {
          e.preventDefault()
          editor.stepFrame(1)
        } else if (k === 'o') {
          editor.updateOnionSkin({ enabled: !editor.onionSkin.enabled })
        }
      } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key.toLowerCase() === 'p') {
          e.preventDefault()
          editor.togglePlay()
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          editor.stepFrame(-1)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          editor.stepFrame(1)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])

  const summaryProject = targetProjectId
    ? projects.find((p) => p.id === targetProjectId) ?? null
    : null

  if (!ready || editor.loading) {
    if (summaryProject) {
      return (
        <ViewTransition>
          <div className="h-dvh w-full flex flex-col bg-[var(--bg-app)] overflow-hidden select-none pl-safe pr-safe">
            <header className="relative flex items-center justify-between gap-2 px-2.5 py-1.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] shrink-0 z-30">
              <VTButtonLink
                to="/"
                title={t('navGallery')}
                className="pixel-btn min-h-[44px] min-w-[44px] px-2.5 flex items-center gap-1.5 text-xs font-bold shrink-0"
              >
                <PixelIcon name="back" size={16} />
                <span>{t('back')}</span>
              </VTButtonLink>
              <div className="flex-1 min-w-0 flex items-center justify-center">
                <span className="text-xs sm:text-sm font-bold truncate">
                  {summaryProject.name}
                </span>
              </div>
              <div className="min-w-[44px] min-h-[44px]" aria-hidden="true" />
            </header>
            <main className="flex-1 min-h-0 flex items-center justify-center bg-[var(--canvas-well)] p-6">
              <ViewTransition name={`artwork-${summaryProject.id}`}>
                <div className="w-64 h-64 max-w-[75vw] max-h-[55dvh] flex items-center justify-center">
                  <PixelThumbnail
                    pngBytes={summaryProject.thumbnailPng}
                    alt={summaryProject.name}
                    checkerDark={settings.checkerboardDark}
                    className="w-full h-full"
                  />
                </div>
              </ViewTransition>
            </main>
          </div>
        </ViewTransition>
      )
    }

    return (
      <div className="h-dvh w-full flex items-center justify-center bg-[var(--bg-app)]">
        <PixelLoadingIndicator label={t('loading')} />
      </div>
    )
  }

  if (!editor.project) {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center gap-4 p-6 bg-[var(--bg-app)]">
        <p className="text-sm font-bold text-[var(--text-secondary)]">
          {t('emptyGalleryTitle')}
        </p>
        <VTButtonLink
          to="/"
          className="min-h-[48px] px-6 pixel-btn pixel-btn-active text-sm font-bold flex items-center gap-2"
        >
          <PixelIcon name="gallery" size={18} />
          <span>{t('navGallery')}</span>
        </VTButtonLink>
      </div>
    )
  }

  return (
    <ViewTransition>
      <div className="h-dvh w-full flex flex-col bg-[var(--bg-app)] overflow-hidden select-none pl-safe pr-safe">
        {/* Minimal Focused Header */}
        <header className="relative flex items-center justify-between gap-2 px-2.5 py-1.5 pt-safe bg-[var(--bg-surface)] border-b-2 border-[var(--border-pixel)] shrink-0 z-30">
          <VTButtonLink
            to="/"
            title={t('navGallery')}
            className="pixel-btn min-h-[44px] min-w-[44px] px-2.5 flex items-center gap-1.5 text-xs font-bold shrink-0"
            data-testid="nav-gallery-btn"
          >
            <PixelIcon name="back" size={16} />
            <span>{t('back')}</span>
          </VTButtonLink>

          {/* Artwork Title */}
          <div className="flex-1 min-w-0 flex items-center justify-center">
            {editingTitle ? (
              <input
                type="text"
                autoFocus
                value={titleDraft}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  setEditingTitle(false)
                  editor.renameProject(titleDraft)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setEditingTitle(false)
                    editor.renameProject(titleDraft)
                  } else if (e.key === 'Escape') {
                    setEditingTitle(false)
                    setTitleDraft(editor.project!.name)
                  }
                }}
                className="w-40 sm:w-56 min-h-[36px] px-2 text-xs font-bold text-center pixel-input"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className="min-h-[38px] px-2 text-xs sm:text-sm font-bold truncate max-w-[180px] sm:max-w-[280px] flex items-center gap-1.5 cursor-pointer hover:text-[var(--accent-primary)]"
                title={t('rename')}
              >
                <span className="truncate">{editor.project.name}</span>
                <span className="text-[10px] text-[var(--text-secondary)] shrink-0">
                  [{editor.project.width}×{editor.project.height}
                  {editor.timeline.frames.length > 1
                    ? ` · ${editor.timeline.frames.length}f`
                    : ''}
                  ]
                </span>
              </button>
            )}
          </div>

          {/* Compact Auxiliary Menu Button */}
          <button
            type="button"
            onClick={() => setHeaderMenuOpen((v) => !v)}
            aria-expanded={headerMenuOpen}
            title={t('menu')}
            className={`min-h-[44px] min-w-[44px] px-2.5 flex items-center justify-center gap-1 text-xs font-bold shrink-0 ${
              headerMenuOpen ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="editor-menu-btn"
          >
            <PixelIcon name="menu" size={18} />
          </button>

          {/* Auxiliary Menu Popover */}
          <AnimatePresence>
            {headerMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setHeaderMenuOpen(false)}
                />
                <motion.div
                  initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  transition={{ duration: reducedMotion ? 0 : 0.1 }}
                  className="absolute right-2.5 top-full mt-1.5 z-30 w-60 pixel-panel p-2 space-y-1.5"
                  data-testid="editor-menu-popover"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setFitTrigger((c) => c + 1)
                      setHeaderMenuOpen(false)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                  >
                    <PixelIcon name="fit" size={16} />
                    <span>{t('fitScreen')}</span>
                  </button>

                  <div className="px-1 py-0.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
                    <PixelCheckbox
                      checked={settings.showGrid}
                      onChange={(next) => void updateSettings({ showGrid: next })}
                      label={t('gridToggle')}
                      testId="menu-grid-checkbox"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      setResizeOpen(true)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                    data-testid="canvas-resize-btn"
                  >
                    <PixelIcon name="resize" size={16} />
                    <span>
                      {t('canvasSizeMenu')} ({editor.project.width}×{editor.project.height})
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      setExportMode(
                        editor.timeline.frames.length >= 2
                          ? 'animation'
                          : 'still'
                      )
                      setExportOpen(true)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn pixel-btn-teal flex items-center gap-2 text-xs font-bold text-left"
                    data-testid="editor-export-btn"
                  >
                    <PixelIcon
                      name={
                        editor.timeline.frames.length >= 2 ? 'film' : 'download'
                      }
                      size={16}
                    />
                    <span>
                      {editor.timeline.frames.length >= 2
                        ? t('exportAnimationBtn')
                        : t('exportImageBtn')}
                    </span>
                  </button>

                  {editor.timeline.frames.length >= 2 && (
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMenuOpen(false)
                        setExportMode('current-frame')
                        setExportOpen(true)
                      }}
                      className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                      data-testid="editor-export-current-frame-btn"
                    >
                      <PixelIcon name="download" size={16} />
                      <span>{t('exportCurrentFrameBtn')}</span>
                    </button>
                  )}

                  {editor.timeline.frames.length >= 2 && (
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMenuOpen(false)
                        setExportSpriteOpen(true)
                      }}
                      className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                      data-testid="editor-export-spritesheet-btn"
                    >
                      <PixelIcon name="sheet" size={16} />
                      <span>{t('exportSpriteSheet')}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      setExportAseOpen(true)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                    data-testid="editor-export-aseprite-btn"
                  >
                    <PixelIcon name="aseprite" size={16} />
                    <span>{t('exportAseprite')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      vtNavigate(`/project/${editor.project!.id}`)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                    data-testid="editor-view-detail-btn"
                  >
                    <PixelIcon name="gallery" size={16} />
                    <span>{t('artworkDetail')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      vtNavigate('/settings')
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
                    data-testid="nav-settings-btn"
                  >
                    <PixelIcon name="settings" size={16} />
                    <span>{t('navSettings')}</span>
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </header>

        {/* Non-Blocking Load Warning Banner */}
        {editor.loadEstimate &&
          editor.loadEstimate.level !== 'normal' &&
          !loadWarningDismissed && (
            <div
              className="px-3 py-1 bg-[var(--bg-elevated)] border-b-2 border-[var(--accent-amber)] flex items-center justify-between gap-2 text-[11px] shrink-0 z-20"
              data-testid="project-load-warning-banner"
            >
              <span className="font-bold text-[var(--text-primary)] truncate">
                {editor.loadEstimate.level === 'high'
                  ? t('loadWarningHeavy')
                  : t('loadWarningCaution')}
              </span>
              <button
                type="button"
                onClick={() => setLoadWarningDismissed(true)}
                className="pixel-btn px-1.5 py-0.5 text-[10px] font-bold shrink-0"
              >
                {t('close')}
              </button>
            </div>
          )}

        {/* 1. Large Expansive Always-Visible Canvas */}
        <main
          className="flex-1 min-h-0 relative"
          onPointerDown={() => {
            if (headerMenuOpen) setHeaderMenuOpen(false)
          }}
        >
          <InteractiveViewport
            projectId={editor.project.id}
            width={editor.project.width}
            height={editor.project.height}
            compositedBuffer={editor.compositedBuffer}
            onionPrevBuffer={editor.onionPrevBuffer}
            onionNextBuffer={editor.onionNextBuffer}
            onionOpacity={editor.onionSkin.opacity}
            isPlaying={editor.isPlaying}
            tool={editor.tool}
            toolSettings={editor.toolSettings}
            cursor={editor.cursor}
            stepPhase={editor.stepPhase}
            floatingShape={editor.floatingShape}
            moveSession={editor.moveSession}
            symmetryMode={editor.symmetryMode}
            showSymmetryGuide={settings.showSymmetryGuide}
            tilePreviewGrid={editor.tilePreviewGrid}
            seamlessWrapMode={editor.seamlessWrapMode}
            hasSelection={editor.hasSelection}
            selectionMask={editor.selectionMask}
            worldSelection={editor.worldSelection}
            showGrid={settings.showGrid}
            checkerboardDark={settings.checkerboardDark}
            activeHexColor={editor.activeHexColor}
            isTransparentColor={editor.isTransparentColorSelected}
            eyedropperDoubleTap={settings.eyedropperDoubleTap}
            cursorSpeed={settings.cursorSpeed}
            cursorSize={settings.cursorSize}
            previewFlipX={previewFlipX}
            previewFlipY={previewFlipY}
            onResetPreviewFlip={() => {
              setPreviewFlipX(false)
              setPreviewFlipY(false)
            }}
            fitTrigger={fitTrigger}
            onModalityChange={setInputModality}
            onMoveCursor={editor.moveCursorTo}
            onBeginDrawAt={(pt, allowOutOfBounds) => {
              if (optionsOpen) setOptionsOpen(false)
              editor.beginDrawAction(pt, allowOutOfBounds)
            }}
            onEndDraw={editor.endDrawAction}
            onAbortStroke={editor.abortStrokePreview}
            onDoubleTapEyedropper={() => {
              editor.pickColorAtCurrentCursor()
            }}
            onMoveFloatingShape={editor.moveFloatingShape}
            onUpdateMoveOffset={editor.updateActiveMoveOffset}
          />
        </main>

        {/* Lower Dock */}
        <section className="relative flex flex-col shrink-0 z-20">
          {editor.moveSession ? (
            <motion.div
              key="active-move-bar"
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reducedMotion ? 0 : 0.18,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <ActiveMoveBar
                moveSession={editor.moveSession}
                onMoveStep={editor.updateActiveMoveOffset}
                onCommit={editor.commitActiveMove}
                onCancel={editor.cancelActiveMove}
              />
            </motion.div>
          ) : editor.floatingShape ? (
            <motion.div
              key="floating-transform-bar"
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reducedMotion ? 0 : 0.18,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <FloatingTransformBar
                floatingShape={editor.floatingShape}
                onRotate={editor.rotateFloatingShape}
                onMove={editor.moveFloatingShape}
                onCommit={editor.commitFloatingShape}
                onDiscard={editor.discardFloatingShape}
              />
            </motion.div>
          ) : editor.hasSelection && !optionsOpen ? (
            <motion.div
              key="selection-ready-bar"
              initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reducedMotion ? 0 : 0.18,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              <SelectionReadyBar
                onStartMove={() => {
                  editor.startSelectionMove()
                }}
                onClearSelection={editor.clearCurrentSelection}
              />
            </motion.div>
          ) : null}

          {!editor.moveSession && !editor.floatingShape && (
            <ToolDetailPopover
              open={optionsOpen}
              onClose={() => setOptionsOpen(false)}
              tool={editor.tool}
              settings={editor.toolSettings}
              paletteColors={editor.palette.colors}
              eyedropperDoubleTap={settings.eyedropperDoubleTap}
              onToggleEyedropperDoubleTap={(next) =>
                void updateSettings({ eyedropperDoubleTap: next })
              }
              hasSelection={editor.hasSelection}
              hasClipboard={editor.clipboard !== null}
              onChange={editor.updateToolSettings}
              onStartSelectionMove={() => {
                editor.startSelectionMove()
              }}
              onNudgeSelection={editor.nudgeSelection}
              onApplyOutline={editor.outlineSelection}
              onCut={() => {
                if (editor.cutSelectedPixels()) showToast(t('toastCut'))
              }}
              onCopy={() => {
                if (editor.copySelectedPixels()) showToast(t('toastCopied'))
              }}
              onPaste={() => {
                if (editor.pasteClipboardPixels()) showToast(t('toastPasted'))
              }}
              onFlipSelection={editor.flipSelectedPixels}
              onInvertSelection={editor.invertCurrentSelection}
              onClearSelection={editor.clearCurrentSelection}
            />
          )}

          {/* Section 2: Clean Workspace Mode Switcher — ONLY `ツール` / (`レイヤー` | `タイムライン`) + Animation Frame Prev/Play/Next */}
          <div
            className="flex items-center justify-between gap-1.5 px-2.5 py-1 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
            data-testid="workspace-mode-bar"
          >
            <div className="grid grid-cols-2 gap-1.5 flex-1 max-w-xs">
              <button
                type="button"
                onClick={() => setWorkspaceTab('tools')}
                className={`relative min-h-[32px] px-2.5 text-xs font-bold flex items-center justify-center gap-1 overflow-hidden ${
                  workspaceTab === 'tools'
                    ? 'text-[var(--accent-primary-fg)] border-2 border-[var(--border-strong)] cursor-pointer'
                    : 'pixel-btn'
                }`}
                data-testid="workspace-tab-tools"
              >
                {workspaceTab === 'tools' && (
                  <motion.span
                    layoutId="workspace-active-tab-pill"
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 520, damping: 38 }
                    }
                    className="absolute inset-0 bg-[var(--accent-primary)] z-0"
                    aria-hidden="true"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1">
                  <PixelIcon name="pen" size={13} />
                  <span>{t('tabTools')}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOptionsOpen(false)
                  setWorkspaceTab('frames')
                }}
                className={`relative min-h-[32px] px-2.5 text-xs font-bold flex items-center justify-center gap-1 overflow-hidden ${
                  workspaceTab === 'frames'
                    ? 'text-[var(--accent-primary-fg)] border-2 border-[var(--border-strong)] cursor-pointer'
                    : 'pixel-btn'
                }`}
                data-testid={
                  editor.timeline.frames.length >= 2
                    ? 'workspace-tab-timeline'
                    : 'workspace-tab-layers'
                }
              >
                {workspaceTab === 'frames' && (
                  <motion.span
                    layoutId="workspace-active-tab-pill"
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 520, damping: 38 }
                    }
                    className="absolute inset-0 bg-[var(--accent-primary)] z-0"
                    aria-hidden="true"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1">
                  <PixelIcon
                    name={editor.timeline.frames.length >= 2 ? 'film' : 'layers'}
                    size={13}
                  />
                  <span>
                    {editor.timeline.frames.length >= 2
                      ? `${t('tabTimeline')} (${editor.timeline.frames.length})`
                      : `${t('tabLayers')} (${editor.layers.length})`}
                  </span>
                </span>
              </button>
            </div>

            {editor.timeline.frames.length >= 2 && (
              <div
                className="flex items-center gap-1 shrink-0 ml-auto"
                data-testid="tabbar-frame-controls"
              >
                <button
                  type="button"
                  onClick={() => editor.stepFrame(-1)}
                  className="pixel-btn min-w-[30px] min-h-[30px] flex items-center justify-center"
                  title={t('prevFrameBtn')}
                  data-testid="quick-prev-frame-btn"
                >
                  <PixelIcon name="arrowLeft" size={12} />
                </button>
                <button
                  type="button"
                  onClick={editor.togglePlay}
                  aria-pressed={editor.isPlaying}
                  className={`min-h-[30px] px-2 text-[11px] font-bold flex items-center gap-1 ${
                    editor.isPlaying
                      ? 'pixel-btn pixel-btn-teal'
                      : 'pixel-btn'
                  }`}
                  data-testid="quick-play-toggle-btn"
                >
                  <PixelIcon
                    name={editor.isPlaying ? 'pause' : 'play'}
                    size={11}
                  />
                  <span>
                    {Math.max(
                      1,
                      editor.timeline.frames.findIndex(
                        (f) => f.id === editor.timeline.activeFrameId
                      ) + 1
                    )}
                    /{editor.timeline.frames.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => editor.stepFrame(1)}
                  className="pixel-btn min-w-[30px] min-h-[30px] flex items-center justify-center"
                  title={t('nextFrameBtn')}
                  data-testid="quick-next-frame-btn"
                >
                  <PixelIcon name="arrowRight" size={12} />
                </button>
              </div>
            )}
          </div>

          {/* 2. Workspace Content (`ツール` Multi-Row Grid OR `レイヤー` [1 frame] / `タイムライン` [>=2 frames]) */}
          <motion.div
            key={
              workspaceTab === 'tools'
                ? 'dock-tools'
                : editor.timeline.frames.length <= 1
                  ? 'dock-layers'
                  : 'dock-timeline'
            }
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0.78, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: reducedMotion ? 0 : 0.2,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="flex flex-col shrink-0"
          >
            {workspaceTab === 'tools' ? (
              <MultiRowToolGrid
                tool={editor.tool}
                toolSettings={editor.toolSettings}
                optionsOpen={optionsOpen}
                globalSettingsOpen={globalSettingsOpen}
                hasActivePreviewFlip={
                  previewFlipX ||
                  previewFlipY ||
                  editor.symmetryMode !== 'none' ||
                  editor.tilePreviewGrid !== 'off' ||
                  editor.seamlessWrapMode !== 'none'
                }
                canUndo={editor.canUndo}
                canRedo={editor.canRedo}
                hasSelection={editor.hasSelection}
                onTapTool={handleTapTool}
                onUndo={editor.undo}
                onRedo={editor.redo}
                onOpenGlobalSettings={() => {
                  setOptionsOpen(false)
                  setHeaderMenuOpen(false)
                  setGlobalSettingsOpen((prev) => !prev)
                }}
              />
            ) : editor.timeline.frames.length <= 1 ? (
              <div
                className="px-2.5 py-2 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
                data-testid="inline-layers-workspace"
              >
                <LayerPanelContent
                  compactInline
                  palette={editor.palette}
                  canvasWidth={editor.project.width}
                  canvasHeight={editor.project.height}
                  checkerDark={settings.checkerboardDark}
                  layers={editor.layers}
                  activeLayerId={editor.activeLayerId}
                  selectedLayerIds={editor.selectedLayerIds}
                  onSelectLayer={editor.setActiveLayerId}
                  onToggleLayerSelected={editor.toggleLayerSelected}
                  onClearLayerSelection={editor.clearLayerSelection}
                  onStartMultiLayerMoveOnCanvas={() => {
                    editor.startMultiLayerMove()
                  }}
                  onDuplicateSelectedLayers={() => {
                    if (!editor.duplicateSelectedLayers()) {
                      showToast(t('layerMaxReached'), 'warning')
                    }
                  }}
                  onMergeSelectedLayers={() => {
                    editor.mergeSelectedLayers()
                  }}
                  onDeleteSelectedLayers={() => {
                    if (!editor.deleteSelectedLayers()) {
                      showToast(t('cannotDeleteLastLayer'), 'warning')
                    }
                  }}
                  onAddLayer={() => {
                    if (!editor.addNewLayer()) {
                      showToast(t('layerMaxReached'), 'warning')
                    }
                  }}
                  onDuplicateLayer={(id) => {
                    if (!editor.duplicateLayer(id)) {
                      showToast(t('layerMaxReached'), 'warning')
                    }
                  }}
                  onDeleteLayer={(id) => {
                    if (!editor.deleteLayer(id)) {
                      showToast(t('cannotDeleteLastLayer'), 'warning')
                    }
                  }}
                  onMergeDown={editor.mergeLayerDown}
                  onUpdateLayer={editor.updateLayerProps}
                  onReorderLayers={editor.reorderLayers}
                  onClearLayer={editor.clearLayerPixels}
                  onCopyLayer={(id) => {
                    if (editor.copyLayerToClipboard(id)) {
                      showToast(t('toastCopied'))
                    }
                  }}
                  onFlipLayer={editor.flipLayer}
                  onStartLayerMoveOnCanvas={(id) => {
                    editor.startLayerMove(id)
                  }}
                  onAddFirstAnimationFrame={() => {
                    editor.duplicateFrame('independent')
                  }}
                />
              </div>
            ) : (
              <TimelinePanel
                palette={editor.palette}
                canvasWidth={editor.project.width}
                canvasHeight={editor.project.height}
                checkerDark={settings.checkerboardDark}
                layers={editor.layers}
                activeLayerId={editor.activeLayerId}
                timeline={editor.timeline}
                selectedCellKeys={editor.selectedCellKeys}
                celClipboard={editor.celClipboard}
                isPlaying={editor.isPlaying}
                playbackSpeed={editor.playbackSpeed}
                onionSkin={editor.onionSkin}
                onSelectLayer={editor.setActiveLayerId}
                onUpdateLayer={editor.updateLayerProps}
                onAddLayer={() => {
                  if (!editor.addNewLayer()) {
                    showToast(t('layerMaxReached'), 'warning')
                  }
                }}
                onOpenLayerSheet={() => setLayersOpen(true)}
                onSelectFrame={editor.selectFrame}
                onAddEmptyFrame={() => {
                  editor.addEmptyFrame()
                }}
                onDuplicateFrame={(mode) => {
                  editor.duplicateFrame(mode)
                }}
                onDeleteFrame={(fid) => {
                  if (!editor.deleteFrame(fid)) {
                    showToast(t('cannotDeleteLastFrame'), 'warning')
                  }
                }}
                onSetFrameDuration={editor.setFrameDuration}
                onSetDefaultFrameDuration={editor.setDefaultFrameDuration}
                onApplyBatchDuration={editor.applyBatchDuration}
                onClearCell={editor.clearCell}
                onUnlinkCell={editor.unlinkCell}
                onLinkCellToAny={editor.linkCellToAny}
                onToggleCellSelected={editor.toggleCellSelected}
                onClearCellSelection={editor.clearCellSelection}
                onBatchClearCells={editor.batchClearSelectedCells}
                onBatchUnlinkCells={editor.batchUnlinkSelectedCells}
                onBatchLinkCells={editor.batchLinkSelectedCells}
                onCopyActiveCell={() => {
                  if (editor.copyActiveCell()) {
                    showToast(t('toastCopied'))
                  }
                }}
                onPasteToActiveCell={(asLinked) => {
                  if (editor.pasteToActiveCell(asLinked)) {
                    showToast(t('toastPasted'))
                  }
                }}
                onSetPlaybackSpeed={editor.setPlaybackSpeed}
                onSetPlaybackDirection={editor.setPlaybackDirection}
                onSetLoopPlayback={editor.setLoopPlayback}
                onUpdateOnionSkin={editor.updateOnionSkin}
              />
            )}
          </motion.div>

          {/* 3. Palette Swatch Strip (with fixed leftmost Transparent Slot & Drag Reorder) */}
          <PaletteBar
            colors={editor.palette.colors}
            selectedIndex={editor.selectedColorIndex}
            checkerDark={settings.checkerboardDark}
            onSelectColor={editor.setSelectedColorIndex}
            onReorderColors={(nextColors, nextSelectedIdx) => {
              editor.updateProjectPalette(
                { ...editor.palette, colors: nextColors },
                nextSelectedIdx
              )
            }}
            onOpenPaletteSheet={() => {
              setOptionsOpen(false)
              setPaletteOpen(true)
            }}
          />

          {/* 4. Bottom Push / Draw Button (Thumb-first on Smartphone/Touch; hidden on PC Mouse!) */}
          {inputModality !== 'mouse' && (
            <DrawButton
              tool={editor.tool}
              toolSettings={editor.toolSettings}
              stepPhase={editor.stepPhase}
              floatingShape={editor.floatingShape}
              moveSession={editor.moveSession}
              isContinuousDrawing={editor.isContinuousDrawing}
              activeHexColor={editor.activeHexColor}
              isTransparentColor={editor.isTransparentColorSelected}
              checkerDark={settings.checkerboardDark}
              onBeginDraw={() => editor.beginDrawAction()}
              onEndDraw={editor.endDrawAction}
              onCancelStep={editor.cancelMultiStep}
              onCommitShape={editor.commitFloatingShape}
              onCommitMove={editor.commitActiveMove}
            />
          )}
        </section>

        {/* Modals & Sheets */}
        <PaletteSheet
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          palette={editor.palette}
          selectedIndex={editor.selectedColorIndex}
          checkerDark={settings.checkerboardDark}
          libraryPalettes={palettes}
          onSelectColor={editor.setSelectedColorIndex}
          onUpdatePalette={editor.updateProjectPalette}
          onSaveToLibrary={async (name, colors, meta) => {
            await addLibraryPalette(name, colors, meta)
            showToast(t('toastSavedPalette'), 'success')
          }}
          canvasWidth={editor.project.width}
          canvasHeight={editor.project.height}
          layers={editor.layers}
          activeLayerId={editor.activeLayerId}
          onReplaceColor={editor.replaceProjectColor}
          onCountColorSlotUsage={editor.countPaletteSlotUsage}
          onDeleteColorSlot={editor.deletePaletteColorSlot}
          onRemoveUnusedColors={editor.removeUnusedPaletteColors}
        />

        <LayerSheet
          open={layersOpen}
          onClose={() => setLayersOpen(false)}
          palette={editor.palette}
          canvasWidth={editor.project.width}
          canvasHeight={editor.project.height}
          checkerDark={settings.checkerboardDark}
          layers={editor.layers}
          activeLayerId={editor.activeLayerId}
          selectedLayerIds={editor.selectedLayerIds}
          onSelectLayer={editor.setActiveLayerId}
          onToggleLayerSelected={editor.toggleLayerSelected}
          onClearLayerSelection={editor.clearLayerSelection}
          onStartMultiLayerMoveOnCanvas={() => {
            editor.startMultiLayerMove()
          }}
          onDuplicateSelectedLayers={() => {
            if (!editor.duplicateSelectedLayers()) {
              showToast(t('layerMaxReached'), 'warning')
            }
          }}
          onMergeSelectedLayers={() => {
            editor.mergeSelectedLayers()
          }}
          onDeleteSelectedLayers={() => {
            if (!editor.deleteSelectedLayers()) {
              showToast(t('cannotDeleteLastLayer'), 'warning')
            }
          }}
          onAddLayer={() => {
            if (!editor.addNewLayer()) {
              showToast(t('layerMaxReached'), 'warning')
            }
          }}
          onDuplicateLayer={(id) => {
            if (!editor.duplicateLayer(id)) {
              showToast(t('layerMaxReached'), 'warning')
            }
          }}
          onDeleteLayer={(id) => {
            if (!editor.deleteLayer(id)) {
              showToast(t('cannotDeleteLastLayer'), 'warning')
            }
          }}
          onMergeDown={editor.mergeLayerDown}
          onUpdateLayer={editor.updateLayerProps}
          onReorderLayers={editor.reorderLayers}
          onClearLayer={editor.clearLayerPixels}
          onCopyLayer={(id) => {
            if (editor.copyLayerToClipboard(id)) {
              showToast(t('toastCopied'))
            }
          }}
          onFlipLayer={editor.flipLayer}
          onStartLayerMoveOnCanvas={(id) => {
            editor.startLayerMove(id)
          }}
        />

        <CanvasResizeModal
          open={resizeOpen}
          currentWidth={editor.project.width}
          currentHeight={editor.project.height}
          layers={editor.layers}
          onClose={() => setResizeOpen(false)}
          onResize={editor.resizeCanvas}
        />

        <UnifiedExportModal
          open={exportOpen}
          mode={exportMode}
          projectName={editor.project.name}
          width={editor.project.width}
          height={editor.project.height}
          palette={editor.palette}
          layers={editor.layers}
          layerMetas={editor.layers}
          frames={editor.timeline.frames}
          cels={editor.timeline.cels}
          celBuffers={editor.timeline.celBuffers}
          activeFrameIndex={Math.max(
            0,
            editor.timeline.frames.findIndex(
              (f) => f.id === editor.timeline.activeFrameId
            )
          )}
          defaultDirection={editor.timeline.playbackDirection}
          defaultLoop={editor.timeline.loopPlayback}
          checkerDark={settings.checkerboardDark}
          onClose={() => setExportOpen(false)}
          onDownloaded={() => showToast(t('toastExportedFile'), 'success')}
          onShared={() => showToast(t('toastSharedFile'), 'success')}
        />

        <GlobalEditorSettingsModal
          open={globalSettingsOpen}
          onClose={() => setGlobalSettingsOpen(false)}
          previewFlipX={previewFlipX}
          previewFlipY={previewFlipY}
          onTogglePreviewFlipX={() => setPreviewFlipX((v) => !v)}
          onTogglePreviewFlipY={() => setPreviewFlipY((v) => !v)}
          onResetPreviewFlip={() => {
            setPreviewFlipX(false)
            setPreviewFlipY(false)
          }}
          symmetryMode={editor.symmetryMode}
          onChangeSymmetryMode={editor.setSymmetryMode}
          tilePreviewGrid={editor.tilePreviewGrid}
          onChangeTilePreviewGrid={editor.setTilePreviewGrid}
          seamlessWrapMode={editor.seamlessWrapMode}
          onChangeSeamlessWrapMode={editor.setSeamlessWrapMode}
        />

        <ExportSpriteSheetModal
          open={exportSpriteOpen}
          onClose={() => setExportSpriteOpen(false)}
          projectName={editor.project.name}
          width={editor.project.width}
          height={editor.project.height}
          palette={editor.palette}
          layerMetas={editor.layers}
          frames={editor.timeline.frames}
          cels={editor.timeline.cels}
          celBuffers={editor.timeline.celBuffers}
          fallbackSingleFrameLayers={editor.layers}
          defaultDirection={editor.timeline.playbackDirection}
          checkerDark={settings.checkerboardDark}
          onExportedPng={() => showToast(t('toastExportedSpriteSheet'), 'success')}
          onExportedJson={() => showToast(t('toastExportedSpriteJson'), 'success')}
        />

        <ExportAsepriteModal
          open={exportAseOpen}
          onClose={() => setExportAseOpen(false)}
          projectName={editor.project.name}
          width={editor.project.width}
          height={editor.project.height}
          layerMetas={editor.layers}
          frames={editor.timeline.frames}
          cels={editor.timeline.cels}
          celBuffers={editor.timeline.celBuffers}
          fallbackSingleFrameLayers={editor.layers}
          palette={editor.palette}
          paletteColors={editor.palette.colors}
          onExported={() => showToast(t('toastExportedAseprite'), 'success')}
        />
      </div>
    </ViewTransition>
  )
}
