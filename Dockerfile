# SpoLocal: FastAPI app + parent-repo scrapers (spotify_scraper / spotifydown_api).
# ffmpeg: image ships /usr/bin/ffmpeg; scraper expects a fixed relative bin dir on disk.
# --- PWA bundle (service worker + registration) built here; was excluded from context before. ---
FROM node:20-alpine AS pwa_builder
WORKDIR /build
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci
COPY webapp/ ./
RUN npm run build:pwa

FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Path hardcoded in spotify_scraper._ffmpeg_bin_dir — keep in sync or refactor scraper to use PATH.
RUN mkdir -p ffmpeg-2026-05-06-git-f2e5eff3ff-essentials_build/bin \
    && ln -sf /usr/bin/ffmpeg ffmpeg-2026-05-06-git-f2e5eff3ff-essentials_build/bin/ffmpeg \
    && ln -sf /usr/bin/ffprobe ffmpeg-2026-05-06-git-f2e5eff3ff-essentials_build/bin/ffprobe

COPY spotify_scraper.py spotifydown_api.py ./
COPY webapp/ ./webapp/
COPY --from=pwa_builder /build/static/pwa ./webapp/static/pwa

WORKDIR /app/webapp
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
EXPOSE 8000

# No --reload in production: volume-mounted sources would restart mid-request and cancel covers.
CMD ["sh", "-c", "rm -rf __pycache__ && exec uvicorn main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
