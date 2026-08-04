import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { config } from './config.js'

const MEDIA_EXTENSIONS = new Set([
  '.m3u8',
  '.mp4',
  '.ts',
  '.m4s',
  '.webm',
  '.mkv',
  '.mov',
  '.flv',
  '.f4v',
  '.m4v',
  '.mpd',
])

const EXCLUDED_PATTERNS = [
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /doubleclick\.net/,
  /facebook\.com\/tr/,
  /analytics/,
  /tracking/,
  /adsystem/,
  /pubads/,
  /gstatic\.com/,
  /fonts\.google/,
]

function looksLikeMedia(url: string): boolean {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    if (
      Array.from(MEDIA_EXTENSIONS).some(
        (ext: string) => pathname.endsWith(ext) || pathname.includes(`${ext}?`)
      )
    ) {
      return true
    }
    if (pathname.endsWith('.m3u8') || pathname.includes('.m3u8?')) return true
    if (pathname.endsWith('.mpd') || pathname.includes('.mpd?')) return true
    return false
  } catch {
    return false
  }
}

function isExcluded(url: string): boolean {
  return EXCLUDED_PATTERNS.some((re) => re.test(url))
}

function scoreMediaUrl(url: string): number {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    let score = 0
    if (pathname.includes('.m3u8')) score += 100
    if (pathname.includes('.mp4')) score += 80
    if (pathname.includes('.m4s')) score += 70
    if (pathname.includes('.ts')) score += 60
    if (pathname.includes('.mpd')) score += 50
    if (pathname.includes('manifest')) score += 40
    if (pathname.includes('master')) score += 30
    if (pathname.includes('720') || pathname.includes('1080')) score += 20
    return score
  } catch {
    return 0
  }
}

interface PlaywrightCookie {
  name: string
  value: string
  domain: string
  path: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  expires?: number
}

function looksLikeNetscapeCookies(data: string): boolean {
  // Netscape cookies.txt starts with # comments and has tab-separated lines.
  // Accept if any non-comment line has 7 tab-separated fields.
  return data.split('\n').some((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    return trimmed.split('\t').length >= 6
  })
}

function parseNetscapeCookies(data: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = []
  for (const rawLine of data.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 6) continue
    // Netscape format: domain \t flag \t path \t secure \t expires \t name \t value
    const [domain, _flag, path, secure, expires, name, ...valueParts] = parts
    const value = valueParts.join('\t') // value itself might contain tabs (rare)
    if (!name || !domain) continue
    const exp = parseInt(expires, 10)
    cookies.push({
      name,
      value,
      domain,
      path: path || '/',
      secure: secure?.toUpperCase() === 'TRUE',
      httpOnly: false,
      sameSite: config.playwrightCookiesSameSite,
      expires: Number.isFinite(exp) && exp > 0 ? exp : undefined,
    })
  }
  return cookies
}

function normalizeCookie(c: any): PlaywrightCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite)
      ? c.sameSite
      : config.playwrightCookiesSameSite,
    expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined,
  }
}

async function loadCookies(context: BrowserContext, cookiesFile: string) {
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const resolved = path.isAbsolute(cookiesFile) ? cookiesFile : path.resolve(process.cwd(), cookiesFile)

    try {
      await fs.access(resolved)
    } catch {
      console.warn(
        `[playwright] PLAYWRIGHT_COOKIES_FILE is set to "${cookiesFile}" (resolved: ${resolved}) but that file does not exist. ` +
          `Downloads will proceed WITHOUT cookies. Mount the file into the container or check the path.`
      )
      return
    }

    const data = await fs.readFile(resolved, 'utf-8')

    let cookies: PlaywrightCookie[]
    if (looksLikeNetscapeCookies(data)) {
      console.log(`[playwright] detected Netscape cookies.txt at ${resolved}, converting to JSON`)
      cookies = parseNetscapeCookies(data)
    } else {
      const parsed = JSON.parse(data)
      cookies = Array.isArray(parsed) ? parsed.map(normalizeCookie) : []
    }

    if (cookies.length > 0) {
      await context.addCookies(cookies)
      console.log(`[playwright] loaded ${cookies.length} cookie(s) from ${resolved}`)
    } else {
      console.warn(`[playwright] cookie file ${resolved} contained no usable cookies`)
    }
  } catch (err) {
    console.warn(`[playwright] failed to load cookies from ${cookiesFile}:`, (err as Error).message)
  }
}

export interface MediaCandidate {
  url: string
  contentType?: string
  score: number
}

