export type VideoStatus =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'complete'
  | 'failed'

export type StorageBackend = 'supabase' | 'r2'

export interface Video {
  id: string
  userId: string
  url: string
  title: string | null
  thumbnailUrl: string | null
  duration: number | null
  storageBackend: StorageBackend
  storageKey: string | null
  status: VideoStatus
  progress: number
  error: string | null
  fileSize: number | null
  createdAt: string
  updatedAt: string
}

export interface QueueJob {
  id: string
  url: string
  storageBackend: StorageBackend
  addedAt: string
}
