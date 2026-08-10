import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join, extname, dirname } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { config } from './config.js'
import { db } from './db.js'
import { createStorageProvider } from './storage.js'
import { extractMediaUrls, buildCookieHeader } from './playwrightFallback.js'
import { getProxy } from './proxy.js'
import type { Cookie } from 'playwright'
import type { StorageBackend, Video } from './types.js'
import http from 'node:http'
import https from 'node:https'

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

/** hanime.tv needs special yt-dlp handling (plugin + ffmpeg HLS). */
function isHanimeTvUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'hanime.tv' ||
      host === 'www.hanime.tv' ||
      host.endsWith('.hanime.tv')
    )
  } catch {
    return /hanime\.tv/i.test(url)
  }
}

/**
 * Hosts served by the bundled `hanime-plugin` yt-dlp extractors.
 * AES-CBC HLS often fails yt-dlp's native fragment decryptor
 * ("Data must be padded to 16 byte boundary") — ffmpeg handles crypto+ HLS.
 */
function needsFfmpegHlsDownloader(url: string): boolean {
  if (isHanimeTvUrl(url)) return true
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'hentaihaven.com' ||
      host.endsWith('.hentaihaven.com') ||
      host === 'hstream.moe' ||
      host.endsWith('.hstream.moe') ||
      host === 'oppai.stream' ||
      host.endsWith('.oppai.stream') ||
      host === 'ohentai.org' ||
      host.endsWith('.ohentai.org') ||
      host === 'hentaimama.io' ||
      host.endsWith('.hentaimama.io') ||
      host === 'hanime.red' ||
      host.endsWith('.hanime.red')
    )
  } catch {
    return false
  }
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

type ParsedCookie = {
  name: string
  value: string
  domain: string
  path?: string
  secure?: boolean
  expires?: number
}

function parseCookiesFromData(data: string): ParsedCookie[] {
  const cookies: ParsedCookie[] = []
  const trimmed = data.trim()
  if (!trimmed) return cookies

  // Try JSON first.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const arr = Array.isArray(parsed) ? parsed : parsed?.cookies || []
      for (const c of arr) {
        const name = String(c?.name || '')
        const domain = String(c?.domain || '')
        if (!name || !domain) continue
        cookies.push({
          name,
          value: String(c.value || ''),
          domain,
          path: String(c.path || '/'),
          secure: !!c.secure,
          expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined,
        })
      }
    } catch {
      return []
    }
    return cookies
  }

  // Netscape format — re-parse and rewrite strictly.
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 6) continue
    const [domain, _flag, path, secure, expires, name, ...valueParts] = parts
    const value = valueParts.join('\t')
    if (!name || !domain) continue
    const exp = parseInt(expires, 10)
    cookies.push({
      name,
      value,
      domain,
      path: path || '/',
      secure: secure?.toUpperCase() === 'TRUE',
      expires: Number.isFinite(exp) && exp > 0 ? exp : undefined,
    })
  }
  return cookies
}

/** Keep only cookies whose domain belongs to one of the given host suffixes. */
function filterCookiesByDomains(cookies: ParsedCookie[], hostSuffixes: string[]): ParsedCookie[] {
  const suffixes = hostSuffixes.map((h) => h.toLowerCase().replace(/^\./, ''))
  return cookies.filter((c) => {
    const d = c.domain.toLowerCase().replace(/^\./, '')
    return suffixes.some((s) => d === s || d.endsWith(`.${s}`) || s.endsWith(`.${d}`))
  })
}

function cookiesToNetscape(cookies: ParsedCookie[]): string | null {
  if (cookies.length === 0) return null
  const lines = [
    '# Netscape HTTP Cookie File',
    '# This file was generated by TubeVault. Edit at your own risk.',
    '',
  ]
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expires = c.expires ? String(c.expires) : '0'
    lines.push([domain, flag, c.path || '/', secure, expires, c.name, c.value].join('\t'))
  }
  return lines.join('\n') + '\n'
}

function buildStrictNetscapeCookies(data: string, domainFilter?: string[]): string | null {
  let cookies = parseCookiesFromData(data)
  if (domainFilter && domainFilter.length > 0) {
    cookies = filterCookiesByDomains(cookies, domainFilter)
  }
  return cookiesToNetscape(cookies)
}

