import { Router, type Request, type Response } from 'express'

/**
 * Human- and agent-readable API reference, generated from the actual routes in
 * index.ts/admin.ts/agent.ts. Public, no auth — the point is that a NeuroClaw-style
 * agent (or you, in a browser) can read it before ever presenting a key. Nothing
 * secret is embedded here: no key values, no Supabase URLs.
 */
export const API_DOCS_MARKDOWN = `# TubeVault API Reference

Three independent auth surfaces. Use the one that matches who's calling:

| Surface | Base path | Auth header | Who it's for |
|---|---|---|---|
| Public | \`/api/health\`, \`/api/config\` | none | health checks, frontend bootstrap |
| Video | \`/api/videos\` | \`Authorization: Bearer <supabase-jwt>\` | the signed-in web UI |
| Admin | \`/api/admin\` | \`X-Admin-Key: <ADMIN_API_KEY>\` | invites, cookie sync, yt-dlp update |
| Agent | \`/api/agent\` | \`X-Agent-Key: <AGENT_API_KEY>\` | automation / NeuroClaw-style agents |

Admin and Agent keys are separate secrets. The Agent key can only start/list/pull/
delete its own downloads — it has none of the Admin surface's invite / cookie-sync /
yt-dlp-update powers. \`/api/agent/*\` is not mounted at all unless \`AGENT_API_KEY\`
is set on the server.

---

## Public

### \`GET /api/health\`
No auth. Returns current yt-dlp version and configured storage backend.

\`\`\`json
{ "status": "ok", "storageBackend": "supabase", "ytDlp": "2026.08.19", "timestamp": "..." }
\`\`\`

### \`GET /api/config\`
No auth. Runtime Supabase client config for the web frontend (anon key only — never
the service key).

\`\`\`json
{ "supabaseUrl": "https://...supabase.co", "supabaseAnonKey": "..." }
\`\`\`

---

## Video API — \`Authorization: Bearer <supabase-jwt>\`

Every route below is scoped to the authenticated user; you only ever see/touch your
own videos.

| Method | Path | Description |
|---|---|---|
| GET | \`/api/videos\` | List your videos |
| POST | \`/api/videos\` | Queue a download. Body: \`{ "url": "...", "backend"?: "supabase" \\| "r2" }\` |
| GET | \`/api/videos/:id\` | Get one video's status/progress |
| GET | \`/api/videos/:id/stream\` | Get a short-lived signed playback URL: \`{ "url": "..." }\` |
| GET | \`/api/videos/:id/download\` | Download the finished file (server-proxied, forces \`Content-Disposition: attachment\`) |
| POST | \`/api/videos/:id/retry\` | Re-queue a \`failed\` download (409 if not eligible) |
| POST | \`/api/videos/:id/cancel\` | Cancel an active download |
| DELETE | \`/api/videos/:id\` | Delete a video + its stored file |

\`backend\` is optional on create — omit it to use the server's \`STORAGE_BACKEND\`
default. Submitted \`url\` is passed through an SSRF guard (blocks internal/
loopback/link-local hosts and non-http(s) schemes) before anything touches yt-dlp.

\`\`\`bash
curl -X POST https://your-host/api/videos \\
  -H "Authorization: Bearer $SUPABASE_JWT" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/video","backend":"r2"}'
\`\`\`

---

## Admin API — \`X-Admin-Key: <ADMIN_API_KEY>\`

Mounted at \`/api/admin\`, isolated from the Video API — never behind
\`requireAuth\`, so a bug there can't expose it.

| Method | Path | Description |
|---|---|---|
| POST | \`/invite\` | Invite-only signup. Body: \`{ "email": "..." }\` — sends a Supabase invite email |
| POST | \`/cookies\` | Merge a browser cookie export into the server's \`cookies.txt\` for yt-dlp/Playwright. Body: \`{ "cookies": [ ...chrome.cookies.getAll() entries... ] }\` (use the \`extension/\` browser extension rather than building this by hand) |
| POST | \`/update-ytdlp\` | Force a yt-dlp update now (pip-upgrade fallback; \`-U\` alone can't self-replace a pip install). Returns \`{ before, after }\` versions |

\`\`\`bash
curl -X POST https://your-host/api/admin/invite \\
  -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com"}'
\`\`\`

---

## Agent API — \`X-Agent-Key: <AGENT_API_KEY>\`

Mounted at \`/api/agent\` only when \`AGENT_API_KEY\` is set. Lets an automation
client start/poll/pull/delete downloads without a Supabase session. Downloads
created here are owned by a reserved internal id — invisible to real users, and
the Agent API never sees a human user's videos either.

| Method | Path | Description |
|---|---|---|
| POST | \`/downloads\` | Start a download. Body: \`{ "url": "...", "backend"?: "supabase" \\| "r2" }\` → 202 + video object |
| GET | \`/downloads\` | List all agent-owned downloads |
| GET | \`/downloads/:id\` | Poll one download's status/progress |
| GET | \`/downloads/:id/file\` | Stream the finished file as bytes (\`Content-Disposition: attachment\`) |
| DELETE | \`/downloads/:id\` | Delete a download + its stored file |

Same SSRF guard and storage-backend choice as the Video API.

\`\`\`bash
# Start
curl -X POST https://your-host/api/agent/downloads \\
  -H "X-Agent-Key: $AGENT_API_KEY" -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/video","backend":"supabase"}'

# Poll
curl https://your-host/api/agent/downloads/<id> -H "X-Agent-Key: $AGENT_API_KEY"

# Pull the finished file
curl -o video.mp4 https://your-host/api/agent/downloads/<id>/file -H "X-Agent-Key: $AGENT_API_KEY"
\`\`\`

---

## Video object shape

\`\`\`json
{
  "id": "uuid",
  "userId": "uuid | \\"__agent__\\"",
  "url": "string",
  "title": "string | null",
  "thumbnailUrl": "string | null",
  "duration": "number | null (seconds)",
  "storageBackend": "supabase | r2",
  "storageKey": "string | null",
  "status": "queued | downloading | processing | uploading | complete | failed",
  "progress": "number (0-100)",
  "error": "string | null",
  "fileSize": "number | null (bytes)",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
\`\`\`
`

export const docsRouter = Router()

docsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ markdown: API_DOCS_MARKDOWN })
})

// Raw markdown for curl/agents that just want the text, no JSON envelope.
docsRouter.get('/raw', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.send(API_DOCS_MARKDOWN)
})
