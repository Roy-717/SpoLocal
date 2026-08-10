"""FastAPI app entrypoint for SpoLocal.

Registers page and API routes for search, playlists, downloads, and media serving.
Coordinates the download, metadata, and model layers to serve each request."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional
import time
import mimetypes

from dotenv import load_dotenv
import asyncio

import httpx
import yt_dlp as _yt_dlp

from fastapi import FastAPI, Request, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
from starlette.datastructures import Headers
from starlette.staticfiles import NotModifiedResponse, StaticFiles

from pydantic import BaseModel, Field

from download_service import DownloadService, youtube_video_id_from_url
from models import Playlist, Track, track_play_variants
from tag_metadata import extract_cover
from cover_image import DEFAULT_JPEG_QUALITY, DEFAULT_THUMB_MAX_SIDE, square_thumb_jpeg


def _youtube_video_id_from_track_metadata(artist: str, title: str) -> Optional[str]:
    """Fallback for cover art: first ytsearch hit for artist + title."""
    q = f"{artist} {title}".strip()
    if len(q) < 2:
        return None
    try:
        hits = search_youtube_tracks(root, q, limit=1)
        if hits and hits[0].get("video_id"):
            return str(hits[0]["video_id"])
    except Exception:
        return None
    return None


def build_playlist_recommendation_query(pl: Playlist) -> str:
    """Combine playlist name with 2–4 distinct artists/titles for YouTube search."""
    base = (pl.name or "").strip() or "music"
    tracks = list(pl.tracks or [])
    if not tracks:
        return base

    artists_order: list[str] = []
    titles_order: list[str] = []
    seen_a: set[str] = set()
    seen_t: set[str] = set()
    for t in tracks:
        a = (t.artist or "").strip()
        if a and a.casefold() not in seen_a:
            seen_a.add(a.casefold())
            artists_order.append(a)
        tt = (t.title or "").strip()
        if tt and tt.casefold() not in seen_t:
            seen_t.add(tt.casefold())
            titles_order.append(tt)

    tokens: list[str] = []
    i = j = 0
    while len(tokens) < 4 and (i < len(artists_order) or j < len(titles_order)):
        take_artist = len(tokens) % 2 == 0
        if take_artist and i < len(artists_order):
            tokens.append(artists_order[i])
            i += 1
        elif j < len(titles_order):
            tokens.append(titles_order[j])
            j += 1
        elif i < len(artists_order):
            tokens.append(artists_order[i])
            i += 1
        else:
            break

    parts = [base] + tokens
    q = " ".join(parts)
    if len(q) > 200:
        q = q[:200].rsplit(" ", 1)[0].strip()
    return q or base

_webapp_dir = Path(__file__).resolve().parent
load_dotenv(_webapp_dir / ".env")

app = FastAPI(title="SpoLocal")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Windows often maps .js to text/plain in the registry; Starlette uses mimetypes.guess_type.
mimetypes.add_type("application/javascript", ".js", strict=False)
mimetypes.add_type("application/javascript", ".mjs", strict=False)
mimetypes.add_type("text/css", ".css", strict=False)
templates = Jinja2Templates(directory=str(_webapp_dir / "templates"))

root = _webapp_dir.parent
import sys

if str(root) not in sys.path:
    sys.path.insert(0, str(root))
from spotify_scraper import search_youtube_tracks

service = DownloadService(root)

_PREVIEW_CACHE_TTL_SECONDS = 300
_PREVIEW_CACHE_MAX_ENTRIES = 2000
_SEARCH_PREVIEW_LIMIT = 6
_SEARCH_CACHE_MAX_RESULTS = 30
_SEARCH_CACHE_TTL_SECONDS = 180
_SEARCH_CACHE_MAX_ENTRIES = 20
_preview_cache: dict[str, tuple[str, dict[str, str], str, float]] = {}
_preview_inflight: dict[str, asyncio.Task[tuple[str, dict[str, str], str]]] = {}
_search_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_search_cache_lock = asyncio.Lock()
_recommendation_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_recommendation_cache_lock = asyncio.Lock()
_RECOMMENDATION_CACHE_TTL_SECONDS = 600
_RECOMMENDATION_CACHE_MAX_ENTRIES = 24


def _now_ts() -> float:
    return time.time()


def _normalize_query(q: str) -> str:
    return " ".join((q or "").strip().lower().split())


def _search_cache_cleanup(now: float) -> None:
    if not _search_cache:
        return
    expired = [k for k, v in _search_cache.items() if v[1] <= now]
    for k in expired:
        _search_cache.pop(k, None)
    if len(_search_cache) <= _SEARCH_CACHE_MAX_ENTRIES:
        return

    items = sorted(_search_cache.items(), key=lambda kv: kv[1][1])
    for k, _ in items[:len(_search_cache) - _SEARCH_CACHE_MAX_ENTRIES]:
        _search_cache.pop(k, None)


def _preview_cache_cleanup(now: float) -> None:
    if not _preview_cache:
        return

    expired = [vid for vid, _ in _preview_cache.items() if _[3] <= now]
    for vid in expired:
        _preview_cache.pop(vid, None)

    if len(_preview_cache) <= _PREVIEW_CACHE_MAX_ENTRIES:
        return

    items = sorted(_preview_cache.items(), key=lambda kv: kv[1][3])
    for vid, _ in items[:len(_preview_cache) - _PREVIEW_CACHE_MAX_ENTRIES]:
        _preview_cache.pop(vid, None)


def _recommendation_cache_cleanup(now: float) -> None:
    if not _recommendation_cache:
        return

    expired = [k for k, v in _recommendation_cache.items() if v[1] <= now]
    for k in expired:
        _recommendation_cache.pop(k, None)

    if len(_recommendation_cache) <= _RECOMMENDATION_CACHE_MAX_ENTRIES:
        return

    items = sorted(_recommendation_cache.items(), key=lambda kv: kv[1][1])
    for k, _ in items[:len(_recommendation_cache) - _RECOMMENDATION_CACHE_MAX_ENTRIES]:
        _recommendation_cache.pop(k, None)


def _extract_preview_payload(video_id: str) -> tuple[str, dict[str, str], str]:
    url_yt = f"https://www.youtube.com/watch?v={video_id}"
    opts = {
        "format": "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "quiet": True,
        "no_warnings": True,
    }
    with _yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url_yt, download=False)
    if not info:
        raise ValueError("No info returned by yt-dlp")
    return (
        str(info.get("url") or ""),
        {str(k): str(v) for k, v in (info.get("http_headers") or {}).items() if isinstance(k, str) and isinstance(v, str)},
        str(info.get("ext") or "webm"),
    )


async def _cache_or_refresh_preview(video_id: str) -> tuple[str, dict[str, str], str]:
    url, headers, ext = await asyncio.get_running_loop().run_in_executor(
        None,
        _extract_preview_payload,
        video_id,
    )
    if not url:
        raise ValueError("No preview stream URL from yt-dlp")

    now = _now_ts()
    _preview_cache[video_id] = (url, headers, ext, now + _PREVIEW_CACHE_TTL_SECONDS)
    _preview_cache_cleanup(now)
    return url, headers, ext


async def _get_preview_payload(video_id: str) -> tuple[str, dict[str, str], str]:
    now = _now_ts()
    entry = _preview_cache.get(video_id)
    if entry is not None and entry[3] > now:
        return entry[0], entry[1], entry[2]

    pending = _preview_inflight.get(video_id)
    if pending is None:
        task = asyncio.create_task(_cache_or_refresh_preview(video_id))
        _preview_inflight[video_id] = task
        pending = task

    try:
        return await pending
    finally:
        if _preview_inflight.get(video_id) is pending:
            _preview_inflight.pop(video_id, None)


async def _prefetch_search_previews(hits: list[dict[str, Any]]) -> None:
    vids = []
    hit_map: dict[str, list[dict[str, Any]]] = {}
    for hit in hits:
        vid = hit.get("video_id")
        if isinstance(vid, str):
            v = vid.strip()
            if not v:
                continue
            vids.append(v)
            hit_map.setdefault(v, []).append(hit)
    if not vids:
        return

    # dedupe while preserving order
    unique: list[str] = []
    seen: set[str] = set()
    for vid in vids:
        if not vid or vid in seen:
            continue
        seen.add(vid)
        unique.append(vid)

    sem = asyncio.Semaphore(3)

    async def _warm(vid: str) -> tuple[str, str | None, str | None] | None:
        now = _now_ts()
        cached = _preview_cache.get(vid)
        if cached is not None and cached[3] > now:
            return (vid, cached[0], cached[2])
        try:
            async with sem:
                payload = await _get_preview_payload(vid)
                return (vid, payload[0], payload[2])
        except Exception:
            return None

    tasks = [asyncio.create_task(_warm(vid)) for vid in unique]
    if not tasks:
        return

    results = await asyncio.gather(*tasks, return_exceptions=False)
    for item in results:
        if item is None:
            continue
        vid, preview_url, preview_ext = item
        if not preview_url:
            continue
        for hit in hit_map.get(vid, []):
            hit["preview_url"] = preview_url
            hit["preview_ext"] = preview_ext
_cover_tile_cache_dir = _webapp_dir / "static" / "cover_tiles"
# Small on-disk / on-the-wire JPEGs so the browser does not decode huge album art for tiny UI tiles.
_COVER_THUMB_MAX_SIDE = DEFAULT_THUMB_MAX_SIDE
_COVER_JPEG_QUALITY = DEFAULT_JPEG_QUALITY


def _track_payload_row(t: Track, *, playback_quality: Optional[str] = None) -> dict[str, Any]:
    st = t.status.value if hasattr(t.status, "value") else str(t.status)
    variants = track_play_variants(t)
    preferred = playback_quality or "192"
    play_src = variants.get(preferred) or variants.get("192") or t.play_src()
    if not play_src and variants:
        best_key = sorted(variants.keys(), key=lambda k: int(k) if str(k).isdigit() else 0, reverse=True)[0]
        play_src = variants.get(best_key)
    return {
        "id": t.id,
        "title": t.title,
        "artist": t.artist,
        "album": t.album or "",
        "play_src": play_src,
        "play_variants": variants,
        "status": st,
        "url": t.url or "",
        "youtube_video_id": t.youtube_video_id or "",
        "error": t.error or "",
        "loudness_gain_db": t.loudness_gain_db,
    }


def cover_tile_cache_path(playlist_id: str, track_id: str) -> Path:
    """On-disk cache: square JPEG, max edge _COVER_THUMB_MAX_SIDE (see module constants)."""
    safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
    safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
    return _cover_tile_cache_dir / f"{safe_p}_{safe_t}_s{_COVER_THUMB_MAX_SIDE}.jpg"


def _unlink_track_cover_caches(playlist_id: str, track_id: str) -> None:
    """Remove current and any legacy per-track cover cache files."""
    safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
    safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
    try:
        for p in _cover_tile_cache_dir.glob(f"{safe_p}_{safe_t}*.jpg"):
            p.unlink(missing_ok=True)
    except OSError:
        pass


def _cover_tiles_for_playlist(pl: Playlist) -> list[str]:
    return [f"/playlists/{pl.id}/tracks/{t.id}/cover" for t in pl.tracks[:4]]


def _library_pool_payload() -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    for pl in service.list_playlists():
        for t in pl.tracks:
            variants = track_play_variants(t)
            src = variants.get("192") or t.play_src()
            if not src and variants:
                best_key = sorted(variants.keys(), key=lambda k: int(k) if str(k).isdigit() else 0, reverse=True)[0]
                src = variants.get(best_key)
            if not src:
                continue
            pool.append(
                {
                    "playlist_id": pl.id,
                    "track_id": t.id,
                    "title": t.title,
                    "artist": t.artist,
                    "album": t.album or "",
                    "play_src": src,
                    "play_variants": variants,
                    "url": t.url or "",
                    "youtube_video_id": t.youtube_video_id or "",
                }
            )
    return pool


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, playlist_id: Optional[str] = None):
    pid = playlist_id.strip() if playlist_id else None
    playlists = service.list_playlists()
    is_home = not pid
    current: Optional[Playlist] = None
    current_tracks_payload: list[dict[str, Any]] = []
    current_cover_tiles: list[str] = []
    home_library_pool: list[dict[str, Any]] = []

    if pid:
        current = service.get_playlist(pid)
        if not current:
            is_home = True
        else:
            await asyncio.to_thread(service.hydrate_media_paths, current, fill_albums=False, persist=False)
            current_tracks_payload = [_track_payload_row(t) for t in current.tracks]
            current_cover_tiles = _cover_tiles_for_playlist(current)

    if is_home:
        for pl in playlists:
            await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
        home_library_pool = _library_pool_payload()

    nav_current = None if is_home else (current.id if current else None)
    playlist_nav = service.list_playlist_nav(nav_current)
    playlist_catalog = service.list_playlist_catalog()
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "playlist_nav": playlist_nav,
            "playlist_catalog": playlist_catalog,
            "current": current,
            "is_home": is_home,
            "current_cover_tiles": current_cover_tiles,
            "current_tracks_payload": current_tracks_payload,
            "home_library_pool": home_library_pool,
            "service": service,
            "liked_playlist_id": DownloadService.LIKED_SONGS_PLAYLIST_ID,
        },
    )


@app.get("/api/playlists/catalog")
async def api_playlists_catalog():
    return JSONResponse(service.list_playlist_catalog())


@app.get("/api/liked-keys")
async def api_liked_keys():
    return JSONResponse({"keys": service.list_liked_entry_keys()})


class CreatePlaylistBody(BaseModel):
    name: str = Field(..., min_length=1)


class TrackLikeBody(BaseModel):
    source_playlist_id: str = Field(..., min_length=1)
    source_track_id: str = Field(..., min_length=1)
    liked: bool


@app.post("/api/track/like")
async def api_track_like(body: TrackLikeBody):
    ok = service.set_track_liked(body.source_playlist_id.strip(), body.source_track_id.strip(), body.liked)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="Could not update like. The track may not be downloaded yet, or it may already be in Liked Songs.",
        )
    return JSONResponse({"ok": True, "liked": body.liked})


@app.get("/api/playlists/{playlist_id}/tracks/{track_id}/info")
async def api_track_info(playlist_id: str, track_id: str):
    info = service.get_track_info(playlist_id, track_id)
    if not info:
        raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse(info)


@app.get("/api/playlists/{playlist_id}/tracks/{track_id}/loudness-gain")
async def api_track_loudness_gain(playlist_id: str, track_id: str):
    gain = await asyncio.to_thread(service.ensure_track_loudness_gain, playlist_id, track_id)
    if gain is None:
        pl = service.get_playlist(playlist_id.strip())
        if not pl or not pl.get_track(track_id.strip()):
            raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse({"loudness_gain_db": gain})


@app.get("/api/playlist/state")
async def api_playlist_state(playlist_id: str):
    pl = service.get_playlist(playlist_id.strip())
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return JSONResponse(
        {
            "playlist_id": pl.id,
            "tracks_payload": [_track_payload_row(t) for t in pl.tracks],
        },
    )


@app.get("/api/home/view")
async def api_home_view(request: Request):
    """HTML fragment for in-page home switching."""
    for pl in service.list_playlists():
        await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    tpl = templates.env.get_template("partials/home_main.html")
    html = tpl.render(request=request)
    return JSONResponse(
        {
            "html": html,
            "view": "home",
            "library_pool": _library_pool_payload(),
            "catalog": service.list_playlist_catalog(),
        }
    )


@app.post("/api/playlists")
async def api_create_playlist(body: CreatePlaylistBody):
    try:
        pl = service.create_playlist(body.name.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    tiles = [f"/playlists/{pl.id}/tracks/{t.id}/cover" for t in pl.tracks[:4]]
    return JSONResponse(
        {
            "ok": True,
            "playlist": {
                "id": pl.id,
                "name": pl.name,
                "bio": pl.bio or "",
                "cover_tiles": tiles,
                "system_locked": False,
            },
        }
    )


@app.get("/api/playlist/view")
async def api_playlist_view(request: Request, playlist_id: str):
    """HTML fragment + track payload for in-page playlist switching (query param avoids path parsing issues)."""
    pl = service.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    tracks_payload = [_track_payload_row(t) for t in pl.tracks]
    tpl = templates.env.get_template("partials/playlist_main.html")
    html = tpl.render(
        request=request,
        current=pl,
        current_cover_tiles=_cover_tiles_for_playlist(pl),
        liked_playlist_id=DownloadService.LIKED_SONGS_PLAYLIST_ID,
    )
    return JSONResponse(
        {"html": html, "tracks_payload": tracks_payload, "playlist_id": pl.id},
    )


@app.get("/api/playlist/recommendations")
async def api_playlist_recommendations(playlist_id: str, limit: int = 12):
    """YouTube recommendations for a playlist (same hit shape as `/api/search/songs`)."""
    pl = service.get_playlist(playlist_id.strip())
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    q = build_playlist_recommendation_query(pl)
    if len(q) < 2:
        q = ((pl.name or "music").strip() or "music") + " mix"
    lim = max(1, min(int(limit), 30))
    extra = min(24, max(4, lim))
    cache_key = f"{pl.id}|{lim}|{q}"

    now = _now_ts()
    cached_hits: list[dict[str, Any]] | None = None
    async with _recommendation_cache_lock:
        _recommendation_cache_cleanup(now)
        cached = _recommendation_cache.get(cache_key)
        if cached is not None:
            cached_hits = cached[0]

    if cached_hits is None:
        def _search() -> list[dict[str, Any]]:
            return search_youtube_tracks(root, q, lim + extra)

        loop = asyncio.get_event_loop()
        cached_hits = await loop.run_in_executor(None, _search)
        async with _recommendation_cache_lock:
            _recommendation_cache[cache_key] = (cached_hits, now + _RECOMMENDATION_CACHE_TTL_SECONDS)

    hits = cached_hits

    existing_ids: set[str] = set()
    for t in pl.tracks:
        vid = t.youtube_video_id or youtube_video_id_from_url(t.url)
        if vid:
            existing_ids.add(vid)

    out: list[dict[str, Any]] = []
    for h in hits:
        vid = h.get("video_id")
        if isinstance(vid, str) and vid in existing_ids:
            continue
        out.append(h)
        if len(out) >= lim:
            break

    return JSONResponse(out)


@app.get("/api/search/songs")
async def api_search_songs(q: str = "", limit: int = 30, offset: int = 0):
    q = (q or "").strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters.")
    if offset < 0:
        offset = 0
    if limit < 1:
        limit = 1
    elif limit > _SEARCH_PREVIEW_LIMIT:
        limit = _SEARCH_PREVIEW_LIMIT
    normalized_q = _normalize_query(q)
    now = _now_ts()
    cache_key = normalized_q
    loop = asyncio.get_event_loop()

    hits_cache: list[dict[str, Any]] | None = None

    async with _search_cache_lock:
        _search_cache_cleanup(now)
        cached = _search_cache.get(cache_key)
        if cached is not None:
            hits_cache = cached[0]

    if hits_cache is None:
        hits_cache = await loop.run_in_executor(None, search_youtube_tracks, root, normalized_q, _SEARCH_CACHE_MAX_RESULTS)
        async with _search_cache_lock:
            _search_cache[cache_key] = (hits_cache, now + _SEARCH_CACHE_TTL_SECONDS)

    start = min(offset, len(hits_cache))
    end = min(start + limit, len(hits_cache))
    hits = hits_cache[start:end]
    if hits:
        await _prefetch_search_previews(hits)

    return JSONResponse(
        {
            "hits": hits,
            "offset": start,
            "limit": limit,
            "has_more": end < len(hits_cache),
        }
    )


@app.get("/api/preview")
async def api_preview(vid: str):
    """Stream the first ~30 s of a YouTube video's best audio."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")

    try:
        stream_url, http_headers, ext = await _get_preview_payload(vid.strip())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not resolve audio stream: {exc}")

    content_type = (
        "audio/webm" if ext == "webm"
        else "audio/mp4" if ext in ("m4a", "mp4")
        else "audio/mpeg"
    )
    MAX_BYTES = 512 * 1024  # ~30 s at 128 kbps

    async def generate():
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            async with client.stream("GET", stream_url, headers=http_headers) as resp:
                sent = 0
                async for chunk in resp.aiter_bytes(8192):
                    if sent >= MAX_BYTES:
                        break
                    sent += len(chunk)
                    yield chunk

    return StreamingResponse(generate(), media_type=content_type)


