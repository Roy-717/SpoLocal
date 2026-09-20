"""YouTube audio/video streaming subsystem.

Wraps yt-dlp extraction, short-lived googlevideo URL caching, CDN proxying with
HTTP Range support, MSE stream preparation, and YouTube thumbnail retrieval.
Everything lives behind one class (`YouTubeStreamingService`) so `main.py` only
routes and delegates.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shlex
import tempfile
import time
from pathlib import Path
from typing import Any, AsyncIterator, Optional
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit

import httpx
import yt_dlp as _yt_dlp

from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from audio_quality import (
    ytdlp_stream_cmd as _ytdlp_audio_cmd,
    ytdlp_video_format,
    ytdlp_youtube_opts,
    ytdlp_stream_extract_opts,
)
from cover_image import DEFAULT_JPEG_QUALITY, DEFAULT_THUMB_MAX_SIDE
from models import Track, track_play_variants

_log = logging.getLogger("spolocal.stream")

# googlevideo URLs 403 when stale; keep them short.
PREVIEW_CACHE_TTL_SECONDS = 8 * 60
PREVIEW_CACHE_MAX_ENTRIES = 24
VIDEO_CACHE_TTL_SECONDS = 8 * 60

_STREAM_MEDIA_TYPES = {
    "webm": "audio/webm",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "mp3": "audio/mpeg",
}

_RE_DESC_CHAPTER = re.compile(
    r"(?m)^\s*(?:[\[(])?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-.]?\s+(.+?)\s*$"
)


def _clock_to_seconds(stamp: str) -> Optional[float]:
    parts = stamp.split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 2:
        return float(nums[0] * 60 + nums[1])
    if len(nums) == 3:
        return float(nums[0] * 3600 + nums[1] * 60 + nums[2])
    return None


def _fmt_chapter_clock(time_ms: int) -> str:
    total_s = max(0, int(time_ms) // 1000)
    hours, rem = divmod(total_s, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def _now_ts() -> float:
    return time.time()


def _cdn_host(url: str) -> str:
    return urlsplit(url).netloc or "?"


def _log_cdn_fail(
    *,
    where: str,
    vid: str,
    url: str,
    status: Optional[int] = None,
    retry_after: Optional[str] = None,
    err: Optional[str] = None,
) -> None:
    _log.warning(
        "cdn %s fail vid=%s host=%s status=%s retry_after=%s err=%s",
        where,
        vid,
        _cdn_host(url),
        status if status is not None else "-",
        retry_after or "-",
        err or "-",
    )


def _int_or_none(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        n = int(value)
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _clen_from_url(url: str) -> Optional[int]:
    for key, val in parse_qsl(urlsplit(url).query, keep_blank_values=True):
        if key.lower() == "clen":
            return _int_or_none(val)
    return None


def _drop_query_key(url: str, key: str) -> str:
    """Drop one query key, leave the rest byte-identical (no re-encode)."""
    parts = urlsplit(url)
    bits = [
        pair for pair in parts.query.split("&")
        if pair and pair.split("=", 1)[0].lower() != key.lower()
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(bits), parts.fragment))


def _http_status_from_dump(text: str) -> int:
    codes = re.findall(r"HTTP/\S+\s+(\d+)", text or "")
    return int(codes[-1]) if codes else 599


def _httpx_youtube_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(8.0, read=60.0),
        http2=False,
    )


class YoutubeCdnAudio:
    """A resolved stream (googlevideo URL + headers) ready to be proxied."""

    SLICE_BYTES = 512 * 1024

    def __init__(
        self,
        url: str,
        headers: dict[str, str],
        ext: str,
        filesize: Optional[int],
        chapters: Optional[list[dict[str, Any]]] = None,
        duration_sec: Optional[float] = None,
    ):
        self.url = url
        self.headers = headers
        self.ext = ext
        self.filesize = filesize
        self.chapters = chapters or []
        self.duration_sec = duration_sec

    @staticmethod
    def chapters_from_info(info: dict[str, Any]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for ch in info.get("chapters") or []:
            if not isinstance(ch, dict):
                continue
            start = ch.get("start_time")
            title = str(ch.get("title") or "").strip()
            if start is None or not title:
                continue
            time_ms = int(float(start) * 1000)
            rows.append({"time_ms": time_ms, "text": f"{_fmt_chapter_clock(time_ms)}  {title}"})
        if len(rows) >= 1:
            return rows
        return YoutubeCdnAudio._chapters_from_description(str(info.get("description") or ""))

    @staticmethod
    def _chapters_from_description(description: str) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        last_s = -1.0
        for match in _RE_DESC_CHAPTER.finditer(description or ""):
            seconds = _clock_to_seconds(match.group(1))
            title = (match.group(2) or "").strip()
            if seconds is None or seconds < last_s or not title:
                continue
            if title.lower().startswith("http"):
                continue
            last_s = seconds
            time_ms = int(seconds * 1000)
            found.append({"time_ms": time_ms, "text": f"{_fmt_chapter_clock(time_ms)}  {title}"})
        if len(found) < 2:
            return []
        return found

    def slice_for_range_header(self, range_header: Optional[str]) -> tuple[int, int]:
        start = 0
        end: Optional[int] = None
        if range_header:
            text = range_header.strip()
            if text.lower().startswith("bytes="):
                spec = text.split("=", 1)[1].split(",", 1)[0].strip()
                left, _, right = spec.partition("-")
                try:
                    if left:
                        start = max(0, int(left))
                    if right:
                        end = int(right)
                except ValueError:
                    start = 0
                    end = None
        if end is None or (end - start + 1) > self.SLICE_BYTES:
            end = start + self.SLICE_BYTES - 1
        total = self.filesize
        if total and total > 0:
            if start >= total:
                start = max(0, total - 1)
            end = min(end, total - 1)
        if end < start:
            end = start
        return start, end


async def _open_ytdlp_audio_process(video_id: str, *, max_seconds: Optional[int] = None) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        *_ytdlp_audio_cmd(video_id, max_seconds=max_seconds),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


class YoutubeStreamProxy:
    """Same-origin proxy of YouTube's audio/video URL so the browser can Range-buffer."""

    def __init__(self, service: "YouTubeStreamingService", video_id: str, *, height: Optional[int] = None):
        self.service = service
        self.video_id = video_id
        self.height = height

    def _media_type(self, ext: str, content_type: Optional[str]) -> str:
        if content_type and "html" not in content_type.lower():
            return content_type.split(";")[0].strip()
        return _STREAM_MEDIA_TYPES.get((ext or "").lower(), "application/octet-stream")

    def _out_headers(self, *, start: int, end: int, total: Optional[int], content_type_len: Optional[int] = None) -> dict[str, str]:
        length = end - start + 1
        total_s = str(total) if total and total > 0 else "*"
        return {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "Content-Range": f"bytes {start}-{end}/{total_s}",
            "Content-Length": str(content_type_len or length),
        }

    def _cdn_headers(
        self,
        yt_headers: dict[str, str],
        start: int,
        end: int,
        *,
        http_range: bool,
    ) -> dict[str, str]:
        headers = dict(yt_headers)
        headers.pop("Range", None)
        if http_range:
            headers["Range"] = f"bytes={start}-{end}"
        return headers

    async def _probe_filesize(self, source: YoutubeCdnAudio) -> Optional[int]:
        return _clen_from_url(source.url) or (source.filesize if source.filesize and source.filesize > 0 else None)

    async def _try_cdn_proxy(
        self,
        method: str,
        source: YoutubeCdnAudio,
        range_header: Optional[str],
    ) -> Optional[Response]:
        start, end = source.slice_for_range_header(range_header)
        url = _drop_query_key(source.url, "range")
        total = source.filesize or _clen_from_url(source.url)
        media_type = self._media_type(source.ext, None)
        if method == "HEAD":
            head_headers = {
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            }
            if total:
                head_headers["Content-Length"] = str(total)
            return Response(status_code=200, headers=head_headers, media_type=media_type)

        hdr_path = ""
        hdr_file = tempfile.NamedTemporaryFile(prefix="spolocal-cdn-", suffix=".hdr", delete=False)
        hdr_path = hdr_file.name
        hdr_file.close()
        cmd = [
            "curl", "-sS", "-L", "--http1.1",
            "-D", hdr_path,
            "-o", "-",
            "-r", f"{int(start)}-{int(end)}",
            "--max-time", "60",
        ]
        for key, val in source.headers.items():
            if str(key).lower() == "range":
                continue
            cmd.extend(["-H", f"{key}: {val}"])
        cmd.append(url)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if proc.stdout is None:
            proc.kill()
            await proc.wait()
            Path(hdr_path).unlink(missing_ok=True)
            return None
        first = await proc.stdout.read(65536)
        try:
            dump = Path(hdr_path).read_text(errors="replace")
        except OSError:
            dump = ""
        status = _http_status_from_dump(dump)
        if status >= 400 or not first:
            _log_cdn_fail(where="curl", vid=self.video_id, url=url, status=status)
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            Path(hdr_path).unlink(missing_ok=True)
            return None
        cr = ""
        for line in dump.splitlines():
            if line.lower().startswith("content-range:"):
                cr = line.split(":", 1)[1].strip()
        if "/" in cr:
            try:
                probed = int(cr.rsplit("/", 1)[-1])
                if probed > 0 and (not total or probed > total):
                    total = probed
                    source.filesize = probed
            except ValueError:
                pass
        out = self._out_headers(start=start, end=end, total=total)
        captured = proc
        header_path = hdr_path
        lead = first

        async def generate() -> AsyncIterator[bytes]:
            sent = 0
            try:
                chunk = lead
                while chunk:
                    yield chunk
                    sent += len(chunk)
                    chunk = await captured.stdout.read(65536)
            finally:
                if captured.returncode is None:
                    captured.kill()
                await captured.wait()
                Path(header_path).unlink(missing_ok=True)

        return StreamingResponse(
            generate(),
            status_code=206,
            media_type=media_type,
            headers=out,
        )

    async def response_for(self, request: Request) -> Response:
        method = "HEAD" if request.method == "HEAD" else "GET"
        range_header = request.headers.get("range")
        for attempt in range(2):
            if attempt:
                self.service.drop_cache(self.video_id, height=self.height)
            try:
                source = (
                    await self.service.get_video_payload(self.video_id, self.height)
                    if self.height
                    else await self.service.get_preview_payload(self.video_id)
                )
            except ValueError as exc:
                _log.warning("cdn extract fail vid=%s err=%s", self.video_id, exc)
                break
            if not source.filesize:
                source.filesize = await self._probe_filesize(source)
            proxied = await self._try_cdn_proxy(method, source, range_header)
            if proxied is not None:
                return proxied
        start = 0
        if range_header:
            text = range_header.strip()
            if text.lower().startswith("bytes="):
                left = text.split("=", 1)[1].split(",", 1)[0].split("-", 1)[0].strip()
                try:
                    start = int(left) if left else 0
                except ValueError:
                    start = 0
        if start > 0:
            _log.warning("cdn give up vid=%s range_start=%s, no ytdlp pipe", self.video_id, start)
            raise HTTPException(status_code=503, detail="Stream range unavailable")
        if self.height:
            raise HTTPException(status_code=502, detail="Video stream unavailable")
        _log.warning("cdn give up vid=%s, mp3 pipe", self.video_id)
        return await self._ytdlp_mp3_pipe_response()

    async def _ytdlp_mp3_pipe_response(self) -> StreamingResponse:
        ytdlp = " ".join(shlex.quote(part) for part in _ytdlp_audio_cmd(self.video_id))
        cmd = (
            ytdlp
            + " | ffmpeg -hide_banner -loglevel error -i pipe:0 -vn -c:a libmp3lame -q:a 6 -f mp3 pipe:1"
        )
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        async def generate() -> AsyncIterator[bytes]:
            sent_any = False
            try:
                if proc.stdout is None:
                    return
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    sent_any = True
                    yield chunk
            finally:
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
                if not sent_any:
                    _log.warning("mp3 pipe empty vid=%s", self.video_id)

        return StreamingResponse(
            generate(),
            media_type="audio/mpeg",
            headers={
                "Accept-Ranges": "none",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )


class YoutubeThumbQuality:
    """Map playback quality to YouTube still filenames and local JPEG size."""

    @staticmethod
    def parse(q: Any) -> str:
        s = str(q or "").strip().lower()
        if s in ("low", "64", "64k"):
            return "low"
        if s in ("mid", "medium", "120", "120k"):
            return "mid"
        return "high"

    @staticmethod
    def files(tier: str) -> tuple[str, ...]:
        if tier == "low":
            return ("default.jpg", "mqdefault.jpg")
        if tier == "mid":
            return ("mqdefault.jpg", "hqdefault.jpg", "default.jpg")
        return ("hqdefault.jpg", "mqdefault.jpg", "default.jpg")

    @staticmethod
    def max_side(tier: str) -> int:
        if tier == "low":
            return 48
        if tier == "mid":
            return 96
        return DEFAULT_THUMB_MAX_SIDE

    @staticmethod
    def jpeg_quality(tier: str) -> int:
        if tier == "low":
            return 28
        if tier == "mid":
            return 50
        return DEFAULT_JPEG_QUALITY


class YouTubeStreamingService:
    """Coordinates stream extraction, caching, proxying, and thumbnails."""

    def __init__(self, root: Path):
        self.root = root
        self._preview_cache: dict[str, tuple[YoutubeCdnAudio, float]] = {}
        self._preview_inflight: dict[str, asyncio.Task[YoutubeCdnAudio]] = {}
        self._video_cache: dict[str, tuple[YoutubeCdnAudio, float]] = {}
        self._video_inflight: dict[str, asyncio.Task[YoutubeCdnAudio]] = {}

    # ---- stream source helpers --------------------------------------------

    def stream_play_src_for_video_id(self, video_id: str) -> str:
        return "/api/stream?vid=" + quote(video_id.strip(), safe="")

    def stream_play_src_for_track(self, t: Track) -> Optional[str]:
        vid = t.resolved_youtube_video_id()
        if not vid:
            return None
        return self.stream_play_src_for_video_id(vid)

    def resolve_track_play_src(self, t: Track, *, playback_quality: Optional[str] = None) -> Optional[str]:
        variants = track_play_variants(t)
        preferred = playback_quality or "192"
        play_src = variants.get(preferred) or variants.get("192") or t.play_src()
        if not play_src and variants:
            best_key = sorted(variants.keys(), key=lambda k: int(k) if str(k).isdigit() else 0, reverse=True)[0]
            play_src = variants.get(best_key)
        if not play_src:
            play_src = self.stream_play_src_for_track(t)
        return play_src

    # ---- preview extraction + caching -------------------------------------

    async def get_preview_payload(self, video_id: str) -> YoutubeCdnAudio:
        now = _now_ts()
        entry = self._preview_cache.get(video_id)
        if entry is not None and entry[1] > now:
            self._preview_cache[video_id] = (entry[0], now + PREVIEW_CACHE_TTL_SECONDS)
            return entry[0]

        pending = self._preview_inflight.get(video_id)
        if pending is None:
            task = asyncio.create_task(self._cache_or_refresh_preview(video_id))
            self._preview_inflight[video_id] = task
            pending = task

        try:
            return await pending
        finally:
            if self._preview_inflight.get(video_id) is pending:
                self._preview_inflight.pop(video_id, None)

    async def _cache_or_refresh_preview(self, video_id: str) -> YoutubeCdnAudio:
        source = await asyncio.get_running_loop().run_in_executor(
            None,
            _extract_preview_payload,
            video_id,
        )
        if not source.url:
            raise ValueError("No preview stream URL from yt-dlp")

        now = _now_ts()
        self._preview_cache[video_id] = (source, now + PREVIEW_CACHE_TTL_SECONDS)
        self._preview_cache_cleanup(now)
        return source

    async def get_video_payload(self, video_id: str, height: int) -> YoutubeCdnAudio:
        key = f"{video_id}:{int(height)}"
        now = _now_ts()
        entry = self._video_cache.get(key)
        if entry is not None and entry[1] > now:
            return entry[0]
        pending = self._video_inflight.get(key)
        if pending is None:
            async def _load() -> YoutubeCdnAudio:
                source = await asyncio.get_running_loop().run_in_executor(
                    None, _extract_video_payload, video_id, int(height)
                )
                self._video_cache[key] = (source, _now_ts() + VIDEO_CACHE_TTL_SECONDS)
                return source

            task = asyncio.create_task(_load())
            self._video_inflight[key] = task
            pending = task
        try:
            return await pending
        finally:
            if self._video_inflight.get(key) is pending:
                self._video_inflight.pop(key, None)

    async def prefetch_preview(self, video_id: str) -> None:
        try:
            await self.get_preview_payload(video_id)
        except Exception as exc:
            _log.debug("prefetch skip vid=%s err=%s", video_id, exc)

    async def prefetch_mix_stream_payloads(self, video_ids: list[str]) -> None:
        seen: list[str] = []
        for raw in video_ids:
            vid = str(raw or "").strip()
            if not vid or vid in seen:
                continue
            seen.append(vid)
        if not seen:
            return
        sem = asyncio.Semaphore(4)

        async def _one(vid: str) -> None:
            async with sem:
                await self.prefetch_preview(vid)

        await asyncio.gather(*[_one(v) for v in seen])

    # ---- cache management ---------------------------------------------------

    def drop_cache(self, video_id: str, *, height: Optional[int] = None) -> None:
        if height:
            key = f"{video_id}:{int(height)}"
            self._video_cache.pop(key, None)
        else:
            self._preview_cache.pop(video_id, None)
        self._video_cache.pop(f"{video_id}:{int(height)}", None) if height else None

    def release(self, video_id: Optional[str] = None) -> None:
        """Drop cached preview/video payloads so the next request re-extracts."""
        if video_id:
            vid = video_id.strip()
            self._preview_cache.pop(vid, None)
            for key in list(self._video_cache.keys()):
                if key.startswith(vid + ":"):
                    self._video_cache.pop(key, None)
            return
        self._preview_cache.clear()
        self._video_cache.clear()

    def _preview_cache_cleanup(self, now: float) -> None:
        if not self._preview_cache:
            return

        expired = [vid for vid, _ in self._preview_cache.items() if _[1] <= now]
        for vid in expired:
            self._preview_cache.pop(vid, None)

        if len(self._preview_cache) <= PREVIEW_CACHE_MAX_ENTRIES:
            return

        items = sorted(self._preview_cache.items(), key=lambda kv: kv[1][1])
        for vid, _ in items[:len(self._preview_cache) - PREVIEW_CACHE_MAX_ENTRIES]:
            self._preview_cache.pop(vid, None)

    # ---- output builders ----------------------------------------------------

    def proxy(self, video_id: str, *, height: Optional[int] = None) -> YoutubeStreamProxy:
        return YoutubeStreamProxy(self, video_id, height=height)

    async def annotate_search_stream_src(self, hits: list[dict[str, Any]]) -> None:
        """Attach same-origin stream URLs; never expose YouTube CDN URLs to the browser."""
        for hit in hits:
            hit.pop("preview_url", None)
            hit.pop("preview_ext", None)
            vid = hit.get("video_id")
            if isinstance(vid, str) and vid.strip():
                hit["stream_src"] = self.stream_play_src_for_video_id(vid.strip())

    async def stream_ytdlp_audio_or_502(
        self,
        video_id: str,
        *,
        max_bytes: Optional[int] = None,
        max_seconds: Optional[int] = None,
    ) -> AsyncIterator[bytes]:
        proc = await _open_ytdlp_audio_process(video_id, max_seconds=max_seconds)
        sent_bytes = 0
        sent_any = False
        try:
            if proc.stdout is None:
                raise HTTPException(status_code=502, detail="Could not stream audio")
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                if max_bytes is not None:
                    remaining = max_bytes - sent_bytes
                    if remaining <= 0:
                        break
                    if len(chunk) > remaining:
                        chunk = chunk[:remaining]
                sent_bytes += len(chunk)
                sent_any = True
                yield chunk
                if max_bytes is not None and sent_bytes >= max_bytes:
                    break
        finally:
            if proc.returncode is None:
                proc.kill()
            rc = await proc.wait()
            if not sent_any:
                detail = "Could not stream audio"
                if proc.stderr is not None:
                    err = (await proc.stderr.read()).decode(errors="replace").strip()
                    if err:
                        detail = err.splitlines()[-1][:240]
                raise HTTPException(status_code=502, detail=detail) from None
            if rc not in (0, None) and not sent_any:
                raise HTTPException(status_code=502, detail=f"Audio stream failed ({rc})")

    async def fetch_thumbnail_bytes(self, video_id: str, tier: str) -> Optional[tuple[bytes, str]]:
        urls = tuple(f"https://i.ytimg.com/vi/{video_id}/{name}" for name in YoutubeThumbQuality.files(tier))
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
                for url in urls:
                    r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                    if r.is_success and r.content:
                        mime = r.headers.get("content-type") or "image/jpeg"
                        if not mime.startswith("image/"):
                            mime = "image/jpeg"
                        return r.content, mime
        except Exception:
            return None
        return None


def _extract_preview_payload(video_id: str) -> YoutubeCdnAudio:
    url_yt = f"https://www.youtube.com/watch?v={video_id}"
    last_err: Exception | None = None
    tries = (
        ytdlp_stream_extract_opts(),
        {**ytdlp_youtube_opts(), "format": "bestaudio/bestaudio*"},
    )
    info = None
    for extra in tries:
        opts: dict[str, Any] = {"quiet": True, "no_warnings": True}
        opts.update(extra)
        try:
            with _yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url_yt, download=False)
        except Exception as exc:
            last_err = exc
            info = None
            continue
        if info and str(info.get("url") or "").strip():
            break
        info = None
    if not info or not str(info.get("url") or "").strip():
        raise ValueError(str(last_err) if last_err else "No preview stream URL from yt-dlp")
    raw_url = str(info.get("url") or "")
    filesize = _clen_from_url(raw_url) or _int_or_none(info.get("filesize")) or _int_or_none(info.get("filesize_approx"))
    return YoutubeCdnAudio(
        url=raw_url,
        headers={
            str(k): str(v)
            for k, v in (info.get("http_headers") or {}).items()
            if isinstance(k, str) and isinstance(v, str)
        },
        ext=str(info.get("ext") or "webm"),
        filesize=filesize,
        chapters=YoutubeCdnAudio.chapters_from_info(info),
        duration_sec=_int_or_none(info.get("duration")),
    )


