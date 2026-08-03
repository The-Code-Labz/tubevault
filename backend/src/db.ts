import { mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Video } from './types.js'

const DB_PATH = process.env.DB_PATH || './data/videos.json'

let memoryDb: Video[] = []
let initialized = false

// Serializes all writes so concurrent create/update/delete calls never race
// on the same on-disk file (previous implementation fired unserialized
// writeFile() calls per progress tick, risking a truncated/corrupt DB).
let writeChain: Promise<void> = Promise.resolve()

async function ensureDir() {
  const dir = join(DB_PATH, '..')
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

async function load(): Promise<Video[]> {
  if (initialized) return memoryDb
  try {
    const raw = await readFile(DB_PATH, 'utf-8')
    memoryDb = JSON.parse(raw)
  } catch {
    memoryDb = []
  }
  initialized = true
  return memoryDb
}

async function persist(videos: Video[]) {
  await ensureDir()
  // Atomic write: write to a temp file then rename, so a crash mid-write
  // never leaves videos.json truncated/corrupted.
  const tmpPath = `${DB_PATH}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmpPath, JSON.stringify(videos, null, 2))
  await rename(tmpPath, DB_PATH)
}

async function save(videos: Video[]): Promise<void> {
  memoryDb = videos
  const chained = writeChain.then(() => persist(videos))
  // Keep the chain alive even if this write fails, so later writes still run.
  writeChain = chained.catch((err) => {
    console.error('Failed to persist videos DB:', err)
  })
  await chained
}

export const db = {
  async list(): Promise<Video[]> {
    const videos = await load()
    return [...videos].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  },
  async listByUser(userId: string): Promise<Video[]> {
    const videos = await this.list()
    return videos.filter((v) => v.userId === userId)
  },
  async get(id: string): Promise<Video | undefined> {
    const videos = await load()
    return videos.find((v) => v.id === id)
  },
  async create(video: Video): Promise<Video> {
    const videos = await load()
    videos.push(video)
    await save(videos)
    return video
  },
  async update(id: string, patch: Partial<Video>): Promise<Video | undefined> {
    const videos = await load()
    const idx = videos.findIndex((v) => v.id === id)
    if (idx === -1) return undefined
    videos[idx] = { ...videos[idx], ...patch, updatedAt: new Date().toISOString() }
    await save(videos)
    return videos[idx]
  },
  async delete(id: string): Promise<Video | undefined> {
    const videos = await load()
    const idx = videos.findIndex((v) => v.id === id)
    if (idx === -1) return undefined
    const [removed] = videos.splice(idx, 1)
    await save(videos)
    return removed
  },
}
