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
  ToolDetailPopover,
} from '../components/editor/ToolPanels'
import { PaletteSheet } from '../components/editor/PaletteSheet'
import { LayerSheet } from '../components/editor/LayerSheet'
import { TimelinePanel } from '../components/editor/TimelinePanel'
import { ExportGifModal } from '../components/editor/ExportGifModal'
import {
  CanvasResizeModal,
  ExportPngModal,
} from '../components/editor/EditorModals'
import {
  detectInitialInputModality,
  type InputModality,
} from '../utils/inputDetect'
import { PixelIcon, PixelLoadingIndicator } from '../components/common/PixelIcon'
import { PixelCheckbox } from '../components/common/PixelCheckbox'
import {
  useViewTransitionNavigate,
  VTButtonLink,
} from '../components/common/ViewTransitionNav'

export function EditorPage() {
  const { id: routeProjectId } = useParams<{ id?: string }>()
  const {
    ready,
    settings,
    reducedMotion,
    palettes,
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
  const [exportGifOpen, setExportGifOpen] = useState(false)
  const [workspaceTab, setWorkspaceTab] = useState<'tools' | 'frames'>('tools')
  const [inputModality, setInputModality] = useState<InputModality>(() =>
    detectInitialInputModality()
  )
  const [loadWarningDismissed, setLoadWarningDismissed] = useState(false)
  const [fitTrigger, setFitTrigger] = useState(0)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const editor = useEditorController({
    projectId: targetProjectId,
    historyLimit: settings.historyLimit,
    soundEnabled: settings.soundEnabled,
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

  if (!ready || editor.loading) {
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
                      setExportOpen(true)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn pixel-btn-teal flex items-center gap-2 text-xs font-bold text-left"
                    data-testid="editor-export-png-btn"
                  >
                    <PixelIcon name="download" size={16} />
                    <span>{t('exportPng')}</span>
                  </button>

                  {editor.timeline.frames.length >= 2 && (
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMenuOpen(false)
                        setExportGifOpen(true)
                      }}
                      className="w-full min-h-[42px] px-3 pixel-btn pixel-btn-active flex items-center gap-2 text-xs font-bold text-left"
                      data-testid="editor-export-gif-btn"
                    >
                      <PixelIcon name="film" size={16} />
                      <span>{t('exportGif')}</span>
                    </button>
                  )}

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

        {/* Non-Blocking Load Warning Banner (when cel memory or expanded GIF size enters caution/high tier) */}
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
            hasSelection={editor.hasSelection}
            selectionMask={editor.selectionMask}
            worldSelection={editor.worldSelection}
            showGrid={settings.showGrid}
            checkerboardDark={settings.checkerboardDark}
            activeHexColor={editor.activeHexColor}
            isTransparentColor={editor.isTransparentColorSelected}
            eyedropperDoubleTap={settings.eyedropperDoubleTap}
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
            <ActiveMoveBar
              moveSession={editor.moveSession}
              onMoveStep={editor.updateActiveMoveOffset}
              onCommit={editor.commitActiveMove}
              onCancel={editor.cancelActiveMove}
            />
          ) : editor.floatingShape ? (
            <FloatingTransformBar
              floatingShape={editor.floatingShape}
              onRotate={editor.rotateFloatingShape}
              onMove={editor.moveFloatingShape}
              onCommit={editor.commitFloatingShape}
              onDiscard={editor.discardFloatingShape}
            />
          ) : (
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
              onChange={(patch) =>
                editor.setToolSettings((prev) => ({ ...prev, ...patch }))
              }
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

          {/* Workspace Mode Switcher: `ツール` vs (`レイヤー` [1 frame] / `タイムライン` [>=2 frames]) */}
          <div
            className="flex items-center justify-between gap-1.5 px-2.5 py-1 bg-[var(--bg-surface)] border-t-2 border-[var(--border-pixel)] shrink-0"
            data-testid="workspace-mode-bar"
          >
            <div className="grid grid-cols-2 gap-1.5 flex-1 max-w-xs">
              <button
                type="button"
                onClick={() => setWorkspaceTab('tools')}
                className={`min-h-[32px] px-2.5 text-xs font-bold flex items-center justify-center gap-1 ${
                  workspaceTab === 'tools'
                    ? 'pixel-btn pixel-btn-active'
                    : 'pixel-btn'
                }`}
                data-testid="workspace-tab-tools"
              >
                <PixelIcon name="pen" size={13} />
                <span>{t('tabTools')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOptionsOpen(false)
                  setWorkspaceTab('frames')
                }}
                className={`min-h-[32px] px-2.5 text-xs font-bold flex items-center justify-center gap-1 ${
                  workspaceTab === 'frames'
                    ? 'pixel-btn pixel-btn-active'
                    : 'pixel-btn'
                }`}
                data-testid={
                  editor.timeline.frames.length >= 2
                    ? 'workspace-tab-timeline'
                    : 'workspace-tab-layers'
                }
              >
                <PixelIcon
                  name={editor.timeline.frames.length >= 2 ? 'film' : 'layers'}
                  size={13}
                />
                <span>
                  {editor.timeline.frames.length >= 2
                    ? `${t('tabTimeline')} (${editor.timeline.frames.length})`
                    : `${t('tabLayers')} (${editor.layers.length})`}
                </span>
              </button>
            </div>

            {editor.timeline.frames.length >= 2 && workspaceTab === 'tools' && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => editor.stepFrame(-1)}
                  className="pixel-btn min-w-[30px] min-h-[30px] flex items-center justify-center"
                  title={t('prevFrameBtn')}
                >
                  <PixelIcon name="arrowLeft" size={12} />
                </button>
                <button
                  type="button"
                  onClick={editor.togglePlay}
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
                >
                  <PixelIcon name="arrowRight" size={12} />
                </button>
              </div>
            )}
          </div>

          {/* 2. Workspace Content (`ツール` Multi-Row Grid OR `レイヤー`/`タイムライン` Inline Panel) */}
          {workspaceTab === 'tools' ? (
            <MultiRowToolGrid
              tool={editor.tool}
              toolSettings={editor.toolSettings}
              optionsOpen={optionsOpen}
              canUndo={editor.canUndo}
              canRedo={editor.canRedo}
              layerCount={editor.layers.length}
              hasSelection={editor.hasSelection}
              onTapTool={handleTapTool}
              onOpenLayers={() => {
                setOptionsOpen(false)
                setLayersOpen(true)
              }}
              onUndo={editor.undo}
              onRedo={editor.redo}
            />
          ) : (
            <TimelinePanel
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
              onStepFrame={editor.stepFrame}
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
              onApplyBatchDuration={editor.applyBatchDuration}
              onClearCell={editor.clearCell}
              onUnlinkCell={editor.unlinkCell}
              onLinkCellTo={editor.linkCellTo}
              onMoveCellTo={editor.moveCellTo}
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
              onTogglePlay={editor.togglePlay}
              onSetPlaybackSpeed={editor.setPlaybackSpeed}
              onSetPlaybackDirection={editor.setPlaybackDirection}
              onSetLoopPlayback={editor.setLoopPlayback}
              onUpdateOnionSkin={editor.updateOnionSkin}
              onOpenExportGif={() => setExportGifOpen(true)}
            />
          )}

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
        />

        <LayerSheet
          open={layersOpen}
          onClose={() => setLayersOpen(false)}
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

        <ExportPngModal
          open={exportOpen}
          projectName={editor.project.name}
          width={editor.project.width}
          height={editor.project.height}
          layers={editor.layers}
          checkerDark={settings.checkerboardDark}
          onClose={() => setExportOpen(false)}
          onDownloaded={() => showToast(t('toastExportedPng'), 'success')}
          onShared={() => showToast(t('toastSharedPng'), 'success')}
        />

        <ExportGifModal
          open={exportGifOpen}
          projectName={editor.project.name}
          width={editor.project.width}
          height={editor.project.height}
          layerMetas={editor.layers}
          frames={editor.timeline.frames}
          cels={editor.timeline.cels}
          celBuffers={editor.timeline.celBuffers}
          fallbackSingleFrameLayers={editor.layers}
          defaultDirection={editor.timeline.playbackDirection}
          defaultLoop={editor.timeline.loopPlayback}
          checkerDark={settings.checkerboardDark}
          onClose={() => setExportGifOpen(false)}
          onDownloaded={() => showToast(t('toastExportedGif'), 'success')}
          onShared={() => showToast(t('toastSharedGif'), 'success')}
          onCancelled={() => showToast(t('toastGifCancelled'), 'info')}
        />
      </div>
    </ViewTransition>
  )
}
