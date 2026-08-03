import { lookup } from 'node:dns/promises'
import net from 'node:net'

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal'])

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127) return true // loopback
    if (a === 10) return true // RFC1918 private
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918 private
    if (a === 192 && b === 168) return true // RFC1918 private
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 0) return true // "this" network
    return false
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true // loopback / unspecified
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true // fe80::/10 link-local
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 unique local
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 address — check the embedded IPv4 range too
      return isBlockedIp(lower.slice('::ffff:'.length))
    }
    return false
  }

  return true // couldn't classify — fail closed
}

/**
 * Best-effort SSRF guard for user-supplied download URLs. Rejects
 * non-http(s) schemes and hosts that resolve to loopback/private/
 * link-local/metadata address space before handing the URL to yt-dlp.
 *
 * Note: this resolves DNS once at validation time; it does not fully
 * eliminate DNS-rebinding TOCTOU risk (yt-dlp resolves again when it
 * actually fetches). It is a defense-in-depth layer, not a sandbox.
 */
export async function assertSafeDownloadUrl(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL host is not allowed')
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('URL resolves to a private or restricted address')
    }
    return
  }

  let records: { address: string }[]
  try {
    records = await lookup(hostname, { all: true })
  } catch {
    throw new Error('Failed to resolve URL host')
  }

  if (records.length === 0) {
    throw new Error('URL host does not resolve')
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error('URL resolves to a private or restricted address')
    }
  }
}
