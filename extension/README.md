# TubeVault Cookie Sync (browser extension)

Reads cookies from your **own authenticated tab** and pushes them into your TubeVault
instance's `cookies.txt`, so YouTube logins / age-verified sessions stay fresh without
manually running Cookie-Editor and re-uploading a file every time a session expires.

This does not automate logging in or clicking through any site's own verification flow —
it only reads cookies from a session **you** already established by browsing normally,
and forwards them to a server **you** control.

## Server prerequisites

Set on the TubeVault backend (`.env`) before using the extension:

```
YTDLP_COOKIES_FILE=/app/data/cookies.txt
PLAYWRIGHT_COOKIES_FILE=/app/data/cookies.txt   # same file — one sync feeds both pipelines
ADMIN_API_KEY=<a long random secret>
```

## Install (Chrome / Edge / Brave — any Chromium browser)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** → select this `extension/` folder.
4. Click the extension's toolbar icon → **Settings** (or right-click the icon → Options).
5. Enter:
   - **TubeVault backend URL** — e.g. `https://tubevault.example.com` (no trailing slash needed)
   - **Admin API key** — the same value as the server's `ADMIN_API_KEY`
6. Save.

## Use

1. Log into the site you want (YouTube, an age-verified site, etc.) normally, in this browser.
2. Click the TubeVault Cookie Sync icon in the toolbar.
3. Click **Sync cookies for this site**.
4. It reads every cookie the browser has for the current tab's URL and POSTs it to
   `POST /api/admin/cookies` on your backend. The server merges it into `cookies.txt`,
   keyed by `(domain, name, path)` — cookies for other sites already in the file are
   left untouched.
5. The next download/download-retry on that domain picks up the new cookies immediately —
   no container restart needed (yt-dlp/Playwright both re-read the file fresh per job).

## Security notes

- The admin key you enter is stored in `chrome.storage.local` for this browser profile only,
  and is only ever sent to the backend URL you configured — nothing else.
- The endpoint is gated by the same `X-Admin-Key` used for the invite endpoint. Anyone with
  that key can overwrite the server's cookie file, so treat it like a password.
- Firefox: this manifest targets MV3 (Chrome/Edge/Brave). Firefox support would need a
  `browser_specific_settings` block and testing against `browser.cookies` — not included here.
