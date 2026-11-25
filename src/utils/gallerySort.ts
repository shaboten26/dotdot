import type { AppSettings, ProjectRecord } from '../types'

/**
 * Shared Gallery artwork sort helper used by both GalleryPage (`/`)
 * and ProjectDetailPage (`/project/:id`) swipe navigation so artwork order
 * stays 100% identical across screens.
 */
export function sortProjectsByGalleryMode(
  projects: readonly ProjectRecord[],
  mode: AppSettings['gallerySortMode']
): ProjectRecord[] {
  const list = [...projects]
  switch (mode) {
    case 'newest':
      return list.sort(
        (a, b) => b.createdAt - a.createdAt || a.order - b.order || a.id.localeCompare(b.id)
      )
    case 'oldest':
      return list.sort(
        (a, b) => a.createdAt - b.createdAt || a.order - b.order || a.id.localeCompare(b.id)
      )
    case 'updated':
      return list.sort(
        (a, b) => b.updatedAt - a.updatedAt || a.order - b.order || a.id.localeCompare(b.id)
      )
    case 'name':
      return list.sort(
        (a, b) => a.name.localeCompare(b.name) || a.order - b.order || a.id.localeCompare(b.id)
      )
    case 'manual':
    default:
      return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }
}
