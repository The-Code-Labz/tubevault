import type { NextFunction, Request, Response } from 'express'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from './config.js'

export interface AuthedRequest extends Request {
  userId?: string
}

let authClient: SupabaseClient | null = null

/** Shared Supabase client using the service-role key (server-side only). */
export function getAuthClient(): SupabaseClient {
  if (!authClient) {
    authClient = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return authClient
}

/**
 * Verifies the Supabase-issued JWT sent in the Authorization header and
 * attaches the authenticated user's id to the request. Rejects with 401
 * on any missing/invalid/expired token.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization') || ''
  const [scheme, token] = header.split(' ')

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' })
    return
  }

  try {
    const { data, error } = await getAuthClient().auth.getUser(token)
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired session' })
      return
    }
    req.userId = data.user.id
    next()
  } catch (err) {
    console.error('Auth verification failed:', err)
    res.status(401).json({ error: 'Failed to verify session' })
  }
}
