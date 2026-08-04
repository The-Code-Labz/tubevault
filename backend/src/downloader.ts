import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from './config.js'
import { db } from './db.js'
import { createStorageProvider } from './storage.js'
import { extractMediaUrls, writeNetscapeCookiesFromJson } from './playwrightFallback.js'
import type { StorageBackend, Video } from './types.js'

const activeJobs = new Map<string, { controller: AbortController; child?: ReturnType<typeof spawn> }>()

// --- Concurrency limiter -----------------------------------------------
// MAX_CONCURRENT_DOWNLOADS was previously read into config but never
// enforced; every submitted URL downloaded in parallel unbounded.
const MAX_CONCURRENT = config.maxConcurrentDownloads
let activeCount = 0
const waitQueue: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (activeCount >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waitQueue.push(resolve))
  }
  activeCount++
}

function releaseSlot(): void {
  activeCount--
  const next = waitQueue.shift()
  if (next) next()
}

// Progress writes are throttled so a chatty yt-dlp stdout stream doesn't
// hammer the JSON DB with a write per line.
const PROGRESS_WRITE_INTERVAL_MS = 1000
const lastProgressWrite = new Map<string, number>()

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9\-_\.]/gi, '_').replace(/_+/g, '_').slice(0, 80)
}

export interface YtDlpVersion {
  version: string
  path: string
  gitHead?: string
}

export async function getYtDlpVersion(): Promise<YtDlpVersion> {
  return new Promise((resolve, reject) => {
    const ytDlpPath = config.ytDlpPath
    const child = spawn(ytDlpPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp --version failed: ${stderr || 'unknown'}`))
      }
      resolve({ version: stdout.trim(), path: ytDlpPath })
    })
  })
}

export async function updateYtDlp(): Promise<string> {
  if (!config.ytDlpAutoUpdate) {
    return 'auto-update disabled'
  }
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, ['-U'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('yt-dlp update timed out after 60s'))
    }, 60000)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || stdout.includes('Updated yt-dlp') || stdout.includes('up to date')) {
        resolve(stdout.trim() || 'yt-dlp up to date')
      } else {
        reject(new Error(`yt-dlp update failed (${code}): ${stderr || stdout || 'unknown'}`))
      }
    })
  })
}

async function ensureNetscapeCookiesFile(sourcePath: string): Promise<string | null> {
  // yt-dlp only accepts Netscape-format cookies.txt. If the user mounted a JSON
  // cookie file, convert it once to a temp Netscape file and point yt-dlp at that.
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const data = await fs.readFile(sourcePath, 'utf-8').catch(() => '')
  const trimmed = data.trim()
  if (!trimmed) return null

  const looksLikeJson = trimmed.startsWith('[') || trimmed.startsWith('{')
  if (!looksLikeJson) {
    // Already Netscape or unknown — let yt-dlp decide.
    return sourcePath
  }

  const netscapePath = path.join(path.dirname(sourcePath), `cookies-ytdlp-${Date.now()}.txt`)
  try {
    await writeNetscapeCookiesFromJson(sourcePath, netscapePath)
    console.log(`[downloader] converted JSON cookies to Netscape format for yt-dlp: ${netscapePath}`)
    return netscapePath
  } catch (err) {
    console.warn(`[downloader] failed to convert cookies to Netscape: ${(err as Error).message}`)
    return sourcePath
  }
}

async function buildBaseArgs(): Promise<string[]> {
  const args: string[] = ['--no-playlist', '--newline']

  if (config.ytDlpUserAgent) {
    args.push('--user-agent', config.ytDlpUserAgent)
  }

  if (config.ytDlpCookiesFromBrowser) {
    args.push('--cookies-from-browser', config.ytDlpCookiesFromBrowser)
  }

  if (config.ytDlpCookiesFile) {
    // yt-dlp does NOT error when --cookies points at a missing file — it silently
    // proceeds unauthenticated, which surfaces later as a confusing extractor
    // failure with no mention of cookies at all. Fail loud here instead.
    if (!existsSync(config.ytDlpCookiesFile)) {
      console.warn(
        `WARNING: YTDLP_COOKIES_FILE is set to "${config.ytDlpCookiesFile}" but that file does not exist ` +
          `inside the container. Downloads will proceed WITHOUT cookies. Check your volume mount / path.`
      )
    } else {
      const netscapePath = await ensureNetscapeCookiesFile(config.ytDlpCookiesFile)
      if (netscapePath) {
        args.push('--cookies', netscapePath)
      }
    }
  }

  if (config.ytDlpReferer) {
    args.push('--add-header', `Referer:${config.ytDlpReferer}`)
  }

  if (config.ytDlpCustomArgs.length > 0) {
    args.push(...config.ytDlpCustomArgs)
  }

  return args
}

async function runYtDlp(
  args: string[],
  options: { signal?: AbortSignal; onProgress?: (line: string) => void } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      const line = data.toString()
      stdout += line
      if (options.onProgress) options.onProgress(line)
    })
    child.stderr.on('data', (data) => {
      const line = data.toString()
      stderr += line
      if (options.onProgress) options.onProgress(line)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr || 'unknown error'}`))
    })

    options.signal?.addEventListener('abort', () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    })
  })
}

