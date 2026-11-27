/**
 * Official `dotdot` Brand Pixel-Art Components:
 * 1. `<DotDotWordmark />` (`32x8` pixel art — crisp `"dotdot"` pixel lettering)
 *    - Cropped tightly to `viewBox="4 2 24 5"` by default (`compactCrop = true`) or full `viewBox="0 0 32 8"`
 *    - Renders with `shapeRendering="crispEdges"` so every pixel is sharp at any zoom!
 * 2. `<DotDotAppIcon />` (`32x32` pixel art — night sky, crescent moon, stars, black cat & `"dotdot"` lettering)
 */
export function DotDotWordmark({
  height = 18,
  color = 'currentColor',
  compactCrop = true,
  className = '',
  title = 'dotdot',
  testId,
}: {
  height?: number
  color?: string
  compactCrop?: boolean
  className?: string
  title?: string
  testId?: string
}) {
  const vb = compactCrop ? '4 2 24 5' : '0 0 32 8'
  const aspect = compactCrop ? 24 / 5 : 32 / 8
  const width = Math.round(height * aspect)

  return (
    <svg
      width={width}
      height={height}
      viewBox={vb}
      shapeRendering="crispEdges"
      fill={color}
      role="img"
      aria-label={title}
      className={`shrink-0 select-none pixelated ${className}`}
      data-testid={testId}
    >
      <title>{title}</title>
      {/* Row 2 */}
      <rect x="6" y="2" width="1" height="1" />
      <rect x="13" y="2" width="1" height="1" />
      <rect x="19" y="2" width="1" height="1" />
      <rect x="26" y="2" width="1" height="1" />
      {/* Row 3 */}
      <rect x="6" y="3" width="1" height="1" />
      <rect x="12" y="3" width="3" height="1" />
      <rect x="19" y="3" width="1" height="1" />
      <rect x="25" y="3" width="3" height="1" />
      {/* Row 4 */}
      <rect x="5" y="4" width="2" height="1" />
      <rect x="9" y="4" width="1" height="1" />
      <rect x="13" y="4" width="1" height="1" />
      <rect x="18" y="4" width="2" height="1" />
      <rect x="22" y="4" width="1" height="1" />
      <rect x="26" y="4" width="1" height="1" />
      {/* Row 5 */}
      <rect x="4" y="5" width="1" height="1" />
      <rect x="6" y="5" width="1" height="1" />
      <rect x="8" y="5" width="1" height="1" />
      <rect x="10" y="5" width="1" height="1" />
      <rect x="13" y="5" width="1" height="1" />
      <rect x="17" y="5" width="1" height="1" />
      <rect x="19" y="5" width="1" height="1" />
      <rect x="21" y="5" width="1" height="1" />
      <rect x="23" y="5" width="1" height="1" />
      <rect x="26" y="5" width="1" height="1" />
      {/* Row 6 */}
      <rect x="5" y="6" width="1" height="1" />
      <rect x="9" y="6" width="1" height="1" />
      <rect x="13" y="6" width="1" height="1" />
      <rect x="18" y="6" width="1" height="1" />
      <rect x="22" y="6" width="1" height="1" />
      <rect x="26" y="6" width="1" height="1" />
    </svg>
  )
}

export function DotDotAppIcon({
  size = 32,
  className = '',
  testId,
}: {
  size?: number
  className?: string
  testId?: string
}) {
  return (
    <img
      src="/favicon.svg"
      alt="dotdot icon"
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none pixelated block ${className}`}
      data-testid={testId}
    />
  )
}
