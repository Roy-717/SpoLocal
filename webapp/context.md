# SpoLocal Webapp Context

## Overview

SpoLocal is a local Spotify downloader web app. Users search/download tracks by Spotify URL, YouTube URL, or plain title/artist. It imports Spotify playlists, creates manual playlists, and saves downloads into playlist-named folders. Right-click a track -> **Save to computer**; right-click a playlist -> **Save to computer (ZIP)** to export files to the browser downloads folder.

**Tech stack**: FastAPI + Tailwind CSS (JIT) + vanilla JS modules. SpotDL alternative. No external API keys needed.

## Backend architecture

`main.py` is a thin router (routes only). Heavy work lives in service classes:

- `youtube_stream.py` - `YouTubeStreamingService` (+ `YoutubeStreamProxy`, `YoutubeCdnAudio`, `YoutubeThumbQuality`): yt-dlp extraction, short-lived googlevideo URL caching, CDN proxy with HTTP Range, MSE stream prep, thumbnails.
- `media_server.py` - `MediaServer`: serves local `/media/...` files with Range support, plus `prepare()` (ext/size/duration for sliced playback) and `probe_duration_seconds()` (ffprobe). `sliced=True` (data-saver) caps each response to a small byte slice.
- `lyrics_service.py` - `LyricsService`: read sidecar/embedded lyrics, save plain + LRC, remote LRCLIB fetch.
- `export_service.py` - `ExportService`: single-file and playlist ZIP exports.
- `download_service.py` - `DownloadService`: the library + download aggregate. Owns playlists/tracks, persistence, hydration cache, download queue/workers, imports, likes. Composes `LyricsService` (`self.lyrics`).
- `loudness_analysis.py` - LUFS analysis for playback normalization.

## Project structure

```
webapp/
├── main.py                  # FastAPI app, routes, API endpoints (thin router)
├── youtube_stream.py        # YouTubeStreamingService: CDN proxy, preview/video payloads, thumbnails
├── media_server.py          # MediaServer: local /media range serving (+ data-saver slicing)
├── lyrics_service.py        # LyricsService: read/save/remote-fetch lyrics
├── export_service.py        # ExportService: single-file and ZIP exports
├── download_service.py      # DownloadService: library + downloads (queue/workers/hydration/persistence)
├── loudness_analysis.py     # Loudness analysis for playback normalization
├── audio_quality.py         # yt-dlp audio/video command + quality helpers
├── cover_image.py           # Square JPEG thumbnail normalization
├── tag_metadata.py          # Embedded tag/cover/lyrics read + write
├── lyrics_files.py          # Sidecar lyrics read/write helpers
├── lyrics_fetch.py          # LRCLIB fetch
├── lyrics_text.py           # Lyrics text helpers
├── models.py                # Track / Playlist dataclasses
├── requirements.txt
├── templates/
│   ├── index.html           # Main page: sidebar, search panel, player bar, lyrics panel, modals
│   └── partials/
│       ├── playlist_main.html # Playlist header (cover, title) + track table + recommendations
│       └── playlist_art_grid.html # 2x2 cover grid renderer
├── static/
│   ├── app.css              # Compiled Tailwind output
│   ├── css/PlaylistPlayer.css # Custom player CSS (sliders, grid, sidebar drawers, vignettes)
│   ├── js/
│   │   ├── PlaylistSession.mjs  # Entry point
│   │   ├── app_shell.js         # AppShellController: global UI (search, preview, recommendations, popover)
│   │   ├── audio_quality_prefs.js      # Playback/download tiers (Data Saver 64 / Highest 192)
│   │   ├── audio_normalization_prefs.js # Loudness-normalization toggle
│   │   ├── playlist/
│   │   │   ├── session.js            # PlaylistSessionController: wires all sub-controllers
│   │   │   └── home_view_controller.js
│   │   ├── player/
│   │   │   ├── transport_controller.js       # PlaylistTransportController: core playback/seek/next/prev
│   │   │   ├── playback_quality_controller.js # PlaybackQualityController: quality variants, downloads, loudness
│   │   │   ├── like_controller.js            # PlaylistLikeController
│   │   │   ├── shuffle_controller.js         # PlaylistShuffleController
│   │   │   ├── media_session_controller.js   # PlaylistMediaSessionController
│   │   │   ├── queue_controller.js           # PlaylistQueueController
│   │   │   ├── lyrics_controller.js          # PlaylistLyricsController: fetch/render/sync/toggle
│   │   │   ├── lyrics_editor.js              # LyricsEditorController: LRC editor
│   │   │   ├── lyrics_visualizer.js          # LyricsVisualizerController: milkdrop/paper/wave
│   │   │   ├── lyrics_colors.js              # LyricsColorExtractor: pure palette math
│   │   │   ├── lyrics_wave_field.js / lyrics_milkdrop.js / lyrics_paper_shaders.js
│   │   │   ├── mse_stream_controller.js      # Sliced MediaSource loader for /api/stream and local /media WebM
│   │   │   ├── audio_normalization_controller.js # Web Audio gain node for loudness
│   │   │   ├── song_mix_controller.js        # Song mix SPA
│   │   │   └── player_state.js               # Shared state hub
│   │   ├── services/download_controller.js
│   │   ├── ui/                               # column_resizer, settings, context_menu, edit_modal, track_info, track_edit
│   │   └── vendor/paper-shaders/             # WebGL visualizer shaders (vendored)
│   └── pwa/                  # PWA build output (ignored by git)
└── context.md                # This file
```

