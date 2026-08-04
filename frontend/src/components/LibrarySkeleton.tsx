interface LibrarySkeletonProps {
  count?: number
}

export function LibrarySkeleton({ count = 8 }: LibrarySkeletonProps) {
  return (
    <div
      className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]"
      role="status"
      aria-label="Loading library"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="animate-pulse overflow-hidden rounded-lg border border-border bg-surface motion-reduce:animate-none"
        >
          <div className="aspect-video w-full bg-well" />
          <div className="flex flex-col gap-2 p-3.5">
            <div className="h-4 w-4/5 rounded bg-surface-raised" />
            <div className="h-3 w-2/5 rounded bg-surface-raised" />
            <div className="h-3 w-1/3 rounded bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  )
}
