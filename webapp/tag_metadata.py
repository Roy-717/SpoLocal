"""Read embedded tag metadata from local audio files.

Extracts cover art and lyrics metadata via mutagen.
Provides normalized values for track enrichment and serving."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from lyrics_text import filter_real_lyrics

CoverBlob = tuple[bytes, str]


def extract_cover(path: Path) -> Optional[CoverBlob]:
    """Return (image_bytes, mime_type) or None."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".mp3":
            from mutagen.id3 import APIC, ID3

            try:
                tags = ID3(path)
            except Exception:
                return None
            for key in tags.keys():
                if key.startswith("APIC"):
                    apic = tags[key]
                    if not isinstance(apic, APIC):
                        continue
                    mime = apic.mime or "image/jpeg"
                    if isinstance(mime, bytes):
                        mime = mime.decode("utf-8", "replace")
                    return bytes(apic.data), mime
            return None
        if suffix in (".m4a", ".mp4", ".m4b"):
            from mutagen.mp4 import MP4, MP4Cover

            audio = MP4(path)
            covr = audio.get("covr")
            if not covr:
                return None
            item = covr[0]
            fmt = getattr(item, "imageformat", MP4Cover.FORMAT_JPEG)
            if fmt == MP4Cover.FORMAT_PNG:
                mime = "image/png"
            else:
                mime = "image/jpeg"
            return bytes(item), mime
    except Exception:
        return None
    return None


