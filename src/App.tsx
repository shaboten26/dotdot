import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { motion } from 'motion/react'
import { AppProvider, useApp } from './state/AppContext'
import { ToastContainer } from './components/common/ToastContainer'
import { IosPwaTopBlurFix } from './components/common/IosPwaTopBlurFix'
import { EditorPage } from './pages/EditorPage'
import { GalleryPage } from './pages/GalleryPage'
import { ProjectDetailPage } from './pages/ProjectDetailPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * Computes a coarse route-group key so switching between `/project/a` and `/project/b`
 * or `/editor/a` and `/editor/b` keeps the page shell mounted without remounting the canvas,
 * while cross-screen transitions (`/` <-> `/project/:id` <-> `/editor/:id` <-> `/settings`)
 * receive a smooth Motion fallback (`transform` + `opacity`) even when View Transition API is absent.
 */
function getRouteGroupKey(pathname: string): string {
  if (pathname.startsWith('/editor')) return 'editor'
  if (pathname.startsWith('/project/')) return 'detail'
  if (pathname.startsWith('/settings')) return 'settings'
  return 'gallery'
}

function AnimatedAppRoutes() {
  const location = useLocation()
  const { reducedMotion } = useApp()
  const supportsVT =
    typeof document !== 'undefined' && 'startViewTransition' in document
  const groupKey = getRouteGroupKey(location.pathname)

  return (
    <motion.div
      key={groupKey}
      initial={
        reducedMotion || supportsVT
          ? false
          : { opacity: 0, y: 6, scale: 0.994 }
      }
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        reducedMotion || supportsVT
          ? { duration: 0 }
          : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
      }
      className="min-h-dvh w-full"
    >
      <Routes location={location}>
        <Route path="/" element={<GalleryPage />} />
        <Route path="/gallery" element={<Navigate to="/" replace />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/editor/:id" element={<EditorPage />} />
        <Route path="/project/:id" element={<ProjectDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </motion.div>
  )
}

/**
 * Standard startup route (`/`) is the Artwork Gallery (`GalleryPage`).
 * Selecting an artwork opens `/project/:id` via synchronized ViewTransition + Motion fallback.
 */
export function App() {
  return (
    <AppProvider>
      <IosPwaTopBlurFix />
      <BrowserRouter>
        <ToastContainer />
        <AnimatedAppRoutes />
      </BrowserRouter>
    </AppProvider>
  )
}
