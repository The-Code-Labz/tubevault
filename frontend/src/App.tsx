import { useEffect, useState } from 'react'
import { api } from './lib/api.ts'
import { useAuth } from './lib/auth-context.tsx'
import { isActiveStatus } from './lib/status.ts'
import { AppHeader } from './components/AppHeader.tsx'
import { AuthGate } from './components/AuthGate.tsx'
import { LibrarySummary } from './components/LibrarySummary.tsx'
import { IngestRail } from './components/IngestRail.tsx'
import { LibraryFilters, FILTER_LABELS, type FilterKey } from './components/LibraryFilters.tsx'
import { VideoTile } from './components/VideoTile.tsx'
import { EmptyLibrary } from './components/EmptyLibrary.tsx'
import { LibrarySkeleton } from './components/LibrarySkeleton.tsx'
import { InlineAlert } from './components/InlineAlert.tsx'
import { ConfirmDeleteDialog } from './components/ConfirmDeleteDialog.tsx'
import { PlayerDialog } from './components/PlayerDialog.tsx'
import type { DownloadRequest, Video } from './types.ts'

export default function App() {
  const { session, loading: authLoading, signOut } = useAuth()
  const [videos, setVideos] = useState<Video[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<Video | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<Video | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set())
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})

  async function loadVideos() {
    try {
      const data = await api.listVideos()
      setVideos(data)
      setLoadError(null)
    } catch (err: any) {
      setLoadError(err.message)
    } finally {
      setInitialLoading(false)
    }
  }

  const userId = session?.user?.id ?? null

  // Clear all account-scoped UI state the moment the signed-in user changes
  // (sign-out/sign-in as a different account) so the previous account's
  // videos, filter, open player, or pending delete can never flash while the
  // next account's data is still loading. Effects run in declaration order
  // within a commit, so this always clears before the fetch effect below runs.
  useEffect(() => {
    setVideos([])
    setInitialLoading(true)
    setLoadError(null)
    setSubmitError(null)
    setFilter('all')
    setPlaying(null)
    setConfirmTarget(null)
    setDeleteBusy(false)
    setRetryingIds(new Set())
    setDownloadingIds(new Set())
    setActionErrors({})
  }, [userId])

  useEffect(() => {
    if (!session) return
    loadVideos()
    const interval = setInterval(loadVideos, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  async function handleSubmit(req: DownloadRequest): Promise<boolean> {
    setSubmitting(true)
    setSubmitError(null)
    try {
      await api.createVideo(req)
      await loadVideos()
      return true
    } catch (err: any) {
      setSubmitError(err.message)
      return false
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRetry(video: Video) {
    setRetryingIds((prev) => new Set(prev).add(video.id))
    setActionErrors((prev) => {
      const { [video.id]: _omit, ...rest } = prev
      return rest
    })
    try {
      await api.retryVideo(video.id)
      await loadVideos()
    } catch (err: any) {
      setActionErrors((prev) => ({ ...prev, [video.id]: err.message }))
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev)
        next.delete(video.id)
        return next
      })
    }
  }

  async function handleDownload(video: Video) {
    setDownloadingIds((prev) => new Set(prev).add(video.id))
    setActionErrors((prev) => {
      const { [video.id]: _omit, ...rest } = prev
      return rest
    })
    try {
      await api.downloadVideo(video.id)
    } catch (err: any) {
      setActionErrors((prev) => ({ ...prev, [video.id]: err.message }))
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev)
        next.delete(video.id)
        return next
      })
    }
  }

  async function handleConfirmDelete() {
    if (!confirmTarget) return
    setDeleteBusy(true)
    try {
      await api.deleteVideo(confirmTarget.id)
      setConfirmTarget(null)
      await loadVideos()
    } catch (err: any) {
      setLoadError(err.message)
      setConfirmTarget(null)
    } finally {
      setDeleteBusy(false)
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-canvas font-mono text-sm text-paper-muted">
        Loading…
      </div>
    )
  }

  if (!session) {
    return <AuthGate />
  }

  const counts: Record<FilterKey, number> = {
    all: videos.length,
    active: videos.filter((v) => isActiveStatus(v.status)).length,
    complete: videos.filter((v) => v.status === 'complete').length,
    failed: videos.filter((v) => v.status === 'failed').length,
  }

  const filtered = videos.filter((v) => {
    if (filter === 'complete') return v.status === 'complete'
    if (filter === 'active') return isActiveStatus(v.status)
    if (filter === 'failed') return v.status === 'failed'
    return true
  })

  return (
    <div className="min-h-[100dvh] bg-canvas text-paper">
      <AppHeader email={session.user.email ?? ''} onSignOut={() => signOut()} />

      <main className="mx-auto max-w-[1440px] px-5 py-8 sm:px-7 sm:py-10 lg:px-10">
        <section className="mb-8 flex flex-col gap-3 sm:mb-10">
          <h1 className="text-2xl font-semibold leading-[30px] text-paper sm:text-[28px] sm:leading-[34px]">
            Private library.
          </h1>
          <p className="max-w-2xl text-[15px] leading-[23px] text-paper-muted">
            Add a supported source, follow its ingest state, then play it from private storage.
          </p>
          <LibrarySummary total={counts.all} active={counts.active} ready={counts.complete} failed={counts.failed} />
        </section>

        <section className="mb-8 sm:mb-10">
          <IngestRail onSubmit={handleSubmit} submitting={submitting} submitError={submitError} />
        </section>

        {loadError ? (
          <div className="mb-6">
            <InlineAlert tone="danger" message={loadError} onRetry={loadVideos} />
          </div>
        ) : null}

        <section aria-labelledby="library-heading">
          <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <h2 id="library-heading" className="text-xl font-semibold leading-[26px] text-paper">
                Library
              </h2>
              <span className="font-mono text-xs text-paper-subtle">{filtered.length} shown</span>
            </div>
            <LibraryFilters filter={filter} onChange={setFilter} counts={counts} />
          </div>

          {initialLoading ? (
            <LibrarySkeleton />
          ) : filtered.length === 0 ? (
            videos.length === 0 ? (
              <EmptyLibrary variant="first-use" />
            ) : (
              <EmptyLibrary variant="filtered" filterLabel={FILTER_LABELS[filter]} onShowAll={() => setFilter('all')} />
            )
          ) : (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
              {filtered.map((video) => (
                <VideoTile
                  key={video.id}
                  video={video}
                  onPlay={setPlaying}
                  onRequestDelete={setConfirmTarget}
                  onRetry={handleRetry}
                  onDownload={handleDownload}
                  retrying={retryingIds.has(video.id)}
                  downloading={downloadingIds.has(video.id)}
                  actionError={actionErrors[video.id] ?? null}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      <PlayerDialog video={playing} onClose={() => setPlaying(null)} />
      <ConfirmDeleteDialog
        video={confirmTarget}
        busy={deleteBusy}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  )
}
