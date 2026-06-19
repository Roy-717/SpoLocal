"""Spotify playlist/track metadata via embed pages — no API credentials needed.

Primary:  /embed/playlist/{id}  → up to 100 tracks from __NEXT_DATA__ JSON blob
Fallback: spclient API          → full track list for large playlists (uses anon token
                                   extracted from the embed page)
Single:   /embed/track/{id}     → per-track metadata for the overflow tracks

Credit: approach from github.com/sunnypatell/sunnify-spotify-downloader
"""

from __future__ import annotations

import functools
import json
import re
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

import requests

T = TypeVar("T")

_DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


class SpotifyDownAPIError(RuntimeError):
    pass

class NetworkError(SpotifyDownAPIError):
    pass

class ExtractionError(SpotifyDownAPIError):
    pass

class RateLimitError(SpotifyDownAPIError):
    pass


def retry_on_network_error(
    max_attempts: int = 3,
    backoff_factor: float = 1.0,
    exceptions: tuple = (NetworkError, RateLimitError, requests.Timeout, requests.ConnectionError),
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args, **kwargs) -> T:
            last_exception = None
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_exception = e
                    if attempt < max_attempts - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
            raise last_exception  # type: ignore
        return wrapper
    return decorator


@dataclass
class PlaylistInfo:
    name: str
    owner: str | None
    description: str | None
    cover_url: str | None
    track_count: int | None = None


@dataclass
class TrackInfo:
    id: str
    title: str
    artists: str
    album: str | None
    release_date: str | None
    cover_url: str | None
    duration_ms: int | None
    preview_url: str | None
    raw: dict

    @property
    def spotify_url(self) -> str:
        return f"https://open.spotify.com/track/{self.id}"


