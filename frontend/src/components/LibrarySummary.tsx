interface LibrarySummaryProps {
  total: number
  active: number
  ready: number
  failed: number
}

export function LibrarySummary({ total, active, ready, failed }: LibrarySummaryProps) {
  const items = [
    { label: 'Total', value: total },
    { label: 'Active', value: active },
    { label: 'Ready', value: ready },
    { label: 'Failed', value: failed },
  ]

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1" aria-label="Library summary">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-paper-subtle">{item.label}</dt>
          <dd className="font-mono text-sm text-paper">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
