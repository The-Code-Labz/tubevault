/**
 * Lightweight self-test for proxy parsing + Playwright bridge selection.
 * Run: npx tsx src/proxy.test.ts
 *
 * Does NOT require a real upstream proxy — the SOCKS5+auth path only
 * asserts that preparePlaywrightProxy returns a bridged local HTTP URL
 * (proxy-chain binds 127.0.0.1 even if upstream is unreachable until used).
 */
import assert from 'node:assert/strict'
import { parseProxyUrl, preparePlaywrightProxy } from './proxy.js'

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

async function testPrepareSocksAuthBridges() {
  const p = parseProxyUrl('socks5://alice:s3cret@127.0.0.1:1') // port 1 = unreachable upstream is fine until traffic
  assert.ok(p)
  const handle = await preparePlaywrightProxy(p)
  assert.ok(handle)
  assert.equal(handle!.bridged, true)
  assert.match(handle!.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(handle!.playwrightProxy.server, handle!.serverUrl)
  assert.equal(handle!.playwrightProxy.username, undefined)
  assert.ok(handle!.excludeHosts.includes('127.0.0.1'))
  await handle!.close()
  console.log('✓ preparePlaywrightProxy bridges socks5+auth → local http')
}

async function testPrepareSocksNoAuthNative() {
  const p = parseProxyUrl('socks5://proxy.example.com:1080')
  const handle = await preparePlaywrightProxy(p)
  assert.ok(handle)
  assert.equal(handle!.bridged, false)
  assert.equal(handle!.serverUrl, 'socks5://proxy.example.com:1080')
  assert.equal(handle!.playwrightProxy.username, undefined)
  await handle!.close()
  console.log('✓ preparePlaywrightProxy keeps socks5 no-auth native')
}

async function testPrepareHttpAuthNative() {
  const p = parseProxyUrl('http://bob:pw@proxy.example.com:8080')
  const handle = await preparePlaywrightProxy(p)
  assert.ok(handle)
  assert.equal(handle!.bridged, false)
  assert.equal(handle!.playwrightProxy.username, 'bob')
  assert.equal(handle!.playwrightProxy.password, 'pw')
  await handle!.close()
  console.log('✓ preparePlaywrightProxy keeps http+auth native')
}

async function testPrepareNull() {
  const handle = await preparePlaywrightProxy(null)
  assert.equal(handle, null)
  console.log('✓ preparePlaywrightProxy(null) → null')
}

async function main() {
  testParseSocksAuth()
  testParseSocksNoAuth()
  testParseHttpAuth()
  testParseRejectsUnknown()
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
