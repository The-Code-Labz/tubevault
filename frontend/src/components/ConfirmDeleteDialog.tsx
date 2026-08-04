import { useModalDialog } from '../lib/use-modal-dialog.ts'
import type { Video } from '../types.ts'

interface ConfirmDeleteDialogProps {
  video: Video | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDeleteDialog({ video, busy, onConfirm, onCancel }: ConfirmDeleteDialogProps) {
  const ref = useModalDialog(video, onCancel)

  const title = video?.title || 'this video'

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-delete-heading"
      className="w-[min(92vw,26rem)] rounded-xl border border-border bg-surface p-6 text-paper shadow-archive backdrop:bg-canvas/85"
    >
      {video ? (
        <>
          <h2 id="confirm-delete-heading" className="text-base font-semibold leading-[22px]">
            Delete "{title}"?
          </h2>
          <p className="mt-2 text-sm text-paper-muted">
            This permanently removes the stored file and its record from your private library.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="h-11 rounded-lg border border-border px-4 text-sm text-paper transition hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="h-11 rounded-lg bg-danger px-4 text-sm font-semibold text-canvas transition hover:opacity-90 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              {busy ? 'Deleting…' : 'Delete video'}
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  )
}
