import http from 'node:http'
import https from 'node:https'
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
   * Tear down any local bridge. Safe to call multiple times.
   */
  close: () => Promise<void>
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
    const hasAuth = !!username

    // Chromium --proxy-server does NOT accept embedded credentials.
    // Playwright's proxy option expects credentials split out (HTTP only —
    // authenticated SOCKS5 is unsupported by Chromium; see preparePlaywrightProxy).
    const serverUrl = `${protocol}://${host}:${port}`
    const fullUrl = hasAuth
      ? `${protocol}://${encodeURIComponent(username!)}:${encodeURIComponent(password || '')}@${host}:${port}`
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
    try {
      // anonymizeProxy accepts socks5://user:pass@host:port and returns
      // http://127.0.0.1:<ephemeral> that Chromium can use without credentials.
      const localUrl = await anonymizeProxy(proxy.fullUrl)
      const local = new URL(localUrl)
      console.log(
        `[proxy] SOCKS5 auth is unsupported by Chromium — bridging via local ${localUrl} → ${proxy.serverUrl}`
      )
      return {
        playwrightProxy: { server: localUrl },
        serverUrl: localUrl,
        excludeHosts: [local.hostname, 'localhost', '127.0.0.1', '::1'],
        bridged: true,
        close: async () => {
          try {
            await closeAnonymizedProxy(localUrl, true)
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
      throw new Error(
        `Failed to start local proxy bridge for authenticated SOCKS5 (${proxy.serverUrl}): ${(err as Error).message}`
      )
    }
  }

  // Everything else Chromium can handle natively.
  // - SOCKS without auth: pass server only
  // - HTTP(S) with/without auth: pass server + split credentials
  return {
    playwrightProxy: proxy.isSocks
      ? { server: proxy.serverUrl } // never attach username/password for SOCKS
      : { ...proxy.playwrightProxy },
    serverUrl: proxy.serverUrl,
    excludeHosts: [],
    bridged: false,
    close: async () => {},
  }
}