class SpotifyEmbedAPI:
    _EMBED_PLAYLIST_URL = "https://open.spotify.com/embed/playlist/{playlist_id}"
    _EMBED_TRACK_URL = "https://open.spotify.com/embed/track/{track_id}"
    _OEMBED_URL = "https://open.spotify.com/oembed"
    _SPCLIENT_URL = "https://spclient.wg.spotify.com/playlist/v2/playlist/{playlist_id}"
    _NEXT_DATA_PATTERN = re.compile(r'<script id="__NEXT_DATA__"[^>]*>([^<]+)</script>')

    def __init__(self, *, session: requests.Session | None = None) -> None:
        self._session = session or requests.Session()
        self._cached_token: str | None = None
        self._token_expiry: float = 0

    @staticmethod
    def _deep_find(data: dict, key: str, max_depth: int = 6) -> dict | None:
        if not isinstance(data, dict) or max_depth <= 0:
            return None
        if key in data:
            return data
        for v in data.values():
            if isinstance(v, dict):
                result = SpotifyEmbedAPI._deep_find(v, key, max_depth - 1)
                if result is not None:
                    return result
        return None

    @staticmethod
    def _resolve_path(data: dict, path: tuple) -> Any:
        result: Any = data
        for key in path:
            if not isinstance(result, dict):
                return None
            result = result.get(key)
        return result

    def _headers(self) -> dict:
        return {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": _DEFAULT_USER_AGENT,
        }

    @retry_on_network_error(max_attempts=4, backoff_factor=1.5)
    def _fetch_embed_data(self, url: str) -> dict:
        try:
            response = self._session.get(url, headers=self._headers(), timeout=30)
        except (requests.Timeout, requests.ConnectionError) as exc:
            raise NetworkError(f"Network error: {exc}") from exc
        except requests.RequestException as exc:
            raise SpotifyDownAPIError(f"Request failed: {exc}") from exc

        if response.status_code == 429:
            raise RateLimitError("Rate limited by Spotify embed page")
        if response.status_code in (401, 403):
            raise ExtractionError(f"Access denied (HTTP {response.status_code}) — playlist may be private")
        if response.status_code != 200:
            raise NetworkError(f"Embed page returned HTTP {response.status_code}")

        match = self._NEXT_DATA_PATTERN.search(response.text)
        if not match:
            raise ExtractionError("Could not find __NEXT_DATA__ in embed page")

        try:
            data = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            raise ExtractionError(f"Invalid JSON in __NEXT_DATA__: {exc}") from exc

        for path in (
            ("props", "pageProps", "state", "settings", "session"),
            ("props", "pageProps", "settings", "session"),
            ("props", "pageProps", "session"),
        ):
            session_data = self._resolve_path(data, path)
            if isinstance(session_data, dict) and "accessToken" in session_data:
                self._cached_token = session_data.get("accessToken")
                expiry_ms = session_data.get("accessTokenExpirationTimestampMs", 0)
                self._token_expiry = expiry_ms / 1000 if expiry_ms else 0
                break

        return data

    _ENTITY_PATHS = (
        ("props", "pageProps", "state", "data", "entity"),
        ("props", "pageProps", "data", "entity"),
        ("props", "pageProps", "entity"),
    )

    def _extract_entity(self, data: dict) -> dict:
        for path in self._ENTITY_PATHS:
            result = self._resolve_path(data, path)
            if isinstance(result, dict):
                return result
        container = self._deep_find(data, "trackList")
        if isinstance(container, dict):
            return container
        container = self._deep_find(data, "type")
        if isinstance(container, dict) and container.get("type") in ("playlist", "track"):
            return container
        page_props = self._resolve_path(data, ("props", "pageProps")) or {}
        keys = list(page_props.keys())[:10] if isinstance(page_props, dict) else []
        raise ExtractionError(f"Could not find entity in embed page. pageProps keys: {keys}")

    def get_playlist_metadata(self, playlist_id: str) -> PlaylistInfo:
        url = self._EMBED_PLAYLIST_URL.format(playlist_id=playlist_id)
        data = self._fetch_embed_data(url)
        entity = self._extract_entity(data)

        name = entity.get("name") or entity.get("title") or "Unknown Playlist"
        subtitle = entity.get("subtitle")

        cover_url = None
        sources = entity.get("coverArt", {}).get("sources", [])
        if sources:
            cover_url = sources[-1].get("url")

        track_list = entity.get("trackList", [])
        track_count = len(track_list)

        try:
            token = self._cached_token
            if token:
                resp = self._session.get(
                    self._SPCLIENT_URL.format(playlist_id=playlist_id),
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                    timeout=10,
                )
                if resp.status_code == 200:
                    track_count = resp.json().get("length", track_count)
        except Exception:
            pass

        return PlaylistInfo(
            name=str(name),
            owner=str(subtitle) if subtitle else None,
            description=entity.get("description"),
            cover_url=cover_url,
            track_count=track_count,
        )

    def iter_playlist_tracks(self, playlist_id: str) -> Iterator[TrackInfo]:
        url = self._EMBED_PLAYLIST_URL.format(playlist_id=playlist_id)
        data = self._fetch_embed_data(url)
        entity = self._extract_entity(data)
        track_list = entity.get("trackList", [])
        embed_ids: set[str] = set()

        for track in track_list:
            if not isinstance(track, dict):
                continue
            uri = track.get("uri", "")
            track_id = uri.split(":")[-1] if uri.startswith("spotify:track:") else ""
            if not track_id:
                continue
            embed_ids.add(track_id)
            yield self._parse_track(track, track_id)

        token = self._cached_token
        if not token:
            return

        try:
            resp = self._session.get(
                self._SPCLIENT_URL.format(playlist_id=playlist_id),
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                timeout=30,
            )
            if resp.status_code != 200:
                return

            spc_data = resp.json()
            if spc_data.get("length", 0) <= len(embed_ids):
                return

            pending: list[tuple[str, str]] = []
            for item in spc_data.get("contents", {}).get("items", []):
                uri = item.get("uri", "")
                if not uri.startswith("spotify:track:"):
                    continue
                tid = uri.split(":")[-1]
                if tid not in embed_ids:
                    pending.append((tid, uri))

            if not pending:
                return

            import concurrent.futures as _cf
            pool = _cf.ThreadPoolExecutor(max_workers=4, thread_name_prefix="spolocal-meta")
            try:
                futures = {pool.submit(self._fetch_track_metadata, tid): (tid, uri) for tid, uri in pending}
                for future in _cf.as_completed(futures):
                    tid, uri = futures[future]
                    try:
                        info = future.result()
                    except Exception:
                        info = None
                    yield info or TrackInfo(
                        id=tid, title=f"Track {tid}", artists="Unknown",
                        album=None, release_date=None, cover_url=None,
                        duration_ms=None, preview_url=None, raw={"uri": uri},
                    )
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

        except Exception:
            pass

    def _parse_track(self, track: dict, track_id: str) -> TrackInfo:
        title = track.get("title") or track.get("name") or "Unknown Track"
        artists = track.get("subtitle") or track.get("artists") or ""
        if isinstance(artists, list):
            artists = ", ".join(a.get("name", "") for a in artists if isinstance(a, dict))

        preview_url = None
        ap = track.get("audioPreview", {})
        if isinstance(ap, dict):
            preview_url = ap.get("url")

        return TrackInfo(
            id=track_id,
            title=str(title),
            artists=str(artists),
            album=track.get("album", {}).get("name") if isinstance(track.get("album"), dict) else None,
            release_date=track.get("releaseDate"),
            cover_url=None,
            duration_ms=int(track["duration"]) if track.get("duration") else None,
            preview_url=preview_url,
            raw=dict(track),
        )

    def _fetch_track_metadata(self, track_id: str) -> TrackInfo | None:
        url = self._EMBED_TRACK_URL.format(track_id=track_id)
        try:
            data = self._fetch_embed_data(url)
            entity = self._extract_entity(data)
        except SpotifyDownAPIError:
            return None

        title = entity.get("name") or entity.get("title") or "Unknown Track"
        artists_data = entity.get("artists", [])
        if isinstance(artists_data, list):
            artists = ", ".join(a.get("name", "") for a in artists_data if isinstance(a, dict))
        else:
            artists = entity.get("subtitle", "")

        cover_url = None
        for img in entity.get("visualIdentity", {}).get("image", []):
            if isinstance(img, dict) and img.get("url"):
                cover_url = img.get("url")
                if img.get("maxWidth", 0) >= 300:
                    break

        release_date = None
        rd = entity.get("releaseDate")
        if isinstance(rd, dict):
            release_date = rd.get("isoString", "")[:10]
        elif isinstance(rd, str):
            release_date = rd

        preview_url = None
        ap = entity.get("audioPreview", {})
        if isinstance(ap, dict):
            preview_url = ap.get("url")

        return TrackInfo(
            id=track_id,
            title=str(title),
            artists=str(artists),
            album=None,
            release_date=release_date,
            cover_url=cover_url,
            duration_ms=entity.get("duration"),
            preview_url=preview_url,
            raw=dict(entity),
        )

    def get_track(self, track_id: str) -> TrackInfo:
        info = self._fetch_track_metadata(track_id)
        if info is None:
            raise SpotifyDownAPIError(f"Could not fetch track {track_id}")
        return info

    def validate_playlist(self, playlist_id: str) -> bool:
        try:
            resp = self._session.get(
                self._OEMBED_URL,
                params={"url": f"https://open.spotify.com/playlist/{playlist_id}"},
                timeout=10,
            )
            return resp.status_code == 200
        except Exception:
            return False


_SPOTIFY_ID_RE = re.compile(
    r"(?:https?://open\.spotify\.com/(?:intl-[a-z]{2,}/)?|spotify:)"
    r"(?P<type>playlist|track|album)[/:](?P<id>[a-zA-Z0-9]+)"
)


def _match_spotify(url: str, expected_type: str | None = None) -> tuple[str, str]:
    if not url:
        raise ValueError("Empty Spotify URL.")
    m = _SPOTIFY_ID_RE.search(url)
    if not m:
        raise ValueError("Invalid Spotify URL.")
    url_type = m.group("type")
    if expected_type and url_type != expected_type:
        raise ValueError(f"Expected Spotify {expected_type} URL, got {url_type}.")
    return url_type, m.group("id")


def extract_playlist_id(url: str) -> str:
    _, pid = _match_spotify(url, expected_type="playlist")
    return pid


def extract_track_id(url: str) -> str:
    _, tid = _match_spotify(url, expected_type="track")
    return tid


def detect_spotify_url_type(url: str) -> tuple[str, str]:
    return _match_spotify(url)
