import express from 'express'
import cors from 'cors'
import { config, validateConfig } from './config.js'
import { db } from './db.js'
import { queueDownload, deleteVideo, getVideoPublicUrl, cancelDownload, getYtDlpVersion, updateYtDlp } from './downloader.js'
import { z } from 'zod'
import type { StorageBackend } from './types.js'

const app = express()
app.use(cors())
app.use(express.json())

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

app.get('/api/videos', async (_req, res) => {
  try {
    const videos = await db.list()
    res.json(videos)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/videos', async (req, res) => {
  try {
    const parsed = downloadSchema.parse(req.body)
    const backend = parsed.backend || config.storageBackend
    const video = await queueDownload(parsed.url, backend as StorageBackend)
    res.status(202).json(video)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors })
      return
    }
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/videos/:id', async (req, res) => {
  try {
    const video = await db.get(req.params.id)
    if (!video) {
      res.status(404).json({ error: 'Video not found' })
      return
    }
    res.json(video)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/videos/:id/stream', async (req, res) => {
  try {
    const url = await getVideoPublicUrl(req.params.id)
    if (!url) {
      res.status(404).json({ error: 'Video not ready or not found' })
      return
    }
    res.json({ url })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/videos/:id', async (req, res) => {
  try {
    const deleted = await deleteVideo(req.params.id)
    if (!deleted) {
      res.status(404).json({ error: 'Video not found' })
      return
    }
    res.status(204).send()
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/videos/:id/cancel', async (req, res) => {
  try {
    const cancelled = await cancelDownload(req.params.id)
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

  app.listen(config.port, () => {
    console.log(`TubeVault API running on http://localhost:${config.port}`)
    console.log(`Storage backend: ${config.storageBackend}`)
  })
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
