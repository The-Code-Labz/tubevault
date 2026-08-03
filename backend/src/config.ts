import 'dotenv/config'

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

  // Supabase Storage
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  supabaseBucket: process.env.SUPABASE_BUCKET || 'videos',

  // Cloudflare R2 (S3-compatible)
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  r2Bucket: process.env.R2_BUCKET || 'videos',
  r2PublicUrl: process.env.R2_PUBLIC_URL || '',

  // yt-dlp / download settings
  downloadDir: process.env.DOWNLOAD_DIR || '/tmp/tubevault-downloads',
  maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2', 10),
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || `${5 * 1024 * 1024 * 1024}`, 10),
}

export function validateConfig() {
  if (config.storageBackend === 'supabase') {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new Error('STORAGE_BACKEND=supabase requires SUPABASE_URL and SUPABASE_SERVICE_KEY')
    }
  }
  if (config.storageBackend === 'r2') {
    if (!config.r2Endpoint || !config.r2AccessKeyId || !config.r2SecretAccessKey) {
      throw new Error('STORAGE_BACKEND=r2 requires R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY')
    }
  }
}
