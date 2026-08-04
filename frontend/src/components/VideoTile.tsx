import { AlertTriangle, CheckCircle2, Clock, Download, Play, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import { MediaPlaceholder } from './MediaPlaceholder.tsx'
import { ProgressRail } from './ProgressRail.tsx'
import { STATUS_META, hasProgress } from '../lib/status.ts'
import { formatBackendLabel, formatBytes, formatDuration, hostnameOf } from '../lib/format.ts'
import type { Video, VideoStatus } from '../types.ts'

const STATUS_ICON: Record<VideoStatus, typeof Clock> = {
  queued: Clock,
  downloading: Download,
  processing: Settings2,
  uploading: ShieldCheck,
  complete: CheckCircle2,
  failed: AlertTriangle,
}

const STATUS_TONE_CLASS: Record<string, string> = {
  neutral: 'border-border-strong bg-canvas/80 text-paper-muted',
  active: 'border-gold/40 bg-gold/15 text-gold',
  success: 'border-success/40 bg-success/15 text-success',
  danger: 'border-danger/40 bg-danger/15 text-danger',
}

function StatusBadge({ status, className = '' }: { status: VideoStatus; className?: string }) {
  const meta = STATUS_META[status]
  const Icon = STATUS_ICON[status]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] ${STATUS_TONE_CLASS[meta.tone]} ${className}`}
    >
      <Icon size={11} aria-hidden="true" />
      {meta.label}
    </span>
  )
}

interface VideoTileProps {
  video: Video
  onPlay: (video: Video) => void
  onRequestDelete: (video: Video) => void
}

export function VideoTile({ video, onPlay, onRequestDelete }: VideoTileProps) {
  const meta = STATUS_META[video.status]
  const isReady = video.status === 'complete'
  const isFailed = video.status === 'failed'
  const isQueued = video.status === 'queued'
  const showProgress = hasProgress(video.status)
  const title = video.title || 'Untitled video'

  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition hover:border-border-strong">
      <div className="relative aspect-video w-full overflow-hidden bg-well">
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title ? `Thumbnail for ${video.title}` : ''}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <MediaPlaceholder />
        )}

        {isReady ? (
          <button
            type="button"
            onClick={() => onPlay(video)}
            aria-label={`Play ${title}`}
            className="absolute inset-0 flex items-center justify-center bg-canvas/25 transition hover:bg-canvas/45 focus-visible:bg-canvas/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-paper/50 bg-canvas/80 text-paper">
              <Play size={20} fill="currentColor" aria-hidden="true" />
            </span>
          </button>
        ) : null}

        {video.duration ? (
          <span className="absolute bottom-2 right-2 rounded bg-canvas/85 px-1.5 py-0.5 font-mono text-[11px] text-paper">
            {formatDuration(video.duration)}
          </span>
        ) : null}

        <StatusBadge status={video.status} className="absolute left-2 top-2" />
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <h3 className="line-clamp-2 text-[15px] font-semibold leading-[21px] text-paper" title={title}>
          {title}
        </h3>

        {showProgress ? (
          <ProgressRail label={meta.label} value={video.progress} />
        ) : isQueued ? (
          <p className="font-mono text-xs text-paper-muted">{meta.label}</p>
        ) : isFailed ? (
          <p role="status" className="text-xs text-danger">
            {video.error || 'Ingest failed for an unknown reason.'}
          </p>
        ) : (
          <p className="truncate font-mono text-xs text-paper-muted">
            {formatBackendLabel(video.storageBackend)}
            {video.fileSize ? ` · ${formatBytes(video.fileSize)}` : ''}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-1.5">
          <span className="min-w-0 truncate font-mono text-[11px] text-paper-subtle" title={video.url}>
            {hostnameOf(video.url)}
          </span>
          <button
            type="button"
            onClick={() => onRequestDelete(video)}
            aria-label={`Delete ${title}`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-paper-subtle transition hover:bg-danger/15 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  )
}
