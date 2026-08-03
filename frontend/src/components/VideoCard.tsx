import { Download, HardDrive, Trash2 } from 'lucide-react'
import type { Video } from '../types.ts'

interface VideoCardProps {
  video: Video
  onDelete: (id: string) => void
  onPlay: (video: Video) => void
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

function statusColor(status: Video['status']): string {
  switch (status) {
    case 'complete':
      return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
    case 'downloading':
    case 'uploading':
    case 'processing':
      return 'bg-amber-500/20 text-amber-400 border-amber-500/30'
    case 'failed':
      return 'bg-red-500/20 text-red-400 border-red-500/30'
    default:
      return 'bg-zinc-700 text-zinc-400 border-zinc-600'
  }
}

export function VideoCard({ video, onDelete, onPlay }: VideoCardProps) {
  const isDone = video.status === 'complete'
  const isActive = ['queued', 'downloading', 'processing', 'uploading'].includes(video.status)

  return (
    <div className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 transition hover:border-zinc-700">
      <div className="aspect-video bg-zinc-950 relative">
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title || 'Video thumbnail'}
            className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-600">
            <HardDrive size={40} />
          </div>
        )}
        {isDone && (
          <button
            onClick={() => onPlay(video)}
            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100"
          >
            <div className="rounded-full bg-white/90 p-3 text-zinc-950">
              <Download size={24} className="rotate-180" />
            </div>
          </button>
        )}
        <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-0.5 text-xs font-medium text-white">
          {formatDuration(video.duration)}
        </div>
      </div>

      <div className="p-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 font-medium text-zinc-100" title={video.title || video.url}>
            {video.title || 'Untitled video'}
          </h3>
          <button
            onClick={() => onDelete(video.id)}
            className="rounded p-1 text-zinc-500 transition hover:bg-red-500/20 hover:text-red-400"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusColor(video.status)}`}>
            {video.status}
          </span>
          {video.fileSize ? (
            <span className="text-xs text-zinc-500">{formatBytes(video.fileSize)}</span>
          ) : null}
        </div>

        {isActive ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${video.progress}%` }}
            />
          </div>
        ) : video.error ? (
          <p className="text-xs text-red-400">{video.error}</p>
        ) : null}
      </div>
    </div>
  )
}