def extract_album(path: Path) -> Optional[str]:
    """Read album name from embedded tags (MP3 ID3, MP4)."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".mp3":
            from mutagen.id3 import ID3

            try:
                tags = ID3(path)
            except Exception:
                return None
            f = tags.get("TALB")
            if f is not None:
                tx = getattr(f, "text", None)
                if tx:
                    if isinstance(tx, list):
                        s = str(tx[0]).strip() if tx else ""
                    else:
                        s = str(tx).strip()
                    return s or None
            return None
        if suffix in (".m4a", ".mp4", ".m4b"):
            from mutagen.mp4 import MP4

            audio = MP4(path)
            for key in ("\xa9alb", "©alb"):
                vals = audio.get(key)
                if vals and vals[0]:
                    s = str(vals[0]).strip()
                    if s:
                        return s
    except Exception:
        return None
    return None


def _normalize_lyrics_text(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            raw = raw.decode("latin-1", "replace")
    if isinstance(raw, list):
        parts: list[str] = []
        for item in raw:
            n = _normalize_lyrics_text(item)
            if n:
                parts.append(n)
        if parts:
            return "\n".join(parts)
        return None
    s = str(raw).strip()
    return s if s else None


def _uslt_text(frame: Any) -> Optional[str]:
    text = getattr(frame, "text", None)
    if callable(text):
        try:
            text = text()
        except Exception:
            text = None
    return _normalize_lyrics_text(text)


def _sylt_text(frame: Any) -> Optional[str]:
    lines: list[str] = []
    raw = getattr(frame, "text", None)
    if raw is None:
        return None
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, tuple) and len(item) >= 2:
                line = _normalize_lyrics_text(item[1])
                if line:
                    lines.append(line)
            else:
                line = _normalize_lyrics_text(item)
                if line:
                    lines.append(line)
    else:
        one = _normalize_lyrics_text(raw)
        if one:
            lines.append(one)
    if not lines:
        return None
    return "\n".join(lines)


def _mp3_id3_lyrics(tags: Any) -> Optional[str]:
    """USLT, SYLT, TXXX (lyrics), COMM."""
    for key in tags.keys():
        if key.startswith("USLT"):
            t = _uslt_text(tags[key])
            if t:
                return t
    for key in tags.keys():
        if key.startswith("SYLT"):
            t = _sylt_text(tags[key])
            if t:
                return t
    lyricish = frozenset(
        {
            "lyrics",
            "unsyncedlyrics",
            "unsynced lyrics",
            "lyric",
            "websites_lyrics",
        }
    )
    for key in tags.keys():
        if key.startswith("TXXX"):
            f = tags[key]
            desc = (getattr(f, "desc", None) or "").strip().lower()
            if desc in lyricish or desc.endswith("lyrics"):
                texts = getattr(f, "text", None)
                if texts is not None:
                    joined = _normalize_lyrics_text(list(texts) if not isinstance(texts, list) else texts)
                    if joined:
                        return joined
                    t = _normalize_lyrics_text(texts[0] if isinstance(texts, list) and texts else texts)
                    if t:
                        return t
    for key in tags.keys():
        if key.startswith("COMM"):
            comm = tags[key]
            desc = (getattr(comm, "desc", None) or "").strip().lower()
            if "lyric" not in desc and desc not in lyricish and desc != "":
                continue
            tx = getattr(comm, "text", None)
            t = _normalize_lyrics_text(tx)
            if t:
                return t
    return None


def _flac_lyrics(audio: Any) -> Optional[str]:
    for key in audio.keys():
        if "lyric" in key.lower():
            vals = audio.get(key)
            if vals:
                t = _normalize_lyrics_text(vals[0])
                if t:
                    return t
    return None


def _mp4_lyrics(audio: Any) -> Optional[str]:
    keys = (
        "\xa9lyr",
        "\xa9LYR",
        "----:com.apple.iTunes:Lyrics",
        "----:com.apple.iTunes:UNSYNCED LYRICS",
        "----:com.apple.iTunes:Unsynced Lyrics",
    )
    for k in keys:
        vals = audio.get(k)
        if vals and vals[0]:
            t = _normalize_lyrics_text(vals[0])
            if t:
                return t
    for key in audio.keys():
        if "lyr" in key.lower() or "lyrics" in key.lower():
            vals = audio.get(key)
            if vals and vals[0]:
                t = _normalize_lyrics_text(vals[0])
                if t:
                    return t
    return None


def _oggish_lyrics(audio: Any) -> Optional[str]:
    if not getattr(audio, "tags", None):
        return None
    for key in audio.tags.keys():
        if "lyric" in key.lower():
            vals = audio.tags.get(key)
            if vals:
                t = _normalize_lyrics_text(vals[0])
                if t:
                    return t
    return None


def extract_lyrics(path: Path) -> Optional[str]:
    """Return lyrics from embedded tags (many formats / frame types)."""
    raw = _extract_lyrics_raw(path)
    return filter_real_lyrics(raw)


def _extract_lyrics_raw(path: Path) -> Optional[str]:
    suffix = path.suffix.lower()
    try:
        from mutagen import File as MutagenFile
        from mutagen.flac import FLAC
        from mutagen.id3 import ID3
        from mutagen.mp3 import MP3
        from mutagen.mp4 import MP4
        from mutagen.oggopus import OggOpus
        from mutagen.oggvorbis import OggVorbis

        try:
            easy = MutagenFile(path, easy=True)
            if easy is not None:
                for k in easy.keys():
                    if "lyric" in k.lower():
                        vals = easy.get(k)
                        if vals:
                            t = _normalize_lyrics_text(vals[0])
                            if t:
                                return t
        except Exception:
            pass

        audio = MutagenFile(path)
        if audio is None:
            return None

        if isinstance(audio, MP3):
            if audio.tags:
                t = _mp3_id3_lyrics(audio.tags)
                if t:
                    return t
            try:
                tags = ID3(path)
                t = _mp3_id3_lyrics(tags)
                if t:
                    return t
            except Exception:
                pass
            return None

        if isinstance(audio, FLAC):
            return _flac_lyrics(audio)

        if isinstance(audio, MP4):
            return _mp4_lyrics(audio)

        if isinstance(audio, (OggVorbis, OggOpus)):
            return _oggish_lyrics(audio)

        if suffix == ".mp3":
            try:
                tags = ID3(path)
                return _mp3_id3_lyrics(tags)
            except Exception:
                return None
    except Exception:
        return None
    return None


def read_audio_file_stats(path: Path) -> dict[str, Any]:
    """Return size, mtime, duration, bitrate, and format for a local audio file."""
    st = path.stat()
    downloaded_at = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
    duration_sec: Optional[float] = None
    bitrate_kbps: Optional[int] = None
    fmt = path.suffix.lstrip(".").lower() or None
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(path)
        if audio is not None and audio.info is not None:
            info = audio.info
            length = getattr(info, "length", None)
            if length is not None:
                duration_sec = round(float(length), 2)
            bitrate = getattr(info, "bitrate", None)
            if bitrate is not None:
                bitrate_kbps = int(round(float(bitrate) / 1000))
    except Exception:
        pass
    return {
        "size_bytes": st.st_size,
        "downloaded_at": downloaded_at,
        "duration_sec": duration_sec,
        "bitrate_kbps": bitrate_kbps,
        "format": fmt,
    }
