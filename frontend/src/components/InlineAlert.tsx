import { AlertTriangle, X } from 'lucide-react'

interface InlineAlertProps {
  message: string
  tone?: 'danger' | 'neutral'
  onRetry?: () => void
  onDismiss?: () => void
}

export function InlineAlert({ message, tone = 'danger', onRetry, onDismiss }: InlineAlertProps) {
  const toneClass =
    tone === 'danger' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-border bg-surface text-paper'

  return (
    <div role="alert" className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${toneClass}`}>
      <span className="flex items-center gap-2">
        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
        {message}
      </span>
      {onRetry || onDismiss ? (
        <span className="flex items-center gap-2">
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-current px-3 py-1.5 text-xs font-medium transition hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              Retry
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="rounded-md p-1.5 transition hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
