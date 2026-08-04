import { getSupabase } from './supabase.ts'
import type { DownloadRequest, Video } from '../types.ts'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await getSupabase().auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const headers = { ...(await authHeaders()), ...(init.headers as Record<string, string> | undefined) }
  const res = await fetch(`${API_BASE}${input}`, { ...init, headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  if (res.status === 204) return undefined as T
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
    return fetchJson<void>(`/api/videos/${id}`, { method: 'DELETE' })
  },
  getStreamUrl(id: string) {
    return fetchJson<{ url: string }>(`/api/videos/${id}/stream`)
  },
  retryVideo(id: string) {
    return fetchJson<Video>(`/api/videos/${id}/retry`, { method: 'POST' })
  },
  async downloadVideo(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/api/videos/${id}/download`, { headers: await authHeaders() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Download failed' }))
      throw new Error(err.error || `Download failed: ${res.status}`)
    }
    const disposition = res.headers.get('content-disposition') || ''
    const match = disposition.match(/filename="([^"]+)"/)
    const filename = match?.[1] || `video-${id}.mp4`

    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  },
}
