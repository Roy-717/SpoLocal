"""Core download service for SpoLocal.

Resolves tracks from Spotify links or URLs.
Coordinates yt_dlp downloads, updates state, and triggers enrichment."""
from __future__ import annotations

import json
import logging
import os
import queue
import re
import sys
import tempfile
import threading
import time
import zipfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from uuid import uuid4

import yt_dlp

from audio_quality import DEFAULT_KBPS, kbps_from_relpath, parse_quality_kbps, variant_key
from lyrics_files import delete_lyrics_sidecars, materialize_lyrics_file_if_needed
from lyrics_fetch import fetch_lrclib_sidecar_sync, on_demand_lyrics_fetch_enabled
from models import DownloadStatus, Playlist, Track, set_track_status_change_listener
from tag_metadata import extract_album, extract_lyrics, read_audio_file_stats

sys.path.append(str(Path(__file__).resolve().parent.parent))
from spotifydown_api import detect_spotify_url_type
from spotify_scraper import (
    SpotifyEmbedDownloader,
    YtDlpAudioDownloader,
    _newest_mp3_under,
    _sanitize_folder_name,
    search_youtube_tracks,
)

# Hydration cache settings
_HYDRATION_CACHE_TTL_SECONDS = 30  # Cache hydration results for 30 seconds
_HYDRATION_CACHE_MAX_ENTRIES = 100


def _now_ts() -> float:
    return time.time()

_SPOTIFY_URI_TYPE_ID = re.compile(r"^spotify:(playlist|album|track):([A-Za-z0-9]+)\s*$", re.I)
_SPOTIFY_WEB_TYPE_ID = re.compile(r"open\.spotify\.com/(playlist|album|track)/([A-Za-z0-9]+)", re.I)


def spotify_catalog_key_from_import_url(raw: str) -> Optional[str]:
    """Stable id for playlist/album/track imports, e.g. playlist:37i9dQZ..., or None."""
    s = (raw or "").strip()
    if not s:
        return None
    m = _SPOTIFY_URI_TYPE_ID.match(s)
    if m:
        return f"{m.group(1).lower()}:{m.group(2)}"
    base = s.split("?", 1)[0].strip()
    m = _SPOTIFY_WEB_TYPE_ID.search(base)
    if m:
        return f"{m.group(1).lower()}:{m.group(2)}"
    return None


def spotify_track_id_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    u = url.strip()
    if u.lower().startswith("spotify:track:"):
        return u.split(":", 2)[2].split("?")[0]
    m = re.search(r"open\.spotify\.com/track/([A-Za-z0-9]+)", u, re.I)
    if m:
        return m.group(1)
    return None


def youtube_video_id_from_url(url: Optional[str]) -> Optional[str]:
    """Parse YouTube video id from watch, youtu.be, or embed URLs."""
    if not url:
        return None
    u = url.strip()
    m = re.search(
        r"(?:youtube\.com/watch\?[^#]*v=|youtu\.be/|youtube\.com/embed/)([A-Za-z0-9_-]{11})",
        u,
        re.I,
    )
    if m:
        return m.group(1)
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{11})\b", u, re.I)
    if m:
        return m.group(1)
    return None


