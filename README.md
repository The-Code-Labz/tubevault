# TubeVault

A self-hosted, universal video downloader web app. Paste almost any video URL (YouTube, RedTube, and hundreds of other sites supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp)), and TubeVault downloads, stores, and serves the video from **Supabase Storage** or **Cloudflare R2**.

## Features

- **Invite-only authentication** via Supabase Auth — every API route (except `/api/health`) requires a signed-in user, self-signup is disabled, and each user only sees/manages their own videos
- **Universal downloads** via `yt-dlp` + `ffmpeg`
- **Storage choice:** Supabase Storage or Cloudflare R2
- **Web UI** to sign in, submit URLs, track progress, stream, and delete videos
- **Real-time progress** polling (queued → downloading → uploading → complete/failed)
- **Docker + Docker Compose** ready
- **Systemd** service file included
- **No database required** — lightweight JSON file store

## Supported sites

Anything yt-dlp supports: YouTube, RedTube, Vimeo, Twitter/X, TikTok, Twitch, and 1000+ more.

## Quick start

### 1. Clone

```bash
git clone https://github.com/The-Code-Labz/tubevault.git
cd tubevault
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Supabase project URL/keys and (optionally) R2 credentials
```

Authentication is required and backed by [Supabase Auth](https://supabase.com/docs/guides/auth). In your Supabase project:

1. Enable the **Email** auth provider (Authentication → Providers).
2. Copy the **Project URL** and **anon public key** into `SUPABASE_URL` / `SUPABASE_ANON_KEY`.
3. Copy the **service_role key** into `SUPABASE_SERVICE_KEY` (backend-only — never expose this client-side).

All three are read at container **runtime** — the frontend fetches `SUPABASE_URL`/`SUPABASE_ANON_KEY` from the backend on load (`GET /api/config`), so nothing is baked into the image at build time. Just edit `.env` and restart the container to change or rotate them; no rebuild required.

### Invite-only setup

This vault has no public self-signup. There are two parts to that, and only one of them is the actual enforcement boundary:

1. **The real boundary — disable signup in Supabase itself.** In your Supabase dashboard: **Authentication → Providers → Email**, turn **off** "Allow new users to sign up". This is required. The frontend no longer has a sign-up form and the backend's own routes don't create users, but the `SUPABASE_ANON_KEY` is a public browser key by design — anyone with it can call Supabase's own `/auth/v1/signup` REST endpoint directly, bypassing TubeVault entirely, unless this dashboard toggle is off. The app-level changes below are defense-in-depth/UX, not a substitute for this.
2. **Set `ADMIN_API_KEY`** in `.env` to a long random value (e.g. `openssl rand -hex 32`). The server refuses to start without it.
3. **Invite a user** by calling the admin endpoint (never exposed to the frontend):
   ```bash
   curl -X POST https://<host>/api/admin/invite \
     -H "X-Admin-Key: $ADMIN_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"email":"user@example.com"}'
   ```
   Supabase emails the invitee a link to set their own password; after that they sign in normally at the TubeVault URL.

**Storage bucket:** if `STORAGE_BACKEND=supabase` (the default), the backend creates `SUPABASE_BUCKET` (default `videos`) automatically on first boot, **as a private bucket**. Video files are never given a permanent public URL — `GET /api/videos/:id/stream` mints a fresh short-lived [signed URL](https://supabase.com/docs/guides/storage/serving/downloads#signed-urls) (default 1 hour TTL, override with `SUPABASE_SIGNED_URL_TTL_SECONDS`) on every authenticated, ownership-checked request instead. Nothing is cached or stored server-side.

> **Upgrading from an older TubeVault** (pre-signed-URL fix): earlier versions created this bucket with `public: true`, meaning anyone who obtained/guessed an object key could pull the video directly with no auth. On startup, the backend now detects an existing public bucket and automatically flips it to private via `updateBucket()` (yes — despite some older docs implying otherwise, the Supabase JS client **can** toggle a bucket's public/private flag after creation; no dashboard visit required). This stops new unsigned access immediately. It does **not** retroactively revoke URLs that were already shared, cached by a browser/proxy, or crawled before the flip — if you suspect any object keys leaked while the bucket was public, re-upload those videos (new storage key) or delete + redownload them.

### 3. Run with Docker (recommended)

`docker-compose.yml` builds locally from the included `Dockerfile` by default, so Chromium + Playwright deps are baked in and adult-site fallback works out of the box.

```bash
docker compose up --build -d
```

Open `http://localhost:4050`.

If you don't use Traefik, use the simpler compose file instead:

```bash
docker compose -f docker-compose.simple.yml up --build -d
```

To use a prebuilt GHCR image instead of building locally, set `TUBEVAULT_IMAGE_TAG` in `.env` and comment out the `build:` block in `docker-compose.yml`.

### 4. Or run locally

Requires Node 20+, `yt-dlp`, and `ffmpeg` installed.

```bash
npm install
npm run build
npm start
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `STORAGE_BACKEND` | Yes | `supabase` or `r2` |
| `SUPABASE_URL` | **Yes** | Project URL — backs auth verification always, and storage when `STORAGE_BACKEND=supabase` |
| `SUPABASE_SERVICE_KEY` | **Yes** | Service role key (backend-only, never expose client-side) |
| `SUPABASE_BUCKET` | No | Bucket name (default `videos`). Created **private**; auto-migrated to private if it already exists as public |
| `SUPABASE_SIGNED_URL_TTL_SECONDS` | No | TTL for signed stream URLs handed out by `GET /api/videos/:id/stream` (default `3600` = 1 hour, min `60`) |
| `SUPABASE_ANON_KEY` | **Yes** | Public anon key — served to the frontend at runtime via `GET /api/config`, used by the browser to sign in |
| `ADMIN_API_KEY` | **Yes** | Shared secret required in the `X-Admin-Key` header for `POST /api/admin/invite`. Server refuses to boot without it. See "Invite-only setup" below |
| `R2_ENDPOINT` | If R2 | S3 endpoint |
| `R2_ACCESS_KEY_ID` | If R2 | Access key |
| `R2_SECRET_ACCESS_KEY` | If R2 | Secret key |
| `R2_BUCKET` | No | Bucket name (default `videos`) |
| `R2_PUBLIC_URL` | No | Public CDN base URL |
| `ALLOWED_ORIGIN` | No | Comma-separated list of origins allowed to call the API cross-origin. Empty = same-origin only |
| `MAX_FILE_SIZE_BYTES` | No | Max download size (default 5GB), also passed to yt-dlp's `--max-filesize` |
| `MAX_CONCURRENT_DOWNLOADS` | No | Enforced parallel-job limit (default 2) |
| `YTDLP_AUTO_UPDATE` | No | Run `yt-dlp -U` on startup (default `true`) |
| `YTDLP_FORMAT` | No | Override format selector |
| `YTDLP_USER_AGENT` | No | Set a browser user-agent |
| `YTDLP_COOKIES_FROM_BROWSER` | No | e.g. `firefox`, `chrome` |
| `YTDLP_COOKIES_FILE` | No | Path to a Netscape cookies.txt (inside container) |
| `YTDLP_REFERER` | No | Force a Referer header |
| `YTDLP_CUSTOM_ARGS` | No | Extra args passed to yt-dlp |
| `PLAYWRIGHT_FALLBACK_ENABLED` | No | Browser fallback when yt-dlp fails on adult/JS sites (default `true`) |
| `PLAYWRIGHT_FALLBACK_SITES` | No | Hostname regex for fallback (default covers major adult sites) |
| `PLAYWRIGHT_HEADLESS` | No | Run Chromium headless (default `true`) |
| `PLAYWRIGHT_TIMEOUT_MS` | No | Page load timeout (default `30000`) |
| `PLAYWRIGHT_STEALTH` | No | Use playwright-extra stealth plugin if installed |
| `PLAYWRIGHT_PROXY_SERVER` | No | Proxy for Chromium, e.g. `socks5://localhost:1080` |
| `PLAYWRIGHT_COOKIES_FILE` | No | Cookie file for Chromium — JSON array **or** Netscape cookies.txt |
| `PLAYWRIGHT_COOKIES_SAMESITE` | No | Override SameSite default (`Lax`) — try `None` for cross-site players |
| `PLAYWRIGHT_EXTRA_ARGS` | No | Extra Chromium launch flags |

## Adult sites (RedTube, PornHub, XVideos, etc.)

TubeVault has **two layers** for these sites:

1. **yt-dlp direct extraction** — fastest, works for most sites.
2. **Playwright browser fallback** — launches Chromium, intercepts the page's network traffic, grabs the actual `.m3u8` / `.mp4` / `.ts` manifest URL, and feeds it back to `yt-dlp` with proper `Referer` / `Origin` headers.

The fallback triggers automatically when yt-dlp fails on a domain matching `PLAYWRIGHT_FALLBACK_SITES`.

### Tips for adult sites

1. **Keep yt-dlp up to date.** TubeVault runs `yt-dlp -U` on startup by default. Site extractors break frequently.
2. **Cookies / age gate.** `YTDLP_COOKIES_FROM_BROWSER` doesn't apply in Docker (no browser profile inside the container). Use a cookies file instead. TubeVault accepts **both** Netscape `cookies.txt` and JSON-array cookie exports:
   ```bash
   # Drop your exported cookies at ./data/cookies.txt (or ./data/cookies.json) on the host
   # (the ./data volume is already mounted to /app/data), then set the CONTAINER path:
   YTDLP_COOKIES_FILE=/app/data/cookies.txt
   PLAYWRIGHT_COOKIES_FILE=/app/data/cookies.txt   # same file works for both
   # If the video player is cross-site, you may need:
   PLAYWRIGHT_COOKIES_SAMESITE=None
   ```
   A relative path (`./cookies.txt`) will NOT work — yt-dlp resolves it against the backend process's cwd (`/app/backend`), not your host directory, and silently downloads unauthenticated if the file isn't found there — no error, same failure as no cookies at all. The backend now logs a startup warning if the configured path doesn't exist inside the container.
3. **Cloud/VPS IP blocks.** Many adult sites block datacenter IPs. The browser fallback may still be blocked at the TCP/IP layer. Options:
   - Run TubeVault from a residential connection.
   - Route Playwright through a proxy:
     ```bash
     PLAYWRIGHT_PROXY_SERVER=socks5://user:pass@host:1080
     ```
   - Set the same proxy at the OS/container level for yt-dlp.
4. **Debug a URL quickly.** SSH into the container/server and run:
   ```bash
   yt-dlp --dump-single-json --cookies-from-browser firefox "https://..."
   # If that fails, test the fallback directly:
   npx tsx -e "(await import('./backend/src/playwrightFallback.ts')).extractMediaUrls('https://...').then(console.log)"
   ```
   Once either path works, paste the URL into TubeVault.

```
Frontend (React + Vite)  ──▶  Backend (Express + TypeScript)
                                     │
                                     ▼
                         ┌──────────────────────┐
                         │ yt-dlp direct        │
                         │ or                   │
                         │ Playwright fallback  │
                         │ (Chromium intercept) │
                         └──────────────────────┘
                                     │
                                     ▼
                         Supabase Storage  or  Cloudflare R2
```

## API

All routes below except `/api/health` require `Authorization: Bearer <supabase-access-token>`. Each user only sees and can act on their own videos.

| Method | Route | Description |
|---|---|---|
| GET | `/api/health` | Health check (public) |
| GET | `/api/videos` | List the current user's videos |
| POST | `/api/videos` | Queue a download `{ url, backend? }` |
| GET | `/api/videos/:id` | Get video details |
| GET | `/api/videos/:id/stream` | Mint a fresh short-lived signed stream URL (Supabase) or CDN URL (R2) |
| DELETE | `/api/videos/:id` | Delete video + storage object |
| POST | `/api/videos/:id/cancel` | Cancel an in-flight download |

`POST /api/admin/invite` is a separate admin-only route, gated by the `X-Admin-Key` header instead of a Supabase session — see "Invite-only setup" below.

## CORS / production

By default the API sends no CORS headers (same-origin only). If the frontend is served from a different origin than the API, set `ALLOWED_ORIGIN` (comma-separated) and `VITE_API_BASE_URL` in the frontend build.

## Security notes

- Every `/api/videos*` route requires a valid Supabase session; there is no more open/anonymous access.
- Download URLs are checked against a best-effort SSRF allowlist (blocks loopback/private/link-local/cloud-metadata address ranges) before being handed to `yt-dlp`. This resolves DNS once at validation time — it reduces but does not eliminate DNS-rebinding risk, so still run this behind network egress restrictions if downloading from untrusted URLs matters to your threat model.
- The Supabase Storage bucket is private (never `public: true`); video URLs are short-lived signed URLs minted per authenticated, ownership-checked request — never permanent/unsigned. See "Storage bucket" above for the auto-migration behavior on existing deployments.
- Keep your service keys in `.env` only — never commit them. `SUPABASE_ANON_KEY` is the one exception meant to be public (it's the browser client key, served via `GET /api/config`).
- Self-signup is disabled: the frontend has no sign-up form, and `/api/admin/invite` (gated by `ADMIN_API_KEY` via `X-Admin-Key`) is the only way to onboard a user, kept isolated from `/api/videos*`. This is still UX/defense-in-depth — the actual enforcement boundary is the "Allow new users to sign up" toggle in Supabase's dashboard (Authentication → Providers → Email); see "Invite-only setup" above.
- R2 storage is unaffected by this: R2 objects are still served via a plain CDN/public-dev URL (`R2_PUBLIC_URL` or the R2 endpoint), matching how R2 buckets are normally fronted. If that's not an acceptable threat model for your R2 bucket's contents, put access control in front of it yourself (e.g. Cloudflare Access, a signed-URL Worker) or use `STORAGE_BACKEND=supabase`.

## License

MIT
