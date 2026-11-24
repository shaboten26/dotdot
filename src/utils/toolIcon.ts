import type { ToolId, ToolSettings } from '../types'
import type { PixelIconName } from '../components/common/PixelIcon'

/**
 * Section 17: Single centralized resolver for the icon representing any tool + its active sub-mode/shape.
 * Guarantees 100% consistency across the MultiRowToolGrid, ToolDetailPopover header, Top-Right Status Badge,
 * and Settings Live UI Preview!
 */
export function resolveToolIconName(
  tool: ToolId,
  settings: ToolSettings
): PixelIconName {
  switch (tool) {
    case 'pen':
      return 'pen'
    case 'eraser':
      return 'eraser'
    case 'fill':
      return settings.fillMode === 'gradient' ? 'gradient' : 'fill'
    case 'line':
      return settings.lineType === 'bezier' ? 'bezier' : 'line'
    case 'shape':
      return settings.shapeType === 'ellipse' ? 'ellipse' : 'rect'
    case 'select':
      if (settings.selectType === 'wand') return 'wand'
      if (settings.selectType === 'ellipse') return 'ellipse'
      return 'rect'
    case 'eyedropper':
      return 'eyedropper'
  }
}

export function resolveBrushShapeIconName(shape: 'square' | 'circle'): PixelIconName {
  return shape === 'circle' ? 'ellipse' : 'rect'
}
