# Changelog

## Unreleased

### Fixed
- **hanime.tv still 403 after SOCKS bypass:** when the container's direct egress is also Cloudflare-blocked (logs show bypass active, then `HTTP Error 403`), TubeVault now (1) skips `YTDLP_COOKIES_FILE` for hanime-family by default (`HANIME_USE_COOKIES=false`) - multi-site cookies are unnecessary for the WASM handshake and can poison CF, (2) supports a dedicated `HANIME_PROXY_SERVER` for hanime-only exits, (3) preflights `https://hanime.tv` before yt-dlp and annotates 403s with the egress fix. Playwright remains disabled for hanime-family.
- **hanime.tv HTTP 403 via SOCKS:** Cloudflare on hanime routinely 403s the same SOCKS exit that works for PornHub. Reproduced: direct egress lists 360p/480p/720p; identical URL through `PLAYWRIGHT_PROXY_SERVER` → `HTTP Error 403`. Hanime-family now **skips the global proxy by default** (`HANIME_BYPASS_PROXY=true`). Playwright fallback is also disabled for hanime-family (browser only harvests Turnstile challenge URLs and cannot run the Deno/WASM handshake). Challenge hosts are excluded from media-candidate scoring.

### Added
- **hanime.tv support:** Docker image installs Deno + `hanime-plugin` + `pycryptodomex`. yt-dlp gains the `HanimeTV` extractor (WASM handshake via Deno). TubeVault auto-uses `--downloader ffmpeg` for hanime-family AES-HLS (avoids "Data must be padded to 16 byte boundary"), skips `--impersonate` on those hosts so a missing curl_cffi target cannot abort the plugin path, and sends `Referer: https://hanime.tv/`. Also covers related plugin hosts (hentaihaven, hstream.moe, oppai.stream, ohentai, hentaimama, hanime.red). Free tiers top out at 720p — premium 1080p is out of scope.
- **hanime 720p preference:** default format selector for hanime-family is `720p/best/480p/360p/...` (plugin format IDs have no height/tbr). Override with `YTDLP_FORMAT=720p` (or `480p` / `360p`).
- **`HANIME_BYPASS_PROXY`:** default `true` — hanime-family yt-dlp runs without `PLAYWRIGHT_PROXY_SERVER`. Set `false` only if your SOCKS exit is known-good for Cloudflare/hanime.

## Unreleased

### Fixed
- **PornHub HTTP 410 / missing impersonation:** image now installs `curl_cffi`; yt-dlp defaults to `--impersonate chrome` (`YTDLP_IMPERSONATE`, empty to disable). Without TLS fingerprinting, PornHub returns 410 even when the SOCKS path works.
- **SOCKS egress diagnostics:** Node probes HTTPS through the upstream proxy before Chromium launch. SOCKS logs showing `Connection from allowed IP` then `splice: connection reset by peer` to `66.254.114.41` / `208.99.84.*` (PornHub / Reflected Networks) mean the **exit IP is RST'd by the CDN** — not SOCKS auth and not the local HTTP bridge. Playwright errors are annotated with this hint.
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
