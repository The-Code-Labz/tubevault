# Changelog

## Unreleased

### Fixed
- **Playwright + authenticated SOCKS5:** Chromium rejects `socks5://user:pass@…` with `Browser does not support socks5 proxy authentication`. TubeVault now auto-bridges authenticated SOCKS5 through a local no-auth HTTP proxy (`proxy-chain`) for Playwright only. yt-dlp and Node direct downloads still use the original SOCKS5 URL with credentials.
- **Bridged SOCKS5 `net::ERR_PROXY_CONNECTION_FAILED`:** the bridge path no longer applies Chromium `--host-resolver-rules=MAP * ~NOTFOUND` (that was intended for native SOCKS only). A space-joined `EXCLUDE` list was also invalid — Chromium requires comma-separated rules — which could blackhole `127.0.0.1` and make every page load fail before traffic hit the bridge. Bridged upstream now uses `socks5h` for remote DNS, and CONNECT is preflighted so upstream/auth failures surface clearly instead of as opaque proxy errors.
- Direct downloads through an **HTTP(S)** upstream proxy no longer incorrectly construct a `SocksProxyAgent` (now uses `HttpsProxyAgent`).

## Unreleased

### Changed
- Playwright fallback is no longer limited to adult-site hostnames. Empty `PLAYWRIGHT_FALLBACK_SITES` (default) means: **after yt-dlp fails, try the browser on any host**.
- Default `PLAYWRIGHT_TIMEOUT_MS` raised to `60000` for slower JS embed players.

### Added
- fmoviess.org / fmovies-style embed player support: click Play, walk Server controls, harvest HLS from player iframes (netoda/JWPlayer), pass player Referer/Origin when downloading.
- Lightweight ad/tracker request blocking during Playwright extraction to reduce player stalls.
- Media candidates can carry preferred `referer`/`origin` from the intercepted request.

## Unreleased

### Security

- **Fixed:** Supabase Storage bucket was created with `public: true`, and video URLs
  were served via `getPublicUrl()` — a permanent, unsigned URL. Anyone who obtained or
  guessed a stored object key could stream/download the raw video directly, bypassing
  `requireAuth` and the per-user ownership check on `/api/videos*`.
  - The bucket is now created with `public: false`.
  - `GET /api/videos/:id/stream` now returns a short-lived **signed URL**
    (`createSignedUrl`, default TTL 1 hour, configurable via
    `SUPABASE_SIGNED_URL_TTL_SECONDS`), minted fresh on every authenticated,
    ownership-checked request. Nothing is cached or stored server-side.
  - **Existing deployments:** on startup, if `SUPABASE_BUCKET` already exists as a
    public bucket, the backend automatically flips it to private via
    `supabase.storage.updateBucket()`. This is supported by the Supabase JS client
    (contrary to some older docs implying a dashboard-only toggle) and requires no
    manual action. It stops new unsigned access immediately but does **not**
    retroactively revoke URLs that were already shared/cached/crawled before the
    flip — if any object keys may have leaked while the bucket was public, re-upload
    those videos under a new storage key (or delete + re-download) to fully rotate
    them. See the README's "Storage bucket" section for details.
  - Cloudflare R2 storage (`STORAGE_BACKEND=r2`) is unaffected — it's still served via
    a plain public/CDN URL by design, matching how R2 is normally fronted. That's
    outside this fix's scope; see the README's Security notes if that's not
    acceptable for your R2 bucket's contents.
