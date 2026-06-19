# SpoLocal

Minimal FastAPI + Tailwind web UI (Spotify-style, local) that reuses your existing `spotify_scraper.py` downloaders.

## Features
- Big search bar: Spotify URL, YouTube URL, or plain title/artist
- Create playlists manually
- Import Spotify playlist URL → creates playlist + queues all tracks
- Downloads saved into playlist-named folders under `downloads/`
- Live download queue with status
- Spotify dark theme (green accents)

## Run
```bash
cd webapp
pip install -r requirements.txt
npm install
npm run build
uvicorn main:app --reload --port 8000
```

`npm run build` runs Tailwind (`build:css`) and the local PWA bundle (`build:pwa`, Vite + vite-plugin-pwa). Use **Node.js 18+** (20+ recommended) for the PWA build.

Open http://127.0.0.1:8000

### PWA (local npm only)

- Config: `vite.config.mjs`, entry: `pwa-entry.js`, output: `static/pwa/` (ignored by git — run `npm run build:pwa` after clone).
- The app serves `static/pwa/sw.js` with a `Service-Worker-Allowed: /` header so the worker can control the whole origin while living under `/static/pwa/`.
- `npm run dev:pwa` runs Vite dev with PWA dev support (optional).

### CSS (Tailwind)

Styles are built to `static/app.css` (not the Tailwind CDN). After editing templates, rebuild:

```bash
cd webapp
npm install
npm run build:css
```

Use `npm run watch:css` during development for auto-rebuild.

Spotify playlist metadata uses public embed pages (`spotify_scraper.py` + `spotifydown_api.py`); no Spotify API keys required.

The app imports the downloader classes from the parent `spotify_scraper.py`.

### Docker (repo root)

From the **SpoLocal repo root** (parent of `webapp/`):

```bash
docker compose build
docker compose up
```

If `docker compose` is missing, update **Docker Desktop** (Compose V2 plugin) or use:

```bash
docker build -t spolocal .
docker run --rm -p 8000:8000 -v "%CD%\downloads:/app/downloads" spolocal
```

(PowerShell volume: `-v "${PWD}/downloads:/app/downloads"`.)

Open http://127.0.0.1:8000 — downloads persist in **`./downloads`** on the host.

`static/pwa/` is not in the image unless you run **`npm run build`** on the host before `docker compose build` (or add a Node build stage later). The app runs without it; PWA assets are optional.
