import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { AppProvider } from './state/AppContext'
import { ToastContainer } from './components/common/ToastContainer'
import { EditorPage } from './pages/EditorPage'
import { GalleryPage } from './pages/GalleryPage'
import { ProjectDetailPage } from './pages/ProjectDetailPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * Spec v2 Section 5-1:
 * Standard startup route (`/`) is the Artwork Gallery (`GalleryPage`).
 * Selecting or creating an artwork navigates to `/editor/:id`.
 */
export function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <ToastContainer />
        <Routes>
          <Route path="/" element={<GalleryPage />} />
          <Route path="/gallery" element={<Navigate to="/" replace />} />
          <Route path="/editor" element={<EditorPage />} />
          <Route path="/editor/:id" element={<EditorPage />} />
          <Route path="/project/:id" element={<ProjectDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  )
}
