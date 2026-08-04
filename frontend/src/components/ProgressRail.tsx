interface ProgressRailProps {
  label: string
  value: number
}

export function ProgressRail({ label, value }: ProgressRailProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value || 0)))

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 font-mono text-xs">
        <span className="flex items-center gap-1.5 text-gold">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold" aria-hidden="true" />
          {label}
        </span>
        <span className="text-paper-muted">{clamped}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-canvas"
      >
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-150 motion-reduce:transition-none"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
