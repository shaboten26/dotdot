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
  FloatingTransformBar,
  MultiRowToolGrid,
  PaletteBar,
  ToolDetailPopover,
} from '../components/editor/ToolPanels'
import { PaletteSheet } from '../components/editor/PaletteSheet'
import { LayerSheet } from '../components/editor/LayerSheet'
import {
  CanvasResizeModal,
  ExportPngModal,
} from '../components/editor/EditorModals'
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

  // Spec v2 Section 7: Tool detail settings start CLOSED by default
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [resizeOpen, setResizeOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
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
  })

  // Keep activeProjectId synced when opened via /editor/:id
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

  /**
   * Spec v2 Section 7:
   * 1. First tap on an unselected tool -> selects that tool & closes any previous detail panel.
   * 2. Second tap on the ALREADY selected tool -> opens its detail panel.
   * 3. Another tap while open -> closes its detail panel.
   */
  const handleTapTool = (clickedTool: ToolId) => {
    setHeaderMenuOpen(false)
    if (clickedTool === editor.tool) {
      if (clickedTool === 'eyedropper' && !editor.hasSelection) return
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
      if (e.key === 'Enter' && editor.floatingShape) {
        e.preventDefault()
        editor.commitFloatingShape()
        return
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
        {/* Spec v2 Section 5-2: Minimal Focused Header (Back to Gallery, Artwork Title, Compact Menu) */}
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
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  setEditingTitle(false)
                  editor.renameProject(titleDraft)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setEditingTitle(false)
                    editor.renameProject(titleDraft)
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
                  [{editor.project.width}×{editor.project.height}]
                </span>
              </button>
            )}
          </div>

          {/* Compact Auxiliary Menu Button (>= 44x44px) */}
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

          {/* Auxiliary Menu Popover (keeps secondary actions out of the main canvas bar) */}
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

                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false)
                      vtNavigate(`/project/${editor.project!.id}`)
                    }}
                    className="w-full min-h-[42px] px-3 pixel-btn flex items-center gap-2 text-xs font-bold text-left"
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

        {/* 1. Large Expansive Canvas (Centerpiece of the Editor: Spec v2 Section 4-1 & 4-2) */}
        <main
          className="flex-1 min-h-0 relative"
          onPointerDown={() => {
            if (headerMenuOpen) setHeaderMenuOpen(false)
          }}
        >
          <InteractiveViewport
            width={editor.project.width}
            height={editor.project.height}
            compositedBuffer={editor.compositedBuffer}
            tool={editor.tool}
            toolSettings={editor.toolSettings}
            cursor={editor.cursor}
            stepPhase={editor.stepPhase}
            floatingShape={editor.floatingShape}
            selectionMask={editor.selectionMask}
            showGrid={settings.showGrid}
            checkerboardDark={settings.checkerboardDark}
            activeHexColor={editor.activeHexColor}
            fitTrigger={fitTrigger}
            onMoveCursor={editor.moveCursorTo}
            onBeginDrawAt={(pt) => {
              if (optionsOpen) setOptionsOpen(false)
              editor.beginDrawAction(pt)
            }}
            onEndDraw={editor.endDrawAction}
            onMoveFloatingShape={editor.moveFloatingShape}
          />
        </main>

        {/* Dotpict-Inspired Lower Dock:
            2. Multi-row Tool Grid (with floating detail popover right above it)
            3. Palette Swatch Bar
            4. Massive Retro Draw Button */}
        <section className="relative flex flex-col shrink-0 z-20">
          {editor.floatingShape ? (
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
              activeHexColor={editor.activeHexColor}
              hasSelection={editor.hasSelection}
              hasClipboard={editor.clipboard !== null}
              onChange={(patch) =>
                editor.setToolSettings((prev) => ({ ...prev, ...patch }))
              }
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

          {/* 2. Multi-row Tool Grid (icon + short label, tap active tool again to toggle options) */}
          <MultiRowToolGrid
            tool={editor.tool}
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

          {/* 3. Palette Swatch Strip */}
          <PaletteBar
            colors={editor.palette.colors}
            selectedIndex={editor.selectedColorIndex}
            onSelectColor={editor.setSelectedColorIndex}
            onOpenPaletteSheet={() => {
              setOptionsOpen(false)
              setPaletteOpen(true)
            }}
          />

          {/* 4. Massive Bottom Push / Draw Button */}
          <DrawButton
            tool={editor.tool}
            toolSettings={editor.toolSettings}
            stepPhase={editor.stepPhase}
            floatingShape={editor.floatingShape}
            isContinuousDrawing={editor.isContinuousDrawing}
            activeHexColor={editor.activeHexColor}
            onBeginDraw={() => editor.beginDrawAction()}
            onEndDraw={editor.endDrawAction}
            onCancelStep={editor.cancelMultiStep}
            onCommitShape={editor.commitFloatingShape}
          />
        </section>

        {/* Modals & Sheets */}
        <PaletteSheet
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          palette={editor.palette}
          selectedIndex={editor.selectedColorIndex}
          libraryPalettes={palettes}
          onSelectColor={editor.setSelectedColorIndex}
          onUpdatePalette={editor.updateProjectPalette}
          onSaveToLibrary={async (name, colors) => {
            await addLibraryPalette(name, colors)
            showToast(t('toastSavedPalette'), 'success')
          }}
        />

        <LayerSheet
          open={layersOpen}
          onClose={() => setLayersOpen(false)}
          layers={editor.layers}
          activeLayerId={editor.activeLayerId}
          onSelectLayer={editor.setActiveLayerId}
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
          onMoveLayer={editor.translateLayer}
        />

        <CanvasResizeModal
          open={resizeOpen}
          currentWidth={editor.project.width}
          currentHeight={editor.project.height}
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
          onExported={() => showToast(t('toastExportedPng'), 'success')}
        />
      </div>
    </ViewTransition>
  )
}
