"""Lyric text utilities for SpoLocal.

Detects placeholder lyric values and strips LRC markers.
Returns clean lyric text suitable for display."""

from __future__ import annotations

import re
from typing import Optional

_SINGLE_URL = re.compile(r"^https?://\S+$", re.IGNORECASE)
_URL_ONLY_LINE = re.compile(r"^https?://\S+\s*$", re.IGNORECASE)


def is_placeholder_lyrics(text: str) -> bool:
    """True when the string is only link(s) / junk, not song lyrics."""
    if not text:
        return True
    s = text.strip()
    if not s:
        return True
    # Single line = one URL (e.g. music.youtube.com / Spotify link in a tag)
    if "\n" not in s and _SINGLE_URL.match(s):
        return True
    # Every non-empty line is a bare URL
    lines = [ln.strip() for ln in s.splitlines() if ln.strip()]
    if lines and all(_URL_ONLY_LINE.match(ln) for ln in lines):
        return True
    # One long token starting with http, no spaces (common misfire)
    if " " not in s and "\n" not in s and s.lower().startswith("http"):
        return True
    # spotify: / other app links sometimes stuffed in lyrics fields
    if " " not in s and "\n" not in s and s.split(":", 1)[0].lower() in (
        "spotify",
        "applemusic",
        "itunes",
    ):
        return True
    return False


def filter_real_lyrics(text: Optional[str]) -> Optional[str]:
    """Return stripped lyrics, or None if empty / URL-only placeholder."""
    if text is None:
        return None
    s = text.strip()
    if not s:
        return None
    if is_placeholder_lyrics(s):
        return None
    return s