async function ensureNetscapeCookiesFile(
  sourcePath: string,
  options: { domainFilter?: string[]; label?: string } = {}
): Promise<string | null> {
  // yt-dlp is strict about Netscape cookie format. Always rewrite the input file
  // (JSON or loose Netscape) to a strict temp Netscape file before handing it to yt-dlp.
  const fs = await import('node:fs/promises')
  const data = await fs.readFile(sourcePath, 'utf-8').catch(() => '')
  const all = parseCookiesFromData(data)
  if (all.length === 0) {
    console.warn(`[downloader] cookie file ${sourcePath} contained no usable cookies`)
    return null
  }

  let cookies = all
  if (options.domainFilter && options.domainFilter.length > 0) {
    cookies = filterCookiesByDomains(all, options.domainFilter)
    if (cookies.length === 0) {
      console.log(
        `[downloader] cookie file has ${all.length} cookie(s) but none match ` +
          `${options.domainFilter.join(', ')} — skipping cookies for this job ` +
          `(this is expected when cookies.txt is PornHub-only and the job is hanime)`
      )
      return null
    }
    console.log(
      `[downloader] domain-filtered cookies: ${cookies.length}/${all.length} kept ` +
        `for ${options.domainFilter.join(', ')}` +
        (options.label ? ` (${options.label})` : '')
    )
  }

  const netscapeContent = cookiesToNetscape(cookies)
  if (!netscapeContent) return null

  const netscapePath = join(
    tmpdir(),
    `tubevault-cookies-ytdlp-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  )
  try {
    await mkdir(tmpdir(), { recursive: true })
    await writeFile(netscapePath, netscapeContent)
    console.log(`[downloader] normalized cookies to strict Netscape format for yt-dlp: ${netscapePath}`)
    return netscapePath
  } catch (err) {
    console.warn(`[downloader] failed to normalize cookies to Netscape: ${(err as Error).message}`)
    return null
  }
}

/** True when YTDLP_CUSTOM_ARGS already supplies --impersonate (avoid double-flag). */
function customArgsHaveImpersonate(): boolean {
  const args = config.ytDlpCustomArgs
  return args.some((a, i) => a === '--impersonate' || a.startsWith('--impersonate=') ||
    (args[i - 1] === '--impersonate'))
}

function redactProxyUrl(url: string): string {
  return url.replace(/:\/\/[^:]+:[^@]+@/, '://***@')
}

function isHttp403Error(message: string): boolean {
  return /HTTP Error 403|403:\s*Forbidden/i.test(message || '')
}

/** Cloudflare / bot-wall failures that warrant trying the other egress hop. */
function isHanimeEgressError(message: string): boolean {
  const m = message || ''
  return (
    isHttp403Error(m) ||
    /cloudflare|just a moment|cf-browser-verification|attention required/i.test(m) ||
    /network is unreachable/i.test(m) ||
    /connection reset by peer/i.test(m) ||
    /Unable to download webpage/i.test(m)
  )
}

function isSocksProxyUrl(url: string | null | undefined): boolean {
  return !!url && /^socks/i.test(url.trim())
}

/**
 * Cheap preflight: can this process open hanime.tv at all?
 * Logs status + body snip so Cloudflare HTML is obvious in container logs.
 * Does not throw — callers still run yt-dlp; this only improves diagnostics.
 */
async function probeHanimeEgress(proxyUrl?: string): Promise<{
  ok: boolean
  status?: number
  snippet?: string
  error?: string
}> {
  return new Promise((resolve) => {
    const target = 'https://hanime.tv/'
    const timer = setTimeout(() => {
      resolve({ ok: false, error: 'preflight timed out after 12s' })
    }, 12000)

    const finish = (result: { ok: boolean; status?: number; snippet?: string; error?: string }) => {
      clearTimeout(timer)
      resolve(result)
    }

    try {
      // Prefer undici-free path: spawn curl so we don't need extra deps and can
      // pass --proxy the same way yt-dlp does (SOCKS5 + HTTP).
      const args = [
        '-sS',
        '-o',
        '-',
        '-w',
        '\n__TV_HTTP_CODE__:%{http_code}',
        '--max-time',
        '10',
        '-A',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-H',
        'Accept: text/html,application/xhtml+xml',
      ]
      if (proxyUrl) {
        args.push('--proxy', proxyUrl)
      }
      args.push(target)

      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => finish({ ok: false, error: err.message }))
      child.on('close', () => {
        const m = stdout.match(/__TV_HTTP_CODE__:(\d+)/)
        const status = m ? parseInt(m[1], 10) : undefined
        const body = stdout.replace(/\n__TV_HTTP_CODE__:\d+\s*$/, '')
        const snippet = body.slice(0, 160).replace(/\s+/g, ' ').trim()
        if (!status) {
          finish({ ok: false, error: stderr.trim() || 'curl failed', snippet })
          return
        }
        const looksCf =
          /just a moment|cf-browser-verification|cloudflare|attention required/i.test(body) ||
          status === 403 ||
          status === 503
        finish({
          ok: status >= 200 && status < 400 && !looksCf,
          status,
          snippet,
          error: looksCf ? 'Cloudflare challenge / block page' : undefined,
        })
      })
    } catch (err: any) {
      finish({ ok: false, error: err?.message || 'preflight failed' })
    }
  })
}

interface BuildBaseArgsOptions {
  /** Force cookies on/off for this invocation (overrides hanime default). */
  forceCookies?: boolean
  /** Override proxy selection for this invocation. string = use it; null = force direct; undefined = default. */
  forceProxy?: string | null
  /** When true, skip the dual-path policy log spam (internal retry hop). */
  quietProxyLog?: boolean
}

/**
 * Ordered egress hops for hanime-family.
 * - Dedicated HANIME_PROXY_SERVER => single hop
 * - Else if PLAYWRIGHT_PROXY_SERVER set:
 *     HANIME_BYPASS_PROXY=true  (default): direct first, then home SOCKS
 *     HANIME_BYPASS_PROXY=false: home SOCKS first, then direct
 * - Else: direct only
 *
 * null inside the list means "no --proxy" (container direct egress).
 */
function hanimeEgressHops(): Array<string | null> {
  if (config.hanimeProxyServer) return [config.hanimeProxyServer]
  const globalProxy = (config.playwrightProxyServer || '').trim()
  if (!globalProxy) return [null]
  if (config.hanimeBypassProxy) {
    // Direct first (datacenter may work); home SOCKS second (browser-proven IP).
    return [null, globalProxy]
  }
  // Prefer home/residential SOCKS first when user says bypass=false.
  return [globalProxy, null]
}

function describeHop(hop: string | null): string {
  return hop ? redactProxyUrl(hop) : 'direct'
}

async function buildBaseArgs(
  pageUrl?: string,
  options: BuildBaseArgsOptions = {}
): Promise<string[]> {
  const args: string[] = ['--no-playlist', '--newline']
  const hanimeFamily = pageUrl ? needsFfmpegHlsDownloader(pageUrl) : false

  // Resolve which proxy this invocation will use (needed before HLS downloader choice).
  let effectiveProxy: string | null | undefined = options.forceProxy
  if (effectiveProxy === undefined) {
    if (hanimeFamily && config.hanimeProxyServer) {
      effectiveProxy = config.hanimeProxyServer
    } else if (hanimeFamily && config.playwrightProxyServer && config.hanimeBypassProxy) {
      effectiveProxy = null // default first hop = direct
    } else if (config.playwrightProxyServer) {
      effectiveProxy = config.playwrightProxyServer
    } else {
      effectiveProxy = null
    }
  }

  // TLS fingerprint via curl_cffi.
  // For hanime: the HTML page fetch hits Cloudflare BEFORE the Deno/WASM handshake.
  // Plain urllib often gets 403 on the same residential IP a browser can open —
  // Chrome impersonation is required for that first hop. If curl_cffi is missing,
  // yt-dlp warns and continues (does not hard-abort the plugin).
  if (config.ytDlpImpersonate && !customArgsHaveImpersonate()) {
    args.push('--impersonate', config.ytDlpImpersonate)
    if (hanimeFamily && !options.quietProxyLog) {
      console.log(
        `[downloader] hanime-family — TLS impersonate=${config.ytDlpImpersonate} ` +
          '(Cloudflare HTML fetch; WASM handshake still runs after)'
      )
    }
  }

  // Force IPv4 on hanime: SOCKS exits without IPv6 fail CF challenge AAAA records
  // ("brunhild.challenges.cloudflare.com ([2606:4700::…]): network is unreachable").
  if (hanimeFamily && config.hanimeForceIpv4) {
    args.push('--force-ipv4')
    if (!options.quietProxyLog) {
      console.log(
        '[downloader] hanime-family — --force-ipv4 ' +
          '(SOCKS often has no IPv6; CF challenge hosts advertise AAAA)'
      )
    }
  }

  if (config.ytDlpUserAgent) {
    args.push('--user-agent', config.ytDlpUserAgent)
  }

  // Cookies: hanime-family defaults OFF. You do not need hanime cookies for the
  // WASM handshake. If HANIME_USE_COOKIES=true, domain-filter so PornHub-only
  // cookies.txt is never imported into a hanime job.
  const wantCookies =
    options.forceCookies !== undefined
      ? options.forceCookies
      : hanimeFamily
        ? config.hanimeUseCookies
        : true

  if (wantCookies && config.ytDlpCookiesFromBrowser) {
    args.push('--cookies-from-browser', config.ytDlpCookiesFromBrowser)
  } else if (hanimeFamily && config.ytDlpCookiesFromBrowser && !wantCookies) {
    if (!options.quietProxyLog) {
      console.log(
        '[downloader] hanime-family — skipping YTDLP_COOKIES_FROM_BROWSER ' +
          '(not needed; set HANIME_USE_COOKIES=true only with fresh hanime.tv cookies)'
      )
    }
  }

  if (wantCookies && config.ytDlpCookiesFile) {
    if (!existsSync(config.ytDlpCookiesFile)) {
      console.warn(
        `WARNING: YTDLP_COOKIES_FILE is set to "${config.ytDlpCookiesFile}" but that file does not exist ` +
          `inside the container. Downloads will proceed WITHOUT cookies. Check your volume mount / path.`
      )
    } else {
      const netscapePath = await ensureNetscapeCookiesFile(config.ytDlpCookiesFile, {
        domainFilter: hanimeFamily
          ? ['hanime.tv', 'hanime.red', 'hentaihaven.com', 'hstream.moe', 'oppai.stream', 'ohentai.org', 'hentaimama.io']
          : undefined,
        label: hanimeFamily ? 'hanime-family' : undefined,
      })
      if (netscapePath) {
        args.push('--cookies', netscapePath)
      }
    }
  } else if (hanimeFamily && config.ytDlpCookiesFile && !wantCookies) {
    if (!options.quietProxyLog) {
      console.log(
        '[downloader] hanime-family — not importing YTDLP_COOKIES_FILE ' +
          '(default; you said you have no hanime cookies — correct. ' +
          'PornHub cookies are never applied here. Set HANIME_USE_COOKIES=true only for fresh hanime.tv cookies)'
      )
    }
  }

  if (config.ytDlpReferer) {
    args.push('--add-header', `Referer:${config.ytDlpReferer}`)
  } else if (pageUrl && isHanimeTvUrl(pageUrl)) {
    args.push('--add-header', 'Referer:https://hanime.tv/')
  }

  // Apply resolved proxy.
  if (effectiveProxy) {
    args.push('--proxy', effectiveProxy)
    if (!options.quietProxyLog) {
      console.log(`[downloader] yt-dlp will use proxy: ${redactProxyUrl(effectiveProxy)}`)
    }
  } else if (hanimeFamily && !options.quietProxyLog) {
    console.log('[downloader] hanime-family — direct egress this hop (no --proxy)')
  }

  // AES-encrypted HLS:
  // - ffmpeg handles crypto well BUT does not support SOCKS proxies
  //   ("WARNING: ffmpeg does not support SOCKS proxies").
  // - Under SOCKS, use native HLS (`--hls-prefer-native`) so fragments stay on the proxy.
  // - Direct / HTTP proxy: prefer ffmpeg.
  if (hanimeFamily) {
    if (isSocksProxyUrl(effectiveProxy || undefined)) {
      args.push('--hls-prefer-native')
      if (!options.quietProxyLog) {
        console.log(
          '[downloader] hanime-family URL — native HLS (SOCKS path; ffmpeg cannot use SOCKS)'
        )
      }
    } else {
      args.push('--downloader', 'ffmpeg')
      if (!options.quietProxyLog) {
        console.log('[downloader] hanime-family URL — using ffmpeg HLS downloader (AES crypto)')
      }
    }
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

function annotateHanime403(message: string): string {
  if (!isHanimeEgressError(message) && !isHttp403Error(message)) return message
  return (
    `${message}\n` +
    '[hanime] Cloudflare blocked this egress hop. TubeVault dual-paths ' +
    'direct ↔ PLAYWRIGHT_PROXY_SERVER automatically. Your home SOCKS is the right ' +
    'exit when the browser works — ensure curl_cffi is in the image (`--impersonate chrome`), ' +
    'IPv4 is forced (default), and cookies are NOT imported (default). ' +
    'SOCKS log `brunhild.challenges.cloudflare.com ([2606:4700::…]) network is unreachable` ' +
    'means the proxy has no IPv6 — fixed by --force-ipv4. ' +
    'Playwright cannot fix hanime (needs Deno/WASM plugin, not browser intercept).'
  )
}

/** First hop used for preflight logging. */
function resolveHanimeProxyForProbe(): string | undefined {
  const hops = hanimeEgressHops()
  const first = hops[0]
  return first === null || first === undefined ? undefined : first
}

async function runYtDlpJsonWithHanimeHops(
  url: string,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  const hops = needsFfmpegHlsDownloader(url) ? hanimeEgressHops() : [undefined as unknown as null]
  // Non-hanime: single default buildBaseArgs path
  if (!needsFfmpegHlsDownloader(url)) {
    const args = [...await buildBaseArgs(url), '--dump-single-json', url]
    return runYtDlp(args, { signal })
  }

  console.log(
    `[downloader] hanime egress plan: ${hops.map((h, i) => `${i + 1}=${describeHop(h)}`).join(' → ')}`
  )

  let lastErr: Error | null = null
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]
    const label = describeHop(hop)
    try {
      if (i > 0) {
        console.warn(`[downloader] hanime metadata: retrying via ${label} after: ${lastErr?.message?.slice(0, 180)}`)
      }
      const probe = await probeHanimeEgress(hop || undefined)
      if (probe.ok) {
        console.log(`[downloader] hanime preflight OK (HTTP ${probe.status} via ${label})`)
      } else {
        console.warn(
          `[downloader] hanime preflight FAILED via ${label}` +
            `${probe.status ? ` HTTP ${probe.status}` : ''}` +
            `${probe.error ? ` — ${probe.error}` : ''}` +
            `${probe.snippet ? ` body≈${JSON.stringify(probe.snippet)}` : ''}`
        )
      }
      const args = [
        ...await buildBaseArgs(url, { forceProxy: hop, quietProxyLog: i > 0 }),
        '--dump-single-json',
        url,
      ]
      return await runYtDlp(args, { signal })
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const msg = lastErr.message
      const canRetry = i < hops.length - 1 && isHanimeEgressError(msg)
      console.warn(
        `[downloader] hanime metadata hop ${label} failed` +
          (canRetry ? ' — will try next hop' : '') +
          `: ${msg.slice(0, 240)}`
      )
      if (!canRetry) break
    }
  }
  throw new Error(annotateHanime403(lastErr?.message || 'hanime metadata failed on all hops'))
}

export async function fetchMetadata(url: string, signal?: AbortSignal): Promise<{
  title: string
  duration?: number
  thumbnail?: string
  ext?: string
  extractor?: string
  uploader?: string
}> {
  try {
    const { stdout, stderr } = await runYtDlpJsonWithHanimeHops(url, signal)

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
  } catch (err: any) {
    throw new Error(annotateHanime403(err?.message || String(err)))
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

/**
 * Re-queues a previously failed download (e.g. a SOCKS5 proxy timeout) using the
 * video's original URL/backend. Only failed jobs are eligible — active jobs already
 * have a running controller in `activeJobs`, and re-scheduling one would spawn a
 * second concurrent yt-dlp process for the same id.
 */
export async function retryDownload(id: string, userId: string): Promise<Video | null> {
  const video = await db.get(id)
  if (!video || video.userId !== userId) return null
  if (video.status !== 'failed') return null
  if (activeJobs.has(id)) return null

  const updated = await db.update(id, {
    status: 'queued',
    progress: 0,
    error: null,
  })
  if (!updated) return null

  const controller = new AbortController()
  activeJobs.set(id, { controller })
  scheduleDownload(id, video.url, video.storageBackend, controller)

  return updated
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
  // hanime-plugin returns discrete HLS labels (720p/480p/360p) with height=None.
  // Prefer format_id by name — plain `best` usually works but can mis-rank when
  // resolution/tbr are missing. Free/guest tops out at 720p (no premium 1080p).
  const formatSelector =
    config.ytDlpFormat ||
    (needsFfmpegHlsDownloader(url)
      ? '720p/best/480p/360p/bestvideo*+bestaudio/bestvideo+bestaudio/best[ext=mp4]/worst'
      : 'bestvideo*+bestaudio/bestvideo+bestaudio/best[ext=mp4]/best/best*[ext=mp4]/worst')

  if (needsFfmpegHlsDownloader(url) && !config.ytDlpFormat) {
    console.log(`[downloader] hanime-family format selector: ${formatSelector} (prefer 720p)`)
  } else if (config.ytDlpFormat) {
    console.log(`[downloader] using YTDLP_FORMAT override: ${formatSelector}`)
  }

  const runOnce = async (opts?: BuildBaseArgsOptions) => {
    const args = [
      ...await buildBaseArgs(url, opts),
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '--max-filesize', String(config.maxFileSizeBytes),
      '--output', outTemplate,
      url,
    ]
    await runYtDlp(args, { signal, onProgress })
  }

  const findVideoFile = async (): Promise<string> => {
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

  // ---- Non-hanime: single path ----
  if (!needsFfmpegHlsDownloader(url)) {
    await runOnce()
    return findVideoFile()
  }

  // ---- Hanime: dual-path egress + cookie strip retry ----
  const hops = hanimeEgressHops()
  console.log(
    `[downloader] hanime download egress plan: ${hops.map((h, i) => `${i + 1}=${describeHop(h)}`).join(' → ')}`
  )

  let lastErr: Error | null = null
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]
    const label = describeHop(hop)
    try {
      if (i > 0) {
        console.warn(
          `[downloader] hanime download: retrying via ${label} after: ${lastErr?.message?.slice(0, 180)}`
        )
      }
      await runOnce({ forceProxy: hop, quietProxyLog: i > 0 })
      return await findVideoFile()
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const msg = lastErr.message

      // If cookies were forced on and CF 403'd on this hop, retry same hop without cookies.
      if (isHttp403Error(msg) && config.hanimeUseCookies) {
        console.warn(
          `[downloader] hanime 403 with cookies via ${label} — retrying same hop without cookies`
        )
        try {
          await runOnce({ forceProxy: hop, forceCookies: false, quietProxyLog: true })
          return await findVideoFile()
        } catch (err2: any) {
          lastErr = err2 instanceof Error ? err2 : new Error(String(err2))
        }
      }

      const canRetry = i < hops.length - 1 && isHanimeEgressError(lastErr.message)
      console.warn(
        `[downloader] hanime download hop ${label} failed` +
          (canRetry ? ' — will try next hop' : '') +
          `: ${lastErr.message.slice(0, 240)}`
      )
      if (!canRetry) break
    }
  }

  throw new Error(annotateHanime403(lastErr?.message || 'hanime download failed on all hops'))
}

function shouldTryPlaywrightFallback(url: string, errorMessage: string): boolean {
  if (!config.playwrightFallbackEnabled) return false

  // hanime-family requires the Deno/WASM plugin path (AES token + ffmpeg HLS).
  // Generic Playwright only sees Cloudflare Turnstile challenge URLs and can never
  // complete the handshake — spinning Chromium just wastes time and confuses logs.
  if (needsFfmpegHlsDownloader(url)) {
    const cf403 = /HTTP Error 403|403:\s*Forbidden|cloudflare/i.test(errorMessage || '')
    console.warn(
      '[downloader] skipping Playwright fallback for hanime-family ' +
        '(needs Deno/WASM plugin + ffmpeg HLS, not browser intercept)' +
        (cf403
          ? '. HTTP 403 = Cloudflare blocked egress. Dual-path already tried direct↔proxy; ' +
            'no cookies imported by default. Check --impersonate chrome + --force-ipv4 in logs.'
          : '')
    )
    return false
  }

  // Empty PLAYWRIGHT_FALLBACK_SITES (default) = try browser on ANY yt-dlp failure.
  // A non-empty value is treated as a hostname regex allowlist.
  const sites = (config.playwrightFallbackSites || '').trim()
  if (!sites) return true

  try {
    const regex = new RegExp(sites, 'i')
    return regex.test(new URL(url).hostname)
  } catch {
    // Bad regex should not silently disable fallback entirely.
    console.warn(
      `[downloader] invalid PLAYWRIGHT_FALLBACK_SITES regex "${sites}"; allowing fallback for all hosts`
    )
    return true
  }
}

/** Prefer player/CDN origin headers when downloading intercepted media. */
function resolveMediaHeaders(
  candidate: { url: string; contentType?: string; referer?: string; origin?: string },
  pageUrl: string
): Record<string, string> {
  let referer = candidate.referer || ''
  let origin = candidate.origin || ''

  if (!referer) {
    try {
      const mediaHost = new URL(candidate.url).hostname.toLowerCase()
      const mediaUrl = candidate.url.toLowerCase()
      // fmoviess / netoda / embos player stack serves HLS from third-party CDNs
      // that require the player origin as Referer, not the film page.
      if (
        /netoda\.tech|embos\.|voxzer\.|s1q\d|streamhls|m3u8/i.test(mediaHost) ||
        /netoda\.tech|\/hls\//i.test(mediaUrl)
      ) {
        referer = 'https://netoda.tech/'
      }
    } catch {
      // ignore
    }
  }

  if (!referer) {
    try {
      referer = `https://${new URL(pageUrl).hostname}/`
    } catch {
      referer = pageUrl
    }
  }

  if (!origin) {
    try {
      origin = new URL(referer).origin
    } catch {
      origin = referer
    }
  }

  const headers: Record<string, string> = {
    Referer: referer,
    Origin: origin,
  }
  if (config.ytDlpUserAgent) {
    headers['User-Agent'] = config.ytDlpUserAgent
  } else if (config.playwrightUserAgent) {
    headers['User-Agent'] = config.playwrightUserAgent
  }
  return headers
}

