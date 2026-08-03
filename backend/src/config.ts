import 'dotenv/config'

function parseCustomArgs(value: string | undefined): string[] {
  if (!value) return []
  // Support comma-separated or space-separated args. No quote-awareness — a value
  // needing an embedded space (e.g. `--add-header "X: y"`) will be split incorrectly.
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

export const config = {
  port: parseInt(process.env.PORT || '4050', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Storage selection: 'supabase' | 'r2'
  storageBackend: (process.env.STORAGE_BACKEND || 'supabase') as 'supabase' | 'r2',

  // Supabase (used for both auth verification and, optionally, storage)
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  supabaseBucket: process.env.SUPABASE_BUCKET || 'videos',
  // TTL (seconds) for signed Storage URLs handed to clients via /api/videos/:id/stream.
  // Short-lived on purpose: the URL grants unauthenticated bearer access to the object
  // for as long as it's valid, so we mint a fresh one per authenticated request rather
  // than caching/storing it. Default 1 hour is enough to stream/download a video.
  supabaseSignedUrlTtlSeconds: Math.max(60, parseInt(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || '3600', 10)),
  // Public anon key — safe to expose to the browser. Served to the frontend at
  // RUNTIME via GET /api/config (see index.ts) instead of being baked into the
  // Vite bundle at build time, so it can just be set in .env like everything else.
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',

  // Cloudflare R2 (S3-compatible)
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  r2Bucket: process.env.R2_BUCKET || 'videos',
  r2PublicUrl: process.env.R2_PUBLIC_URL || '',

  // CORS: comma-separated list of allowed origins. Empty = same-origin only (no CORS headers sent).
  allowedOrigins: (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // yt-dlp / download settings
  downloadDir: process.env.DOWNLOAD_DIR || '/tmp/tubevault-downloads',
  maxConcurrentDownloads: Math.max(1, parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2', 10)),
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || `${5 * 1024 * 1024 * 1024}`, 10),

  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ytDlpAutoUpdate: process.env.YTDLP_AUTO_UPDATE !== 'false',
  ytDlpFormat: process.env.YTDLP_FORMAT || '',
  ytDlpUserAgent: process.env.YTDLP_USER_AGENT || '',
  ytDlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
  ytDlpCookiesFile: process.env.YTDLP_COOKIES_FILE || '',
  ytDlpReferer: process.env.YTDLP_REFERER || '',
  ytDlpCustomArgs: parseCustomArgs(process.env.YTDLP_CUSTOM_ARGS),
}

export function validateConfig() {
  // Supabase is now mandatory: it backs authentication regardless of storage backend.
  requireEnv('SUPABASE_URL')
  requireEnv('SUPABASE_SERVICE_KEY')
  requireEnv('SUPABASE_ANON_KEY')

  if (config.storageBackend === 'r2') {
    if (!config.r2Endpoint || !config.r2AccessKeyId || !config.r2SecretAccessKey) {
      throw new Error('STORAGE_BACKEND=r2 requires R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY')
    }
  }
}
