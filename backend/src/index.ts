import express from 'express'
import cors from 'cors'
import { config, validateConfig } from './config.js'
import { db } from './db.js'
import {
  queueDownload,
  deleteVideo,
  getVideoPublicUrl,
  cancelDownload,
  getYtDlpVersion,
  updateYtDlp,
  shutdownActiveJobs,
} from './downloader.js'
import { z } from 'zod'
import { requireAuth, type AuthedRequest } from './auth.js'
import { assertSafeDownloadUrl } from './url-safety.js'
import type { StorageBackend } from './types.js'

const app = express()

// Same-origin only by default. Set ALLOWED_ORIGIN (comma-separated) when the
// frontend is served from a different origin than this API.
app.use(cors(config.allowedOrigins.length ? { origin: config.allowedOrigins } : { origin: false }))
app.use(express.json({ limit: '100kb' }))

const downloadSchema = z.object({
  url: z.string().url(),
  backend: z.enum(['supabase', 'r2']).optional(),
})

app.get('/api/health', async (_req, res) => {
  try {
    const ytDlp = await getYtDlpVersion()
    res.json({
      status: 'ok',
      storageBackend: config.storageBackend,
      ytDlp,
      timestamp: new Date().toISOString(),
    })
  } catch (err: any) {
    res.status(503).json({
      status: 'error',
      storageBackend: config.storageBackend,
      error: err.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Public runtime config for the frontend — read live from process.env, so the
// Supabase project can be reconfigured by editing .env + restarting the container,
// no rebuild required. Only ever exposes the anon (public) key, never the service key.
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
  })
})

// Every /api/videos* route requires a valid Supabase session.
app.use('/api/videos', requireAuth)

app.get('/api/videos', async (req: AuthedRequest, res) => {
  try {
    const videos = await db.listByUser(req.userId!)
    res.json(videos)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/videos', async (req: AuthedRequest, res) => {
  try {
    const parsed = downloadSchema.parse(req.body)

    try {
      await assertSafeDownloadUrl(parsed.url)
    } catch (safetyErr: any) {
      res.status(400).json({ error: safetyErr.message })
      return
    }

    const backend = parsed.backend || config.storageBackend
    const video = await queueDownload(parsed.url, backend as StorageBackend, req.userId!)
    res.status(202).json(video)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors })
      return
    }
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/videos/:id', async (req: AuthedRequest, res) => {
  try {
    const video = await db.get(req.params.id)
    if (!video || video.userId !== req.userId) {
      res.status(404).json({ error: 'Video not found' })
      return
    }
    res.json(video)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/videos/:id/stream', async (req: AuthedRequest, res) => {
  try {
    const url = await getVideoPublicUrl(req.params.id, req.userId!)
    if (!url) {
      res.status(404).json({ error: 'Video not ready or not found' })
      return
    }
    res.json({ url })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/videos/:id', async (req: AuthedRequest, res) => {
  try {
    const deleted = await deleteVideo(req.params.id, req.userId!)
    if (!deleted) {
      res.status(404).json({ error: 'Video not found' })
      return
    }
    res.status(204).send()
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/videos/:id/cancel', async (req: AuthedRequest, res) => {
  try {
    const cancelled = await cancelDownload(req.params.id, req.userId!)
    if (!cancelled) {
      res.status(404).json({ error: 'No active download found' })
      return
    }
    res.json({ cancelled: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Serve built frontend in production
app.use(express.static('public'))
app.get('*', (_req, res) => {
  res.sendFile('index.html', { root: 'public' })
})

async function main() {
  validateConfig()

  try {
    const updateResult = await updateYtDlp()
    console.log(`yt-dlp: ${updateResult}`)
  } catch (err: any) {
    console.warn(`yt-dlp update check failed: ${err.message}`)
  }

  const server = app.listen(config.port, () => {
    console.log(`TubeVault API running on http://localhost:${config.port}`)
    console.log(`Storage backend: ${config.storageBackend}`)
  })

  let shuttingDown = false
  function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Received ${signal}, shutting down gracefully...`)
    shutdownActiveJobs()
    server.close(() => process.exit(0))
    // Force-exit if something keeps the event loop alive.
    setTimeout(() => process.exit(1), 10000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
