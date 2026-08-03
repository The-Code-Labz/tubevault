# Changelog

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
