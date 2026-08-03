import { config } from './config.js'
import type { StorageBackend } from './types.js'

export interface StorageProvider {
  upload(key: string, filePath: string, contentType: string): Promise<void>
  delete(key: string): Promise<void>
  getPublicUrl(key: string): string
}

// Supabase Storage provider
async function createSupabaseProvider(): Promise<StorageProvider> {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey)

  const { data: bucket, error } = await supabase.storage.getBucket(config.supabaseBucket)
  if (error && error.message?.includes('not found')) {
    const { error: createError } = await supabase.storage.createBucket(config.supabaseBucket, {
      public: true,
    })
    if (createError) throw createError
  } else if (error) {
    throw error
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
    getPublicUrl(key) {
      const { data } = supabase.storage.from(config.supabaseBucket).getPublicUrl(key)
      return data.publicUrl
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
    getPublicUrl(key) {
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
