FROM node:22-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages yt-dlp || pip3 install yt-dlp
# Ensure yt-dlp is on PATH and up-to-date at build time
RUN yt-dlp -U || true

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

RUN npm install

COPY . .

# Supabase project config (SUPABASE_URL / SUPABASE_ANON_KEY) is NOT baked in here —
# the frontend fetches it at container runtime from GET /api/config (see
# backend/src/index.ts), so no build-args/CI secrets are needed. Just set them
# in .env like every other variable.
RUN npm run build
RUN cp -r frontend/dist backend/public

ENV NODE_ENV=production
ENV PORT=4050
ENV DOWNLOAD_DIR=/app/data/downloads
ENV DB_PATH=/app/data/videos.json

EXPOSE 4050

VOLUME ["/app/data"]

CMD ["npm", "start"]