export async function extractMediaUrls(pageUrl: string, signal?: AbortSignal): Promise<MediaCandidate[]> {
  if (config.playwrightFallbackSites) {
    const regex = new RegExp(config.playwrightFallbackSites, 'i')
    if (!regex.test(new URL(pageUrl).hostname)) {
      console.log(`[playwright] skipping fallback: ${pageUrl} does not match fallback sites`)
      return []
    }
  }

  const mediaUrls = new Map<string, MediaCandidate>()
  let browser: Browser | null = null
  let context: BrowserContext | null = null

  try {
    const launchArgs: string[] = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      ...(config.playwrightProxyServer ? [`--proxy-server=${config.playwrightProxyServer}`] : []),
      ...config.playwrightExtraArgs,
    ]

    if (config.playwrightStealth) {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — optional stealth plugins, not installed by default
        const stealthModule = await import('playwright-extra')
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const stealthPluginModule = await import('puppeteer-extra-plugin-stealth')
        const stealthChromium = (stealthModule as any).chromium
        const stealthPlugin = (stealthPluginModule as any).default
        stealthChromium.use(stealthPlugin())
        browser = await stealthChromium.launch({
          headless: config.playwrightHeadless,
          args: launchArgs,
        })
      } catch (stealthErr) {
        console.warn('[playwright] stealth plugin unavailable, using standard chromium:', (stealthErr as Error).message)
        browser = await chromium.launch({
          headless: config.playwrightHeadless,
          args: launchArgs,
        })
      }
    } else {
      browser = await chromium.launch({
        headless: config.playwrightHeadless,
        args: launchArgs,
      })
    }

    if (!browser) {
      throw new Error('Playwright failed to launch browser')
    }

    context = await browser.newContext({
      userAgent:
        config.playwrightUserAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1920, height: 1080 },
      ...(config.playwrightProxyServer ? { proxy: { server: config.playwrightProxyServer } } : {}),
    })

    if (config.playwrightCookiesFile) {
      await loadCookies(context, config.playwrightCookiesFile)
    }

    const page: Page = await context.newPage()

    const onRequest = (request: any) => {
      const url = request.url()
      if (isExcluded(url)) return
      if (looksLikeMedia(url)) {
        const score = scoreMediaUrl(url)
        const headers = request.headers()
        const contentType = headers['content-type'] || ''
        if (!mediaUrls.has(url) || (mediaUrls.get(url)?.score ?? 0) < score) {
          mediaUrls.set(url, { url, contentType, score })
          console.log(`[playwright] captured media candidate (${score}): ${url.slice(0, 200)}`)
        }
      }
    }

    page.on('request', onRequest)
    page.on('requestfinished', async (request) => {
      onRequest(request)
      try {
        const response = await request.response()
        if (!response) return
        const contentType = response.headers()['content-type'] || ''
        const url = request.url()
        if (
          contentType.includes('video') ||
          contentType.includes('application/vnd.apple.mpegurl') ||
          contentType.includes('application/dash+xml')
        ) {
          const score = scoreMediaUrl(url) + 25
          if (!mediaUrls.has(url) || (mediaUrls.get(url)?.score ?? 0) < score) {
            mediaUrls.set(url, { url, contentType, score })
          }
        }
      } catch {
        // ignore
      }
    })

    const abortListener = () => {
      console.log('[playwright] abort signal received, closing browser')
      browser?.close().catch(() => {})
    }
    signal?.addEventListener('abort', abortListener)

    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.playwrightTimeoutMs,
      })

      // Wait for the player to load and request manifests
      await page.waitForTimeout(4000)

      // Try to dismiss common age gates / cookie prompts by clicking the first visible button
      try {
        const buttons = await page.locator('button:visible').all()
        for (const btn of buttons.slice(0, 6)) {
          const text = await btn.textContent().catch(() => '')
          if (/enter|yes|i am|confirm|agree|accept/i.test(text || '')) {
            await btn.click({ timeout: 2000 })
            await page.waitForTimeout(1500)
            break
          }
        }
      } catch {
        // ignore
      }

      // Try to start playback so the manifest is requested
      try {
        const player = page.locator('video').first()
        if (await player.isVisible().catch(() => false)) {
          await player.click({ timeout: 3000 })
          await page.waitForTimeout(3000)
        }
      } catch {
        // ignore
      }

      await page.waitForTimeout(3000)
    } finally {
      signal?.removeEventListener('abort', abortListener)
      await context?.close().catch(() => {})
      await browser?.close().catch(() => {})
    }
  } catch (err) {
    console.error('[playwright] extraction failed:', (err as Error).message)
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    throw err
  }

  const candidates = Array.from(mediaUrls.values()).sort((a, b) => b.score - a.score)
  console.log(`[playwright] found ${candidates.length} media candidate(s) for ${pageUrl}`)
  return candidates
}