export async function fetchMetadata(url: string, signal?: AbortSignal): Promise<{
  title: string
  duration?: number
  thumbnail?: string
  ext?: string
  extractor?: string
  uploader?: string
}> {
  const args = [...await buildBaseArgs(), '--dump-single-json', url]
  const { stdout, stderr } = await runYtDlp(args, { signal })

  try {
    const data = JSON.parse(stdout)
    return {
      title: data.title || 'untitled',
      duration: data.duration ? Math.round(data.duration) : undefined,
      thumbnail: data.thumbnail,
      ext: data.ext,
      extractor: data.extractor,
      uploader: data.uploader || data.channel || data.uploader_id,
    }
  } catch (err) {
    throw new Error(`Failed to parse yt-dlp metadata: ${err instanceof Error ? err.message : 'unknown'}; stderr: ${stderr.slice(0, 500)}`)
  }
}

function parseProgress(line: string): number {
  const match = line.match(/(\d{1,3}\.\d)%/)
  if (match) return parseFloat(match[1])
  return 0
}

export async function queueDownload(url: string, backend: StorageBackend, userId: string): Promise<Video> {
  const id = uuidv4()
  const now = new Date().toISOString()

  const video: Video = {
    id,
    userId,
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

  const controller = new AbortController()
  activeJobs.set(id, { controller })
  scheduleDownload(id, url, backend, controller)

  return video
}

function scheduleDownload(id: string, url: string, backend: StorageBackend, controller: AbortController): void {
  acquireSlot()
    .then(() => {
      if (controller.signal.aborted) {
        releaseSlot()
        return
      }
      return processDownload(id, url, backend, controller).finally(releaseSlot)
    })
    .catch(console.error)
}

async function processDownload(
  id: string,
  url: string,
  backend: StorageBackend,
  controller: AbortController
): Promise<void> {
  const workDir = join(config.downloadDir, id)
  const outTemplate = join(workDir, 'video.%(ext)s')

  try {
    await mkdir(workDir, { recursive: true })
    await db.update(id, { status: 'downloading', progress: 0 })

    let title = 'untitled'
    let thumbnailUrl: string | null = null
    let duration: number | null = null

    try {
      const metadata = await fetchMetadata(url, controller.signal)
      title = metadata.title
      duration = metadata.duration ?? null
      thumbnailUrl = metadata.thumbnail || null
      await db.update(id, { title, duration, thumbnailUrl })
    } catch (metaErr: any) {
      console.warn(`[downloader] metadata fetch failed: ${metaErr.message}`)
      if (!shouldTryPlaywrightFallback(url, metaErr.message)) {
        throw metaErr
      }
    }

    const onProgress = (line: string) => {
      const progress = parseProgress(line)
      if (progress <= 0) return
      const now = Date.now()
      const last = lastProgressWrite.get(id) || 0
      if (now - last < PROGRESS_WRITE_INTERVAL_MS) return
      lastProgressWrite.set(id, now)
      db.update(id, { progress: Math.min(Math.round(progress), 99) }).catch(console.error)
    }

    let videoFile: string
    try {
      videoFile = await downloadWithYtDlp(url, workDir, outTemplate, controller.signal, onProgress)
    } catch (dlErr: any) {
      if (!shouldTryPlaywrightFallback(url, dlErr.message)) {
        throw dlErr
      }
      const fallback = await downloadWithPlaywrightFallback(
        url,
        workDir,
        outTemplate,
        controller.signal,
        onProgress
      )
      videoFile = fallback.videoFile
      if (title === 'untitled') {
        title = fallback.title
        await db.update(id, { title })
      }
    }

    const videoStat = await stat(videoFile)
    if (videoStat.size > config.maxFileSizeBytes) {
      throw new Error(`File size ${videoStat.size} exceeds maximum allowed ${config.maxFileSizeBytes}`)
    }

    await db.update(id, { status: 'uploading', progress: 99 })

    const safeTitle = sanitizeFilename(title)
    const storageKey = `tubevault/${id}/${safeTitle}.mp4`

    const provider = await createStorageProvider(backend)
    await provider.upload(storageKey, videoFile, 'video/mp4')

    await db.update(id, {
      status: 'complete',
      progress: 100,
      storageKey,
      fileSize: videoStat.size,
    })
  } catch (err: any) {
    console.error(`Download ${id} failed:`, err)
    await db.update(id, { status: 'failed', error: err.message || 'Unknown error' })
  } finally {
    activeJobs.delete(id)
    lastProgressWrite.delete(id)
    try {
      if (existsSync(workDir)) {
        await rm(workDir, { recursive: true, force: true })
      }
    } catch (cleanupErr) {
      console.error(`Failed to cleanup ${workDir}:`, cleanupErr)
    }
  }
}

async function downloadWithYtDlp(
  url: string,
  workDir: string,
  outTemplate: string,
  signal: AbortSignal,
  onProgress?: (line: string) => void
): Promise<string> {
  const formatSelector =
    config.ytDlpFormat ||
    'bestvideo*+bestaudio/bestvideo+bestaudio/best[ext=mp4]/best/best*[ext=mp4]/worst'

  const args = [
    ...await buildBaseArgs(),
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--max-filesize', String(config.maxFileSizeBytes),
    '--output', outTemplate,
    url,
  ]

  await runYtDlp(args, { signal, onProgress })

  const entries = (await readdir(workDir)).map((name) => join(workDir, name))
  const fileStats = await Promise.all(
    entries.map(async (path) => {
      try {
        const s = await stat(path)
        return { path, isFile: s.isFile(), size: s.size }
      } catch {
        return { path, isFile: false, size: 0 }
      }
    })
  )
  const candidates = fileStats
    .filter((f) => f.isFile && !f.path.endsWith('.json') && !f.path.endsWith('.txt') && !f.path.endsWith('.nfo'))
    .sort((a, b) => b.size - a.size)

  const videoFile =
    candidates.find((f) => f.path.endsWith('.mp4'))?.path ||
    candidates.find((f) => ['.mp4', '.webm', '.mkv', '.mov'].includes(extname(f.path).toLowerCase()))?.path ||
    candidates[0]?.path

  if (!videoFile) {
    throw new Error('Download completed but no video file found')
  }

  return videoFile
}

function shouldTryPlaywrightFallback(url: string, _errorMessage: string): boolean {
  if (!config.playwrightFallbackEnabled) return false
  try {
    const regex = new RegExp(config.playwrightFallbackSites, 'i')
    if (!regex.test(new URL(url).hostname)) return false
  } catch {
    return false
  }
  // If the URL's hostname matches the fallback list, always try the browser.
  // The hostname check is the real gate; relying on error-message heuristics
  // caused "Unable to extract video URL" errors to skip the fallback.
  return true
}

async function downloadWithPlaywrightFallback(
  pageUrl: string,
  workDir: string,
  outTemplate: string,
  signal: AbortSignal,
  onProgress?: (line: string) => void
): Promise<{ videoFile: string; title: string }> {
  console.log(`[downloader] yt-dlp failed on ${pageUrl}; trying Playwright fallback`)
  const candidates = await extractMediaUrls(pageUrl, signal)
  if (candidates.length === 0) {
    throw new Error('yt-dlp failed and Playwright fallback found no media URLs')
  }

  const hostname = new URL(pageUrl).hostname
  const referer = `https://${hostname}/`

  for (const candidate of candidates.slice(0, 3)) {
    if (signal.aborted) throw new Error('Download aborted')

    console.log(`[downloader] trying fallback candidate: ${candidate.url.slice(0, 150)}`)

    const extraArgs: string[] = [
      '--add-header', `Referer:${referer}`,
      '--add-header', `Origin:${referer}`,
    ]
    if (config.ytDlpUserAgent) {
      extraArgs.push('--user-agent', config.ytDlpUserAgent)
    }

    try {
      const baseArgs = await buildBaseArgs()
      const args = [
        '--no-playlist',
        '--newline',
        ...baseArgs,
        ...extraArgs,
        '-f', 'bestvideo*+bestaudio/bestvideo+bestaudio/best/best*[ext=mp4]/worst',
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--max-filesize', String(config.maxFileSizeBytes),
        '--output', outTemplate,
        candidate.url,
      ]
      await runYtDlp(args, { signal, onProgress })

      const entries = (await readdir(workDir)).map((name) => join(workDir, name))
      const fileStats = await Promise.all(
        entries.map(async (path) => {
          try {
            const s = await stat(path)
            return { path, isFile: s.isFile(), size: s.size }
          } catch {
            return { path, isFile: false, size: 0 }
          }
        })
      )
      const candidates2 = fileStats
        .filter((f) => f.isFile && !f.path.endsWith('.json') && !f.path.endsWith('.txt') && !f.path.endsWith('.nfo'))
        .sort((a, b) => b.size - a.size)

      const videoFile =
        candidates2.find((f) => f.path.endsWith('.mp4'))?.path ||
        candidates2.find((f) => ['.mp4', '.webm', '.mkv', '.mov'].includes(extname(f.path).toLowerCase()))?.path ||
        candidates2[0]?.path

      if (videoFile) {
        return { videoFile, title: `Video from ${hostname}` }
      }
    } catch (err: any) {
      console.warn(`[downloader] fallback candidate failed: ${err.message}`)
      continue
    }
  }

  throw new Error('Playwright fallback found candidates but none could be downloaded')
}

export async function cancelDownload(id: string, userId: string): Promise<boolean> {
  const video = await db.get(id)
  if (!video || video.userId !== userId) return false

  const job = activeJobs.get(id)
  if (job) {
    job.controller.abort()
    activeJobs.delete(id)
    return true
  }
  return false
}

export async function deleteVideo(id: string, userId: string): Promise<boolean> {
  const video = await db.get(id)
  if (!video || video.userId !== userId) return false

  // Abort an in-flight download for this video, if any.
  const job = activeJobs.get(id)
  if (job) {
    job.controller.abort()
    activeJobs.delete(id)
  }

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

/**
 * Mints a fresh stream URL for a video, gated by ownership. Callers must not cache
 * or persist the returned URL — for Supabase this is a short-TTL signed URL, and a
 * new one is generated on every call.
 */
export async function getVideoStreamUrl(id: string, userId: string): Promise<string | null> {
  const video = await db.get(id)
  if (!video || video.userId !== userId || !video.storageKey) return null
  const provider = await createStorageProvider(video.storageBackend)
  return provider.getStreamUrl(video.storageKey)
}

/** Best-effort abort of every in-flight download; used on graceful shutdown. */
export function shutdownActiveJobs(): void {
  for (const [id, job] of activeJobs) {
    job.controller.abort()
    activeJobs.delete(id)
  }
}
