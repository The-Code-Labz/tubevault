import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { DownloadRequest } from '../types.ts'

interface DownloadFormProps {
  onSubmit: (req: DownloadRequest) => Promise<void>
  disabled?: boolean
}

export function DownloadForm({ onSubmit, disabled }: DownloadFormProps) {
  const [url, setUrl] = useState('')
  const [backend, setBackend] = useState<'supabase' | 'r2'>('supabase')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || disabled) return
    await onSubmit({ url: url.trim(), backend })
    setUrl('')
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="mb-4">
        <label htmlFor="url" className="mb-2 block text-sm font-medium text-zinc-300">
          Video URL
        </label>
        <input
          id="url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          required
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3 text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-400">Storage:</span>
          <select
            value={backend}
            onChange={(e) => setBackend(e.target.value as 'supabase' | 'r2')}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          >
            <option value="supabase">Supabase Storage</option>
            <option value="r2">Cloudflare R2</option>
          </select>
        </div>
      </div>

      <button
        type="submit"
        disabled={disabled || !url.trim()}
        className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {disabled ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
        {disabled ? 'Starting download...' : 'Download video'}
      </button>
    </form>
  )
}