@app.post("/playlists")
async def create_playlist(request: Request, name: str = Form(...)):
    wants_json = "application/json" in (request.headers.get("accept") or "").lower()
    try:
        pl = service.create_playlist(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if wants_json:
        return JSONResponse({"ok": True, "playlist_id": pl.id, "name": pl.name})
    return RedirectResponse("/", status_code=303)


@app.post("/playlists/import")
async def import_spotify(spotify_url: str = Form(...)):
    try:
        pl = service.import_spotify_playlist(spotify_url)
        return RedirectResponse(f"/?playlist_id={pl.id}", status_code=303)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/playlists/{playlist_id}/tracks")
async def add_track(
    request: Request,
    playlist_id: str,
    title: str = Form(...),
    artist: str = Form(...),
    url: Optional[str] = Form(None),
    album: Optional[str] = Form(None),
    skip_download: Optional[str] = Form(None),
    quality: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    raw = (skip_download or "").strip().lower()
    skip = raw in ("1", "true", "yes", "on")
    u = (url or "").strip() or None
    alb = (album or "").strip() or None
    dl_quality = (quality or "192").strip() or "192"
    wants_json = "application/json" in (request.headers.get("accept") or "").lower()
    try:
        track = service.add_track_to_playlist(
            pid,
            title.strip(),
            artist.strip(),
            url=u,
            album=alb,
            enqueue_download=not skip,
            download_quality=dl_quality,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Playlist not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if wants_json:
        return JSONResponse(
            {
                "ok": True,
                "playlist_id": pid,
                "track": _track_payload_row(track),
            }
        )
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/tracks/{track_id}/download")
async def start_download(
    playlist_id: str,
    track_id: str,
    redownload: Optional[str] = Form(None),
    quality: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    tid = track_id.strip()
    force = (redownload or "").strip().lower() in ("1", "true", "yes", "on")
    dl_quality = (quality or "192").strip() or "192"
    if not service.start_track_download(pid, tid, force_redownload=force, quality=dl_quality):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/tracks/{track_id}/delete")
async def delete_track(playlist_id: str, track_id: str):
    pid = playlist_id.strip()
    tid = track_id.strip()
    if not service.delete_track(pid, tid):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    _unlink_track_cover_caches(pid, tid)
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/delete")
async def delete_playlist(playlist_id: str):
    pid = playlist_id.strip()
    if service.is_liked_songs_playlist(pid):
        raise HTTPException(status_code=403, detail="The Liked Songs playlist cannot be deleted.")
    if not service.delete_playlist(pid):
        raise HTTPException(status_code=404, detail="Playlist not found")
    return RedirectResponse("/", status_code=303)


@app.post("/playlists/{playlist_id}/edit")
async def edit_playlist(
    playlist_id: str,
    name: Optional[str] = Form(None),
    bio: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    pl = service.get_playlist(pid)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if service.is_liked_songs_playlist(pid):
        raise HTTPException(status_code=403, detail="The Liked Songs playlist cannot be edited.")

    if name is None and bio is None:
        raise HTTPException(status_code=400, detail="Provide name and/or bio.")

    name_kw: Optional[str] = None
    if name is not None:
        n = name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="Playlist name cannot be empty.")
        name_kw = n

    bio_kw: Optional[str] = None
    if bio is not None:
        bio_kw = bio

    if not service.update_playlist_meta(pid, name=name_kw, bio=bio_kw):
        raise HTTPException(status_code=404, detail="Playlist not found")

    pl2 = service.get_playlist(pl.id)
    display_name = pl2.name if pl2 else pl.name
    display_bio = (pl2.bio or "") if pl2 else ""
    return JSONResponse(
        {
            "ok": True,
            "id": pl2.id if pl2 else pl.id,
            "name": display_name,
            "bio": display_bio,
        }
    )


@app.get("/playlists/{playlist_id}/tracks/{track_id}/cover")
async def track_cover(playlist_id: str, track_id: str):
    pid = playlist_id.strip()
    tid = track_id.strip()
    cpath = cover_tile_cache_path(pid, tid)
    if cpath.is_file():
        return FileResponse(
            str(cpath),
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=604800"},
        )

    path = await asyncio.to_thread(service.get_track_audio_path, pid, tid)
    if path is None:
        raise HTTPException(status_code=404, detail="Track or file not found")

    blob = await asyncio.to_thread(extract_cover, path)
    raw: Optional[bytes] = blob[0] if blob else None
    orig_mime = blob[1] if blob else "image/jpeg"

    pl = service.get_playlist(pid)
    track = pl.get_track(tid) if pl else None
    yt_id: Optional[str] = None
    if track:
        yt_id = track.youtube_video_id or youtube_video_id_from_url(track.url)
    if raw is None and not yt_id and track:
        yt_id = await asyncio.to_thread(
            _youtube_video_id_from_track_metadata,
            track.artist,
            track.title,
        )
    if raw is None and yt_id:
        # Prefer small YouTube still; fall back to mqdefault if default is missing.
        yt_urls = (
            f"https://i.ytimg.com/vi/{yt_id}/default.jpg",
            f"https://i.ytimg.com/vi/{yt_id}/mqdefault.jpg",
        )
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
                for url in yt_urls:
                    r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                    if r.is_success and r.content:
                        raw = r.content
                        orig_mime = r.headers.get("content-type") or "image/jpeg"
                        break
        except Exception:
            raw = None

    if not raw:
        raise HTTPException(status_code=404, detail="No embedded cover")

    processed = await asyncio.to_thread(
        square_thumb_jpeg,
        raw,
        max_side=_COVER_THUMB_MAX_SIDE,
        quality=_COVER_JPEG_QUALITY,
    )
    headers = {"Cache-Control": "public, max-age=604800"}
    if processed:
        try:
            cpath.parent.mkdir(parents=True, exist_ok=True)
            cpath.write_bytes(processed)
        except OSError:
            pass
        return Response(content=processed, media_type="image/jpeg", headers=headers)

    return Response(
        content=raw,
        media_type=orig_mime if orig_mime.startswith("image/") else "image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


class LyricsSaveBody(BaseModel):
    lyrics: str = Field(default="")


class LrcSaveBody(BaseModel):
    lines: list = Field(default_factory=list)


@app.get("/playlists/{playlist_id}/tracks/{track_id}/lyrics")
def track_lyrics(playlist_id: str, track_id: str):
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    return JSONResponse(service.get_lyrics_payload(playlist_id, track_id))


@app.post("/playlists/{playlist_id}/tracks/{track_id}/lyrics")
async def track_lyrics_save(playlist_id: str, track_id: str, body: LyricsSaveBody):
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if not service.save_track_lyrics_file(playlist_id, track_id, body.lyrics):
        raise HTTPException(
            status_code=400,
            detail="Lyrics are saved next to the audio file. Download or fix this track first.",
        )
    return JSONResponse({"ok": True})


@app.post("/playlists/{playlist_id}/tracks/{track_id}/lyrics/lrc")
async def track_lrc_save(playlist_id: str, track_id: str, body: LrcSaveBody):
    """Save LRC lyrics with timestamps."""
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if not service.save_track_lrc_file(playlist_id, track_id, body.lines):
        raise HTTPException(
            status_code=400,
            detail="Lyrics are saved next to the audio file. Download or fix this track first.",
        )
    return JSONResponse({"ok": True})


@app.post("/api/downloads/retry-all-errors")
async def api_retry_all_errors():
    """Re-queue all tracks that are in error state (any playlist)."""
    n = service.retry_all_error_tracks()
    return JSONResponse({"ok": True, "queued": n})


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


@app.get("/playlists/{playlist_id}/tracks/{track_id}/file")
async def export_track_file(playlist_id: str, track_id: str):
    """Browser download of one track's audio file."""
    result = await asyncio.to_thread(service.get_track_export, playlist_id, track_id)
    if not result:
        raise HTTPException(
            status_code=404,
            detail="Track audio not found. Download the track in the library first.",
        )
    path, filename = result
    return FileResponse(
        path,
        media_type=_media_content_type(path),
        filename=filename,
        content_disposition_type="attachment",
    )


@app.get("/playlists/{playlist_id}/export.zip")
async def export_playlist_zip(playlist_id: str):
    """Browser download of a ZIP of all downloaded tracks in the playlist."""
    pid = playlist_id.strip()
    if not service.get_playlist(pid):
        raise HTTPException(status_code=404, detail="Playlist not found")

    built = await asyncio.to_thread(service.build_playlist_export_zip, pid)
    if not built:
        raise HTTPException(
            status_code=404,
            detail="No downloaded tracks to export. Download songs in this playlist first.",
        )
    tmp_path, zip_name, _count = built
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=zip_name,
        content_disposition_type="attachment",
        background=BackgroundTask(_unlink_quiet, tmp_path),
    )


class QualityDownloadBody(BaseModel):
    quality: str = Field(..., min_length=1)


@app.post("/api/playlists/{playlist_id}/downloads/quality")
async def api_playlist_quality_downloads(playlist_id: str, body: QualityDownloadBody):
    """Queue downloads for every track in a playlist missing the given quality variant."""
    result = service.queue_playlist_quality_downloads(playlist_id, body.quality)
    if result is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return JSONResponse({"ok": True, **result})


@app.post("/api/downloads/quality-all")
async def api_quality_downloads_all(body: QualityDownloadBody):
    """Queue missing quality variants for every track in every playlist."""
    result = service.queue_all_quality_downloads(body.quality)
    return JSONResponse({"ok": True, **result})


@app.get("/api/progress")
async def api_progress():
    """Live per-track download progress plus how many downloads are left in the queue."""
    return JSONResponse(service.progress_api_payload())


_manifest_path = _webapp_dir / "manifest.json"


@app.get("/manifest.json")
async def serve_web_app_manifest():
    """PWA manifest stored under ``webapp/manifest.json`` (linked from templates as ``manifest.json``)."""
    if not _manifest_path.is_file():
        raise HTTPException(status_code=404, detail="manifest.json missing")
    return FileResponse(
        _manifest_path,
        media_type="application/manifest+json; charset=utf-8",
    )


class JsMimeStaticFiles(StaticFiles):
    """Serve .js / .mjs / .css with correct MIME types on Windows.

    ``mimetypes`` often maps ``.js`` to ``text/plain``, which makes browsers reject
    scripts and ES module graphs. ``FileResponse`` uses ``guess_type`` unless
    ``media_type`` is set explicitly.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        request_headers = Headers(scope=scope)
        suffix = Path(full_path).suffix.lower()
        media_type = None
        if suffix in (".js", ".mjs"):
            media_type = "application/javascript; charset=utf-8"
        elif suffix == ".css":
            media_type = "text/css; charset=utf-8"
        response = FileResponse(
            full_path,
            status_code=status_code,
            stat_result=stat_result,
            media_type=media_type,
        )
        if self.is_not_modified(response.headers, request_headers):
            return NotModifiedResponse(response.headers)
        return response


_static_dir = _webapp_dir / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
_pwa_sw_path = _static_dir / "pwa" / "sw.js"


@app.get("/static/pwa/sw.js", include_in_schema=False)
async def pwa_service_worker():
    """Serve generated Workbox SW with full-site scope (SW lives under ``/static/pwa/``)."""
    if not _pwa_sw_path.is_file():
        raise HTTPException(status_code=404, detail="Run: npm run build:pwa")
    return FileResponse(
        _pwa_sw_path,
        media_type="application/javascript; charset=utf-8",
        headers={"Service-Worker-Allowed": "/"},
    )


app.mount("/static", JsMimeStaticFiles(directory=str(_static_dir)), name="static")

_media_root = root / "downloads"
_media_root.mkdir(parents=True, exist_ok=True)


def _media_content_type(file_path: Path) -> str:
    mime, _ = mimetypes.guess_type(file_path.name)
    if mime:
        return mime
    if file_path.suffix.lower() == ".m4a":
        return "audio/mp4"
    if file_path.suffix.lower() == ".mp3":
        return "audio/mpeg"
    if file_path.suffix.lower() == ".webm":
        return "audio/webm"
    return "application/octet-stream"


def _iter_media_range(file_path: Path, start: int, end: int):
    remaining = end - start + 1
    with file_path.open("rb") as f:
        f.seek(start)
        while remaining > 0:
            chunk = f.read(min(64 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.get("/media/{media_path:path}")
async def serve_media(media_path: str, request: Request):
    target = (_media_root / media_path).resolve()
    media_root = _media_root.resolve()
    try:
        target.relative_to(media_root)
    except ValueError:
        raise HTTPException(status_code=404, detail="Media file not found")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")

    total = target.stat().st_size
    content_type = _media_content_type(target)
    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }

    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            _iter_media_range(target, 0, total - 1),
            media_type=content_type,
            headers={**base_headers, "Content-Length": str(total)},
        )

    if not range_header.startswith("bytes="):
        raise HTTPException(status_code=416, detail="Unsupported range")

    range_value = range_header.split("=", 1)[1].strip()
    if "," in range_value:
        raise HTTPException(status_code=416, detail="Multiple ranges not supported")

    start_str, end_str = (range_value.split("-", 1) + [""])[:2]
    if start_str == "" and end_str == "":
        raise HTTPException(status_code=416, detail="Invalid range")

    if start_str == "":
        if not end_str.isdigit():
            raise HTTPException(status_code=416, detail="Invalid range")
        suffix_len = int(end_str)
        if suffix_len <= 0:
            raise HTTPException(status_code=416, detail="Invalid range")
        start = max(total - suffix_len, 0)
        end = total - 1
    else:
        if not start_str.isdigit():
            raise HTTPException(status_code=416, detail="Invalid range")
        start = int(start_str)
        if end_str and not end_str.isdigit():
            raise HTTPException(status_code=416, detail="Invalid range")
        end = int(end_str) if end_str else total - 1

    if start < 0 or end < start or start >= total:
        raise HTTPException(status_code=416, detail="Invalid range")
    end = min(end, total - 1)

    return StreamingResponse(
        _iter_media_range(target, start, end),
        media_type=content_type,
        status_code=206,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{total}",
            "Content-Length": str(end - start + 1),
        },
    )
