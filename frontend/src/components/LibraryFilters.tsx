import { Check } from 'lucide-react'

export type FilterKey = 'all' | 'active' | 'complete' | 'failed'

export const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All',
  active: 'Active',
  complete: 'Ready',
  failed: 'Failed',
}

const FILTER_ORDER: FilterKey[] = ['all', 'active', 'complete', 'failed']

interface LibraryFiltersProps {
  filter: FilterKey
  onChange: (filter: FilterKey) => void
  counts: Record<FilterKey, number>
}

export function LibraryFilters({ filter, onChange, counts }: LibraryFiltersProps) {
  return (
    <div role="group" aria-label="Filter library" className="-m-0.5 flex gap-2 overflow-x-auto p-0.5">
      {FILTER_ORDER.map((key) => {
        const selected = filter === key
        return (
          <button
            key={key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(key)}
            className={`flex h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${
              selected
                ? 'border-gold bg-gold/15 text-gold'
                : 'border-border text-paper-muted hover:border-border-strong hover:text-paper'
            }`}
          >
            {selected ? <Check size={14} aria-hidden="true" /> : null}
            {FILTER_LABELS[key]}
            <span className="font-mono text-xs opacity-80">{counts[key]}</span>
          </button>
        )
      })}
    </div>
  )
}
