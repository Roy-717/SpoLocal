"""Local file serving for downloaded media with HTTP Range support.

The browser seeks/buffers like a streaming player, so we serve audio files with
byte-range requests and correct MIME types.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse


class MediaServer:
    """Serves files from a media root with HTTP Range support and MIME sniffing."""

    CHUNK_BYTES = 64 * 1024

    def __init__(self, media_root: Path):
        self.media_root = media_root.resolve()

    def content_type(self, file_path: Path) -> str:
        import mimetypes

        mime, _ = mimetypes.guess_type(file_path.name)
        if mime:
            return mime
        suffix = file_path.suffix.lower()
        if suffix == ".m4a":
            return "audio/mp4"
        if suffix == ".mp3":
            return "audio/mpeg"
        if suffix == ".webm":
            return "audio/webm"
        return "application/octet-stream"

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

    def serve(self, media_path: str, request: Request) -> Response:
        target = self._resolve_target(media_path)
        total = target.stat().st_size
        content_type = self.content_type(target)
        base_headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }

        range_header = request.headers.get("range")
        if not range_header:
            return StreamingResponse(
                self.iter_range(target, 0, total - 1),
                media_type=content_type,
                headers={**base_headers, "Content-Length": str(total)},
            )

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

        if start < 0 or end < start or start >= total:
            raise HTTPException(status_code=416, detail="Invalid range")
        end = min(end, total - 1)

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
