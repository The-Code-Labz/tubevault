import { LogOut } from 'lucide-react'
import { VaultMark, VaultWordmark } from './VaultMark.tsx'

interface AppHeaderProps {
  email: string
  onSignOut: () => void
}

export function AppHeader({ email, onSignOut }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-chrome">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-5 sm:px-7 lg:px-10">
        <VaultMark size={26} className="shrink-0 text-gold" />
        <VaultWordmark withDescriptor />

        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:gap-3">
          <span className="min-w-0 truncate font-mono text-xs text-paper-muted" title={email}>
            {email}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            aria-label="Sign out"
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-paper-muted transition hover:border-border-strong hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            <LogOut size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  )
}
