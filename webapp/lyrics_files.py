"""Lyrics sidecar file management for downloaded tracks.

Reads, writes, and cleans .lyrics.txt and .lrc sidecar files.
Keeps lyric data consistent for playback and display."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal, Optional, Tuple

LyricsSource = Literal["none", "file", "lrc", "embedded"]


def user_lyrics_path(audio_path: Path) -> Path:
    """SpoLocal-editable plain lyrics: {stem}.lyrics.txt."""
    return audio_path.with_name(audio_path.stem + ".lyrics.txt")


def lrc_path(audio_path: Path) -> Path:
    return audio_path.with_suffix(".lrc")


def lrc_to_plain(raw: str) -> str:
    """Strip LRC timestamps for reading; keep line breaks."""
    lines_out: list[str] = []
    for line in raw.replace("\r\n", "\n").split("\n"):
        stripped = re.sub(r"\[[^\]]*\]", "", line).strip()
        if stripped:
            lines_out.append(stripped)
    return "\n".join(lines_out)


def read_sidecar_lyrics(audio_path: Path) -> Optional[Tuple[str, LyricsSource]]:
    """
    Read lyrics from disk next to the audio file.
    Order: .lyrics.txt (user / materialized), then .lrc.
    Skips files whose content is URL-only placeholders.
    """
    from lyrics_text import filter_real_lyrics

    txt = user_lyrics_path(audio_path)
    if txt.is_file():
        text = txt.read_text(encoding="utf-8", errors="replace").strip()
        text = filter_real_lyrics(text)
        if text:
            return text, "file"
    lp = lrc_path(audio_path)
    if lp.is_file():
        raw = lp.read_text(encoding="utf-8", errors="replace")
        plain = filter_real_lyrics(lrc_to_plain(raw))
        if plain:
            return plain, "lrc"
    return None


def read_raw_lrc(audio_path: Path) -> Optional[str]:
    """Return raw LRC file content if it exists and is valid."""
    from lyrics_text import filter_real_lyrics

    lp = lrc_path(audio_path)
    if lp.is_file():
        raw = lp.read_text(encoding="utf-8", errors="replace")
        plain = filter_real_lyrics(lrc_to_plain(raw))
        if plain:
            return raw
    return None


def parse_lrc_lines(raw: str) -> list:
    """Parse LRC content into list of {time_ms, text} objects."""
    lines_out: list = []
    time_pattern = re.compile(r"\[(\d{2}):(\d{2})\.(\d{2,3})\]")

    for line in raw.replace("\r\n", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        # Find all timestamps in the line (LRC can have multiple timestamps for same text)
        matches = list(time_pattern.finditer(line))
        if not matches:
            continue
        # Remove all timestamp brackets to get the text
        text = re.sub(r"\[[^\]]*\]", "", line).strip()
        if not text:
            continue
        for match in matches:
            minutes = int(match.group(1))
            seconds = int(match.group(2))
            millis_str = match.group(3)
            # Handle both 2-digit (centisec) and 3-digit (msec) formats
            if len(millis_str) == 2:
                millis = int(millis_str) * 10
            else:
                millis = int(millis_str)
            time_ms = (minutes * 60 + seconds) * 1000 + millis
            lines_out.append({"time_ms": time_ms, "text": text})

    # Sort by timestamp and remove duplicates (same time+text)
    lines_out.sort(key=lambda x: x["time_ms"])
    seen = set()
    unique = []
    for item in lines_out:
        key = (item["time_ms"], item["text"])
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def save_user_lyrics(audio_path: Path, text: str) -> None:
    """Write or remove {stem}.lyrics.txt (UTF-8)."""
    path = user_lyrics_path(audio_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    t = text.rstrip()
    if not t:
        if path.is_file():
            path.unlink()
        return
    path.write_text(t + "\n", encoding="utf-8")


def save_lrc_from_lines(audio_path: Path, lines: list) -> None:
    """Write LRC file from list of {time_ms, text} objects."""
    path = lrc_path(audio_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    output_lines = []
    for item in lines:
        time_ms = item.get("time_ms", 0)
        text = item.get("text", "").strip()
        if not text:
            continue
        # Convert ms to [mm:ss.xx] format
        minutes = time_ms // 60000
        seconds = (time_ms % 60000) // 1000
        centis = (time_ms % 1000) // 10
        timestamp = f"[{minutes:02d}:{seconds:02d}.{centis:02d}]"
        output_lines.append(f"{timestamp}{text}")

    if not output_lines:
        if path.is_file():
            path.unlink()
        return

    path.write_text("\n".join(output_lines) + "\n", encoding="utf-8")


def delete_lyrics_sidecars(audio_path: Path) -> None:
    """Remove lyrics files tied to this audio stem (when track is deleted)."""
    for p in (user_lyrics_path(audio_path), lrc_path(audio_path)):
        try:
            if p.is_file():
                p.unlink()
        except OSError:
            pass


def save_lrc(audio_path: Path, raw: str) -> None:
    """Write {stem}.lrc next to the audio (synced LRCLIB / LRC format)."""
    path = lrc_path(audio_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    t = raw.rstrip()
    if not t:
        if path.is_file():
            path.unlink()
        return
    path.write_text(t + "\n", encoding="utf-8")


def materialize_lyrics_file_if_needed(
    audio_path: Path,
    embedded_text: Optional[str],
    remote_plain: Optional[str],
    remote_synced: Optional[str],
) -> None:
    """
    After download: prefer search → lyrics file on disk, then embedded tags.

    Skips if .lyrics.txt or .lrc already exists next to the audio.
    Remote: writes synced as .lrc when present, else plain as .lyrics.txt.
    Embedded: writes .lyrics.txt only when no remote match.
    """
    from lyrics_text import filter_real_lyrics

    up = user_lyrics_path(audio_path)
    if up.is_file():
        try:
            body = up.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        if filter_real_lyrics(body):
            return
        try:
            up.unlink()
        except OSError:
            return
    if lrc_path(audio_path).is_file():
        return
    if remote_synced and remote_synced.strip():
        save_lrc(audio_path, remote_synced)
        return
    if remote_plain and remote_plain.strip():
        save_user_lyrics(audio_path, remote_plain)
        return
    if embedded_text and embedded_text.strip():
        save_user_lyrics(audio_path, embedded_text)
