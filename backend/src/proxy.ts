import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain'

/** Agent usable with Node's http/https request APIs. */
export type ProxyAgent = http.Agent | https.Agent

export interface ParsedProxy {
  /**
   * Upstream server URL WITHOUT credentials.
   * Useful for logs and Chromium --proxy-server when no auth is required.
   */
  serverUrl: string
  /**
   * Full upstream URL INCLUDING credentials when present.
   * Safe for yt-dlp --proxy and proxy-chain; never log this raw.
   */
  fullUrl: string
  /**
   * Protocol without trailing colon: http | https | socks4 | socks5 | socks5h
   */
  protocol: string
  /**
   * Host of the upstream proxy (not the local bridge).
   */
  host: string
  /**
   * Playwright-native proxy object for HTTP(S) proxies (credentials split out).
   * For authenticated SOCKS5 this is NOT safe to pass directly — use
   * {@link preparePlaywrightProxy} instead, which bridges via a local no-auth proxy.
   */
  playwrightProxy: { server: string; username?: string; password?: string }
  /**
   * Node http(s) agent that tunnels through the upstream proxy.
   * SOCKS → SocksProxyAgent; HTTP(S) → HttpsProxyAgent.
   */
  agent: ProxyAgent
  /** Original env string. */
  raw: string
  /** Whether credentials were present on the upstream URL. */
  hasAuth: boolean
  /** True when protocol is socks4/socks5/socks5h. */
  isSocks: boolean
}

export interface PlaywrightProxyHandle {
  /**
   * Value safe to hand to Playwright / Chromium.
   * For authenticated SOCKS5 this points at a local proxy-chain bridge
   * (http://127.0.0.1:PORT) that authenticates upstream on Chromium's behalf.
   */
  playwrightProxy: { server: string; username?: string; password?: string }
  /**
   * Server URL for Chromium --proxy-server (no credentials embedded).
   */
  serverUrl: string
  /**
   * Hosts Chromium must resolve locally (so it can reach the bridge / loopback).
   * Empty when no bridge is used.
   */
  excludeHosts: string[]
  /**
   * True when a local anonymizing bridge was started for this handle.
   */
  bridged: boolean
  /**
   * When true, Chromium should force remote DNS through the proxy
   * (`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE …`).
   *
   * ONLY safe for native SOCKS. For a bridged local HTTP proxy this must be
   * false — otherwise a broken/misparsed EXCLUDE list makes Chromium map
   * 127.0.0.1 → ~NOTFOUND and every navigation dies with
   * net::ERR_PROXY_CONNECTION_FAILED before traffic ever hits the bridge.
   */
  forceProxyDns: boolean
  /**
   * Tear down any local bridge. Safe to call multiple times.
   */
  close: () => Promise<void>
}

/**
 * Build Chromium `--host-resolver-rules` value.
 * Rules MUST be comma-separated. Space-separated EXCLUDE clauses are silently
 * misparsed and the MAP rule then applies to loopback too.
 */
export function buildHostResolverRules(excludeHosts: string[]): string {
  const excludes = Array.from(
    new Set(['localhost', '127.0.0.1', '::1', ...excludeHosts].filter(Boolean))
  )
  return ['MAP * ~NOTFOUND', ...excludes.map((h) => `EXCLUDE ${h}`)].join(', ')
}

export function parseProxyUrl(raw: string): ParsedProxy | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const protocol = url.protocol.replace(':', '').toLowerCase()
    if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(protocol)) {
      console.warn(`[proxy] unsupported proxy protocol: ${protocol}`)
      return null
    }

    const host = url.hostname
    const port =
      url.port ||
      (protocol === 'http' ? '80' : protocol === 'https' ? '443' : '1080')
    const username = url.username ? decodeURIComponent(url.username) : undefined
    const password = url.password ? decodeURIComponent(url.password) : undefined
    // URL.username is empty string when absent; also treat password-only as auth.
    const hasAuth = !!(username || password)

    // Chromium --proxy-server does NOT accept embedded credentials.
    // Playwright's proxy option expects credentials split out (HTTP only —
    // authenticated SOCKS5 is unsupported by Chromium; see preparePlaywrightProxy).
    const serverUrl = `${protocol}://${host}:${port}`
    const fullUrl = hasAuth
      ? `${protocol}://${encodeURIComponent(username || '')}:${encodeURIComponent(password || '')}@${host}:${port}`
      : serverUrl

    const playwrightProxy: ParsedProxy['playwrightProxy'] = { server: serverUrl }
    if (username) playwrightProxy.username = username
    if (password) playwrightProxy.password = password

    const isSocks = protocol.startsWith('socks')
    // socks-proxy-agent only speaks SOCKS. HTTP(S) upstreams need HttpsProxyAgent
    // (works for both http: and https: target URLs when tunneling CONNECT).
    const agent: ProxyAgent = isSocks
      ? new SocksProxyAgent(fullUrl)
      : new HttpsProxyAgent(fullUrl)

    return {
      serverUrl,
      fullUrl,
      protocol,
      host,
      playwrightProxy,
      agent,
      raw,
      hasAuth,
      isSocks,
    }
  } catch (err) {
    console.warn(`[proxy] failed to parse proxy URL "${raw}":`, (err as Error).message)
    return null
  }
}

