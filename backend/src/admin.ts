import { timingSafeEqual } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from './config.js'
import { getAuthClient } from './auth.js'
import { ingestChromeCookies } from './cookies.js'

const inviteSchema = z.object({
  email: z.string().email(),
})

const chromeCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  hostOnly: z.boolean().optional(),
  session: z.boolean().optional(),
  expirationDate: z.number().optional(),
})

const cookieSyncSchema = z.object({
  // Raw chrome.cookies.getAll() array from the TubeVault Cookie Sync extension.
  cookies: z.array(chromeCookieSchema).min(1).max(1000),
})

/**
 * Constant-time comparison of the caller-supplied key against the configured
 * ADMIN_API_KEY. Rejects (fail closed) on any length mismatch or missing header
 * before doing the timing-safe compare.
 */
function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-admin-key') || ''
  const expected = config.adminApiKey

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

export const adminRouter = Router()

// Isolated from the public API surface — mounted separately in index.ts, never
// under /api/videos, so a mistake in requireAuth can't accidentally expose this.
adminRouter.post('/invite', requireAdminKey, async (req: Request, res: Response) => {
  try {
    const { email } = inviteSchema.parse(req.body)

    const { error } = await getAuthClient().auth.admin.inviteUserByEmail(email)
    if (error) {
      res.status(400).json({ error: error.message })
      return
    }

    // Don't echo back the Supabase response — it can carry user metadata/tokens.
    res.status(200).json({ invited: true })
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors })
      return
    }
    console.error('Invite failed:', err)
    res.status(500).json({ error: 'Failed to send invite' })
  }
})

// Cookie sync — accepts a chrome.cookies.getAll() export from the TubeVault Cookie
// Sync browser extension (see /extension) and merges it into the on-disk cookies.txt
// used by yt-dlp/Playwright, so authenticated sites (YouTube login, age-gated sessions)
// stay fresh without manually re-exporting via Cookie-Editor. Merge is keyed per
// (domain, name, path) so syncing one site never wipes cookies for another.
adminRouter.post('/cookies', requireAdminKey, async (req: Request, res: Response) => {
  try {
    const { cookies } = cookieSyncSchema.parse(req.body)

    const targetFile = config.ytDlpCookiesFile || config.playwrightCookiesFile
    if (!targetFile) {
      res.status(400).json({
        error: 'Set YTDLP_COOKIES_FILE (and/or PLAYWRIGHT_COOKIES_FILE) on the server before syncing cookies.',
      })
      return
    }

    const result = await ingestChromeCookies(targetFile, cookies)
    console.log(`[admin] cookie sync: merged ${result.added} cookie(s) into ${targetFile} (${result.total} total)`)
    res.status(200).json({ ok: true, ...result })
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.errors })
      return
    }
    console.error('Cookie sync failed:', err)
    res.status(500).json({ error: 'Failed to sync cookies' })
  }
})
