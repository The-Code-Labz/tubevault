import { VaultMark } from './VaultMark.tsx'

export function MediaPlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-well" aria-hidden="true">
      <VaultMark size={32} className="text-border-strong" />
    </div>
  )
}
