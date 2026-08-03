import type { DownloadRequest, Video } from '../types.ts'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${input}`, init)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export const api = {
  health() {
    return fetchJson<{ status: string; storageBackend: string; timestamp: string }>('/api/health')
  },
  listVideos() {
    return fetchJson<Video[]>('/api/videos')
  },
  createVideo(req: DownloadRequest) {
    return fetchJson<Video>('/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },
  deleteVideo(id: string) {
    return fetch(`${API_BASE}/api/videos/${id}`, { method: 'DELETE' })
  },
  getStreamUrl(id: string) {
    return fetchJson<{ url: string }>(`/api/videos/${id}/stream`)
  },
}
