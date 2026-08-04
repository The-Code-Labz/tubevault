import { timingSafeEqual } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from './config.js'
import { getAuthClient } from './auth.js'

const inviteSchema = z.object({
  email: z.string().email(),
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