function looksLikeDirectMedia(url: string, contentType?: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    const ct = (contentType || '').toLowerCase()
    if (pathname.includes('.m3u8') || pathname.includes('.mpd')) return false
    if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/dash+xml')) return false
    return (
      pathname.endsWith('.mp4') ||
      pathname.includes('.mp4?') ||
      pathname.endsWith('.webm') ||
      pathname.includes('.webm?') ||
      pathname.endsWith('.mov') ||
      pathname.includes('.mov?') ||
      pathname.endsWith('.mkv') ||
      pathname.includes('.mkv?') ||
      pathname.endsWith('.m4v') ||
      pathname.includes('.m4v?') ||
      ct.startsWith('video/')
    )
  } catch {
    return false
  }
}

async function downloadDirectMedia(
  url: string,
  outputPath: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onProgress?: (line: string) => void,
  cookies?: Cookie[]
): Promise<void> {
  console.log(`[downloader] direct-downloading media from ${url.slice(0, 120)}...`)

  const finalHeaders: Record<string, string> = { ...headers }
  if (cookies && cookies.length > 0) {
    const cookieHeader = buildCookieHeader(cookies, url)
    if (cookieHeader) {
      finalHeaders['Cookie'] = cookieHeader
      console.log(`[downloader] sending ${cookies.length} cookie(s) with request`)
    }
  }

  const proxy = getProxy()
  if (proxy) {
    console.log(`[downloader] routing direct download through proxy: ${proxy.serverUrl}`)
  }

  const parsedUrl = new URL(url)
  const agent = proxy?.agent
  const requestModule = parsedUrl.protocol === 'https:' ? https : http

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = requestModule.get(
      url,
      {
        headers: finalHeaders,
        agent,
      },
      (res) => resolve(res)
    )

    req.on('error', reject)

    if (signal) {
      const abort = () => {
        req.destroy(new Error('Download aborted'))
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', abort))
    }
  })

  if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
    throw new Error(`Direct media download failed: HTTP ${response.statusCode} ${response.statusMessage || ''}`)
  }

  const contentLength = parseInt(response.headers['content-length'] || '0', 10)
  if (contentLength === 0) {
    console.warn('[downloader] no Content-Length header; progress will be indeterminate')
  }

  await mkdir(dirname(outputPath), { recursive: true })
  const fileStream = createWriteStream(outputPath)

  let downloaded = 0
  let lastReportedPercent = 0

  response.on('data', (chunk: Buffer) => {
    downloaded += chunk.length
    if (contentLength > 0 && onProgress) {
      const percent = Math.floor((downloaded / contentLength) * 100)
      if (percent > lastReportedPercent) {
        lastReportedPercent = percent
        onProgress(`${percent}.0% of ${contentLength} bytes at unknown ETA`)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    response.pipe(fileStream)
    fileStream.on('finish', resolve)
    fileStream.on('error', reject)
    response.on('error', reject)
  })

  const stats = await stat(outputPath)
  if (stats.size === 0) {
    throw new Error('Direct media download failed: file is empty')
  }
  console.log(`[downloader] direct download complete: ${outputPath} (${stats.size} bytes)`)
}

async function downloadWithPlaywrightFallback(
  pageUrl: string,
  workDir: string,
  outTemplate: string,
  signal: AbortSignal,
  onProgress?: (line: string) => void
): Promise<{ videoFile: string; title: string }> {
  console.log(`[downloader] yt-dlp failed on ${pageUrl}; trying Playwright fallback`)
  const { candidates, cookies, title: pageTitle } = await extractMediaUrls(pageUrl, signal)
  if (candidates.length === 0) {
    throw new Error('yt-dlp failed and Playwright fallback found no media URLs')
  }

  const hostname = new URL(pageUrl).hostname

  for (const candidate of candidates.slice(0, 8)) {
    if (signal.aborted) throw new Error('Download aborted')

    console.log(`[downloader] trying fallback candidate: ${candidate.url.slice(0, 150)}`)

    const headers = resolveMediaHeaders(candidate, pageUrl)
    console.log(
      `[downloader] fallback headers Referer=${headers.Referer} Origin=${headers.Origin}`
    )

    try {
      if (looksLikeDirectMedia(candidate.url, candidate.contentType)) {
        const ext = extname(new URL(candidate.url).pathname).toLowerCase() || '.mp4'
        const safeExt = ['.mp4', '.webm', '.mov', '.mkv', '.m4v'].includes(ext) ? ext : '.mp4'
        const outputPath = outTemplate.replace('%(ext)s', safeExt.replace('.', ''))
        await downloadDirectMedia(candidate.url, outputPath, headers, signal, onProgress, cookies)

        // Reject obvious preview/age-gate videos: extremely short or tiny.
        const stats = await stat(outputPath)
        if (stats.size < 200_000) {
          console.warn(`[downloader] candidate file too small (${stats.size} bytes); likely preview/age-gate, trying next`)
          continue
        }

        return {
          videoFile: outputPath,
          title: pageTitle || `Video from ${hostname}`,
        }
      }

      // For HLS/DASH manifests, keep using yt-dlp (it handles fragment fetching).
      const extraArgs: string[] = [
        '--add-header', `Referer:${headers.Referer}`,
        '--add-header', `Origin:${headers.Origin}`,
      ]
      if (headers['User-Agent']) {
        extraArgs.push('--user-agent', headers['User-Agent'])
      }

      const baseArgs = await buildBaseArgs(pageUrl)
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
        // Reject tiny HLS remuxes (failed token / preview playlist).
        const stats = await stat(videoFile)
        if (stats.size < 200_000) {
          console.warn(
            `[downloader] HLS candidate too small (${stats.size} bytes); trying next`
          )
          continue
        }
        return { videoFile, title: pageTitle || `Video from ${hostname}` }
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

/**
 * Resolves the info needed to proxy-download a completed video to the browser as an
 * attachment. Proxying through our own server (rather than just handing back the raw
 * storage URL) guarantees a Content-Disposition: attachment response regardless of
 * which storage backend is in use — the R2 provider's URL is a plain public link with
 * no signed-URL download-param support, so redirecting the browser there would just
 * open/stream the video inline instead of saving it.
 */
export async function getVideoForDownload(
  id: string,
  userId: string
): Promise<{ streamUrl: string; filename: string; contentType: string } | null> {
  const video = await db.get(id)
  if (!video || video.userId !== userId || !video.storageKey || video.status !== 'complete') return null
  const provider = await createStorageProvider(video.storageBackend)
  const streamUrl = await provider.getStreamUrl(video.storageKey)
  const filename = `${sanitizeFilename(video.title || 'video')}.mp4`
  return { streamUrl, filename, contentType: 'video/mp4' }
}

/** Best-effort abort of every in-flight download; used on graceful shutdown. */
export function shutdownActiveJobs(): void {
  for (const [id, job] of activeJobs) {
    job.controller.abort()
    activeJobs.delete(id)
  }
}
