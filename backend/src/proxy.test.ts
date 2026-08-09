/**
 * Lightweight self-test for proxy parsing + Playwright bridge selection.
 * Run: npx tsx src/proxy.test.ts
 *
 * Does NOT require a real upstream proxy — the SOCKS5+auth path only
 * asserts bridge shape / host-resolver-rules. Preflight is skipped when
 * upstream is unreachable by catching preparePlaywrightProxy errors that
 * mention the bridge (still validates anonymizeProxy start path via unit
 * of buildHostResolverRules + parse).
 */
import assert from 'node:assert/strict'
import {
  buildHostResolverRules,
  explainProxyNavigationError,
  parseProxyUrl,
  preparePlaywrightProxy,
} from './proxy.js'

function testParseSocksAuth() {
  const p = parseProxyUrl('socks5://alice:s3cret@proxy.example.com:1080')
  assert.ok(p)
  assert.equal(p!.protocol, 'socks5')
  assert.equal(p!.isSocks, true)
  assert.equal(p!.hasAuth, true)
  assert.equal(p!.serverUrl, 'socks5://proxy.example.com:1080')
  assert.equal(p!.playwrightProxy.server, 'socks5://proxy.example.com:1080')
  assert.equal(p!.playwrightProxy.username, 'alice')
  assert.equal(p!.playwrightProxy.password, 's3cret')
  assert.match(p!.fullUrl, /^socks5:\/\/alice:s3cret@proxy\.example\.com:1080$/)
  console.log('✓ parse socks5+auth')
}

function testParseSocksNoAuth() {
  const p = parseProxyUrl('socks5://proxy.example.com:1080')
  assert.ok(p)
  assert.equal(p!.hasAuth, false)
  assert.equal(p!.isSocks, true)
  assert.equal(p!.playwrightProxy.username, undefined)
  console.log('✓ parse socks5 no-auth')
}

function testParseHttpAuth() {
  const p = parseProxyUrl('http://bob:pw@proxy.example.com:8080')
  assert.ok(p)
  assert.equal(p!.isSocks, false)
  assert.equal(p!.hasAuth, true)
  assert.equal(p!.serverUrl, 'http://proxy.example.com:8080')
  assert.equal(p!.playwrightProxy.username, 'bob')
  console.log('✓ parse http+auth')
}

function testParseRejectsUnknown() {
  const p = parseProxyUrl('ftp://x:y@h:21')
  assert.equal(p, null)
  console.log('✓ reject unsupported protocol')
}

function testHostResolverRulesCommaSeparated() {
  const rules = buildHostResolverRules(['127.0.0.1', 'localhost'])
  // Chromium requires comma-separated rules. Space-only EXCLUDE lists are
  // misparsed and MAP * ~NOTFOUND then blackholes loopback.
  assert.match(rules, /^MAP \* ~NOTFOUND/)
  assert.ok(rules.includes(', EXCLUDE 127.0.0.1'))
  assert.ok(rules.includes(', EXCLUDE localhost'))
  assert.ok(rules.includes(', EXCLUDE ::1'))
  // No bare space-joined EXCLUDE chain without commas.
  assert.equal(rules.includes('EXCLUDE 127.0.0.1 EXCLUDE'), false)
  console.log('✓ host-resolver-rules are comma-separated:', rules)
}

async function testPrepareSocksAuthBridges() {
  // Use an unreachable upstream. preparePlaywrightProxy now preflights CONNECT,
  // so a dead upstream should throw a clear bridge/upstream error — NOT the
  // Chromium socks5-auth error, and NOT succeed silently.
  const p = parseProxyUrl('socks5://alice:s3cret@127.0.0.1:1')
  assert.ok(p)
  let threw = false
  try {
    const handle = await preparePlaywrightProxy(p)
    // If somehow preflight passed (shouldn't on port 1), still validate shape.
    assert.ok(handle)
    assert.equal(handle!.bridged, true)
    assert.equal(handle!.forceProxyDns, false) // critical: no MAP* on bridge
    assert.match(handle!.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(handle!.playwrightProxy.username, undefined)
    await handle!.close()
    console.log('✓ preparePlaywrightProxy bridges socks5+auth (preflight passed unexpectedly)')
  } catch (err) {
    threw = true
    const msg = (err as Error).message
    assert.match(msg, /bridge|upstream|SOCKS|proxy/i)
    // Must not be the old Chromium-native error.
    assert.equal(/does not support socks5 proxy authentication/i.test(msg), false)
    console.log('✓ preparePlaywrightProxy socks5+auth fails preflight loudly:', msg.slice(0, 160))
  }
  assert.equal(threw, true)
}

async function testPrepareSocksNoAuthNative() {
  const p = parseProxyUrl('socks5://proxy.example.com:1080')
  const handle = await preparePlaywrightProxy(p)
  assert.ok(handle)
  assert.equal(handle!.bridged, false)
  assert.equal(handle!.forceProxyDns, true) // native SOCKS forces remote DNS
  assert.equal(handle!.serverUrl, 'socks5://proxy.example.com:1080')
  assert.equal(handle!.playwrightProxy.username, undefined)
  await handle!.close()
  console.log('✓ preparePlaywrightProxy keeps socks5 no-auth native + forceProxyDns')
}

async function testPrepareHttpAuthNative() {
  const p = parseProxyUrl('http://bob:pw@proxy.example.com:8080')
  const handle = await preparePlaywrightProxy(p)
  assert.ok(handle)
  assert.equal(handle!.bridged, false)
  assert.equal(handle!.forceProxyDns, false) // HTTP never uses MAP*
  assert.equal(handle!.playwrightProxy.username, 'bob')
  assert.equal(handle!.playwrightProxy.password, 'pw')
  await handle!.close()
  console.log('✓ preparePlaywrightProxy keeps http+auth native, no forceProxyDns')
}

async function testPrepareNull() {
  const handle = await preparePlaywrightProxy(null)
  assert.equal(handle, null)
  console.log('✓ preparePlaywrightProxy(null) → null')
}

function testExplainProxyNavigationError() {
  const p = parseProxyUrl('socks5://alice:s3cret@100.89.46.32:1080')
  assert.ok(p)
  const raw = 'page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://www.pornhub.com/'
  const annotated = explainProxyNavigationError(new Error(raw), p)
  assert.match(annotated, /ERR_PROXY_CONNECTION_FAILED/)
  assert.match(annotated, /66\.254\.114\.41|Reflected|residential|egress/i)
  assert.match(annotated, /100\.89\.46\.32/)
  // Non-proxy errors stay untouched.
  assert.equal(explainProxyNavigationError(new Error('boom'), p), 'boom')
  console.log('✓ explainProxyNavigationError annotates Chromium proxy failures')
}

async function main() {
  testParseSocksAuth()
  testParseSocksNoAuth()
  testParseHttpAuth()
  testParseRejectsUnknown()
  testHostResolverRulesCommaSeparated()
  testExplainProxyNavigationError()
  await testPrepareSocksAuthBridges()
  await testPrepareSocksNoAuthNative()
  await testPrepareHttpAuthNative()
  await testPrepareNull()
  console.log('\nAll proxy tests passed.')
}

main().catch((err) => {
  console.error('TEST FAILED:', err)
  process.exit(1)
})
