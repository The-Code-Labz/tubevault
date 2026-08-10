FROM node:22-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    # Playwright / Chromium system deps
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Deno is required by the hanime-plugin yt-dlp extractor (WASM auth handshake).
# Install system-wide so PATH is correct for non-interactive Node/yt-dlp children.
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh \
    && deno --version

# curl_cffi enables yt-dlp --impersonate (TLS fingerprint). PornHub and similar
# return HTTP 410 / bot walls to plain Python urllib; Chrome impersonation fixes that.
# hanime-plugin + pycryptodomex add HanimeTV / related extractors (not in stock yt-dlp).
RUN pip3 install --break-system-packages \
      "yt-dlp[default,curl-cffi]" \
      "hanime-plugin" \
      "pycryptodomex" \
    || pip3 install --break-system-packages yt-dlp curl_cffi hanime-plugin pycryptodomex \
    || pip3 install yt-dlp curl_cffi hanime-plugin pycryptodomex
# Ensure yt-dlp is on PATH and up-to-date at build time
RUN yt-dlp -U || true
# Log impersonation + plugin support so missing deps are obvious in build logs
RUN yt-dlp --list-impersonate-targets || true
RUN yt-dlp --list-extractors 2>/dev/null | grep -E 'HanimeTV|HentaiHaven|Hstream' || true
RUN python3 -c "import yt_dlp_plugins.extractor.htv as h; print('hanime-plugin OK', h.HanimeTVIE.__name__)"

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

RUN npm install
# Install Playwright Chromium for fallback extraction on adult/JS-heavy sites
RUN cd backend && npx playwright install chromium && npx playwright install-deps chromium || true

COPY . .

# Supabase project config (SUPABASE_URL / SUPABASE_ANON_KEY) is NOT baked in here —
# the frontend fetches it at container runtime from GET /api/config (see
# backend/src/index.ts), so no build-args/CI secrets are needed. Just set them
# in .env like every other variable.
RUN npm run build
# backend/public/.gitkeep is tracked so the dir pre-exists at COPY-time — `cp -r
# frontend/dist backend/public` would then nest into backend/public/dist/* instead
# of copying its contents directly. Clear it first so the copy lands flat.
RUN rm -rf backend/public && cp -r frontend/dist backend/public

ENV NODE_ENV=production
ENV PORT=4050
ENV DOWNLOAD_DIR=/app/data/downloads
ENV DB_PATH=/app/data/videos.json

EXPOSE 4050

VOLUME ["/app/data"]

CMD ["npm", "start"]
