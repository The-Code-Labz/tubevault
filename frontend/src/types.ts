export type VideoStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'complete'
  | 'failed'

export interface Video {
  id: string
  userId: string
  url: string
  title: string | null
  thumbnailUrl: string | null
  duration: number | null
  storageBackend: 'supabase' | 'r2'
  storageKey: string | null
  status: VideoStatus
  progress: number
  error: string | null
  fileSize: number | null
  createdAt: string
  updatedAt: string
}

export interface DownloadRequest {
  url: string
  backend?: 'supabase' | 'r2'
}
