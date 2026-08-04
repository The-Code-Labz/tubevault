import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/api.ts'
import { useModalDialog } from '../lib/use-modal-dialog.ts'
import { formatBackendLabel } from '../lib/format.ts'
import type { Video } from '../types.ts'

interface PlayerDialogProps {
  video: Video | null
  onClose: () => void
}

export function PlayerDialog({ video, onClose }: PlayerDialogProps) {
  const ref = useModalDialog(video, onClose)
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!video) return
    let cancelled = false
    setStreamUrl(null)
    setError(null)
    api
      .getStreamUrl(video.id)
      .then((res) => {
        if (!cancelled) setStreamUrl(res.url)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, attempt])

  const title = video?.title || 'Untitled video'

  return (
    <dialog
      ref={ref}
      aria-labelledby="player-heading"
      className="w-[min(94vw,72rem)] rounded-xl border border-border bg-surface p-4 text-paper shadow-archive backdrop:bg-canvas/85 sm:p-6"
    >
      {video ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 id="player-heading" className="min-w-0 truncate text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              aria-label="Close player"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-paper-muted transition hover:bg-surface-raised hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-4 aspect-video max-h-[70dvh] w-full overflow-hidden rounded-lg bg-well">
            {error ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
                <p className="text-sm text-danger">{error}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAttempt((n) => n + 1)}
                    className="h-11 rounded-lg border border-border px-4 text-sm text-paper transition hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={() => ref.current?.close()}
                    className="h-11 rounded-lg border border-border px-4 text-sm text-paper-muted transition hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : streamUrl ? (
              <video src={streamUrl} controls className="h-full w-full bg-canvas" />
            ) : (
              <div role="status" className="flex h-full w-full items-center justify-center text-sm text-paper-muted">
                Loading stream…
              </div>
            )}
          </div>

          <p className="mt-3 font-mono text-xs text-paper-muted">{formatBackendLabel(video.storageBackend)}</p>
        </>
      ) : null}
    </dialog>
  )
}
