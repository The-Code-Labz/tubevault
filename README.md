# TubeVault

A self-hosted, universal video downloader web app. Paste almost any video URL (YouTube, RedTube, and hundreds of other sites supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp)), and TubeVault downloads, stores, and serves the video from **Supabase Storage** or **Cloudflare R2**.

## Features

- **Universal downloads** via `yt-dlp` + `ffmpeg`
- **Storage choice:** Supabase Storage or Cloudflare R2
- **Web UI** to submit URLs, track progress, stream, and delete videos
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
# Edit .env with your Supabase or R2 credentials
```

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
| `SUPABASE_URL` | If Supabase | Project URL |
| `SUPABASE_SERVICE_KEY` | If Supabase | Service role key |
| `SUPABASE_BUCKET` | No | Bucket name (default `videos`) |
| `R2_ENDPOINT` | If R2 | S3 endpoint |
| `R2_ACCESS_KEY_ID` | If R2 | Access key |
| `R2_SECRET_ACCESS_KEY` | If R2 | Secret key |
| `R2_BUCKET` | No | Bucket name (default `videos`) |
| `R2_PUBLIC_URL` | No | Public CDN base URL |
| `MAX_FILE_SIZE_BYTES` | No | Max download size (default 5GB) |
| `MAX_CONCURRENT_DOWNLOADS` | No | Parallel jobs (default 2) |
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

| Method | Route | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/videos` | List all videos |
| POST | `/api/videos` | Queue a download `{ url, backend? }` |
| GET | `/api/videos/:id` | Get video details |
| GET | `/api/videos/:id/stream` | Get public stream URL |
| DELETE | `/api/videos/:id` | Delete video + storage object |

## CORS / production

For production, run the backend and frontend from the same origin, or set `VITE_API_BASE_URL` in the frontend build and configure CORS in `backend/src/index.ts`.

## Security notes

- This tool downloads arbitrary video URLs. Run it in a private network or behind authentication.
- Set strong RLS / bucket policies on your Supabase Storage bucket.
- Keep your service keys in `.env` only — never commit them.

## License

MIT
