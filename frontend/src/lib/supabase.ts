import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

// Fetches Supabase project config from the backend at RUNTIME (GET /api/config,
// same-origin, proxied to the API in dev via vite.config.ts) instead of baking
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY into the bundle at build time. This
// means the Docker image never needs rebuilding to change/rotate the Supabase
// project — just edit SUPABASE_URL / SUPABASE_ANON_KEY in .env and restart.
export async function initSupabase(): Promise<void> {
  let url: string | undefined
  let anonKey: string | undefined

  try {
    const res = await fetch('/api/config')
    if (res.ok) {
      const cfg = await res.json()
      url = cfg.supabaseUrl || undefined
      anonKey = cfg.supabaseAnonKey || undefined
    }
  } catch {
    // network error — fall through to the warning below
  }

  if (!url || !anonKey) {
    console.error(
      'Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_ANON_KEY in the backend .env ' +
        '(served to the frontend at runtime via /api/config) — sign-in will not work without them.'
    )
  }

  client = createClient(url || '', anonKey || '')
}

export function getSupabase(): SupabaseClient {
  if (!client) throw new Error('Supabase client not initialized — call initSupabase() before use')
  return client
}
