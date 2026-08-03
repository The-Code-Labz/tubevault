import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from './config.js'
import { db } from './db.js'
import { createStorageProvider } from './storage.js'
import type { StorageBackend, Video } from './types.js'

const activeJobs = new Map<string, { controller: AbortController; child?: ReturnType<typeof spawn> }>()

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9\-_\.]/gi, '_').replace(/_+/g, '_').slice(0, 80)
}

async function runYtDlp(
  args: string[],
  options: { signal?: AbortSignal; onProgress?: (line: string) => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ytDlpPath = process.env.YTDLP_PATH || 'yt-dlp'
    const child = spawn(ytDlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stdout.on('data', (data) => {
      const line = data.toString()
      if (options.onProgress) options.onProgress(line)
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
      if (options.onProgress) options.onProgress(data.toString())
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr || 'unknown error'}`))
    })

    options.signal?.addEventListener('abort', () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    })
  })
}

async function fetchMetadata(url: string, signal?: AbortSignal): Promise<{
  title: string
  duration?: number
  thumbnail?: string
  ext?: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', ['--dump-single-json', '--no-playlist', '--no-warnings', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    signal?.addEventListener('abort', () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp metadata failed with code ${code}: ${stderr || 'unknown error'}`))
      }
      try {
        const data = JSON.parse(stdout)
        resolve({
          title: data.title || 'untitled',
          duration: data.duration ? Math.round(data.duration) : undefined,
          thumbnail: data.thumbnail,
          ext: data.ext,
        })
      } catch (err) {
        reject(new Error(`Failed to parse yt-dlp metadata: ${err instanceof Error ? err.message : 'unknown'}`))
      }
    })
  })
}

function parseProgress(line: string): number {
  const match = line.match(/(\d{1,3}\.\d)%/)
  if (match) return parseFloat(match[1])
  return 0
}

export async function queueDownload(url: string, backend: StorageBackend): Promise<Video> {
  const id = uuidv4()
  const now = new Date().toISOString()

  const video: Video = {
    id,
    url,
    title: null,
    thumbnailUrl: null,
    duration: null,
    storageBackend: backend,
    storageKey: null,
    status: 'queued',
    progress: 0,
    error: null,
    fileSize: null,
    createdAt: now,
    updatedAt: now,
  }

  await db.create(video)
  processDownload(id, url, backend).catch(console.error)
  return video
}

async function processDownload(id: string, url: string, backend: StorageBackend) {
  const controller = new AbortController()
  activeJobs.set(id, { controller })

  const workDir = join(config.downloadDir, id)
  const outTemplate = join(workDir, 'video.%(ext)s')

  try {
    await mkdir(workDir, { recursive: true })
    await db.update(id, { status: 'downloading', progress: 0 })

    const metadata = await fetchMetadata(url, controller.signal)
    await db.update(id, {
      title: metadata.title,
      duration: metadata.duration ?? null,
      thumbnailUrl: metadata.thumbnail || null,
    })

    await runYtDlp(
      [
        '--no-playlist',
        '--newline',
        '--no-warnings',
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--output', outTemplate,
        url,
      ],
      {
        signal: controller.signal,
        onProgress: (line) => {
          const progress = parseProgress(line)
          if (progress > 0) {
            db.update(id, { progress: Math.min(Math.round(progress), 99) }).catch(console.error)
          }
        },
      }
    )

    const files = (await readdir(workDir)).map((name) => join(workDir, name))
    const videoFile =
      files.find((f) => f.endsWith('.mp4')) ||
      files.find((f) => ['.mp4', '.webm', '.mkv', '.mov'].includes(extname(f)))
    if (!videoFile) {
      throw new Error('Download completed but no video file found')
    }

    const fileStats = await stat(videoFile)
    if (fileStats.size > config.maxFileSizeBytes) {
      throw new Error(`File size ${fileStats.size} exceeds maximum allowed ${config.maxFileSizeBytes}`)
    }

    await db.update(id, { status: 'uploading', progress: 99 })

    const safeTitle = sanitizeFilename(metadata.title)
    const storageKey = `tubevault/${id}/${safeTitle}.mp4`

    const provider = await createStorageProvider(backend)
    await provider.upload(storageKey, videoFile, 'video/mp4')

    await db.update(id, {
      status: 'complete',
      progress: 100,
      storageKey,
      fileSize: fileStats.size,
    })
  } catch (err: any) {
    console.error(`Download ${id} failed:`, err)
    await db.update(id, { status: 'failed', error: err.message || 'Unknown error' })
  } finally {
    activeJobs.delete(id)
    try {
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true })
      }
    } catch (cleanupErr) {
      console.error(`Failed to cleanup ${workDir}:`, cleanupErr)
    }
  }
}

export async function cancelDownload(id: string): Promise<boolean> {
  const job = activeJobs.get(id)
  if (job) {
    job.controller.abort()
    activeJobs.delete(id)
    return true
  }
  return false
}

export async function deleteVideo(id: string): Promise<boolean> {
  const video = await db.get(id)
  if (!video) return false

  if (video.storageKey) {
    try {
      const provider = await createStorageProvider(video.storageBackend)
      await provider.delete(video.storageKey)
    } catch (err) {
      console.error(`Failed to delete storage object ${video.storageKey}:`, err)
      // Continue and delete DB record anyway
    }
  }

  await db.delete(id)
  return true
}

export async function getVideoPublicUrl(id: string): Promise<string | null> {
  const video = await db.get(id)
  if (!video || !video.storageKey) return null
  const provider = await createStorageProvider(video.storageBackend)
  return provider.getPublicUrl(video.storageKey)
}
