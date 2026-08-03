import { config } from './config.js'
import type { StorageBackend } from './types.js'

export interface StorageProvider {
  upload(key: string, filePath: string, contentType: string): Promise<void>
  delete(key: string): Promise<void>
  /**
   * Returns a URL the client can use to stream/download the object.
   * MUST be called fresh per authenticated request — implementations may return
   * a short-lived signed URL and callers must not cache or persist the result.
   */
  getStreamUrl(key: string): Promise<string>
}

// Supabase Storage provider
async function createSupabaseProvider(): Promise<StorageProvider> {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)

  const { data: bucket, error } = await supabase.storage.getBucket(config.supabaseBucket)
  if (error && error.message?.includes('not found')) {
    const { error: createError } = await supabase.storage.createBucket(config.supabaseBucket, {
      public: false,
    })
    if (createError) throw createError
  } else if (error) {
    throw error
  } else if (bucket?.public) {
    // Bucket pre-existed (e.g. deployed before this fix) as public. Flip it private.
    // Note: this stops NEW unsigned access immediately, but any public URL that was
    // already handed out/cached/crawled before the flip may keep working briefly at
    // any CDN/proxy edge caching layer in front of Supabase Storage until its cache
    // entry expires — flipping `public` is not a retroactive revoke of prior URLs.
    // Rotating storage keys (re-upload under new paths) is the only hard guarantee
    // for objects that were already exposed under a public URL.
    const { error: updateError } = await supabase.storage.updateBucket(config.supabaseBucket, {
      public: false,
    })
    if (updateError) throw updateError
    console.warn(
      `[storage] Supabase bucket "${config.supabaseBucket}" was public and has been switched to private. ` +
        `If any object keys in this bucket were previously shared/leaked as public URLs, rotate those objects.`
    )
  }

  return {
    async upload(key, filePath, contentType) {
      const fs = await import('node:fs')
      const file = fs.createReadStream(filePath)
      const { error: uploadError } = await supabase.storage
        .from(config.supabaseBucket)
        .upload(key, file, {
          contentType,
          upsert: true,
        })
      if (uploadError) throw uploadError
    },
    async delete(key) {
      const { error } = await supabase.storage.from(config.supabaseBucket).remove([key])
      if (error) throw error
    },
    async getStreamUrl(key) {
      const { data, error: signError } = await supabase.storage
        .from(config.supabaseBucket)
        .createSignedUrl(key, config.supabaseSignedUrlTtlSeconds)
      if (signError) throw signError
      return data.signedUrl
    },
  }
}

// Cloudflare R2 (S3-compatible) provider
async function createR2Provider(): Promise<StorageProvider> {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3')

  const client = new S3Client({
    endpoint: config.r2Endpoint,
    region: 'auto',
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  })

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.r2Bucket }))
  } catch (err: any) {
    throw new Error(`R2 bucket ${config.r2Bucket} is not accessible: ${err.message}`)
  }

  return {
    async upload(key, filePath, contentType) {
      const fs = await import('node:fs')
      const { createReadStream } = fs
      await client.send(
        new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: contentType,
        })
      )
    },
    async delete(key) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.r2Bucket,
          Key: key,
        })
      )
    },
    // R2 backend intentionally still returns a plain (unsigned) URL, matching how
    // R2 is normally fronted: either a public bucket dev URL or a custom CDN domain
    // via R2_PUBLIC_URL. That's a different threat model than the Supabase bucket
    // (this repo doesn't manage R2 bucket ACLs), so it's out of scope for this fix.
    // Wrapped in a resolved Promise only to satisfy the shared StorageProvider interface.
    async getStreamUrl(key) {
      if (config.r2PublicUrl) {
        return `${config.r2PublicUrl.replace(/\/$/, '')}/${key}`
      }
      return `${config.r2Endpoint.replace(/\/$/, '')}/${config.r2Bucket}/${key}`
    },
  }
}

export async function createStorageProvider(backend: StorageBackend): Promise<StorageProvider> {
  if (backend === 'r2') return createR2Provider()
  return createSupabaseProvider()
}