export function getProxy(): ParsedProxy | null {
  const raw =
    process.env.PLAYWRIGHT_PROXY_SERVER ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    ''
  return parseProxyUrl(raw)
}

/**
 * Prefer socks5h for the bridge upstream so destination DNS is resolved by the
 * SOCKS server (not the TubeVault container). yt-dlp still gets the original URL.
 */
function bridgeUpstreamUrl(proxy: ParsedProxy): string {
  if (!proxy.isSocks) return proxy.fullUrl
  // socks4a already implies remote DNS; socks5h is the SOCKS5 equivalent.
  if (proxy.protocol === 'socks5h' || proxy.protocol === 'socks4a') return proxy.fullUrl
  if (proxy.protocol === 'socks4') {
    // socks4a = SOCKS4 with remote DNS. Keep credentials shape via URL rebuild.
    return proxy.fullUrl.replace(/^socks4:/i, 'socks4a:')
  }
  // socks5 / socks → socks5h
  return proxy.fullUrl.replace(/^socks5?:/i, 'socks5h:')
}

/**
 * Probe the local HTTP bridge with CONNECT. Distinguishes:
 *  - bridge not listening (true ERR_PROXY_CONNECTION_FAILED precursor)
 *  - upstream SOCKS unreachable / auth failed (bridge up, chain broken)
 */
async function preflightBridgedProxy(localUrl: string, upstreamServerUrl: string): Promise<void> {
  const local = new URL(localUrl)
  const probeHost = 'example.com'
  const probePort = 443
  const timeoutMs = 12_000

  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      host: local.hostname,
      port: Number(local.port),
      method: 'CONNECT',
      path: `${probeHost}:${probePort}`,
      timeout: timeoutMs,
      headers: {
        Host: `${probeHost}:${probePort}`,
      },
    })

    const fail = (msg: string) => {
      req.destroy()
      reject(new Error(msg))
    }

    req.on('connect', (res, socket) => {
      const status = res.statusCode || 0
      socket.destroy()
      if (status >= 200 && status < 300) {
        resolve()
        return
      }
      // proxy-chain uses 59x for upstream failures (594 refused, 597 auth, 599 generic).
      const hint =
        status === 597
          ? 'upstream SOCKS authentication failed — check user/pass'
          : status === 594
            ? 'upstream SOCKS connection refused — is the proxy reachable from this container?'
            : status === 593
              ? 'DNS failed while contacting upstream SOCKS'
              : `upstream SOCKS chain failed (HTTP ${status})`
      fail(
        `Local bridge at ${localUrl} is up, but cannot reach upstream ${upstreamServerUrl}: ${hint}`
      )
    })

    req.on('timeout', () => {
      fail(
        `Timed out connecting through local bridge ${localUrl} → ${upstreamServerUrl}. ` +
          `Upstream SOCKS may be unreachable from this container (NetBird/firewall/bind address).`
      )
    })

    req.on('error', (err) => {
      fail(
        `Cannot connect to local proxy bridge ${localUrl}: ${err.message}. ` +
          `Chromium would report net::ERR_PROXY_CONNECTION_FAILED.`
      )
    })

    // Some Node versions emit response instead of connect for non-200 CONNECT.
    req.on('response', (res) => {
      const status = res.statusCode || 0
      res.resume()
      fail(
        `Local bridge at ${localUrl} rejected CONNECT with HTTP ${status} ` +
          `(upstream ${upstreamServerUrl}).`
      )
    })

    req.end()
  })
}

/**
 * Build a Playwright-safe proxy configuration.
 *
 * Chromium supports:
 *   - HTTP/HTTPS proxies WITH username/password  ✓
 *   - SOCKS5 proxies WITHOUT auth                ✓
 *   - SOCKS5 proxies WITH username/password      ✗  → "Browser does not support socks5 proxy authentication"
 *
 * For authenticated SOCKS5 we start a short-lived local HTTP proxy via
 * `proxy-chain` that authenticates to the upstream SOCKS5 on Chromium's behalf.
 * Chromium then only sees `http://127.0.0.1:<port>` (no auth).
 *
 * yt-dlp and Node agents continue to use the original authenticated URL —
 * they already support SOCKS5 auth natively.
 */
