interface VaultMarkProps {
  size?: number
  className?: string
}

/**
 * Repository-owned brand mark: a square vault aperture with a triangular
 * play cutout and one offset locking notch. Single-color (currentColor) so
 * it holds up at 16px and in any accent context.
 */
export function VaultMark({ size = 24, className = '' }: VaultMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.25 8v8l6.5-4-6.5-4z" fill="currentColor" />
      <rect x="15.5" y="1.5" width="3.4" height="3.4" rx="0.8" fill="currentColor" />
    </svg>
  )
}

interface VaultWordmarkProps {
  withDescriptor?: boolean
  className?: string
}

export function VaultWordmark({ withDescriptor = false, className = '' }: VaultWordmarkProps) {
  return (
    <span className={`inline-flex flex-col justify-center leading-none ${className}`}>
      <span className="text-2xl font-semibold leading-[30px] tracking-tight text-paper sm:text-[28px] sm:leading-[34px]">
        <span className="font-normal">Tube</span>Vault
      </span>
      {withDescriptor ? (
        <span className="hidden font-mono text-[11px] uppercase tracking-[0.14em] text-paper-subtle lg:block">
          Private media archive
        </span>
      ) : null}
    </span>
  )
}
