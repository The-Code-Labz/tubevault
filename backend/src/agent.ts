import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from './config.js'
import { db } from './db.js'
import { queueDownload, getVideoForDownload, deleteVideo } from './downloader.js'
import { assertSafeDownloadUrl } from './url-safety.js'
import type { StorageBackend } from './types.js'

/**
 * Reserved synthetic owner for every download created through the Agent API.
 * db.listByUser/db.get ownership checks key on this string exactly like a real
 * Supabase user id, so agent-originated downloads are isolated both ways:
 * a human user never sees them in /api/videos, and the Agent API never sees
 * a human user's videos.
 */
export const AGENT_USER_ID = '__agent__'

/**
 * Constant-time comparison against AGENT_API_KEY, same pattern as admin.ts's
 * requireAdminKey. Deliberately a SEPARATE key from ADMIN_API_KEY — the admin
 * surface can invite users / sync cookies / force a yt-dlp update; the agent
 * surface should only ever be able to start/list/pull/delete its own downloads.
 */
function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-agent-key') || ''
  const expected = config.agentApiKey

  if (!expected || !provided) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  const match = providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)

  if (!match) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}

const downloadSchema = z.object({
  url: z.string().url(),
  // Omit to use the server default (STORAGE_BACKEND).
  backend: z.enum(['supabase', 'r2']).optional(),
})

export const agentRouter = Router()
agentRouter.use(requireAgentKey)

// Start a download. Same SSRF guard and storage-backend choice as the human
// /api/videos route, just keyed to AGENT_USER_ID instead of a Supabase session.
agentRouter.post('/downloads', async (req: Request, res: Response) => {
  try {
    const parsed = downloadSchema.parse(req.body)

    try {
      await assertSafeDownloadUrl(parsed.url)
    } catch (safetyErr: any) {
      res.status(400).json({ error: safetyErr.message })
      return
    }

    const backend = parsed.backend || config.storageBackend
    const video = await queueDownload(parsed.url, backend as StorageBackend, AGENT_USER_ID)
    res.status(202).json(video)
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors })
      return
    }
    res.status(500).json({ error: err.message })
  }
})

agentRouter.get('/downloads', async (_req: Request, res: Response) => {
  try {
    const videos = await db.listByUser(AGENT_USER_ID)
    res.json(videos)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentRouter.get('/downloads/:id', async (req: Request, res: Response) => {
  try {
    const video = await db.get(req.params.id)
    if (!video || video.userId !== AGENT_USER_ID) {
      res.status(404).json({ error: 'Download not found' })
      return
    }
    res.json(video)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Streams the finished file back as bytes (Content-Disposition: attachment) so an
// agent can pull it directly without ever touching the underlying storage
// credentials. Same proxy-through-server approach as /api/videos/:id/download —
// R2's URL has no signed download-disposition support, so this is the only way
// that works uniformly across both backends.
agentRouter.get('/downloads/:id/file', async (req: Request, res: Response) => {
  try {
    const info = await getVideoForDownload(req.params.id, AGENT_USER_ID)
    if (!info) {
      res.status(404).json({ error: 'Video not ready or not found' })
      return
    }

    const upstream = await fetch(info.streamUrl)
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `Failed to fetch video from storage: ${upstream.status}` })
      return
    }

    res.setHeader('Content-Type', info.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${info.filename}"`)
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) res.setHeader('Content-Length', contentLength)

    Readable.fromWeb(upstream.body as any).pipe(res)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentRouter.delete('/downloads/:id', async (req: Request, res: Response) => {
  try {
    const video = await db.get(req.params.id)
    if (!video || video.userId !== AGENT_USER_ID) {
      res.status(404).json({ error: 'Download not found' })
      return
    }
    await deleteVideo(req.params.id, AGENT_USER_ID)
    res.status(204).send()
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