export async function preparePlaywrightProxy(
  proxy: ParsedProxy | null
): Promise<PlaywrightProxyHandle | null> {
  if (!proxy) return null

  // Authenticated SOCKS → local no-auth HTTP bridge.
  if (proxy.isSocks && proxy.hasAuth) {
    let localUrl: string | null = null
    try {
      // anonymizeProxy accepts socks5://user:pass@host:port and returns
      // http://127.0.0.1:<ephemeral> that Chromium can use without credentials.
      // Prefer socks5h so destination DNS happens on the SOCKS server.
      const upstreamForBridge = bridgeUpstreamUrl(proxy)
      localUrl = await anonymizeProxy(upstreamForBridge)
      const local = new URL(localUrl)
      console.log(
        `[proxy] SOCKS5 auth is unsupported by Chromium — bridging via local ${localUrl} → ${proxy.serverUrl}`
      )

      // Fail before Chromium launch if the chain is already broken. Otherwise
      // Playwright only surfaces the opaque net::ERR_PROXY_CONNECTION_FAILED.
      try {
        await preflightBridgedProxy(localUrl, proxy.serverUrl)
        console.log(`[proxy] bridge preflight OK (CONNECT example.com:443 via ${localUrl})`)
      } catch (preflightErr) {
        try {
          await closeAnonymizedProxy(localUrl, true)
        } catch {
          // ignore close errors during failed preflight
        }
        throw preflightErr
      }

      return {
        playwrightProxy: { server: localUrl },
        serverUrl: localUrl,
        // Kept for diagnostics / future resolver rules; forceProxyDns is false for bridges.
        excludeHosts: [local.hostname, 'localhost', '127.0.0.1', '::1'],
        bridged: true,
        // Critical: do NOT force MAP * ~NOTFOUND when Chromium's proxy is a
        // local HTTP bridge. HTTP CONNECT carries the hostname; DNS is done by
        // proxy-chain/upstream. Forcing ~NOTFOUND also risks blackholing the
        // bridge itself if EXCLUDE parsing fails.
        forceProxyDns: false,
        close: async () => {
          try {
            await closeAnonymizedProxy(localUrl!, true)
          } catch (err) {
            console.warn(
              `[proxy] failed to close anonymized proxy ${localUrl}:`,
              (err as Error).message
            )
          }
        },
      }
    } catch (err) {
      // Fail loud — silently falling back to direct SOCKS5+auth just reproduces
      // the original Chromium error and hides the real cause.
      if (localUrl) {
        try {
          await closeAnonymizedProxy(localUrl, true)
        } catch {
          // ignore
        }
      }
      throw new Error(
        `Failed to start local proxy bridge for authenticated SOCKS5 (${proxy.serverUrl}): ${(err as Error).message}`
      )
    }
  }

  // Everything else Chromium can handle natively.
  // - SOCKS without auth: pass server only; force DNS through SOCKS to avoid leaks
  // - HTTP(S) with/without auth: pass server + split credentials; no MAP* rules
  //   (HTTP proxy receives hostnames via CONNECT; MAP* would only break local resolves)
  return {
    playwrightProxy: proxy.isSocks
      ? { server: proxy.serverUrl } // never attach username/password for SOCKS
      : { ...proxy.playwrightProxy },
    serverUrl: proxy.serverUrl,
    excludeHosts: proxy.isSocks ? ['localhost', '127.0.0.1', '::1'] : [],
    bridged: false,
    forceProxyDns: proxy.isSocks,
    close: async () => {},
  }
}