## Playback and quality

Two playback tiers (`audio_quality_prefs.js`): **Data Saver** (64 kbps) and **Highest** (192 kbps). `formatLabel()` maps them.

Download formats differ by tier (`audio_quality.py`):
- **Data Saver** keeps YouTube's WebM/Opus container (`bestaudio[ext=webm]...`, no remux). WebM/Opus is decodable by Media Source Extensions, Ogg/Opus is not.
- **Highest** remuxes to Ogg Opus (`FFmpegExtractAudio`, stream copy).

Source resolution (`resolvePlaybackPlaySrc`): a local `/media/...` variant if present for the tier, else the YouTube `/api/stream?vid=...` fallback. `streamFitsTier()` says the stream (~130 kbps) only stands in for Highest; Data Saver waits for the real file.

Sliced loading:
- **Streams** (`/api/stream`) and **Data Saver local WebM** go through `MseStreamController`: it fetches explicit byte ranges and keeps ~10 s ahead of the playhead. For local files `play_media()` calls `/api/media/prepare` (ext/size/duration: mutagen first, ffprobe for WebM) and then ranges over `/media/...`. If MSE is unsupported, size/duration is unknown, or the file is not WebM, it falls back to native playback.
- **Native local playback** (Highest, and the Data Saver fallback): in Data Saver the client appends `?sliced=1` and `MediaServer` caps each response to `DATA_SAVER_SLICE_BYTES` (512 KB). Native `<audio>` still chooses its own buffering, so this cap is best-effort; the MSE path is what truly slices.

## Key UI components

### Player bar (`#player-bar`)
Fixed at the bottom of the screen. Three sections:
- **pb-meta** (left): Cover art, track title/artist, **like button** (mobile), **lyrics button** (mobile), **queue button** (mobile)
- **pb-mid** (center): Seek slider (time, range input, duration), transport controls (shuffle, prev, play/pause, next, repeat, like button on desktop only)
- **pb-vol** (right, desktop only): Lyrics button, queue button, volume icon, volume slider

**Mobile** (< 1024px): Single column layout, black background, volume section hidden. Lyrics and queue buttons are in pb-meta next to the like button. No volume controls.

**Desktop** (>= 1024px): Three-column grid, background `#181818`, volume controls visible.

The seek slider has a custom class `.player-seek-row` that overrides `max-w-2xl mx-auto` on mobile to be full-width.

### Search panel (`#global-search-panel`)
Overlay panel triggered by top search bar. Full-width, scrollable grid of YouTube hit cards.
- Cards have `max-w-[220px] mx-auto` with responsive grid columns (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`)
- Play button always visible on mobile (`max-lg:opacity-100`), hover-reveal on desktop
- "Add to playlist" button on each card
- Preview (~30s audio) via `playPreview()` function
- Pagination: 6 hits per page

### Lyrics panel (`#lyrics-panel`)
Fixed overlay that opens above the player bar.
- **Positioning**: JS dynamically sets `bottom` to match `playerBar.offsetHeight` when opened
- **Background color**: Dynamically extracted from cover art dominant color, with min brightness of 40 for dark covers
- **Vignettes**: Top and bottom fade-to-bg using `var(--lyrics-bg-color)` via `::before`/`::after`
- **LRC editor**: Edit mode with per-line timestamps. Insert gaps between lines are full-width clickable, shown on hover with a `+` indicator via `::after`.
- **Mode switch**: Read/Edit tabs

### Sidebars
- **Playlists** (`#sidebar-playlists`): Docked on desktop (20rem), slide-over on mobile
- **Downloads** (`#sidebar-downloads`): Right slide-over
- **Queue** (`#sidebar-queue`): Right slide-over, follows same drawer pattern

## CSS

**PlaylistPlayer.css**: Custom CSS (~700 lines). Key sections:
- Slider styling (`#player-seek`, `#player-volume`) - custom webkit/moz thumb/track
- Player bar grid - responsive with 1024px breakpoint
- Sidebar drawers - slide-over sheets with backdrop
- Lyrics panel - overflow hidden + vignettes + LRC editor styles
- Track row styling - play overlay on hover

**Tailwind** is compiled JIT. After editing templates, run `npm run build:css`. Use `npm run watch:css` during dev.

## JS architecture

`PlaylistSession.mjs` -> `PlaylistSessionController` (session.js) -> initializes sub-controllers:
1. `PlaylistTransportController` - core playback (play/pause/seek/next/prev, streaming)
2. `PlaybackQualityController` - quality variants / downloads / loudness (via `transport.quality`)
3. `PlaylistLikeController` - like state + buttons (via `transport.likes`)
4. `PlaylistShuffleController` - shuffle/repeat (via `transport.shuffle`)
5. `PlaylistMediaSessionController` - Media Session API + progress (via `transport.mediaSession`)
6. `PlaylistQueueController` - queue management
7. `PlaylistLyricsController` - lyrics fetch/render/toggle (delegates to editor/visualizer/colors)
8. `PlaylistColumnResizer` - table column resize

Global non-playlist UI (search, preview, recommendations) lives in `app_shell.js` as the `AppShellController` class (classic script, booted via `window.AppShell.boot()`).

## Key rules
- Always ask before implementing
- Be critical of the approach
- Minimal, simple, robust, human-readable code
- snake_case for functions/variables, camelCase for classes/methods
- OOP: use classes
- Short, accurate responses
