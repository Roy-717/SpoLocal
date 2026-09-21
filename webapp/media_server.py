"""Local file serving for downloaded media with HTTP Range support.

The browser seeks/buffers like a streaming player, so we serve audio files with
byte-range requests and correct MIME types.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from loudness_analysis import ffprobe_executable
from tag_metadata import read_audio_file_stats


def probe_duration_seconds(path: Path, root: Path) -> Optional[float]:
    """Read a media file's duration via ffprobe (mutagen can't parse WebM)."""
    cmd = [
        ffprobe_executable(root),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=False)
        value = float((proc.stdout or "").strip())
        return value if value > 0 else None
    except Exception:
        return None


class MediaServer:
    """Serves files from a media root with HTTP Range support and MIME sniffing.

    When ``sliced`` is true (data-saver mode) each response is capped to a small
    byte range so the browser fetches the file incrementally instead of
    buffering the whole file at once.
    """

    CHUNK_BYTES = 64 * 1024
    DATA_SAVER_SLICE_BYTES = 512 * 1024

    def __init__(self, media_root: Path, root: Optional[Path] = None):
        self.media_root = media_root.resolve()
        # Project root: used to locate the bundled ffprobe for duration probing.
        self.root = (root or self.media_root.parent).resolve()

    def content_type(self, file_path: Path) -> str:
        explicit = {
            ".m4a": "audio/mp4",
            ".mp3": "audio/mpeg",
            ".webm": "audio/webm",
            ".opus": "audio/ogg",
            ".ogg": "audio/ogg",
        }.get(file_path.suffix.lower())
        if explicit:
            return explicit
        import mimetypes

        mime, _ = mimetypes.guess_type(file_path.name)
        return mime or "application/octet-stream"

    def iter_range(self, file_path: Path, start: int, end: int):
        remaining = end - start + 1
        with file_path.open("rb") as f:
            f.seek(start)
            while remaining > 0:
                chunk = f.read(min(self.CHUNK_BYTES, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    def _resolve_target(self, media_path: str) -> Path:
        target = (self.media_root / media_path).resolve()
        try:
            target.relative_to(self.media_root)
        except ValueError:
            raise HTTPException(status_code=404, detail="Media file not found")
        if not target.is_file():
            raise HTTPException(status_code=404, detail="Media file not found")
        return target

    def prepare(self, media_path: str) -> dict[str, Any]:
        """Metadata for sliced playback: extension, size, duration."""
        target = self._resolve_target(media_path)
        duration = read_audio_file_stats(target).get("duration_sec")
        if not duration:
            duration = probe_duration_seconds(target, self.root)
        return {
            "ok": True,
            "ext": target.suffix.lstrip(".").lower(),
            "filesize": target.stat().st_size,
            "duration_sec": duration,
        }

    def serve(self, media_path: str, request: Request, *, sliced: bool = False) -> Response:
        target = self._resolve_target(media_path)
        total = target.stat().st_size
        content_type = self.content_type(target)
        base_headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store" if sliced else "public, max-age=3600",
        }

        range_header = request.headers.get("range")

        # Highest quality: plain whole-file response when the browser sends no Range.
        if not range_header and not sliced:
            return StreamingResponse(
                self.iter_range(target, 0, total - 1),
                media_type=content_type,
                headers={**base_headers, "Content-Length": str(total)},
            )

        # Parse the requested range (defaults to the whole file).
        start = 0
        end = total - 1
        if range_header:
            if not range_header.startswith("bytes="):
                raise HTTPException(status_code=416, detail="Unsupported range")
            range_value = range_header.split("=", 1)[1].strip()
            if "," in range_value:
                raise HTTPException(status_code=416, detail="Multiple ranges not supported")
            start_str, end_str = (range_value.split("-", 1) + [""])[:2]
            if start_str == "" and end_str == "":
                raise HTTPException(status_code=416, detail="Invalid range")
            if start_str == "":
                if not end_str.isdigit():
                    raise HTTPException(status_code=416, detail="Invalid range")
                suffix_len = int(end_str)
                if suffix_len <= 0:
                    raise HTTPException(status_code=416, detail="Invalid range")
                start = max(total - suffix_len, 0)
                end = total - 1
            else:
                if not start_str.isdigit():
                    raise HTTPException(status_code=416, detail="Invalid range")
                start = int(start_str)
                if end_str and not end_str.isdigit():
                    raise HTTPException(status_code=416, detail="Invalid range")
                end = int(end_str) if end_str else total - 1

        if start < 0 or start >= total:
            raise HTTPException(status_code=416, detail="Invalid range")
        end = min(end, total - 1)
        if end < start:
            end = start

        if sliced:
            # Data Saver: cap each response to a small slice so the browser
            # re-requests as the playhead advances instead of buffering all.
            end = min(end, start + self.DATA_SAVER_SLICE_BYTES - 1)

        return StreamingResponse(
            self.iter_range(target, start, end),
            media_type=content_type,
            status_code=206,
            headers={
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{total}",
                "Content-Length": str(end - start + 1),
            },
        )
