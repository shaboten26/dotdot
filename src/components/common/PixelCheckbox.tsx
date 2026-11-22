export interface PixelCheckboxProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  ariaLabel?: string
  disabled?: boolean
  size?: number | string
  testId?: string
}

/**
 * Flat Pixel-Art Checkbox component (Zero shadows: state shown by border, fill, and pixel checkmark):
 * - OFF: Crisp empty square pixel frame
 * - ON: Crisp pixel checkmark inside framed box (never relies on color alone)
 * - Supports both labeled rows and compact standalone checkboxes (e.g. multi-layer selection)
 */
export function PixelCheckbox({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  size,
  testId,
}: PixelCheckboxProps) {
  const boxDim = size ?? 'var(--checkbox-size, 20px)'

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`group inline-flex items-center ${
        label ? 'gap-2 px-2 py-1' : 'p-1 justify-center'
      } min-h-[38px] select-none text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)] ${
        disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <span
        style={{
          width: boxDim,
          height: boxDim,
          minWidth: boxDim,
          minHeight: boxDim,
          aspectRatio: '1 / 1',
        }}
        className={`inline-flex items-center justify-center shrink-0 border-2 transition-colors ${
          checked
            ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] border-[var(--border-strong)]'
            : 'bg-[var(--bg-app)] text-transparent border-[var(--border-pixel)]'
        }`}
      >
        {checked && (
          <svg
            viewBox="0 0 12 12"
            preserveAspectRatio="xMidYMid meet"
            shapeRendering="crispEdges"
            fill="currentColor"
            className="w-[75%] h-[75%] block"
            aria-hidden="true"
          >
            <rect x={9} y={2} width={2} height={2} />
            <rect x={8} y={3} width={2} height={2} />
            <rect x={7} y={4} width={2} height={2} />
            <rect x={6} y={5} width={2} height={2} />
            <rect x={5} y={6} width={2} height={2} />
            <rect x={4} y={7} width={2} height={2} />
            <rect x={2} y={5} width={2} height={2} />
            <rect x={3} y={6} width={2} height={2} />
          </svg>
        )}
      </span>
      {label && (
        <span className="text-xs leading-snug text-[var(--text-primary)]">
          {label}
        </span>
      )}
    </button>
  )
}
