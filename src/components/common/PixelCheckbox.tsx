export interface PixelCheckboxProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  size?: number | string
  testId?: string
}

/**
 * Spec v2 Section 8:
 * Pixel-art Checkbox component:
 * - OFF: Crisp empty square pixel frame
 * - ON: Crisp pixel checkmark inside framed box (never relies on color alone)
 * - Focus: Distinct outer pixel outline
 * - Touch hit target >= 44px height when tapped
 */
export function PixelCheckbox({
  checked,
  onChange,
  label,
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
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`group inline-flex items-center gap-2 min-h-[38px] px-2 py-1 select-none text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)] ${
        disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <span
        style={{ width: boxDim, height: boxDim }}
        className={`inline-flex items-center justify-center shrink-0 border-2 border-[var(--border-pixel)] transition-colors ${
          checked
            ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] shadow-[2px_2px_0px_var(--accent-primary-shadow)]'
            : 'bg-[var(--bg-app)] text-transparent shadow-[2px_2px_0px_var(--shadow-pixel)]'
        }`}
      >
        {checked && (
          <svg
            viewBox="0 0 12 12"
            shapeRendering="crispEdges"
            fill="currentColor"
            className="w-[75%] h-[75%]"
            aria-hidden="true"
          >
            {/* Crisp pixel checkmark */}
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
      <span className="text-xs leading-snug text-[var(--text-primary)]">
        {label}
      </span>
    </button>
  )
}
