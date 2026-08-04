import { VaultMark } from './VaultMark.tsx'

interface EmptyLibraryProps {
  variant: 'first-use' | 'filtered'
  filterLabel?: string
  onShowAll?: () => void
}

export function EmptyLibrary({ variant, filterLabel, onShowAll }: EmptyLibraryProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
      <VaultMark size={30} className="text-border-strong" />
      {variant === 'filtered' ? (
        <>
          <p className="max-w-sm text-sm text-paper-muted">
            No videos match <span className="text-paper">{filterLabel}</span>.
          </p>
          <button
            type="button"
            onClick={onShowAll}
            className="h-11 rounded-lg border border-border px-4 text-sm text-paper transition hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            Show all
          </button>
        </>
      ) : (
        <p className="max-w-sm text-sm text-paper-muted">
          Your private library is empty. Paste a source URL above to add the first item.
        </p>
      )}
    </div>
  )
}