def _parse_dt(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        s = value.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    return datetime.utcnow()


def _track_from_dict(raw: dict) -> Track:
    data = dict(raw)
    st = data.get("status", DownloadStatus.queued)
    if isinstance(st, str):
        data["status"] = DownloadStatus(st)
    data["added_at"] = _parse_dt(data.get("added_at", datetime.utcnow()))
    data.setdefault("media_relpath", None)
    data.setdefault("media_variants", {})
    if data.get("media_relpath") and not data.get("media_variants"):
        rel = data["media_relpath"]
        inferred = kbps_from_relpath(rel)
        key = variant_key(inferred) if inferred else "192"
        data["media_variants"] = {key: rel}
    if not isinstance(data.get("media_variants"), dict):
        data["media_variants"] = {}
    data.setdefault("cover_url", None)
    data.setdefault("youtube_video_id", None)
    data.setdefault("album", None)
    data.setdefault("liked_source_playlist_id", None)
    data.setdefault("liked_source_track_id", None)
    return Track(**data)


def _playlist_from_dict(pdata: dict) -> Playlist:
    data = dict(pdata)
    data.setdefault("bio", None)
    tracks = [_track_from_dict(t) for t in data.get("tracks", [])]
    return Playlist(
        id=data["id"],
        name=data["name"],
        tracks=tracks,
        created_at=_parse_dt(data.get("created_at", datetime.utcnow())),
        spotify_catalog_key=data.get("spotify_catalog_key"),
        spotify_snapshot_id=data.get("spotify_snapshot_id"),
        bio=data.get("bio"),
    )


def _download_worker_count() -> int:
    try:
        n = int(
            (
                os.environ.get("SPOLOCAL_DOWNLOAD_WORKERS")
                or os.environ.get("SPRITY_DOWNLOAD_WORKERS")
                or "2"
            ).strip()
        )
    except ValueError:
        n = 2
    return max(1, min(n, 8))


class _HydrationCacheEntry:
    """Cached hydration data for a playlist."""
    __slots__ = ("playlist_id", "by_stem", "expires_at", "albums")

    def __init__(self, playlist_id: str, by_stem: Dict[str, Path], expires_at: float):
        self.playlist_id = playlist_id
        self.by_stem = by_stem
        self.expires_at = expires_at
        self.albums: Dict[str, Optional[str]] = {}  # track_id -> album name (lazy-loaded)


class DownloadService:
    """Download work is spread across N background threads (SPOLOCAL_DOWNLOAD_WORKERS, default 2)."""

    LIKED_SONGS_PLAYLIST_ID = "spolocal_liked_songs"
    LIKED_SONGS_PLAYLIST_NAME = "Liked Songs"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.playlists: Dict[str, Playlist] = {}
        self.job_queue: queue.Queue[Callable[[], None]] = queue.Queue()
        self._lock = threading.Lock()
        # Embed downloader is plain HTTP — safe to use from any thread immediately.
        self._embed = SpotifyEmbedDownloader(root)

        self._startup_enqueue_done = False
        # track_id -> {title, artist, percent, speed, eta, phase}
        self.progress: Dict[str, dict] = {}
        # (track_id, quality) jobs already queued or running — avoid duplicate bulk enqueues
        self._pending_job_keys: set[Tuple[str, str]] = set()
        self._error_rows_cache: Optional[List[dict]] = None
        self._save_timer: Optional[threading.Timer] = None
        self._save_timer_lock = threading.Lock()

        # Hydration cache: playlist_id -> _HydrationCacheEntry
        self._hydration_cache: Dict[str, _HydrationCacheEntry] = {}
        self._hydration_cache_lock = threading.Lock()
        # One lock per playlist so parallel /cover requests don't each glob the same folder.
        self._hydrate_pl_guard = threading.Lock()
        self._hydrate_pl_locks: Dict[str, threading.Lock] = {}

        self._load_playlists()
        self._sync_from_download_folders()
        self._reset_interrupted_downloads()
        self._ensure_liked_songs_playlist()

        set_track_status_change_listener(self._invalidate_error_rows_cache)

        n = _download_worker_count()
        for i in range(n):
            threading.Thread(
                target=self._worker_main, name=f"spolocal-dl-{i}", daemon=True
            ).start()

    def _data_file(self) -> Path:
        override = (os.environ.get("SPLOCAL_PLAYLISTS_PATH") or "").strip()
        if override:
            return Path(override)
        return self.root / "webapp_playlists.json"

    def _invalidate_error_rows_cache(self) -> None:
        self._error_rows_cache = None

    def _invalidate_hydration_cache(self, playlist_id: Optional[str] = None) -> None:
        """Invalidate hydration cache for a specific playlist or all playlists."""
        with self._hydration_cache_lock:
            if playlist_id:
                self._hydration_cache.pop(playlist_id, None)
            else:
                self._hydration_cache.clear()

    def _cleanup_hydration_cache(self, now: float) -> None:
        """Remove expired entries from the hydration cache."""
        expired = [k for k, v in self._hydration_cache.items() if v.expires_at <= now]
        for k in expired:
            self._hydration_cache.pop(k, None)

        if len(self._hydration_cache) <= _HYDRATION_CACHE_MAX_ENTRIES:
            return

        # LRU eviction: remove oldest entries by expiration time
        items = sorted(self._hydration_cache.items(), key=lambda kv: kv[1].expires_at)
        for k, _ in items[:len(self._hydration_cache) - _HYDRATION_CACHE_MAX_ENTRIES]:
            self._hydration_cache.pop(k, None)

    def _get_cached_hydration(self, playlist_id: str, now: float) -> Optional[_HydrationCacheEntry]:
        """Get cached hydration data if still valid."""
        with self._hydration_cache_lock:
            self._cleanup_hydration_cache(now)
            entry = self._hydration_cache.get(playlist_id)
            if entry and entry.expires_at > now:
                return entry
            return None

    def _set_cached_hydration(self, playlist_id: str, by_stem: Dict[str, Path]) -> _HydrationCacheEntry:
        """Store hydration data in cache."""
        now = _now_ts()
        entry = _HydrationCacheEntry(playlist_id, by_stem, now + _HYDRATION_CACHE_TTL_SECONDS)
        with self._hydration_cache_lock:
            self._hydration_cache[playlist_id] = entry
            self._cleanup_hydration_cache(now)
        return entry

    def _flush_playlists_to_disk(self) -> None:
        with self._lock:
            serializable = {}
            for pid, pl in self.playlists.items():
                serializable[pid] = {
                    "id": pl.id,
                    "name": pl.name,
                    "bio": pl.bio,
                    "created_at": pl.created_at.isoformat(),
                    "spotify_catalog_key": pl.spotify_catalog_key,
                    "spotify_snapshot_id": pl.spotify_snapshot_id,
                    "tracks": [
                        {
                            "id": t.id,
                            "title": t.title,
                            "artist": t.artist,
                            "url": t.url,
                            "status": t.status.value,
                            "error": t.error,
                            "added_at": t.added_at.isoformat(),
                            "media_relpath": t.media_relpath,
                            "media_variants": dict(t.media_variants or {}),
                            "cover_url": t.cover_url,
                            "youtube_video_id": t.youtube_video_id,
                            "album": t.album,
                            "liked_source_playlist_id": t.liked_source_playlist_id,
                            "liked_source_track_id": t.liked_source_track_id,
                        }
                        for t in pl.tracks
                    ],
                }
            path = self._data_file()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(serializable, indent=2), encoding="utf-8")

    def _save_playlists(self, *, immediate: bool = True) -> None:
        if immediate:
            with self._save_timer_lock:
                if self._save_timer is not None:
                    self._save_timer.cancel()
                    self._save_timer = None
            self._flush_playlists_to_disk()
            return

        def _fire() -> None:
            with self._save_timer_lock:
                self._save_timer = None
            self._flush_playlists_to_disk()

        with self._save_timer_lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
            self._save_timer = threading.Timer(0.45, _fire)
            self._save_timer.daemon = True
            self._save_timer.start()

    def _load_playlists(self) -> None:
        data_file = self._data_file()
        if not data_file.exists():
            return
        raw = json.loads(data_file.read_text(encoding="utf-8"))
        for _pid, pdata in raw.items():
            pl = _playlist_from_dict(pdata)
            self.playlists[pl.id] = pl

    def is_liked_songs_playlist(self, playlist_id: Optional[str]) -> bool:
        if not playlist_id:
            return False
        return str(playlist_id).strip() == self.LIKED_SONGS_PLAYLIST_ID

    def _ensure_liked_songs_playlist(self) -> None:
        pid = self.LIKED_SONGS_PLAYLIST_ID
        if pid in self.playlists:
            pl = self.playlists[pid]
            if pl.name != self.LIKED_SONGS_PLAYLIST_NAME:
                pl.name = self.LIKED_SONGS_PLAYLIST_NAME
                self._save_playlists()
            return
        pl = Playlist(
            id=pid,
            name=self.LIKED_SONGS_PLAYLIST_NAME,
            tracks=[],
            created_at=datetime.utcnow(),
            spotify_catalog_key=None,
            spotify_snapshot_id=None,
            bio=None,
        )
        self.playlists[pid] = pl
        self._save_playlists()

    def list_liked_entry_keys(self) -> List[str]:
        """Stable keys ``source_playlist_id|source_track_id`` for tracks saved to Liked Songs."""
        self._ensure_liked_songs_playlist()
        liked_pl = self.playlists.get(self.LIKED_SONGS_PLAYLIST_ID)
        if not liked_pl:
            return []
        keys: List[str] = []
        for t in liked_pl.tracks:
            sp = (t.liked_source_playlist_id or "").strip()
            st = (t.liked_source_track_id or "").strip()
            if sp and st:
                keys.append(f"{sp}|{st}")
        return keys

    def set_track_liked(self, source_playlist_id: str, source_track_id: str, liked: bool) -> bool:
        """Add/remove a playable track in the Liked Songs playlist (by source list + track id)."""
        spid = source_playlist_id.strip()
        stid = source_track_id.strip()
        if not spid or not stid:
            return False
        self._ensure_liked_songs_playlist()
        liked_pl = self.playlists.get(self.LIKED_SONGS_PLAYLIST_ID)
        if not liked_pl:
            return False

        if self.is_liked_songs_playlist(spid):
            if liked:
                return True
            track = liked_pl.get_track(stid)
            if not track:
                return False
            return self.delete_track(spid, stid, unlink_media=False)

        src_pl = self.get_playlist(spid)
        if not src_pl:
            return False
        src = src_pl.get_track(stid)
        if not src:
            return False
        if src.status != DownloadStatus.done or not self._track_has_resolved_file(src):
            return False

        if liked:
            for t in liked_pl.tracks:
                if (t.liked_source_playlist_id or "").strip() == spid and (t.liked_source_track_id or "").strip() == stid:
                    return True
            new_t = replace(
                src,
                id=str(uuid4()),
                liked_source_playlist_id=spid,
                liked_source_track_id=stid,
                added_at=datetime.utcnow(),
            )
            liked_pl.add_track(new_t)
            self._invalidate_hydration_cache(liked_pl.id)
            self._save_playlists()
            return True

        for t in list(liked_pl.tracks):
            if (t.liked_source_playlist_id or "").strip() == spid and (t.liked_source_track_id or "").strip() == stid:
                return self.delete_track(liked_pl.id, t.id, unlink_media=False)
        return True

    def _reset_interrupted_downloads(self) -> None:
        """
        Any track left in 'downloading' state means the server was killed mid-download.
        Reset them to 'queued' so they are re-enqueued when the worker starts.
        The worker calls _enqueue_download for these after _worker_main initialises.
        """
        changed = False
        for pl in self.playlists.values():
            for track in list(pl.tracks):
                if track.status == DownloadStatus.downloading:
                    pl.update_track_status(track.id, DownloadStatus.queued, None)
                    changed = True
        if changed:
            self._save_playlists()

    def _sync_from_download_folders(self) -> None:
        """Expose existing download folders as playlists in the UI."""
        downloads = self.root / "downloads"
        if not downloads.is_dir():
            return
        skip = {"youtube"}
        existing_names = {pl.name for pl in self.playlists.values()}
        changed = False
        for path in sorted(downloads.iterdir()):
            if not path.is_dir() or path.name.lower() in skip:
                continue
            if path.name in existing_names:
                continue
            audio_files = sorted(path.glob("*.mp3")) + sorted(path.glob("*.m4a"))
            if not audio_files:
                continue
            pl = Playlist.create(path.name)
            for f in audio_files:
                stem = f.stem
                if " - " in stem:
                    artist, title = stem.split(" - ", 1)
                else:
                    artist, title = "Unknown", stem
                tr = Track.create(title=title.strip(), artist=artist.strip())
                tr.status = DownloadStatus.done
                tr.media_relpath = f.relative_to(downloads).as_posix()
                pl.add_track(tr)
            self.playlists[pl.id] = pl
            existing_names.add(pl.name)
            changed = True
        if changed:
            self._save_playlists()

    def _playlist_by_catalog_key(self, key: Optional[str]) -> Optional[Playlist]:
        if not key:
            return None
        for pl in self.playlists.values():
            if pl.spotify_catalog_key == key:
                return pl
        return None

    def _find_track_by_spotify_id(self, pl: Playlist, spotify_track_id: Optional[str]) -> Optional[Track]:
        if not spotify_track_id:
            return None
        for t in pl.tracks:
            if spotify_track_id_from_url(t.url) == spotify_track_id:
                return t
        return None

    def _find_track_by_metadata(self, pl: Playlist, artist: str, title: str) -> Optional[Track]:
        for t in pl.tracks:
            if t.title == title and t.artist == artist:
                return t
        return None

    def _clear_stale_variant(self, track: Track, quality: str) -> None:
        """Drop a variant entry when its file is missing on disk."""
        qk = variant_key(parse_quality_kbps(quality))
        rel = (track.media_variants or {}).get(qk)
        if not rel:
            return
        try:
            exists = (self.root / "downloads" / rel).resolve().is_file()
        except OSError:
            exists = False
        if not exists and track.media_variants:
            track.media_variants.pop(qk, None)

    def _download_query_for_track(self, track: Track) -> str:
        """Best download target: Spotify/YouTube URL, known video id, or title search."""
        url = (track.url or "").strip()
        if url:
            return url
        vid = (track.youtube_video_id or "").strip()
        if vid:
            return f"https://www.youtube.com/watch?v={vid}"
        return f"{track.title} {track.artist}".strip()

    def _youtube_video_id_for_track(self, track: Track) -> str:
        vid = (track.youtube_video_id or "").strip()
        if vid:
            return vid
        for rel in (track.media_variants or {}).values():
            if not rel:
                continue
            m = re.search(r"\[([^\]]+)\]", Path(rel).name)
            if m:
                return m.group(1)
        if track.media_relpath:
            m = re.search(r"\[([^\]]+)\]", Path(track.media_relpath).name)
            if m:
                return m.group(1)
        return youtube_video_id_from_url(track.url) or ""

    def _relpath_matches_quality(self, relpath: str, qk: str) -> bool:
        """True when ``relpath`` exists on disk and matches quality key ``qk`` (e.g. ``64``, ``192``)."""
        try:
            if not (self.root / "downloads" / relpath).resolve().is_file():
                return False
        except OSError:
            return False
        inferred = kbps_from_relpath(relpath)
        want = variant_key(parse_quality_kbps(qk))
        if inferred is not None:
            return variant_key(inferred) == want
        return want == variant_key(DEFAULT_KBPS)

    def _track_can_queue_quality_download(self, track: Track) -> bool:
        if (track.url or "").strip() or (track.youtube_video_id or "").strip():
            return True
        if self._youtube_video_id_for_track(track):
            return True
        return bool((track.title or "").strip() and (track.artist or "").strip())

    def _track_has_resolved_file(self, track: Track, quality: Optional[str] = None) -> bool:
        variants = track.media_variants or {}
        if quality:
            qk = variant_key(parse_quality_kbps(quality))
            rel = variants.get(qk)
            if rel and self._relpath_matches_quality(rel, qk):
                return True
            if qk == variant_key(DEFAULT_KBPS) and track.media_relpath:
                return self._relpath_matches_quality(track.media_relpath, qk)
            return False
        for rel in variants.values():
            if not rel:
                continue
            try:
                if (self.root / "downloads" / rel).resolve().is_file():
                    return True
            except OSError:
                continue
        if track.media_relpath:
            try:
                return (self.root / "downloads" / track.media_relpath).resolve().is_file()
            except OSError:
                return False
        return False

    def create_playlist(self, name: str) -> Playlist:
        n = (name or "").strip()
        if n == self.LIKED_SONGS_PLAYLIST_NAME:
            raise ValueError("That name is reserved for the built-in Liked Songs playlist.")
        pl = Playlist.create(name)
        self.playlists[pl.id] = pl
        self._save_playlists()
        return pl

    def get_playlist(self, playlist_id: str) -> Optional[Playlist]:
        if playlist_id is None:
            return None
        key = str(playlist_id).strip()
        if not key:
            return None
        pl = self.playlists.get(key)
        if pl is not None:
            return pl
        key_lower = key.lower()
        for k, pl in self.playlists.items():
            if k.lower() == key_lower:
                return pl
        return None

    def _liked_source_track(self, track: Track) -> Optional[Track]:
        spid = (track.liked_source_playlist_id or "").strip()
        stid = (track.liked_source_track_id or "").strip()
        if not spid or not stid:
            return None
        src_pl = self.get_playlist(spid)
        if not src_pl:
            return None
        return src_pl.get_track(stid)

    def _sync_liked_track_media_from_source(self, track: Track) -> bool:
        """Copy media paths from the liked entry's source track when missing locally."""
        src = self._liked_source_track(track)
        if not src:
            return False
        sp_pl = self.get_playlist((track.liked_source_playlist_id or "").strip())
        if sp_pl:
            self.hydrate_media_paths(sp_pl, persist=False)
        changed = False
        if src.media_relpath and not track.media_relpath:
            track.media_relpath = src.media_relpath
            changed = True
        if src.media_variants and not track.media_variants:
            track.media_variants = dict(src.media_variants)
            changed = True
        if src.status == DownloadStatus.done and track.status != DownloadStatus.done:
            track.status = DownloadStatus.done
            changed = True
        return changed

    def get_track_audio_path(self, playlist_id: str, track_id: str) -> Optional[Path]:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.hydrate_media_paths(pl, persist=False)
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        media_track = track
        if self.is_liked_songs_playlist(pl.id):
            src = self._liked_source_track(track)
            if src:
                sp_pl = self.get_playlist((track.liked_source_playlist_id or "").strip())
                if sp_pl:
                    self.hydrate_media_paths(sp_pl, persist=False)
                media_track = src
            elif self._sync_liked_track_media_from_source(track):
                media_track = track
        if not media_track.media_relpath:
            return None
        audio_path = (self.root / "downloads" / media_track.media_relpath).resolve()
        downloads_root = (self.root / "downloads").resolve()
        try:
            if audio_path.is_file() and audio_path.is_relative_to(downloads_root):
                return audio_path
        except (OSError, ValueError):
            pass
        return None

    @staticmethod
    def export_filename_for_track(track: Track, audio_path: Path) -> str:
        """Human-readable attachment name: Artist - Title.ext."""
        artist = _sanitize_folder_name((track.artist or "").strip()) or "Unknown"
        title = _sanitize_folder_name((track.title or "").strip()) or "Track"
        stem = f"{artist} - {title}"
        if len(stem) > 180:
            stem = stem[:180].rstrip(". ")
        suffix = audio_path.suffix.lower() or ".mp3"
        return stem + suffix

    def get_track_export(self, playlist_id: str, track_id: str) -> Optional[Tuple[Path, str]]:
        """Audio path plus browser download filename, or None if missing."""
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        path = self.get_track_audio_path(playlist_id, track_id)
        if not path:
            return None
        return path, self.export_filename_for_track(track, path)

    def build_playlist_export_zip(self, playlist_id: str) -> Optional[Tuple[Path, str, int]]:
        """Zip downloaded tracks. Returns (temp_zip, zip_name, file_count) or None if playlist missing."""
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.hydrate_media_paths(pl, persist=False)
        entries: List[Tuple[Path, str]] = []
        used_names: Dict[str, int] = {}
        for track in pl.tracks:
            path = self.get_track_audio_path(pl.id, track.id)
            if not path:
                continue
            name = self.export_filename_for_track(track, path)
            key = name.lower()
            n = used_names.get(key, 0)
            used_names[key] = n + 1
            if n:
                stem = Path(name).stem
                suffix = Path(name).suffix
                name = f"{stem} ({n + 1}){suffix}"
            entries.append((path, name))
        if not entries:
            return None
        pl_name = _sanitize_folder_name(pl.name) or "playlist"
        zip_name = f"{pl_name}.zip"
        fd, tmp_name = tempfile.mkstemp(suffix=".zip", prefix="spolocal_export_")
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for path, name in entries:
                    zf.write(path, arcname=name)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return tmp_path, zip_name, len(entries)

    def get_track_info(self, playlist_id: str, track_id: str) -> Optional[dict]:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.hydrate_media_paths(pl, persist=False)
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        downloads_root = (self.root / "downloads").resolve()
        variants: Dict[str, str] = dict(track.media_variants or {})
        if track.media_relpath:
            variants.setdefault("192", track.media_relpath)
        files: List[dict] = []
        seen_relpaths: set[str] = set()
        for key, rel in sorted(variants.items(), key=lambda kv: parse_quality_kbps(kv[0])):
            if not rel or rel in seen_relpaths:
                continue
            seen_relpaths.add(rel)
            audio_path = (self.root / "downloads" / rel).resolve()
            try:
                if not audio_path.is_file() or not audio_path.is_relative_to(downloads_root):
                    continue
            except (OSError, ValueError):
                continue
            stats = read_audio_file_stats(audio_path)
            files.append({"kbps": parse_quality_kbps(key), "relpath": rel, **stats})
        st = track.status.value if hasattr(track.status, "value") else str(track.status)
        return {
            "title": track.title,
            "artist": track.artist,
            "album": track.album or "",
            "status": st,
            "added_at": track.added_at.isoformat(),
            "url": track.url or "",
            "youtube_video_id": track.youtube_video_id or "",
            "error": track.error or "",
            "files": files,
        }

    def get_lyrics_payload(self, playlist_id: str, track_id: str) -> dict:
        from lyrics_files import read_sidecar_lyrics, read_raw_lrc, parse_lrc_lines

        pl = self.get_playlist(playlist_id.strip())
        tid = track_id.strip()
        if not pl or not pl.get_track(tid):
            return {"lyrics": "", "source": "none", "has_audio": False, "lrc_data": None, "lrc_raw": None}
        path = self.get_track_audio_path(playlist_id, track_id)
        if not path:
            return {"lyrics": "", "source": "none", "has_audio": False, "lrc_data": None, "lrc_raw": None}
        side = read_sidecar_lyrics(path)
        if side:
            result = {"lyrics": side[0], "source": side[1], "has_audio": True, "lrc_data": None, "lrc_raw": None}
            # Include parsed LRC data and raw content for synced lyrics
            if side[1] == "lrc":
                raw_lrc = read_raw_lrc(path)
                if raw_lrc:
                    result["lrc_data"] = parse_lrc_lines(raw_lrc)
                    result["lrc_raw"] = raw_lrc
            return result
        emb = extract_lyrics(path)
        if emb and emb.strip():
            return {"lyrics": emb.strip(), "source": "embedded", "has_audio": True, "lrc_data": None, "lrc_raw": None}
        track = pl.get_track(tid)
        if track and on_demand_lyrics_fetch_enabled():
            plain, synced = fetch_lrclib_sidecar_sync(track.artist, track.title, force=True)
            if (plain and plain.strip()) or (synced and synced.strip()):
                materialize_lyrics_file_if_needed(path, None, plain, synced)
                again = read_sidecar_lyrics(path)
                if again:
                    result = {"lyrics": again[0], "source": again[1], "has_audio": True, "lrc_data": None, "lrc_raw": None}
                    if again[1] == "lrc":
                        raw_lrc = read_raw_lrc(path)
                        if raw_lrc:
                            result["lrc_data"] = parse_lrc_lines(raw_lrc)
                            result["lrc_raw"] = raw_lrc
                    return result
        return {"lyrics": "", "source": "none", "has_audio": True, "lrc_data": None, "lrc_raw": None}

    def save_track_lyrics_file(self, playlist_id: str, track_id: str, text: str) -> bool:
        from lyrics_files import save_user_lyrics

        path = self.get_track_audio_path(playlist_id, track_id)
        if not path:
            return False
        save_user_lyrics(path, text)
        return True

    def save_track_lrc_file(self, playlist_id: str, track_id: str, lines: list) -> bool:
        from lyrics_files import save_lrc_from_lines

        path = self.get_track_audio_path(playlist_id, track_id)
        if not path:
            return False
        save_lrc_from_lines(path, lines)
        return True

    def _resolve_variant_relpath(self, track: Track, quality: str) -> Optional[str]:
        """Find on-disk file for a quality variant (``__64k.mp3`` suffix + video id)."""
        qk = variant_key(parse_quality_kbps(quality))
        ytdir = (self.root / "downloads" / "youtube").resolve()
        if not ytdir.is_dir():
            return None
        vid = self._youtube_video_id_for_track(track)
        if not vid:
            return None
        suffix = f"__{qk}k"
        candidates: List[Path] = []
        for path in ytdir.rglob("*.mp3"):
            if suffix not in path.stem:
                continue
            if f"[{vid}]" not in path.name:
                continue
            candidates.append(path)
        if not candidates:
            return None
        newest = max(candidates, key=lambda p: p.stat().st_mtime)
        root_dl = (self.root / "downloads").resolve()
        return newest.resolve().relative_to(root_dl).as_posix()

    def list_playlist_catalog(self) -> List[dict]:
        """Lightweight list for /api/playlists/catalog (Add to playlist, etc.)."""
        rows: List[dict] = []
        for pl in sorted(
            self.playlists.values(),
            key=lambda p: (0 if p.id == self.LIKED_SONGS_PLAYLIST_ID else 1, (p.name or "").lower()),
        ):
            tiles = [f"/playlists/{pl.id}/tracks/{t.id}/cover" for t in pl.tracks[:4]]
            rows.append(
                {
                    "id": pl.id,
                    "name": pl.name,
                    "bio": pl.bio or "",
                    "cover_tiles": tiles,
                    "system_locked": self.is_liked_songs_playlist(pl.id),
                }
            )
        return rows

    def list_playlist_nav(self, current_id: Optional[str]) -> List[dict]:
        """Sidebar rows: id, name, cover_tiles, active (avoids passing full playlist objects to the template)."""
        cur = (current_id or "").strip()
        rows: List[dict] = []
        for pl in sorted(
            self.playlists.values(),
            key=lambda p: (0 if p.id == self.LIKED_SONGS_PLAYLIST_ID else 1, (p.name or "").lower()),
        ):
            tiles = [f"/playlists/{pl.id}/tracks/{t.id}/cover" for t in pl.tracks[:4]]
            rows.append(
                {
                    "id": pl.id,
                    "name": pl.name,
                    "cover_tiles": tiles,
                    "active": bool(cur and pl.id == cur),
                    "system_locked": self.is_liked_songs_playlist(pl.id),
                }
            )
        return rows

    def _materialize_lyrics_after_download(self, track: Track) -> None:
        if not track.media_relpath:
            return
        ap = (self.root / "downloads" / track.media_relpath).resolve()
        if not ap.is_file():
            return
        remote_plain, remote_synced = fetch_lrclib_sidecar_sync(track.artist, track.title)
        has_remote = (remote_plain and remote_plain.strip()) or (remote_synced and remote_synced.strip())
        emb = extract_lyrics(ap) if not has_remote else None
        materialize_lyrics_file_if_needed(ap, emb, remote_plain, remote_synced)

    def _preemptive_cover_tile_generation(self, pl_id: str, track_id: str) -> None:
        """Generate cover tile preemptively after download to avoid slow first request."""
        try:
            from cover_image import DEFAULT_THUMB_MAX_SIDE, square_thumb_jpeg
            from tag_metadata import extract_cover

            pid = pl_id.strip()
            tid = track_id.strip()
            cpath = self.root / "webapp" / "static" / "cover_tiles"
            cpath.mkdir(parents=True, exist_ok=True)

            safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in pid)[:120]
            safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in tid)[:120]
            tile_path = cpath / f"{safe_p}_{safe_t}_s{DEFAULT_THUMB_MAX_SIDE}.jpg"

            # Skip if already exists
            if tile_path.is_file():
                return

            # Get audio path
            audio_path = self.get_track_audio_path(pid, tid)
            if not audio_path:
                return

            # Extract cover and generate thumbnail
            blob = extract_cover(audio_path)
            if not blob:
                return

            raw, _ = blob
            processed = square_thumb_jpeg(raw)
            if processed:
                tile_path.write_bytes(processed)
        except Exception:
            # Non-critical - don't fail downloads if cover generation fails
            pass

    def delete_playlist(self, playlist_id: str) -> bool:
        key = playlist_id.strip()
        if self.is_liked_songs_playlist(key):
            return False
        with self._lock:
            if key in self.playlists:
                del self.playlists[key]
            else:
                alt = next((k for k, pl in self.playlists.items() if pl.id == key), None)
                if alt is None:
                    return False
                del self.playlists[alt]
        self._invalidate_error_rows_cache()
        self._save_playlists()
        return True

    def update_playlist_meta(
        self,
        playlist_id: str,
        *,
        name: Optional[str] = None,
        bio: Optional[str] = None,
    ) -> bool:
        """Update playlist name and/or bio. ``name`` must be non-empty when provided."""
        key = playlist_id.strip()
        if self.is_liked_songs_playlist(key):
            return False
        if name is None and bio is None:
            return False
        with self._lock:
            pl = self.playlists.get(key)
            if pl is None:
                pl = next((p for p in self.playlists.values() if p.id == key), None)
            if pl is None:
                return False
            if name is not None:
                n = name.strip()
                if not n:
                    return False
                pl.name = n
            if bio is not None:
                b = bio.strip()
                pl.bio = b if b else None
        self._save_playlists()
        return True

    def list_playlists(self) -> List[Playlist]:
        return sorted(
            list(self.playlists.values()),
            key=lambda p: (0 if p.id == self.LIKED_SONGS_PLAYLIST_ID else 1, (p.name or "").lower()),
        )

    def downloads_remaining_count(self) -> int:
        """How many downloads are still in the pipeline (queued, running, or supplementary)."""
        pipeline = self.job_queue.qsize() + len(self.progress)
        status_n = 0
        for pl in self.playlists.values():
            for t in pl.tracks:
                if t.status in (DownloadStatus.queued, DownloadStatus.downloading):
                    status_n += 1
        return max(pipeline, status_n)

    def error_tracks_for_sidebar(self) -> List[dict]:
        """All tracks in error state (any playlist), for the downloads sidebar."""
        if self._error_rows_cache is None:
            rows: List[dict] = []
            for pl in self.playlists.values():
                for t in pl.tracks:
                    if t.status != DownloadStatus.error:
                        continue
                    rows.append(
                        {
                            "playlist_id": pl.id,
                            "playlist_name": pl.name,
                            "track_id": t.id,
                            "title": t.title,
                            "artist": t.artist,
                            "error": t.error or "",
                        }
                    )
            self._error_rows_cache = rows
        return self._error_rows_cache

    def retry_all_error_tracks(self) -> int:
        """Re-queue every track currently in error state (all playlists). Returns how many were queued."""
        n = 0
        for pl in self.playlists.values():
            for t in list(pl.tracks):
                if t.status != DownloadStatus.error:
                    continue
                if self.start_track_download(pl.id, t.id, force_redownload=False):
                    n += 1
        return n

    def _track_content_key(self, track: Track) -> str:
        """Stable key for deduping the same song across playlists."""
        vid = self._youtube_video_id_for_track(track)
        if vid:
            return f"yt:{vid}"
        sid = spotify_track_id_from_url(track.url)
        if sid:
            return f"sp:{sid}"
        artist = (track.artist or "").strip().lower()
        title = (track.title or "").strip().lower()
        if artist and title:
            return f"meta:{artist}|{title}"
        return f"id:{track.id}"

    def _tally_playlist_quality_downloads(
        self,
        pl: Playlist,
        q: str,
        seen: Optional[set[str]] = None,
    ) -> dict[str, int]:
        """Count queue outcomes for one playlist. ``seen`` dedupes library-wide bulk runs."""
        if self.is_liked_songs_playlist(pl.id):
            return {"queued": 0, "already_have": 0, "ineligible": 0, "duplicates": 0}
        self.hydrate_media_paths(pl, fill_albums=False, persist=False)
        queued = 0
        already_have = 0
        ineligible = 0
        duplicates = 0
        for t in pl.tracks:
            key = self._track_content_key(t)
            if seen is not None:
                if key in seen:
                    duplicates += 1
                    continue
                seen.add(key)
            if not self._track_can_queue_quality_download(t):
                ineligible += 1
                continue
            if self._track_has_resolved_file(t, q):
                already_have += 1
                continue
            if self.start_track_download(pl.id, t.id, quality=q):
                queued += 1
            else:
                ineligible += 1
        return {
            "queued": queued,
            "already_have": already_have,
            "ineligible": ineligible,
            "duplicates": duplicates,
        }

    def queue_playlist_quality_downloads(self, playlist_id: str, quality: str) -> Optional[dict]:
        """Queue downloads for every track missing the given quality variant. Returns None if playlist missing."""
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return None
        q = variant_key(parse_quality_kbps(quality))
        tallies = self._tally_playlist_quality_downloads(pl, q)
        skipped = tallies["already_have"] + tallies["ineligible"]
        return {
            "queued": tallies["queued"],
            "skipped": skipped,
            "already_have": tallies["already_have"],
            "ineligible": tallies["ineligible"],
            "duplicates": tallies["duplicates"],
            "quality": q,
        }

    def queue_all_quality_downloads(self, quality: str) -> dict:
        """Queue missing quality variants across all playlists (excluding Liked Songs)."""
        q = variant_key(parse_quality_kbps(quality))
        seen: set[str] = set()
        queued = 0
        already_have = 0
        ineligible = 0
        duplicates = 0
        for pl in self.playlists.values():
            tallies = self._tally_playlist_quality_downloads(pl, q, seen)
            queued += tallies["queued"]
            already_have += tallies["already_have"]
            ineligible += tallies["ineligible"]
            duplicates += tallies["duplicates"]
        skipped = already_have + ineligible
        return {
            "queued": queued,
            "skipped": skipped,
            "already_have": already_have,
            "ineligible": ineligible,
            "duplicates": duplicates,
            "quality": q,
        }

    def progress_api_payload(self) -> dict:
        """Shape used by GET /api/progress (active jobs + queue summary)."""
        err_all = self.error_tracks_for_sidebar()
        max_err = 120
        err_slice = err_all[:max_err]
        return {
            "jobs": dict(self.progress),
            "remaining": self.downloads_remaining_count(),
            "queue_depth": self.job_queue.qsize(),
            "errors": err_slice,
            "errors_total": len(err_all),
        }

    def _hydrate_lock_for_playlist(self, playlist_id: str) -> threading.Lock:
        with self._hydrate_pl_guard:
            lk = self._hydrate_pl_locks.get(playlist_id)
            if lk is None:
                lk = threading.Lock()
                self._hydrate_pl_locks[playlist_id] = lk
            return lk

    def hydrate_media_paths(self, pl: Optional[Playlist], *, fill_albums: bool = False, persist: bool = True) -> None:
        """If files exist on disk but JSON has no path, attach media_relpath; optionally read album tags.
        `persist` controls whether discovered media/albums are flushed to disk.
        Uses in-memory caching to avoid repeated filesystem scans.
        """
        if pl is None:
            return

        with self._hydrate_lock_for_playlist(pl.id):
            now = _now_ts()
            cache_entry = self._get_cached_hydration(pl.id, now)

            sub = _sanitize_folder_name(pl.name)
            base = self.root / "downloads" / sub
            changed = False

            if cache_entry:
                # Use cached stem-to-path mapping
                by_stem = cache_entry.by_stem
            else:
                # Build fresh mapping and cache it
                by_stem: Dict[str, Path] = {}
                if base.is_dir():
                    by_stem = {p.stem: p for p in list(base.glob("*.mp3")) + list(base.glob("*.m4a"))}
                cache_entry = self._set_cached_hydration(pl.id, by_stem)

            # Match tracks to files using cached mapping
            for t in pl.tracks:
                if t.media_relpath or t.status != DownloadStatus.done:
                    continue
                key = f"{t.artist} - {t.title}"
                hit = by_stem.get(key)
                if hit is None:
                    hit = next((by_stem[s] for s in by_stem if t.title.lower() in s.lower()), None)
                if hit is not None:
                    t.media_relpath = hit.relative_to(self.root / "downloads").as_posix()
                    changed = True

            if fill_albums:
                changed = self._hydrate_albums_cached(pl, cache_entry, persist) or changed

            if self.is_liked_songs_playlist(pl.id):
                for t in pl.tracks:
                    if self._sync_liked_track_media_from_source(t):
                        changed = True

            if changed and persist:
                self._save_playlists()

    def _hydrate_albums_for_playlist(self, pl: Playlist) -> bool:
        """Legacy album hydration - reads all files immediately. Consider using _hydrate_albums_cached for lazy loading."""
        downloads = self.root / "downloads"
        changed = False
        for t in pl.tracks:
            if t.status != DownloadStatus.done or not t.media_relpath:
                continue
            if t.album and str(t.album).strip():
                continue
            p = downloads / t.media_relpath
            try:
                rp = p.resolve()
            except OSError:
                continue
            if not rp.is_file():
                continue
            try:
                rp.relative_to(downloads.resolve())
            except ValueError:
                continue
            alb = extract_album(p)
            if alb:
                t.album = alb
                changed = True
        return changed

    def _hydrate_albums_cached(self, pl: Playlist, cache_entry: _HydrationCacheEntry, persist: bool) -> bool:
        """Lazy album hydration using cache - only reads files without cached album data."""
        downloads = self.root / "downloads"
        changed = False

        for t in pl.tracks:
            if t.status != DownloadStatus.done or not t.media_relpath:
                continue
            if t.album and str(t.album).strip():
                continue

            # Check cached album data first
            cached_album = cache_entry.albums.get(t.id)
            if cached_album is not None:
                t.album = cached_album if cached_album else None
                if cached_album:
                    changed = True
                continue

            # Not cached - read from file and store in cache
            p = downloads / t.media_relpath
            try:
                rp = p.resolve()
            except OSError:
                cache_entry.albums[t.id] = None
                continue
            if not rp.is_file():
                cache_entry.albums[t.id] = None
                continue
            try:
                rp.relative_to(downloads.resolve())
            except ValueError:
                cache_entry.albums[t.id] = None
                continue

            alb = extract_album(p)
            cache_entry.albums[t.id] = alb
            if alb:
                t.album = alb
                changed = True

        return changed

    def _worker_main(self) -> None:
        # Each thread owns its own YtDlpAudioDownloader — yt-dlp is not thread-safe to share.
        local_ytdlp = YtDlpAudioDownloader(self.root)

        # Only the first thread to arrive re-enqueues interrupted tracks.
        with self._lock:
            if not self._startup_enqueue_done:
                self._startup_enqueue_done = True
                for pl in list(self.playlists.values()):
                    for track in list(pl.tracks):
                        if track.status == DownloadStatus.queued and not self._track_has_resolved_file(track):
                            self._enqueue_download(pl.id, track.id)

        while True:
            job = self.job_queue.get()
            try:
                job(local_ytdlp)
            except Exception:
                logging.getLogger(__name__).exception("Download worker job failed")
            finally:
                self.job_queue.task_done()

    def import_from_line(self, raw: str) -> Playlist:
        """
        Top bar: Spotify playlist/track URL, YouTube video URL, or plain words (YouTube search).
        """
        s = (raw or "").strip()
        if not s:
            raise ValueError("Enter a Spotify or YouTube link, or type a song / artist to search.")

        low = s.lower()

        if "open.spotify.com" in low or low.startswith("spotify:"):
            try:
                kind, _sid = detect_spotify_url_type(s)
            except ValueError:
                raise ValueError(
                    "That Spotify link doesn’t look valid. Use a playlist or track URL "
                    "(open.spotify.com/…), or type words to search YouTube."
                ) from None
            if kind == "playlist":
                return self._import_spotify_playlist(s)
            if kind == "track":
                return self._import_spotify_track(s)
            if kind == "album":
                raise ValueError(
                    "Album links aren’t supported in this box yet. Use a playlist or track link, "
                    "or search by song name."
                )

        if low.startswith("http://") or low.startswith("https://"):
            if "youtube.com" in low or "youtu.be" in low:
                return self._import_youtube_video_url(s)
            raise ValueError(
                "Only Spotify and YouTube URLs work here. For other sites, open a playlist and use Add song."
            )

        hits = search_youtube_tracks(self.root, s, 1)
        if not hits:
            raise ValueError(
                f'No YouTube results for “{s}”. Try different words or paste an open.spotify.com or YouTube link.'
            )
        h = hits[0]
        label = s[:56] + ("…" if len(s) > 57 else "")
        pl = Playlist.create(f"Search: {label}")
        self.playlists[pl.id] = pl
        track = Track.create(title=h["title"], artist=h["artist"], url=h["url"])
        vid = h.get("video_id")
        if isinstance(vid, str) and vid:
            track.youtube_video_id = vid
        alb = h.get("album")
        if isinstance(alb, str) and alb.strip():
            track.album = alb.strip()[:500]
        pl.add_track(track)
        self._enqueue_download(pl.id, track.id)
        self._invalidate_hydration_cache(pl.id)  # Invalidate cache for new playlist
        self._save_playlists()
        return pl

    def import_spotify_playlist(self, spotify_url: str) -> Playlist:
        """Same as the top bar importer (not playlists-only). Kept for clarity / callers."""
        return self.import_from_line(spotify_url)

    def _import_youtube_video_url(self, url: str) -> Playlist:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "socket_timeout": 25,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        title = (info.get("title") or "Video").strip()
        uploader = (info.get("uploader") or info.get("channel") or "YouTube").strip()
        pl = Playlist.create(title[:100] or "YouTube")
        self.playlists[pl.id] = pl
        track = Track.create(title=title[:300], artist=uploader[:300], url=url.strip())
        yid = youtube_video_id_from_url(url) or (
            str(info.get("id")) if info.get("id") else None
        )
        if yid:
            track.youtube_video_id = yid
        alb = info.get("album")
        if isinstance(alb, str) and alb.strip():
            track.album = alb.strip()[:500]
        pl.add_track(track)
        self._enqueue_download(pl.id, track.id)
        self._invalidate_hydration_cache(pl.id)
        self._save_playlists()
        return pl

    def _import_spotify_track(self, spotify_url: str) -> Playlist:
        catalog_key = spotify_catalog_key_from_import_url(spotify_url)
        info = self._embed.get_track_info(spotify_url)
        existing_pl = self._playlist_by_catalog_key(catalog_key)
        name = f"{info.artists} — {info.title}"
        if len(name) > 120:
            name = name[:117] + "…"
        pl = existing_pl
        if pl is None:
            pl = Playlist.create(name or "Imported track")
            pl.spotify_catalog_key = catalog_key
            self.playlists[pl.id] = pl
        else:
            self.hydrate_media_paths(pl)

        sid = info.id
        existing = self._find_track_by_spotify_id(pl, sid) or self._find_track_by_metadata(
            pl, info.artists, info.title
        )
        if existing:
            if existing.status not in (DownloadStatus.queued, DownloadStatus.downloading):
                self.hydrate_media_paths(pl)
                if not (
                    existing.status == DownloadStatus.done and self._track_has_resolved_file(existing)
                ):
                    if info.cover_url and not existing.cover_url:
                        existing.cover_url = info.cover_url
                    if info.album and not existing.album:
                        existing.album = (info.album or "").strip()[:500] or None
                    self._enqueue_download(pl.id, existing.id)
            self._invalidate_hydration_cache(pl.id)
            self._save_playlists()
            return pl

        track = Track.create(title=info.title, artist=info.artists, url=info.spotify_url)
        track.cover_url = info.cover_url
        if info.album and str(info.album).strip():
            track.album = str(info.album).strip()[:500]
        pl.add_track(track)
        self._enqueue_download(pl.id, track.id)
        self._invalidate_hydration_cache(pl.id)
        self._save_playlists()
        return pl

    def _import_spotify_playlist(self, spotify_url: str) -> Playlist:
        catalog_key = spotify_catalog_key_from_import_url(spotify_url)
        existing_pl = self._playlist_by_catalog_key(catalog_key)

        # Fetch metadata directly — no need to queue behind pending downloads.
        meta, track_infos = self._embed.get_playlist_info(spotify_url)
        if not track_infos:
            raise ValueError("No tracks found for that Spotify URL")

        name = (meta.name or "").strip() or "Imported Playlist"
        pl = existing_pl
        if pl is None:
            pl = Playlist.create(name)
            pl.spotify_catalog_key = catalog_key
            self.playlists[pl.id] = pl
        else:
            if name and pl.name != name:
                pl.name = name
            self.hydrate_media_paths(pl)

        for info in track_infos:
            sid = info.id
            existing = (
                self._find_track_by_spotify_id(pl, sid)
                or self._find_track_by_metadata(pl, info.artists, info.title)
            )
            if existing:
                if existing.status in (DownloadStatus.queued, DownloadStatus.downloading):
                    continue
                self.hydrate_media_paths(pl)
                if existing.status == DownloadStatus.done and self._track_has_resolved_file(existing):
                    continue
                # Update cover_url in case it changed
                if info.cover_url and not existing.cover_url:
                    existing.cover_url = info.cover_url
                if info.album and not existing.album:
                    existing.album = (info.album or "").strip()[:500] or None
                self._enqueue_download(pl.id, existing.id)
                continue

            track = Track.create(
                title=info.title,
                artist=info.artists,
                url=info.spotify_url,
            )
            track.cover_url = info.cover_url
            if info.album and str(info.album).strip():
                track.album = str(info.album).strip()[:500]
            pl.add_track(track)
            self._enqueue_download(pl.id, track.id)

        self._invalidate_hydration_cache(pl.id)
        self._save_playlists()
        return pl

    def add_track_to_playlist(
        self,
        playlist_id: str,
        title: str,
        artist: str,
        url: Optional[str] = None,
        album: Optional[str] = None,
        *,
        enqueue_download: bool = True,
        download_quality: str = str(DEFAULT_KBPS),
    ) -> Track:
        pl = self.get_playlist(playlist_id)
        if not pl:
            raise KeyError("Playlist not found")
        if self.is_liked_songs_playlist(playlist_id):
            raise ValueError("Add songs to Liked Songs using the heart button on the player.")
        track = Track.create(title=title, artist=artist, url=url)
        if album and isinstance(album, str) and album.strip():
            track.album = album.strip()[:500]
        yid = youtube_video_id_from_url(url)
        if yid:
            track.youtube_video_id = yid
        if not enqueue_download:
            track.status = DownloadStatus.pending
        pl.add_track(track)
        if enqueue_download:
            self._enqueue_download(playlist_id, track.id, quality=download_quality)
        self._invalidate_hydration_cache(pl.id)  # Invalidate cache on new track
        self._save_playlists()
        return track

    def start_track_download(
        self,
        playlist_id: str,
        track_id: str,
        *,
        force_redownload: bool = False,
        quality: str = str(DEFAULT_KBPS),
    ) -> bool:
        """Queue a pending (or retry failed) track for download."""
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return False
        track = pl.get_track(track_id.strip())
        if not track:
            return False
        q = variant_key(parse_quality_kbps(quality))
        if self._track_has_resolved_file(track, q) and not force_redownload:
            if track.status != DownloadStatus.done:
                pl.update_track_status(track.id, DownloadStatus.done, None)
                self._save_playlists()
            return True
        if force_redownload:
            if not (track.url or track.youtube_video_id):
                return False
            rel = (track.media_variants or {}).get(q) or (track.media_relpath if q == "192" else None)
            if rel:
                audio_path = (self.root / "downloads" / rel).resolve()
                downloads_root = (self.root / "downloads").resolve()
                try:
                    if audio_path.is_file() and audio_path.is_relative_to(downloads_root):
                        delete_lyrics_sidecars(audio_path)
                        audio_path.unlink()
                except OSError:
                    pass
                if track.media_variants and q in track.media_variants:
                    del track.media_variants[q]
            if track.status != DownloadStatus.downloading:
                pl.update_track_status(track.id, DownloadStatus.queued, None)
            self._save_playlists()
            self._enqueue_download(playlist_id.strip(), track.id, quality=q, supplementary=track.status == DownloadStatus.done)
            return True
        if not self._track_has_resolved_file(track, q):
            supplementary = track.status == DownloadStatus.done or self._track_has_resolved_file(track)
            if supplementary:
                self._enqueue_download(playlist_id.strip(), track.id, quality=q, supplementary=True)
                return True
            st = track.status
            if st in (DownloadStatus.downloading, DownloadStatus.queued):
                self._enqueue_download(playlist_id.strip(), track.id, quality=q, supplementary=True)
                return True
            if st not in (DownloadStatus.pending, DownloadStatus.error):
                return False
            pl.update_track_status(track.id, DownloadStatus.queued, None)
            self._save_playlists()
            self._enqueue_download(playlist_id.strip(), track.id, quality=q)
            return True
        if track.status != DownloadStatus.done:
            pl.update_track_status(track.id, DownloadStatus.done, None)
            self._save_playlists()
        return True

    def delete_track(self, playlist_id: str, track_id: str, *, unlink_media: bool = True) -> bool:
        pl = self.get_playlist(playlist_id.strip())
        if not pl:
            return False
        tid = track_id.strip()
        track = pl.get_track(tid)
        if not track:
            return False
        if unlink_media and track.media_relpath:
            audio_path = (self.root / "downloads" / track.media_relpath).resolve()
            downloads_root = (self.root / "downloads").resolve()
            try:
                if audio_path.is_file() and audio_path.is_relative_to(downloads_root):
                    delete_lyrics_sidecars(audio_path)
                    audio_path.unlink()
            except OSError:
                pass
        pl.remove_track(tid)
        self._invalidate_hydration_cache(pl.id)  # Invalidate cache on track deletion
        self._save_playlists()
        return True

    def _make_progress_hook(self, track_id: str, title: str, artist: str):
        def hook(d: dict) -> None:
            status = d.get("status", "")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes") or 0
                pct = round((downloaded / total) * 100, 1) if total else None
                speed = d.get("speed")
                eta = d.get("eta")
                self.progress[track_id] = {
                    "title": title,
                    "artist": artist,
                    "percent": pct,
                    "speed": round(speed / 1024, 1) if speed else None,  # KB/s
                    "eta": int(eta) if eta else None,
                    "phase": "downloading",
                }
            elif status == "finished":
                self.progress[track_id] = {
                    "title": title,
                    "artist": artist,
                    "percent": 100,
                    "speed": None,
                    "eta": None,
                    "phase": "converting",
                }
        return hook

    def _enqueue_download(self, pl_id: str, track_id: str, *, quality: str = str(DEFAULT_KBPS), supplementary: bool = False) -> None:
        q = variant_key(parse_quality_kbps(quality))
        job_key = (track_id, q)
        with self._lock:
            if job_key in self._pending_job_keys:
                return
            self._pending_job_keys.add(job_key)

        def job(ytdlp: YtDlpAudioDownloader) -> None:
            try:
                pl = self.get_playlist(pl_id)
                track = pl.get_track(track_id) if pl else None
                if not track:
                    return

                if self._track_has_resolved_file(track, q):
                    if not supplementary and track.status != DownloadStatus.done:
                        pl.update_track_status(track_id, DownloadStatus.done)
                        self._save_playlists(immediate=False)
                    return

                if not supplementary:
                    pl.update_track_status(track_id, DownloadStatus.downloading)

                hook = self._make_progress_hook(track_id, track.title, track.artist)
                self.progress[track_id] = {
                    "title": track.title,
                    "artist": track.artist,
                    "percent": None,
                    "speed": None,
                    "eta": None,
                    "phase": "searching",
                    "quality": q,
                }

                if track.url and "open.spotify.com" in track.url:
                    sub = _sanitize_folder_name(pl.name)
                    out_dir = (self.root / "downloads" / sub)
                    path, yid = self._embed.download_track(
                        artist=track.artist,
                        title=track.title,
                        out_dir=out_dir,
                        cover_url=track.cover_url,
                        progress_hook=hook,
                        quality=q,
                    )
                    if yid:
                        track.youtube_video_id = yid
                    if path is not None:
                        root_dl = (self.root / "downloads").resolve()
                        try:
                            rel = path.resolve().relative_to(root_dl).as_posix()
                            track.set_media_variant(q, rel)
                        except ValueError:
                            pass
                    if not self._track_has_resolved_file(track, q):
                        rel = self._resolve_variant_relpath(track, q)
                        if rel:
                            track.set_media_variant(q, rel)
                else:
                    query = self._download_query_for_track(track)
                    yid, out_path = ytdlp.download_from_line(query, progress_hook=hook, quality=q)
                    if yid:
                        track.youtube_video_id = yid
                    root_dl = (self.root / "downloads").resolve()
                    if out_path is not None and out_path.is_file():
                        try:
                            rel = out_path.resolve().relative_to(root_dl).as_posix()
                            track.set_media_variant(q, rel)
                        except ValueError:
                            pass
                    if not self._track_has_resolved_file(track, q):
                        rel = self._resolve_variant_relpath(track, q)
                        if rel:
                            track.set_media_variant(q, rel)

                if self._track_has_resolved_file(track, q):
                    self._materialize_lyrics_after_download(track)
                    self._preemptive_cover_tile_generation(pl_id, track_id)
                    self._invalidate_hydration_cache(pl_id)
                    if not supplementary or track.status != DownloadStatus.done:
                        pl.update_track_status(track_id, DownloadStatus.done)
                elif supplementary:
                    self._clear_stale_variant(track, q)
                    logging.getLogger(__name__).warning(
                        "Supplementary download for %s kbps did not produce a file for track %s",
                        q,
                        track_id,
                    )
                else:
                    err = (
                        "No YouTube match found. The track may be very obscure or region-locked on YouTube."
                        if track.url and "open.spotify.com" in track.url
                        else "No audio file found under downloads/youtube after YouTube download."
                    )
                    pl.update_track_status(track_id, DownloadStatus.error, err)

            except Exception as exc:
                if supplementary:
                    if track:
                        self._clear_stale_variant(track, q)
                    logging.getLogger(__name__).exception(
                        "Supplementary download failed for track %s at %s kbps",
                        track_id,
                        q,
                    )
                elif pl:
                    pl.update_track_status(track_id, DownloadStatus.error, str(exc))
            finally:
                with self._lock:
                    self._pending_job_keys.discard(job_key)
                self.progress.pop(track_id, None)
                try:
                    delay = float(
                        (
                            os.environ.get("SPOLOCAL_DOWNLOAD_DELAY_SEC")
                            or os.environ.get("SPRITY_DOWNLOAD_DELAY_SEC")
                            or "0"
                        ).strip()
                    )
                except ValueError:
                    delay = 0.0
                if delay > 0:
                    time.sleep(delay)
                self._save_playlists(immediate=False)

        self.job_queue.put(job)
