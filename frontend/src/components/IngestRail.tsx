import { useRef, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { InlineAlert } from './InlineAlert.tsx'
import type { DownloadRequest } from '../types.ts'

interface IngestRailProps {
  onSubmit: (req: DownloadRequest) => Promise<boolean>
  submitting: boolean
  submitError: string | null
}

export function IngestRail({ onSubmit, submitting, submitError }: IngestRailProps) {
  const [url, setUrl] = useState('')
  const [backend, setBackend] = useState<'supabase' | 'r2'>('supabase')
  const [announcement, setAnnouncement] = useState('')
  // Screen readers only re-announce a live region when its text content
  // changes, so back-to-back identical successes ("Added to queue.") would
  // silently announce once and then go quiet. A trailing zero-width space
  // toggled on each success keeps the text unique every time without
  // changing what is heard or seen.
  const announceSeq = useRef(0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || submitting) return
    const ok = await onSubmit({ url: url.trim(), backend })
    if (ok) {
      setUrl('')
      announceSeq.current += 1
      setAnnouncement(`Added to queue.${announceSeq.current % 2 === 0 ? '​' : ''}`)
    }
  }

  return (
    <section aria-labelledby="ingest-rail-heading" className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 id="ingest-rail-heading" className="sr-only">
        Add to vault
      </h2>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      {submitError ? (
        <div className="mb-4">
          <InlineAlert tone="danger" message={submitError} />
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="ingest-url" className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-paper-muted">
            Source URL
          </label>
          <input
            id="ingest-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            required
            disabled={submitting}
            className="h-[52px] w-full rounded-lg border border-border bg-canvas px-4 text-[15px] text-paper placeholder-paper-subtle outline-none transition focus-visible:border-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-60"
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div>
            <label htmlFor="ingest-backend" className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-paper-muted">
              Storage
            </label>
            <select
              id="ingest-backend"
              value={backend}
              onChange={(e) => setBackend(e.target.value as 'supabase' | 'r2')}
              disabled={submitting}
              className="h-[52px] rounded-lg border border-border bg-canvas px-3 text-sm text-paper outline-none transition focus-visible:border-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-60"
            >
              <option value="supabase">Supabase</option>
              <option value="r2">Cloudflare R2</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="flex h-[52px] items-center justify-center gap-2 rounded-lg bg-gold px-6 text-[15px] font-semibold text-canvas transition hover:bg-gold-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            {submitting ? (
              <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Plus size={18} aria-hidden="true" />
            )}
            {submitting ? 'Adding to queue…' : 'Add to vault'}
          </button>
        </div>
      </form>

      <p className="mt-3 text-xs text-paper-subtle">
        Supported by yt-dlp. Archive only media you own or are permitted to download.
      </p>
    </section>
  )
}
