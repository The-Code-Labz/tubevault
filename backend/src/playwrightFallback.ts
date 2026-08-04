import { chromium, type Browser, type BrowserContext, type Page, type Response, type Cookie } from 'playwright'
import { config } from './config.js'
import { getProxy } from './proxy.js'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

const MEDIA_CONTENT_TYPES = [
  'video/',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
  'application/octet-stream', // sometimes HLS segments are served as binary
]

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
  /favicon/,
  /\.js$/,
  /\.css$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.webp$/,
  /\.svg$/,
  /\.woff2?$/,
]

const CDN_DOMAIN_PATTERNS = [
  /cdn/,
  /media/,
  /video/,
  /hls/,
  /dash/,
  /stream/,
  /edge/,
  /cv\-/,
  /phncdn/,
  /rdtcdn/,
  /xvideos-cdn/,
  /pornhub/,
  /redtube/,
  /spankbang/,
]

function looksLikeMedia(url: string, contentType = ''): boolean {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()

    if (EXCLUDED_PATTERNS.some((re) => re.test(pathname))) return false

    for (const ext of MEDIA_EXTENSIONS) {
      if (pathname.endsWith(ext) || pathname.includes(`${ext}?`)) return true
    }

    const ct = contentType.toLowerCase()
    if (MEDIA_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))) {
      return true
    }

    return false
  } catch {
    return false
  }
}

function isExcluded(url: string): boolean {
  return EXCLUDED_PATTERNS.some((re) => re.test(url))
}

