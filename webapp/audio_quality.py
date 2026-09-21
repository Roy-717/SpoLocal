"""Audio quality tiers for downloads and playback.

Both tiers are Opus passthrough: YouTube already serves Opus, so yt-dlp only
remuxes the container (``-c:a copy``) instead of re-encoding to MP3.
"""
from __future__ import annotations

import re
import shutil
from typing import Any, Optional

QUALITY_LOW_KBPS = 64
QUALITY_HIGH_KBPS = 192
# Retired middle tier. Older downloads may still exist at 120 kbps; it is
# never selected anymore but stays parseable so those files keep working.
QUALITY_MID_KBPS = 120
QUALITY_TIERS = (QUALITY_LOW_KBPS, QUALITY_HIGH_KBPS)

MIN_KBPS = QUALITY_LOW_KBPS
MAX_KBPS = QUALITY_HIGH_KBPS
DEFAULT_KBPS = QUALITY_HIGH_KBPS

_LEGACY_MAP = {
    "low": QUALITY_LOW_KBPS,
    "mid": QUALITY_HIGH_KBPS,
    "medium": QUALITY_HIGH_KBPS,
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
        n = int(float(text))
    except ValueError:
        return snap_kbps(default)
    if n == QUALITY_MID_KBPS:
        return QUALITY_HIGH_KBPS
    return snap_kbps(n)


def variant_key(kbps: int) -> str:
    return str(snap_kbps(kbps))


def ytdlp_audio_format(kbps: int | None = None) -> str:
    """Audio-only DASH. Never fall back to muxed video (often ~44 kbps AAC).

    Data Saver takes the low Opus tier (~50 kbps, itag 249) as WebM so playback
    can slice it through Media Source Extensions; Highest the ~130 kbps Opus tier.
    """
    if kbps is not None and snap_kbps(kbps) <= QUALITY_LOW_KBPS:
        return (
            "bestaudio[ext=webm][acodec^=opus][abr<=80]/"
            "bestaudio[ext=webm][abr<=80]/"
            "bestaudio[ext=webm]/"
            "bestaudio[acodec^=opus]"
        )
    return (
        "bestaudio[acodec^=opus][abr>=96]/"
        "bestaudio[acodec^=opus]/"
        "bestaudio[acodec^=mp4a]/"
        "bestaudio[abr>=96]/"
        "bestaudio"
    )


def ytdlp_audio_postprocessor() -> dict:
    """Remux to Ogg Opus. yt-dlp copies the stream when the source is already Opus."""
    return {
        "key": "FFmpegExtractAudio",
        "preferredcodec": "opus",
    }


def ytdlp_extract_audio_opts(kbps: int) -> dict[str, Any]:
    q = snap_kbps(kbps)
    opts: dict[str, Any] = {"format": ytdlp_audio_format(q)}
    if q > QUALITY_LOW_KBPS:
        opts["postprocessors"] = [ytdlp_audio_postprocessor()]
    else:
        # Data Saver: keep YouTube's WebM/Opus container untouched. Ogg/Opus is
        # not decodable by Media Source Extensions, but WebM/Opus is.
        opts["postprocessors"] = []
    return opts


def quality_file_stem(base_stem: str, kbps: int) -> str:
    return f"{base_stem}__{variant_key(kbps)}k"


_RE_KBPS_SUFFIX = re.compile(r"__(\d+)k\.(?:mp3|m4a|opus|webm)$", re.I)


def kbps_from_relpath(relpath: str | None) -> int | None:
    """Parse ``__64k.opus`` suffix from a media path, if present."""
    if not relpath:
        return None
    m = _RE_KBPS_SUFFIX.search(relpath.replace("\\", "/"))
    if not m:
        return None
    try:
        return snap_kbps(int(m.group(1)))
    except ValueError:
        return None


def ytdlp_video_format(height: int) -> str:
    h = 360 if height <= 360 else 480 if height <= 480 else 720
    return (
        f"bestvideo[vcodec^=avc1][height<={h}]/"
        f"bestvideo[vcodec^=avc][height<={h}]/"
        f"bestvideo[ext=mp4][height<={h}]/"
        f"bestvideo[height<={h}]"
    )


def video_height_for_kbps(kbps: int) -> int:
    k = snap_kbps(kbps)
    if k <= QUALITY_LOW_KBPS:
        return 360
    if k <= QUALITY_MID_KBPS:
        return 480
    return 720


def ytdlp_youtube_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "force_ipv4": True,
        "extractor_args": {
            "youtube": {"player_client": ["web", "mweb", "web_embedded", "tv", "ios", "android"]},
        },
    }
    deno = shutil.which("deno")
    if deno:
        opts["js_runtimes"] = {"deno": {"path": deno}}
    return opts


def ytdlp_stream_extract_opts() -> dict[str, Any]:
    opts = dict(ytdlp_youtube_opts())
    opts["format"] = ytdlp_audio_format() + "/bestaudio/bestaudio*"
    return opts


def ytdlp_stream_cmd(video_id: str, *, max_seconds: Optional[int] = None) -> list[str]:
    cmd = [
        "yt-dlp",
        "-f",
        ytdlp_audio_format(),
        "-o",
        "-",
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "--force-ipv4",
        "--extractor-args",
        "youtube:player_client=web,mweb,web_embedded,tv,ios,android",
    ]
    deno = shutil.which("deno")
    if deno:
        cmd.extend(["--js-runtimes", f"deno:{deno}"])
    if max_seconds is not None:
        cmd.extend(["--download-sections", f"*0-{max_seconds}", "--force-keyframes-at-cuts"])
    cmd.append(f"https://www.youtube.com/watch?v={video_id}")
    return cmd
