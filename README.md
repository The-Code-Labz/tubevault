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

## Architecture

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