function scoreMediaUrl(url: string, contentType = '', responseSize = 0): number {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    const hostname = parsed.hostname.toLowerCase()
    let score = 0

    if (pathname.includes('.m3u8')) score += 120
    if (pathname.includes('.mpd')) score += 110
    if (pathname.includes('.mp4')) score += 90
    if (pathname.includes('.webm')) score += 85
    if (pathname.includes('.m4s')) score += 80
    if (pathname.includes('.ts')) score += 70
    if (pathname.includes('.mov')) score += 60

    const ct = contentType.toLowerCase()
    if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')) score += 120
    if (ct.includes('application/dash+xml')) score += 110
    if (ct.startsWith('video/')) score += 90
    if (ct === 'application/octet-stream' && pathname.includes('seg')) score += 50

    if (pathname.includes('master')) score += 40
    if (pathname.includes('manifest')) score += 40
    if (pathname.includes('index')) score += 20
    if (pathname.includes('playlist')) score += 30

    if (pathname.includes('2160') || pathname.includes('4k')) score += 35
    if (pathname.includes('1080')) score += 30
    if (pathname.includes('720')) score += 20
    if (pathname.includes('480')) score += 10

    if (CDN_DOMAIN_PATTERNS.some((re) => re.test(hostname))) score += 30

    // Segment files are small; manifests and MP4s are bigger. Boost larger responses.
    if (responseSize > 100_000) score += 15
    if (responseSize > 1_000_000) score += 25

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

export function netscapeCookiesToJson(data: string): PlaywrightCookie[] {
  return parseNetscapeCookies(data)
}

export async function writeNetscapeCookiesFromJson(
  sourceFile: string,
  destinationFile: string
): Promise<void> {
  const fs = await import('node:fs/promises')
  const data = await fs.readFile(sourceFile, 'utf-8')
  let cookies: PlaywrightCookie[]
  if (looksLikeNetscapeCookies(data)) {
    cookies = parseNetscapeCookies(data)
  } else {
    const parsed = JSON.parse(data)
    cookies = Array.isArray(parsed) ? parsed.map(normalizeCookie) : []
  }

  const lines = ['# Netscape HTTP Cookie File', '# Auto-generated by TubeVault', '']
  for (const c of cookies) {
    const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expires = c.expires ? String(c.expires) : '0'
    lines.push([domain, flag, c.path, secure, expires, c.name, c.value].join('\t'))
  }

  await mkdirp(dirname(destinationFile))
  await writeFile(destinationFile, lines.join('\n') + '\n')
}

async function mkdirp(p: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(p, { recursive: true })
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
  source: 'request' | 'response' | 'dom' | 'xhr' | 'mediasource' | 'jscfg'
  responseSize?: number
}

export interface ExtractionResult {
  candidates: MediaCandidate[]
  cookies: Cookie[]
  title: string
}

function domainMatches(cookieDomain: string, hostname: string): boolean {
  const cd = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain
  return hostname === cd || hostname.endsWith('.' + cd)
}

export function buildCookieHeader(cookies: Cookie[], targetUrl: string): string {
  try {
    const hostname = new URL(targetUrl).hostname
    const relevant = cookies.filter((c) => domainMatches(c.domain, hostname))
    if (relevant.length === 0) return ''
    return relevant.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

export async function extractMediaUrls(pageUrl: string, signal?: AbortSignal): Promise<ExtractionResult> {
  if (config.playwrightFallbackSites) {
    const regex = new RegExp(config.playwrightFallbackSites, 'i')
    if (!regex.test(new URL(pageUrl).hostname)) {
      console.log(`[playwright] skipping fallback: ${pageUrl} does not match fallback sites`)
      return { candidates: [], cookies: [], title: '' }
    }
  }

  const mediaUrls = new Map<string, MediaCandidate>()
  let title = ''
  let browser: Browser | null = null
  let context: BrowserContext | null = null

  function addCandidate(candidate: MediaCandidate) {
    const existing = mediaUrls.get(candidate.url)
    if (!existing || existing.score < candidate.score) {
      mediaUrls.set(candidate.url, candidate)
      if (candidate.score >= 50) {
        console.log(
          `[playwright] candidate score=${candidate.score} source=${candidate.source}: ${candidate.url.slice(0, 200)}`
        )
      }
    }
  }

  try {
    const proxy = getProxy()
    if (proxy) {
      console.log(`[playwright] using proxy: ${proxy.serverUrl} (auth=${proxy.hasAuth})`)
    } else if (config.playwrightProxyServer) {
      console.warn(`[playwright] PLAYWRIGHT_PROXY_SERVER is set but could not be parsed: "${config.playwrightProxyServer}"`)
    }

    const launchArgs: string[] = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      ...(proxy ? [`--proxy-server=${proxy.serverUrl}`] : []),
      // Force all DNS resolution through the proxy so the site can't see our real IP/location.
      ...(proxy?.serverUrl.startsWith('socks5')
        ? ['--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE localhost"']
        : []),
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
      ...(proxy ? { proxy: proxy.playwrightProxy } : {}),
    })

    if (config.playwrightCookiesFile) {
      await loadCookies(context, config.playwrightCookiesFile)
    }

    const page: Page = await context.newPage()

    // --- Proxy diagnostics: log egress IP seen by the target site ------------
    try {
      const ipChecks = [
        'https://api.ipify.org?format=json',
        'https://httpbin.org/ip',
        'https://checkip.amazonaws.com/',
      ]
      for (const ipUrl of ipChecks) {
        try {
          const ipResponse = await page.goto(ipUrl, { waitUntil: 'commit', timeout: 15000 })
          const body = await ipResponse?.text().catch(() => '')
          const cleanBody = (body || '').replace(/\s+/g, ' ').trim()
          console.log(`[playwright] egress IP via ${new URL(ipUrl).hostname}: ${cleanBody}`)
          break
        } catch (ipErr) {
          console.warn(`[playwright] IP check failed for ${ipUrl}:`, (ipErr as Error).message)
        }
      }
    } catch {
      // ignore diagnostic failures
    }

    // Capture every request/response, including XHR/fetch, regardless of extension.
    page.on('request', (request) => {
      const url = request.url()
      if (isExcluded(url)) return
      const headers = request.headers()
      const contentType = headers['content-type'] || ''
      if (looksLikeMedia(url, contentType)) {
        addCandidate({
          url,
          contentType,
          score: scoreMediaUrl(url, contentType),
          source: 'request',
        })
      }
    })

    page.on('requestfinished', async (request) => {
      const url = request.url()
      if (isExcluded(url)) return
      try {
        const response = await request.response()
        if (!response) return
        const headers = response.headers()
        const contentType = headers['content-type'] || ''
        const contentLength = parseInt(headers['content-length'] || '0', 10)
        const score = scoreMediaUrl(url, contentType, contentLength)
        if (score > 0 || looksLikeMedia(url, contentType)) {
          addCandidate({
            url,
            contentType,
            score,
            source: 'response',
            responseSize: contentLength,
          })
        }
      } catch {
        // ignore
      }
    })

    page.on('response', async (response: Response) => {
      const url = response.url()
      if (isExcluded(url)) return
      try {
        const headers = response.headers()
        const contentType = headers['content-type'] || ''
        const contentLength = parseInt(headers['content-length'] || '0', 10)
        const score = scoreMediaUrl(url, contentType, contentLength)
        if (score > 0) {
          addCandidate({ url, contentType, score, source: 'response', responseSize: contentLength })
        }

        // Some players load manifests via fetch/XHR with no obvious extension.
        // Peek at small responses and look for HLS/DASH signatures.
        if (
          (contentType.includes('json') || contentType.includes('text') || contentType === 'application/octet-stream') &&
          contentLength > 0 &&
          contentLength < 500_000
        ) {
          try {
            const body = await response.text().catch(() => '')
            if (
              body.includes('#EXTM3U') ||
              body.includes('#EXT-X-STREAM-INF') ||
              body.includes('<MPD') ||
              body.includes('<SmoothStreamingMedia')
            ) {
              addCandidate({
                url,
                contentType: 'application/vnd.apple.mpegurl',
                score: 150,
                source: 'response',
                responseSize: contentLength,
              })
            }
          } catch {
            // ignore
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

      // Give the page a moment to settle before interacting.
      await page.waitForTimeout(3000)

      // Try to read the page title for later use.
      try {
        title = (await page.title()).trim() || ''
      } catch {
        title = ''
      }

      // --- Age-gate / disclaimer handling ----------------------------------
      // Adult sites commonly show an age gate that must be dismissed before
      // the real video player is injected. We try several known selectors and
      // button texts, then wait for the player to swap in.
      const ageGateSelectors = [
        'button[data-role="age-gate-confirm"]',
        'button.age-verification__button',
        'button.ageConfirmationBtn',
        'button.js_ageDisclaimer',
        '.ageDisclaimerContainer button',
        '.age-verification button',
        '.agegate button',
        '#age-verification-wrapper button',
        '.ageDisclaimerWrapper button',
        'button[class*="age" i]',
        'a[class*="age" i]',
        'button[class*="disclaimer" i]',
        'button[id*="age" i]',
        'button[id*="disclaimer" i]',
      ]

      const ageGateTexts = [
        /enter/i,
        /yes/i,
        /i am.*18/i,
        /i['’]?m.*18/i,
        /confirm/i,
        /agree/i,
        /accept/i,
        /continue/i,
        /got it/i,
        /over.*18/i,
        /adults?\s+only/i,
        /i?\s*agree/i,
      ]

      let gateClicked = false
      for (const selector of ageGateSelectors) {
        try {
          const locator = page.locator(selector).first()
          if (await locator.isVisible({ timeout: 2000 }).catch(() => false)) {
            await locator.click({ timeout: 3000 })
            console.log(`[playwright] clicked age-gate selector: ${selector}`)
            gateClicked = true
            await page.waitForTimeout(3000)
            break
          }
        } catch {
          // try next selector
        }
      }

      if (!gateClicked) {
        try {
          const buttons = await page.locator('button:visible, a:visible').all()
          for (const btn of buttons.slice(0, 12)) {
            const text = await btn.textContent().catch(() => '')
            if (ageGateTexts.some((re) => re.test(text || ''))) {
              await btn.click({ timeout: 2000 })
              console.log(`[playwright] clicked age-gate button by text: "${text?.trim()}"`)
              gateClicked = true
              await page.waitForTimeout(3000)
              break
            }
          }
        } catch {
          // ignore
        }
      }

      // Some sites replace the entire player after the gate is dismissed.
      // Wait for that to happen, then scroll and click to trigger playback.
      await page.waitForTimeout(gateClicked ? 5000 : 2000)

      // Scroll down and back up to trigger lazy-loaded players.
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2))
        await page.waitForTimeout(1500)
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.waitForTimeout(1000)
      } catch {
        // ignore
      }

      // Try to click the video player to start playback / trigger manifest load.
      try {
        const player = page.locator('video').first()
        if (await player.isVisible().catch(() => false)) {
          await player.click({ timeout: 3000 })
          await page.waitForTimeout(4000)
        }
      } catch {
        // ignore
      }

      // Also try clicking the largest visible image or the body center as a fallback.
      try {
        const bodyClick = page.locator('body')
        await bodyClick.click({ position: { x: 100, y: 100 }, timeout: 2000, force: true })
        await page.waitForTimeout(2000)
      } catch {
        // ignore
      }

      // --- Extract media URLs directly from the DOM -------------------------
      try {
        const domUrls = await page.evaluate(() => {
          const results: Array<{ url: string; source: string }> = []
          const selectors = ['video', 'source', 'audio']
          for (const sel of selectors) {
            for (const el of Array.from(document.querySelectorAll(sel))) {
              const url =
                el.getAttribute('src') ||
                el.getAttribute('data-src') ||
                el.getAttribute('data-video') ||
                el.getAttribute('data-source')
              if (url) results.push({ url, source: el.tagName.toLowerCase() })
            }
          }
          // Some players store the manifest in a global variable.
          const globals = ['videojs', 'jwplayer', 'player', 'flowplayer', 'clappr', 'plyr']
          for (const g of globals) {
            try {
              const val = (window as any)[g]
              if (val && typeof val === 'object') {
                const src = val.src || val.currentSrc || val.source || val.sources
                if (typeof src === 'string') results.push({ url: src, source: `global:${g}` })
                if (Array.isArray(src)) {
                  for (const s of src) {
                    const u = typeof s === 'string' ? s : s?.file || s?.src || s?.url
                    if (u) results.push({ url: u, source: `global:${g}` })
                  }
                }
              }
            } catch {
              // ignore
            }
          }
          return results
        })
        for (const { url, source } of domUrls) {
          addCandidate({
            url,
            score: scoreMediaUrl(url) + (url.startsWith('blob:') ? -30 : 30),
            source: 'dom',
          })
        }
        if (domUrls.length > 0) {
          console.log(`[playwright] extracted ${domUrls.length} DOM/global media reference(s)`)
        }
      } catch {
        // ignore
      }

      // --- Extract video config from inline/page scripts --------------------
      // Pornhub/RedTube and similar sites embed a JSON/JS config object that
      // contains the canonical quality variants. We scrape it from globals and
      // inline scripts so we don't have to rely on the DOM <video> element,
      // which may initially point at the age-gate preview.
      try {
        const jsCfgUrls = await page.evaluate(() => {
          const found: Array<{ url: string; quality?: string }> = []
          const pushUrl = (u: string, quality?: string) => {
            if (u && !u.startsWith('blob:')) found.push({ url: u, quality })
          }

          // Common global config names on adult tube sites.
          const configKeys = [
            'flashvars',
            'videoVars',
            'playerObj',
            'videoPlayer',
            'pornhub',
            'redtube',
            'xvideos',
            'mediaPlayer',
            'playerConfig',
          ]
          for (const key of configKeys) {
            try {
              const val = (window as any)[key]
              if (!val) continue
              const json = JSON.stringify(val)
              for (const m of json.matchAll(/https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8|webm|mov)/gi)) {
                pushUrl(m[0])
              }
            } catch {
              // ignore
            }
          }

          // Walk inline scripts for quality-variant objects.
          for (const script of Array.from(document.querySelectorAll('script'))) {
            try {
              const text = script.textContent || ''
              // Match qualityVariantConfig, qualityItems, mediaDefinitions, etc.
              const patterns = [
                /mediaDefinitions\s*:\s*(\[[^\]]+\])/i,
                /qualityItems\s*:\s*(\[[^\]]+\])/i,
                /qualityVariantConfig\s*:\s*(\[[^\]]+\])/i,
                /videoUrl\s*:\s*("[^"]+"|'[^']+')/i,
                /video_url\s*:\s*("[^"]+"|'[^']+')/i,
                /mp4\s*:\s*("[^"]+"|'[^']+')/i,
              ]
              for (const re of patterns) {
                const m = text.match(re)
                if (!m) continue
                try {
                  const parsed = new Function('return ' + m[1])()
                  if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                      if (typeof item === 'string') pushUrl(item)
                      else {
                        const u = item.videoUrl || item.video_url || item.mp4 || item.url || item.file || item.src
                        if (u) pushUrl(String(u), String(item.quality || item.label || ''))
                      }
                    }
                  }
                } catch {
                  // ignore parse failure
                }
              }
              // Catch-all URL extraction from inline scripts.
              for (const m of text.matchAll(/https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8|webm|mov)/gi)) {
                pushUrl(m[0])
              }
            } catch {
              // ignore
            }
          }
          return found
        })

        for (const { url, quality } of jsCfgUrls) {
          let score = scoreMediaUrl(url)
          if (quality?.includes('1080')) score += 30
          if (quality?.includes('720')) score += 20
          addCandidate({ url, score, source: 'jscfg' })
        }
        if (jsCfgUrls.length > 0) {
          console.log(`[playwright] extracted ${jsCfgUrls.length} URL(s) from JS video config`)
        }
      } catch {
        // ignore
      }

      // Wait for any late network activity after interactions.
      await page.waitForTimeout(4000)

      // If the age gate was dismissed late, a new video element may have
      // appeared. Do one more DOM scan to prefer it over the gate preview.
      try {
        const finalDomUrls = await page.evaluate(() => {
          const results: string[] = []
          for (const el of Array.from(document.querySelectorAll('video, source'))) {
            const url = el.getAttribute('src') || el.getAttribute('data-src')
            if (url && !url.startsWith('blob:')) results.push(url)
          }
          return results
        })
        for (const url of finalDomUrls) {
          addCandidate({ url, score: scoreMediaUrl(url) + 40, source: 'dom' })
        }
        if (finalDomUrls.length > 0) {
          console.log(`[playwright] post-gate DOM scan found ${finalDomUrls.length} URL(s)`)
        }
      } catch {
        // ignore
      }
    } finally {
      signal?.removeEventListener('abort', abortListener)
    }

    const candidates = Array.from(mediaUrls.values()).sort((a, b) => b.score - a.score)

    // Capture cookies from the browser context before closing. These are
    // needed to authenticate the direct media request to the CDN.
    let cookies: Cookie[] = []
    try {
      cookies = await context.cookies()
      console.log(`[playwright] captured ${cookies.length} cookie(s) from browser context`)
    } catch (err) {
      console.warn('[playwright] failed to capture cookies:', (err as Error).message)
    }

    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})

    console.log(`[playwright] found ${candidates.length} media candidate(s) for ${pageUrl}`)
    return { candidates, cookies, title }
  } catch (err) {
    console.error('[playwright] extraction failed:', (err as Error).message)
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    throw err
  }
}
