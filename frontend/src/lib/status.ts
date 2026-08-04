import type { VideoStatus } from '../types.ts'

export interface StatusMeta {
  label: string
  tone: 'neutral' | 'active' | 'success' | 'danger'
}

export const STATUS_META: Record<VideoStatus, StatusMeta> = {
  queued: { label: 'In queue', tone: 'neutral' },
  downloading: { label: 'Downloading', tone: 'active' },
  processing: { label: 'Processing', tone: 'active' },
  uploading: { label: 'Securing file', tone: 'active' },
  complete: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
}

export const PROGRESS_STATUSES: VideoStatus[] = ['downloading', 'processing', 'uploading']

export const ACTIVE_STATUSES: VideoStatus[] = ['queued', 'downloading', 'processing', 'uploading']

export function isActiveStatus(status: VideoStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export function hasProgress(status: VideoStatus): boolean {
  return PROGRESS_STATUSES.includes(status)
}
