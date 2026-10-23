"""Loudness analysis for playback normalization."""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

_log = logging.getLogger(__name__)

TARGET_LUFS = -14.0
MAX_GAIN_DB = 12.0
MIN_GAIN_DB = -12.0


def clamp_gain_db(gain: float) -> float:
    return max(MIN_GAIN_DB, min(MAX_GAIN_DB, gain))


def extract_replaygain_track_gain_db(path: Path) -> Optional[float]:
    """Read ReplayGain track adjustment from embedded tags (dB)."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".mp3":
            from mutagen.id3 import ID3

            try:
                tags = ID3(path)
            except Exception:
                return None
            for key in tags.keys():
                if not key.startswith("TXXX"):
                    continue
                frame = tags[key]
                desc = (getattr(frame, "desc", None) or "").strip().upper()
                if desc != "REPLAYGAIN_TRACK_GAIN":
                    continue
                text = getattr(frame, "text", None)
                if not text:
                    continue
                s = text[0] if isinstance(text, list) else str(text)
                m = re.search(r"([-+]?\d+(?:\.\d+)?)", s)
                if m:
                    return clamp_gain_db(float(m.group(1)))
            return None

        from mutagen import File as MutagenFile

        audio = MutagenFile(path)
        if audio is None:
            return None
        keys = list(audio.keys()) if hasattr(audio, "keys") else []
        for key in keys:
            if "replaygain_track_gain" not in key.lower():
                continue
            vals = audio.get(key)
            if not vals:
                continue
            m = re.search(r"([-+]?\d+(?:\.\d+)?)", str(vals[0]))
            if m:
                return clamp_gain_db(float(m.group(1)))
    except Exception:
        return None
    return None


def ffmpeg_executable(root: Path) -> str:
    bin_dir = root / "ffmpeg-2026-05-06-git-f2e5eff3ff-essentials_build" / "bin"
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    local = bin_dir / name
    if local.is_file():
        return str(local)
    found = shutil.which("ffmpeg")
    return found or "ffmpeg"


def ffprobe_executable(root: Path) -> str:
    bin_dir = root / "ffmpeg-2026-05-06-git-f2e5eff3ff-essentials_build" / "bin"
    name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    local = bin_dir / name
    if local.is_file():
        return str(local)
    found = shutil.which("ffprobe")
    return found or "ffprobe"


def _integrated_lufs(text: str) -> Optional[float]:
    """Return the last integrated loudness value ffmpeg printed, if any."""
    value: Optional[float] = None
    for line in text.splitlines():
        if "I:" not in line or "LUFS" not in line:
            continue
        try:
            value = float(line.split("I:", 1)[1].split("LUFS", 1)[0].strip())
        except ValueError:
            continue
    return value


def analyze_loudness_gain_db(
    path: Path,
    root: Path,
    target_lufs: float = TARGET_LUFS,
) -> Optional[float]:
    """Return gain in dB to reach target LUFS, or None if analysis fails."""
    if not path.is_file():
        return None

    replay = extract_replaygain_track_gain_db(path)
    if replay is not None:
        return replay

    ffmpeg = ffmpeg_executable(root)
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-i",
        str(path),
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
        text = (proc.stderr or "") + (proc.stdout or "")
        matches = re.findall(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", text)
        if not matches:
            return None
        integrated = float(matches[-1])
        return clamp_gain_db(target_lufs - integrated)
    except Exception as exc:
        _log.warning("loudness analysis failed for %s: %s", path, exc)
        return None


def analyze_stream_loudness_gain_db(
    video_id: str,
    root: Path,
    target_lufs: float = TARGET_LUFS,
) -> Optional[float]:
    """Measure a YouTube stream's integrated loudness without keeping the file.

    yt-dlp writes the same Opus stream the player receives into ffmpeg, so the
    gain matches what the browser decodes. The whole track is read once; the
    caller caches the result per video id.
    """
    from audio_quality import ytdlp_stream_cmd

    ffmpeg_cmd = [
        ffmpeg_executable(root),
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-i",
        "pipe:0",
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]
    dl = None
    try:
        dl = subprocess.Popen(
            ytdlp_stream_cmd(video_id),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        proc = subprocess.run(
            ffmpeg_cmd,
            stdin=dl.stdout,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        integrated = _integrated_lufs((proc.stderr or "") + (proc.stdout or ""))
        if integrated is None:
            return None
        return clamp_gain_db(target_lufs - integrated)
    except Exception as exc:
        _log.warning("stream loudness analysis failed for %s: %s", video_id, exc)
        return None
    finally:
        if dl is not None:
            if dl.stdout is not None:
                dl.stdout.close()
            try:
                dl.wait(timeout=10)
            except Exception:
                dl.kill()
