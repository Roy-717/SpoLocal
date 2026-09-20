# SpoLocal Webapp Context

## Overview

SpoLocal is a local Spotify downloader web app. Users search/download tracks by Spotify URL, YouTube URL, or plain title/artist. It imports Spotify playlists, creates manual playlists, and saves downloads into playlist-named folders. Right-click a track → **Save to computer**; right-click a playlist → **Save to computer (ZIP)** to export files to the browser downloads folder.

**Tech stack**: FastAPI + Tailwind CSS (JIT) + vanilla JS modules. SpotDL alternative. No external API keys needed.

## Project structure

```
webapp/
├── main.py                  # FastAPI app, routes, API endpoints
├── requirements.txt
├── templates/
│   ├── index.html           # Main page: sidebar, search panel, player bar, lyrics panel, modals
│   └── partials/
│       ├── playlist_main.html # Playlist header (cover, title) + track table + recommendations
│       └── playlist_art_grid.html # 2×2 cover grid renderer
├── static/
│   ├── app.css              # Compiled Tailwind output
│   ├── css/PlaylistPlayer.css # Custom player CSS (sliders, grid, sidebar drawers, vignettes)
│   ├── js/
│   │   ├── PlaylistSession.mjs  # Entry point
│   │   ├── spolocal_chrome.js   # Global UI: search panel, preview, recommendations, add-to-playlist popover
│   │   ├── playlist/session.js  # Session controller: initializes all sub-controllers, wires DOM refs
│   │   ├── player/
│   │   │   ├── lyrics_controller.js  # Lyrics: fetch, render, LRC sync, color extraction, toggle
│   │   │   ├── song_mix_controller.js # Song mix SPA: YouTube Mix streams for one track
│   │   │   ├── queue_controller.js     # Queue: add/remove/reorder/manage queue sidebar
│   │   │   └── player_state.js        # Shared state hub
│   │   └── ui/column_resizer.js  # Track table column resizer
│   └── pwa/                  # PWA build output (ignored by git)
└── context.md                # This file
```

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
- Slider styling (`#player-seek`, `#player-volume`) — custom webkit/moz thumb/track
- Player bar grid — responsive with 1024px breakpoint
- Sidebar drawers — slide-over sheets with backdrop
- Lyrics panel — overflow hidden + vignettes + LRC editor styles
- Track row styling — play overlay on hover

**Tailwind** is compiled JIT. After editing templates, run `npm run build:css`. Use `npm run watch:css` during dev.

## JS architecture

`PlaylistSession.mjs` → `PlaylistSessionController` (session.js) → initializes sub-controllers:
1. `PlaylistTransportController` — playback, seek, volume, like
2. `PlaylistQueueController` — queue management
3. `PlaylistLyricsController` — lyrics fetch/render/colors/LRC editor
4. `PlaylistColumnResizer` — table column resize

Global non-playlist UI (search, preview, recommendations) lives in `spolocal_chrome.js` — an IIFE.

## Key rules
- Always ask before implementing
- Be critical of the approach
- Minimal, simple, robust, human-readable code
- snake_case for functions/variables, camelCase for classes/methods
- OOP: use classes
- Short, accurate responses
