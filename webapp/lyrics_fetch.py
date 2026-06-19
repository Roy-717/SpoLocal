"""Fetch plain-text lyrics from LRCLIB.

Queries by artist and title.
Writes matched lyric text into track sidecar files."""

from __future__ import annotations

import os
import re
from typing import Any, Optional

import httpx

LRCLIB_SEARCH = "https://lrclib.net/api/search"
DEFAULT_UA = "SpoLocal lyrics (local downloader)"


def fetch_on_download_enabled() -> bool:
    """Default on: after each download, search LRCLIB and save a lyrics file when found."""
    raw = (
        os.environ.get("SPOLOCAL_FETCH_LYRICS_ON_DOWNLOAD")
        or os.environ.get("SPRITY_FETCH_LYRICS_ON_DOWNLOAD")
    )
    if raw is None or str(raw).strip() == "":
        return True
    v = str(raw).strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    return v in ("1", "true", "yes", "on")


def _primary_artist(artist: str) -> str:
    a = (artist or "").strip()
    if not a:
        return a
    lower = a.lower()
    for needle in (" feat.", " ft.", " featuring ", ","):
        idx = lower.find(needle)
        if idx != -1:
            return a[:idx].strip()
    if "&" in a:
        return a.split("&", 1)[0].strip()
    return a


def _simplify_title(title: str) -> str:
    t = (title or "").strip()
    t = re.sub(r"\s*\([^)]*\)\s*", " ", t)
    t = re.sub(r"\s*\[[^\]]*\]\s*", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _score_item(item: dict, want_title: str) -> int:
    want_norm = want_title.strip().lower()
    tn = (item.get("trackName") or "").strip().lower()
    if not want_norm:
        return 50
    if tn == want_norm:
        return 100
    if want_norm in tn:
        return 80
    if tn in want_norm:
        return 70
    return 50


def _pick_best_record(data: Any, want_title: str) -> Optional[dict]:
    """Best LRCLIB hit with plain or synced lyrics."""
    if not isinstance(data, list) or not data:
        return None
    scored: list[tuple[int, dict]] = []
    for item in data:
        if not isinstance(item, dict) or item.get("instrumental"):
            continue
        plain = (item.get("plainLyrics") or "").strip()
        synced = (item.get("syncedLyrics") or "").strip()
        if not plain and not synced:
            continue
        sc = _score_item(item, want_title)
        scored.append((sc, item))
    scored.sort(key=lambda x: -x[0])
    if scored:
        return scored[0][1]
    return None


def fetch_lrclib_sidecar_sync(
    artist: str, title: str, *, force: bool = False
) -> tuple[Optional[str], Optional[str]]:
    """
    Search LRCLIB; return (plain_lyrics, synced_lrc) for saving next to the audio.
    Either or both may be set. Synced is preferred for writing an .lrc file.
    """
    if not force and not fetch_on_download_enabled():
        return None, None
    artist = (artist or "").strip()
    title = (title or "").strip()
    if not title:
        return None, None
    pa = _primary_artist(artist)
    st = _simplify_title(title)
    queries: list[dict[str, str]] = []
    if artist:
        queries.append({"artist_name": artist, "track_name": title})
    queries.append({"artist_name": pa or artist, "track_name": title})
    if st != title:
        queries.append({"artist_name": pa or artist, "track_name": st})
    if st:
        queries.append({"q": f"{pa or artist} {st}".strip()})

    seen: set[tuple[tuple[str, str], ...]] = set()
    uniq: list[dict[str, str]] = []
    for q in queries:
        key = tuple(sorted(q.items()))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(q)

    headers = {
        "User-Agent": (
            os.environ.get("SPOLOCAL_LRCLIB_USER_AGENT")
            or os.environ.get("SPRITY_LRCLIB_USER_AGENT")
            or DEFAULT_UA
        )
    }
    with httpx.Client(timeout=httpx.Timeout(25.0)) as client:
        for params in uniq:
            try:
                r = client.get(LRCLIB_SEARCH, params=params, headers=headers)
            except httpx.RequestError:
                continue
            if r.status_code != 200:
                continue
            rec = _pick_best_record(r.json(), title)
            if not rec:
                continue
            plain = (rec.get("plainLyrics") or "").strip() or None
            synced = (rec.get("syncedLyrics") or "").strip() or None
            if plain or synced:
                return plain, synced
    return None, None


def on_demand_lyrics_fetch_enabled() -> bool:
    """When a track has no usable lyrics files/tags, GET may search LRCLIB once (default on)."""
    raw = os.environ.get("SPOLOCAL_LYRICS_ON_DEMAND") or os.environ.get("SPRITY_LYRICS_ON_DEMAND")
    if raw is None or str(raw).strip() == "":
        return True
    v = str(raw).strip().lower()
    return v not in ("0", "false", "no", "off")
