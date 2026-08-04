import { SocksProxyAgent } from 'socks-proxy-agent'

export interface ParsedProxy {
  /** URL form used by Chromium CLI and simple consumers, WITHOUT credentials. */
  serverUrl: string
  /** Playwright proxy object (credentials split out). */
  playwrightProxy: { server: string; username?: string; password?: string }
  /** SOCKS agent for Node fetch/HTTP clients. */
  agent: SocksProxyAgent
  /** Original string. */
  raw: string
  /** Whether credentials were present. */
  hasAuth: boolean
}

export function parseProxyUrl(raw: string): ParsedProxy | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const protocol = url.protocol.replace(':', '')
    if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(protocol)) {
      console.warn(`[proxy] unsupported proxy protocol: ${protocol}`)
      return null
    }

    const host = url.hostname
    const port = url.port || (protocol === 'http' ? '80' : protocol === 'https' ? '443' : '1080')
    const username = url.username ? decodeURIComponent(url.username) : undefined
    const password = url.password ? decodeURIComponent(url.password) : undefined

    // Chromium's --proxy-server flag does NOT accept embedded credentials.
    // Playwright's proxy option expects credentials split out.
    const serverUrl = `${protocol}://${host}:${port}`
    const playwrightProxy: ParsedProxy['playwrightProxy'] = { server: serverUrl }
    if (username) playwrightProxy.username = username
    if (password) playwrightProxy.password = password

    // Node fetch agent needs the full URL with credentials.
    const agentUrl = username ? `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@${host}:${port}` : serverUrl
    const agent = new SocksProxyAgent(agentUrl)

    return {
      serverUrl,
      playwrightProxy,
      agent,
      raw,
      hasAuth: !!username,
    }
  } catch (err) {
    console.warn(`[proxy] failed to parse proxy URL "${raw}":`, (err as Error).message)
    return null
  }
}

export function getProxy(): ParsedProxy | null {
  const raw = process.env.PLAYWRIGHT_PROXY_SERVER || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || ''
  return parseProxyUrl(raw)
}