def _video_fmt_url(info: dict[str, Any]) -> tuple[str, str, Optional[int], dict[str, str]]:
    fmt = info
    req = info.get("requested_formats")
    if isinstance(req, list) and req:
        picked = next(
            (row for row in req if isinstance(row, dict) and str(row.get("vcodec") or "none") != "none"),
            req[0],
        )
        if isinstance(picked, dict):
            fmt = picked
    raw_url = str(fmt.get("url") or info.get("url") or "")
    filesize = _clen_from_url(raw_url) or _int_or_none(fmt.get("filesize")) or _int_or_none(fmt.get("filesize_approx"))
    headers = {
        str(k): str(v)
        for k, v in (fmt.get("http_headers") or info.get("http_headers") or {}).items()
        if isinstance(k, str) and isinstance(v, str)
    }
    ext = str(fmt.get("ext") or info.get("ext") or "mp4")
    return raw_url, ext, filesize, headers


def _extract_video_payload(video_id: str, height: int) -> YoutubeCdnAudio:
    url_yt = f"https://www.youtube.com/watch?v={video_id}"
    opts: dict[str, Any] = {
        "format": ytdlp_video_format(height),
        "quiet": True,
        "no_warnings": True,
    }
    opts.update(ytdlp_youtube_opts())
    try:
        with _yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url_yt, download=False)
    except Exception as exc:
        raise ValueError(str(exc)) from exc
    if not info:
        raise ValueError("No info returned by yt-dlp")
    raw_url, ext, filesize, headers = _video_fmt_url(info)
    if not raw_url:
        raise ValueError("No video stream URL from yt-dlp")
    return YoutubeCdnAudio(url=raw_url, headers=headers, ext=ext, filesize=filesize, chapters=[])