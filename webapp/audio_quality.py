"""Audio quality (MP3 kbps) for downloads and playback."""
from __future__ import annotations

import re

MIN_KBPS = 32
MAX_KBPS = 192
DEFAULT_KBPS = 192

_LEGACY_MAP = {"low": 64, "high": DEFAULT_KBPS}


def clamp_kbps(value: int) -> int:
    return max(MIN_KBPS, min(MAX_KBPS, int(value)))


def parse_quality_kbps(raw: str | int | None, *, default: int = DEFAULT_KBPS) -> int:
    if raw is None:
        return clamp_kbps(default)
    if isinstance(raw, int):
        return clamp_kbps(raw)
    text = str(raw).strip().lower()
    if not text:
        return clamp_kbps(default)
    if text in _LEGACY_MAP:
        return _LEGACY_MAP[text]
    if text.endswith("k"):
        text = text[:-1]
    try:
        return clamp_kbps(int(float(text)))
    except ValueError:
        return clamp_kbps(default)


def variant_key(kbps: int) -> str:
    return str(clamp_kbps(kbps))


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
        return clamp_kbps(int(m.group(1)))
    except ValueError:
        return None
