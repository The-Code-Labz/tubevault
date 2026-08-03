import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/api.ts'
import type { Video } from '../types.ts'

interface VideoPlayerProps {
  video: Video
  onClose: () => void
}

export function VideoPlayer({ video, onClose }: VideoPlayerProps) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .getStreamUrl(video.id)
      .then((res) => setStreamUrl(res.url))
      .catch((err) => setError(err.message))
  }, [video.id])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-zinc-800 p-2 text-zinc-200 hover:bg-zinc-700"
      >
        <X size={24} />
      </button>

      <div className="w-full max-w-5xl">
        {error ? (
          <div className="flex aspect-video items-center justify-center rounded-xl bg-zinc-900 text-red-400">
            {error}
          </div>
        ) : streamUrl ? (
          <video
            src={streamUrl}
            controls
            autoPlay
            className="max-h-[80vh] w-full rounded-xl bg-black"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-xl bg-zinc-900 text-zinc-500">
            Loading stream...
          </div>
        )}
        <h2 className="mt-4 text-lg font-medium text-white">{video.title || 'Untitled'}</h2>
      </div>
    </div>
  )
}