/** Optional: quick TCP reachability check for the upstream host:port (no auth). */
export async function tcpReachable(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

export interface ProxyEgressProbeResult {
  ok: boolean
  /** Egress IP string when readable (ipify / plain body). */
  egressIp?: string
  /** Which probe URL succeeded. */
  via?: string
  /** Human-readable failure (proxy auth, RST, timeout, HTTP status). */
  error?: string
  /** Raw body snippet for logs. */
  bodySnippet?: string
}

/**
 * Probe real HTTPS egress through the configured upstream proxy (SOCKS or HTTP)
 * using Node's agent — same path yt-dlp / direct downloads use.
 *
 * Distinguishes:
 *  - proxy reachable + auth OK + destination accepts TLS  → ok + egress IP
 *  - proxy OK but destination RSTs / times out            → ok=false with RST hint
 *  - proxy unreachable / auth fail                        → ok=false with agent error
 *
 * SOCKS server logs like:
 *   readfrom …->66.254.114.41:443: splice: connection reset by peer
 * mean the *destination* closed the tunnel after CONNECT succeeded. That is
 * NOT Chromium bridge failure and NOT SOCKS auth failure — the exit IP is
 * being rejected by the target CDN.
 */
export async function probeProxyEgress(
  proxy: ParsedProxy,
  options: { timeoutMs?: number; urls?: string[] } = {}
): Promise<ProxyEgressProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const urls =
    options.urls ??
    [
      'https://api.ipify.org?format=json',
      'https://httpbin.org/ip',
      'https://checkip.amazonaws.com/',
    ]

  let lastError = 'no probe URLs attempted'

  for (const url of urls) {
    try {
      const result = await new Promise<ProxyEgressProbeResult>((resolve) => {
        const parsed = new URL(url)
        const requestModule = parsed.protocol === 'https:' ? https : http
        const req = requestModule.get(
          url,
          {
            agent: proxy.agent,
            timeout: timeoutMs,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
              Accept: '*/*',
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => {
              if (Buffer.concat(chunks).length < 4096) chunks.push(c)
            })
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8').trim()
              const status = res.statusCode || 0
              if (status < 200 || status >= 300) {
                resolve({
                  ok: false,
                  error: `HTTP ${status} from ${parsed.hostname} via proxy ${proxy.serverUrl}`,
                  bodySnippet: body.slice(0, 200),
                  via: url,
                })
                return
              }
              let egressIp: string | undefined
              try {
                const json = JSON.parse(body)
                egressIp = String(json.ip || json.origin || '').split(',')[0]?.trim() || undefined
              } catch {
                // plain-text IP body (checkip.amazonaws.com)
                const m = body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
                if (m) egressIp = m[0]
              }
              resolve({
                ok: true,
                egressIp,
                via: parsed.hostname,
                bodySnippet: body.slice(0, 200),
              })
            })
          }
        )
        req.on('timeout', () => {
          req.destroy()
          resolve({
            ok: false,
            error:
              `Timed out after ${timeoutMs}ms fetching ${parsed.hostname} via ${proxy.serverUrl}. ` +
              `If SOCKS logs show "connection reset by peer" to the destination IP, the exit is being RST'd by the target (not auth).`,
            via: url,
          })
        })
        req.on('error', (err) => {
          const msg = err.message || String(err)
          const rst =
            /ECONNRESET|socket hang up|read ECONNRESET|connection reset/i.test(msg)
          resolve({
            ok: false,
            error: rst
              ? `Destination closed the tunnel while fetching ${parsed.hostname} via ${proxy.serverUrl}: ${msg}. ` +
                `SOCKS auth already succeeded if the proxy logged "Connection from allowed IP". ` +
                `This is egress rejection (datacenter / ASN / geo block), not a TubeVault bridge bug.`
              : `Proxy egress error for ${parsed.hostname} via ${proxy.serverUrl}: ${msg}`,
            via: url,
          })
        })
      })

      if (result.ok) {
        console.log(
          `[proxy] Node egress probe OK via ${result.via}: ${result.egressIp || result.bodySnippet || 'ok'} (upstream ${proxy.serverUrl})`
        )
        return result
      }
      lastError = result.error || lastError
      console.warn(`[proxy] Node egress probe failed for ${result.via}: ${result.error}`)
    } catch (err) {
      lastError = (err as Error).message
      console.warn(`[proxy] Node egress probe threw: ${lastError}`)
    }
  }

  return { ok: false, error: lastError }
}

/**
 * Annotate Chromium / Playwright proxy failures with SOCKS-log context so operators
 * do not chase bridge bugs when the destination is RST'ing the exit IP.
 */
export function explainProxyNavigationError(err: unknown, proxy: ParsedProxy | null): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (!proxy) return msg
  if (!/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|net::ERR_/i.test(msg)) {
    return msg
  }
  return (
    `${msg}\n` +
    `[hint] Upstream proxy is ${proxy.serverUrl} (auth=${proxy.hasAuth}, socks=${proxy.isSocks}). ` +
    `If your SOCKS daemon logs "Connection from allowed IP" then "splice: connection reset by peer" ` +
    `to destinations like 66.254.114.41 / 208.99.84.* (PornHub / Reflected Networks CDN), ` +
    `the proxy exit is being rejected by the site — not SOCKS auth and not the local HTTP bridge. ` +
    `Try a residential exit, a different region, or the provider's HTTP endpoint. ` +
    `Node probe: check container logs for "[proxy] Node egress probe".`
  )
}
