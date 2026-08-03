import { supabase } from './supabase.ts'
import type { DownloadRequest, Video } from '../types.ts'

const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
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
}
