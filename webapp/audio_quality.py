"""Audio quality (MP3 kbps) for downloads and playback."""
from __future__ import annotations

import re

QUALITY_LOW_KBPS = 64
QUALITY_MID_KBPS = 120
QUALITY_HIGH_KBPS = 192
QUALITY_TIERS = (QUALITY_LOW_KBPS, QUALITY_MID_KBPS, QUALITY_HIGH_KBPS)

MIN_KBPS = QUALITY_LOW_KBPS
MAX_KBPS = QUALITY_HIGH_KBPS
DEFAULT_KBPS = QUALITY_HIGH_KBPS

_LEGACY_MAP = {
    "low": QUALITY_LOW_KBPS,
    "mid": QUALITY_MID_KBPS,
    "medium": QUALITY_MID_KBPS,
    "high": QUALITY_HIGH_KBPS,
}


def snap_kbps(value: int) -> int:
    v = int(value)
    return min(QUALITY_TIERS, key=lambda t: abs(t - v))


def clamp_kbps(value: int) -> int:
    return snap_kbps(value)


def parse_quality_kbps(raw: str | int | None, *, default: int = DEFAULT_KBPS) -> int:
    if raw is None:
        return snap_kbps(default)
    if isinstance(raw, int):
        return snap_kbps(raw)
    text = str(raw).strip().lower()
    if not text:
        return snap_kbps(default)
    if text in _LEGACY_MAP:
        return _LEGACY_MAP[text]
    if text.endswith("k"):
        text = text[:-1]
    try:
        return snap_kbps(int(float(text)))
    except ValueError:
        return snap_kbps(default)


def variant_key(kbps: int) -> str:
    return str(snap_kbps(kbps))


def ytdlp_audio_postprocessor(kbps: int) -> dict:
    q = variant_key(kbps)
    return {
        "key": "FFmpegExtractAudio",
        "preferredcodec": "mp3",
        "preferredquality": q,
    }


def quality_file_stem(base_stem: str, kbps: int) -> str:
    return f"{base_stem}__{variant_key(kbps)}k"


_RE_KBPS_SUFFIX = re.compile(r"__(\d+)k\.(?:mp3|m4a|opus)$", re.I)


def kbps_from_relpath(relpath: str | None) -> int | None:
    """Parse ``__64k.mp3`` suffix from a media path, if present."""
    if not relpath:
        return None
    m = _RE_KBPS_SUFFIX.search(relpath.replace("\\", "/"))
    if not m:
        return None
    try:
        return snap_kbps(int(m.group(1)))
    except ValueError:
        return None
