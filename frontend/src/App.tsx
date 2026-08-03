import { useEffect, useState } from 'react'
import { Film, LogOut, Trash2 } from 'lucide-react'
import { api } from './lib/api.ts'
import { DownloadForm } from './components/DownloadForm.tsx'
import { VideoCard } from './components/VideoCard.tsx'
import { VideoPlayer } from './components/VideoPlayer.tsx'
import { AuthForm } from './components/AuthForm.tsx'
import { useAuth } from './lib/auth-context.tsx'
import type { DownloadRequest, Video } from './types.ts'

export default function App() {
  const { session, loading: authLoading, signOut } = useAuth()
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [playing, setPlaying] = useState<Video | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'complete' | 'active' | 'failed'>('all')

  async function loadVideos() {
    try {
      const data = await api.listVideos()
      setVideos(data)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!session) return
    loadVideos()
    const interval = setInterval(loadVideos, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  async function handleDownload(req: DownloadRequest) {
    setSubmitting(true)
    try {
      await api.createVideo(req)
      await loadVideos()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this video and its stored file?')) return
    try {
      await api.deleteVideo(id)
      await loadVideos()
    } catch (err: any) {
      setError(err.message)
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-500">
        Loading...
      </div>
    )
  }

  if (!session) {
    return <AuthForm />
  }

  const filtered = videos.filter((v) => {
    if (filter === 'complete') return v.status === 'complete'
    if (filter === 'active') return ['queued', 'downloading', 'processing', 'uploading'].includes(v.status)
    if (filter === 'failed') return v.status === 'failed'
    return true
  })

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-4">
          <div className="rounded-lg bg-indigo-600 p-2">
            <Film size={20} className="text-white" />
          </div>
          <h1 className="text-xl font-bold">TubeVault</h1>
          <span className="ml-4 text-sm text-zinc-500">{session.user.email}</span>
          <button
            onClick={() => signOut()}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {error ? (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <DownloadForm onSubmit={handleDownload} disabled={submitting} />

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Library</h2>
          <div className="flex gap-2">
            {(['all', 'active', 'complete', 'failed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-sm capitalize transition ${
                  filter === f
                    ? 'bg-indigo-600 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="py-12 text-center text-zinc-500">Loading videos...</p>
        ) : filtered.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 py-16 text-center">
            <Trash2 size={40} className="mx-auto mb-3 text-zinc-600" />
            <p className="text-zinc-400">No videos yet. Paste a URL above to start downloading.</p>
          </div>
        ) : (
          <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                onDelete={handleDelete}
                onPlay={setPlaying}
              />
            ))}
          </div>
        )}
      </main>

      {playing ? <VideoPlayer video={playing} onClose={() => setPlaying(null)} /> : null}
    </div>
  )
}
