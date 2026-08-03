# TubeVault

A self-hosted, universal video downloader web app. Paste almost any video URL (YouTube, RedTube, and hundreds of other sites supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp)), and TubeVault downloads, stores, and serves the video from **Supabase Storage** or **Cloudflare R2**.

## Features

- **Authentication** via Supabase Auth — every API route (except `/api/health`) requires a signed-in user, and each user only sees/manages their own videos
- **Universal downloads** via `yt-dlp` + `ffmpeg`
- **Storage choice:** Supabase Storage or Cloudflare R2
- **Web UI** to sign in/up, submit URLs, track progress, stream, and delete videos
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
2. Copy the **Project URL** and **anon public key** into `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
3. Copy the **service_role key** into `SUPABASE_SERVICE_KEY` (backend-only — never expose this client-side).

`VITE_*` values are baked into the frontend bundle at **build time**, not read at container runtime — `docker compose up --build` picks them up from `.env` automatically via the compose file's `build.args`.

### 3. Run with Docker (recommended)

```bash
docker compose up --build -d
```

Open `http://localhost:4050`.

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
| `SUPABASE_BUCKET` | No | Bucket name (default `videos`) |
| `VITE_SUPABASE_URL` | **Yes** | Same project URL, exposed to the frontend build |
| `VITE_SUPABASE_ANON_KEY` | **Yes** | Public anon key, used by the browser to sign in/up |
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
| `YTDLP_COOKIES_FILE` | No | Path to a Netscape cookies.txt |
| `YTDLP_REFERER` | No | Force a Referer header |
| `YTDLP_CUSTOM_ARGS` | No | Extra args passed to yt-dlp |

## Adult sites (RedTube, PornHub, XVideos, etc.)

yt-dlp supports these sites, but they often require extra handling:

1. **Keep yt-dlp up to date.** TubeVault runs `yt-dlp -U` on startup by default. Site extractors break frequently.
2. **Use a real user-agent.** Add to `.env`:
   ```bash
   YTDLP_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
   ```
3. **Pass cookies if age-gated.** Either:
   ```bash
   YTDLP_COOKIES_FROM_BROWSER=firefox
   # or
   YTDLP_COOKIES_FILE=./cookies.txt
   ```
4. **Cloud/VPS IP blocks.** Many adult sites block datacenter IPs. If downloads fail with HTTP 403 or "unable to extract", run TubeVault from a residential connection or proxy `yt-dlp` traffic.
5. **Debug a URL quickly.** SSH into the container/server and run:
   ```bash
   yt-dlp --dump-single-json --cookies-from-browser firefox "https://..."
   ```
   Once that works, paste the same URL into TubeVault.

```
Frontend (React + Vite)  ──▶  Backend (Express + TypeScript)
                                     │
                                     ▼
                              yt-dlp + ffmpeg
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
| GET | `/api/videos/:id/stream` | Get public stream URL |
| DELETE | `/api/videos/:id` | Delete video + storage object |
| POST | `/api/videos/:id/cancel` | Cancel an in-flight download |

## CORS / production

By default the API sends no CORS headers (same-origin only). If the frontend is served from a different origin than the API, set `ALLOWED_ORIGIN` (comma-separated) and `VITE_API_BASE_URL` in the frontend build.

## Security notes

- Every `/api/videos*` route requires a valid Supabase session; there is no more open/anonymous access.
- Download URLs are checked against a best-effort SSRF allowlist (blocks loopback/private/link-local/cloud-metadata address ranges) before being handed to `yt-dlp`. This resolves DNS once at validation time — it reduces but does not eliminate DNS-rebinding risk, so still run this behind network egress restrictions if downloading from untrusted URLs matters to your threat model.
- Set strong RLS / bucket policies on your Supabase Storage bucket.
- Keep your service keys in `.env` only — never commit them. `VITE_SUPABASE_ANON_KEY` is the one exception meant to be public (it's the browser client key).

## License

MIT
