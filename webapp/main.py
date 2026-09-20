"""FastAPI app entrypoint for SpoLocal.

Registers page and API routes for search, playlists, downloads, and media serving.
Coordinates the download, metadata, and model layers to serve each request."""
from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator, Optional
import logging
import re
import time
import mimetypes
import shlex
import tempfile
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit

from dotenv import load_dotenv
import asyncio

import httpx
import yt_dlp as _yt_dlp

from fastapi import FastAPI, Request, Form, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
from starlette.datastructures import Headers
from starlette.staticfiles import NotModifiedResponse, StaticFiles

from pydantic import BaseModel, Field

from lyrics_fetch import fetch_lrclib_sidecar_sync
from models import Playlist, Track, track_play_variants
from download_service import DownloadService
from tag_metadata import extract_cover
from cover_image import DEFAULT_JPEG_QUALITY, DEFAULT_THUMB_MAX_SIDE, square_thumb_jpeg
from audio_quality import ytdlp_stream_cmd as _ytdlp_audio_cmd
from audio_quality import (
    ytdlp_video_format,
    ytdlp_youtube_opts,
    ytdlp_stream_extract_opts,
    parse_quality_kbps,
    video_height_for_kbps,
)


def _youtube_video_id_from_track_metadata(artist: str, title: str) -> Optional[str]:
    """Fallback for cover art: first ytsearch hit for artist + title."""
    q = f"{artist} {title}".strip()
    if len(q) < 2:
        return None
    try:
        hits = search_youtube_tracks(root, q, limit=1)
        if hits and hits[0].get("video_id"):
            return str(hits[0]["video_id"])
    except Exception:
        return None
    return None


_webapp_dir = Path(__file__).resolve().parent
load_dotenv(_webapp_dir / ".env")

app = FastAPI(title="SpoLocal")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Windows often maps .js to text/plain in the registry; Starlette uses mimetypes.guess_type.
mimetypes.add_type("application/javascript", ".js", strict=False)
mimetypes.add_type("application/javascript", ".mjs", strict=False)
mimetypes.add_type("text/css", ".css", strict=False)
templates = Jinja2Templates(directory=str(_webapp_dir / "templates"))

root = _webapp_dir.parent
import sys

if str(root) not in sys.path:
    sys.path.insert(0, str(root))
from spotify_scraper import YoutubePlaylistMix, search_youtube_tracks

service = DownloadService(root)

# googlevideo URLs 403 when stale; keep them short.
_PREVIEW_CACHE_TTL_SECONDS = 8 * 60
_PREVIEW_CACHE_MAX_ENTRIES = 24
_SEARCH_PREVIEW_LIMIT = 6
_SEARCH_CACHE_MAX_RESULTS = 30
_SEARCH_CACHE_TTL_SECONDS = 180
_SEARCH_CACHE_MAX_ENTRIES = 20
_preview_cache: dict[str, tuple[YoutubeCdnAudio, float]] = {}
_preview_inflight: dict[str, asyncio.Task[YoutubeCdnAudio]] = {}
_video_cache: dict[str, tuple[YoutubeCdnAudio, float]] = {}
_video_inflight: dict[str, asyncio.Task[YoutubeCdnAudio]] = {}
_search_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_search_cache_lock = asyncio.Lock()
_recommendation_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_recommendation_cache_lock = asyncio.Lock()
_RECOMMENDATION_CACHE_TTL_SECONDS = 600
_RECOMMENDATION_CACHE_MAX_ENTRIES = 24


def _now_ts() -> float:
    return time.time()


def _normalize_query(q: str) -> str:
    return " ".join((q or "").strip().lower().split())


def _search_cache_cleanup(now: float) -> None:
    if not _search_cache:
        return
    expired = [k for k, v in _search_cache.items() if v[1] <= now]
    for k in expired:
        _search_cache.pop(k, None)
    if len(_search_cache) <= _SEARCH_CACHE_MAX_ENTRIES:
        return

    items = sorted(_search_cache.items(), key=lambda kv: kv[1][1])
    for k, _ in items[:len(_search_cache) - _SEARCH_CACHE_MAX_ENTRIES]:
        _search_cache.pop(k, None)


def _preview_cache_cleanup(now: float) -> None:
    if not _preview_cache:
        return

    expired = [vid for vid, _ in _preview_cache.items() if _[1] <= now]
    for vid in expired:
        _preview_cache.pop(vid, None)

    if len(_preview_cache) <= _PREVIEW_CACHE_MAX_ENTRIES:
        return

    items = sorted(_preview_cache.items(), key=lambda kv: kv[1][1])
    for vid, _ in items[:len(_preview_cache) - _PREVIEW_CACHE_MAX_ENTRIES]:
        _preview_cache.pop(vid, None)


def _release_preview_cache(video_id: Optional[str] = None) -> None:
    if video_id:
        vid = video_id.strip()
        _preview_cache.pop(vid, None)
        for key in list(_video_cache.keys()):
            if key.startswith(vid + ":"):
                _video_cache.pop(key, None)
        return
    _preview_cache.clear()
    _video_cache.clear()


def _recommendation_cache_cleanup(now: float) -> None:
    if not _recommendation_cache:
        return

    expired = [k for k, v in _recommendation_cache.items() if v[1] <= now]
    for k in expired:
        _recommendation_cache.pop(k, None)

    if len(_recommendation_cache) <= _RECOMMENDATION_CACHE_MAX_ENTRIES:
        return

    items = sorted(_recommendation_cache.items(), key=lambda kv: kv[1][1])
    for k, _ in items[:len(_recommendation_cache) - _RECOMMENDATION_CACHE_MAX_ENTRIES]:
        _recommendation_cache.pop(k, None)


def _stream_play_src_for_video_id(video_id: str) -> str:
    return "/api/stream?vid=" + quote(video_id.strip(), safe="")


def _stream_play_src_for_track(t: Track) -> Optional[str]:
    vid = t.resolved_youtube_video_id()
    if not vid:
        return None
    return _stream_play_src_for_video_id(vid)


def _resolve_track_play_src(t: Track, *, playback_quality: Optional[str] = None) -> Optional[str]:
    variants = track_play_variants(t)
    preferred = playback_quality or "192"
    play_src = variants.get(preferred) or variants.get("192") or t.play_src()
    if not play_src and variants:
        best_key = sorted(variants.keys(), key=lambda k: int(k) if str(k).isdigit() else 0, reverse=True)[0]
        play_src = variants.get(best_key)
    if not play_src:
        play_src = _stream_play_src_for_track(t)
    return play_src


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


class YoutubeCdnAudio:
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


_STREAM_MEDIA_TYPES = {
    "webm": "audio/webm",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "mp3": "audio/mpeg",
}

_stream_log = logging.getLogger("spolocal.stream")


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
    _stream_log.warning(
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


class YoutubeStreamProxy:
    """Same-origin proxy of YouTube's audio/video URL so the browser can Range-buffer."""

    def __init__(self, video_id: str, *, height: Optional[int] = None):
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
                if self.height:
                    _video_cache.pop(f"{self.video_id}:{int(self.height)}", None)
                else:
                    _preview_cache.pop(self.video_id, None)
            try:
                source = (
                    await _get_video_payload(self.video_id, self.height)
                    if self.height
                    else await _get_preview_payload(self.video_id)
                )
            except ValueError as exc:
                _stream_log.warning("cdn extract fail vid=%s err=%s", self.video_id, exc)
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
            _stream_log.warning("cdn give up vid=%s range_start=%s, no ytdlp pipe", self.video_id, start)
            raise HTTPException(status_code=503, detail="Stream range unavailable")
        if self.height:
            raise HTTPException(status_code=502, detail="Video stream unavailable")
        _stream_log.warning("cdn give up vid=%s, mp3 pipe", self.video_id)
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
                    _stream_log.warning("mp3 pipe empty vid=%s", self.video_id)

        return StreamingResponse(
            generate(),
            media_type="audio/mpeg",
            headers={
                "Accept-Ranges": "none",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )


async def _stream_ytdlp_audio_or_502(
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


async def _cache_or_refresh_preview(video_id: str) -> YoutubeCdnAudio:
    source = await asyncio.get_running_loop().run_in_executor(
        None,
        _extract_preview_payload,
        video_id,
    )
    if not source.url:
        raise ValueError("No preview stream URL from yt-dlp")

    now = _now_ts()
    _preview_cache[video_id] = (source, now + _PREVIEW_CACHE_TTL_SECONDS)
    _preview_cache_cleanup(now)
    return source


async def _get_preview_payload(video_id: str) -> YoutubeCdnAudio:
    now = _now_ts()
    entry = _preview_cache.get(video_id)
    if entry is not None and entry[1] > now:
        _preview_cache[video_id] = (entry[0], now + _PREVIEW_CACHE_TTL_SECONDS)
        return entry[0]

    pending = _preview_inflight.get(video_id)
    if pending is None:
        task = asyncio.create_task(_cache_or_refresh_preview(video_id))
        _preview_inflight[video_id] = task
        pending = task

    try:
        return await pending
    finally:
        if _preview_inflight.get(video_id) is pending:
            _preview_inflight.pop(video_id, None)


async def _prefetch_one_preview(video_id: str) -> None:
    try:
        await _get_preview_payload(video_id)
    except Exception as exc:
        _stream_log.debug("prefetch skip vid=%s err=%s", video_id, exc)


async def _prefetch_mix_stream_payloads(video_ids: list[str]) -> None:
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
            await _prefetch_one_preview(vid)

    await asyncio.gather(*[_one(v) for v in seen])


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


async def _get_video_payload(video_id: str, height: int) -> YoutubeCdnAudio:
    key = f"{video_id}:{int(height)}"
    now = _now_ts()
    entry = _video_cache.get(key)
    if entry is not None and entry[1] > now:
        return entry[0]
    pending = _video_inflight.get(key)
    if pending is None:
        async def _load() -> YoutubeCdnAudio:
            source = await asyncio.get_running_loop().run_in_executor(
                None, _extract_video_payload, video_id, int(height)
            )
            _video_cache[key] = (source, _now_ts() + _PREVIEW_CACHE_TTL_SECONDS)
            return source

        task = asyncio.create_task(_load())
        _video_inflight[key] = task
        pending = task
    try:
        return await pending
    finally:
        if _video_inflight.get(key) is pending:
            _video_inflight.pop(key, None)


async def _annotate_search_stream_src(hits: list[dict[str, Any]]) -> None:
    """Attach same-origin stream URLs; never expose YouTube CDN URLs to the browser."""
    for hit in hits:
        hit.pop("preview_url", None)
        hit.pop("preview_ext", None)
        vid = hit.get("video_id")
        if isinstance(vid, str) and vid.strip():
            hit["stream_src"] = _stream_play_src_for_video_id(vid.strip())


def _annotate_library_matches(hits: list[dict[str, Any]]) -> None:
    for hit in hits:
        hit["library_matches"] = service.library_matches_for_hit(
            str(hit.get("video_id") or ""),
            str(hit.get("title") or ""),
            str(hit.get("artist") or hit.get("channel") or ""),
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


async def _fetch_youtube_thumb_bytes(video_id: str, tier: str) -> Optional[tuple[bytes, str]]:
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


_cover_tile_cache_dir = _webapp_dir / "static" / "cover_tiles"
# Small on-disk / on-the-wire JPEGs so the browser does not decode huge album art for tiny UI tiles.
_COVER_THUMB_MAX_SIDE = DEFAULT_THUMB_MAX_SIDE
_COVER_JPEG_QUALITY = DEFAULT_JPEG_QUALITY


def _track_payload_row(t: Track, *, playback_quality: Optional[str] = None) -> dict[str, Any]:
    st = t.status.value if hasattr(t.status, "value") else str(t.status)
    variants = track_play_variants(t)
    play_src = _resolve_track_play_src(t, playback_quality=playback_quality)
    stream_src = _stream_play_src_for_track(t)
    return {
        "id": t.id,
        "title": t.title,
        "artist": t.artist,
        "album": t.album or "",
        "play_src": play_src,
        "stream_src": stream_src,
        "play_variants": variants,
        "status": st,
        "url": t.url or "",
        "youtube_video_id": t.resolved_youtube_video_id(),
        "error": t.error or "",
        "loudness_gain_db": t.loudness_gain_db,
    }


def cover_tile_cache_path(playlist_id: str, track_id: str, *, max_side: Optional[int] = None) -> Path:
    """On-disk cache: square JPEG, max edge _COVER_THUMB_MAX_SIDE (see module constants)."""
    side = int(max_side or _COVER_THUMB_MAX_SIDE)
    safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
    safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
    return _cover_tile_cache_dir / f"{safe_p}_{safe_t}_s{side}.jpg"


def _unlink_track_cover_caches(playlist_id: str, track_id: str) -> None:
    """Remove current and any legacy per-track cover cache files."""
    safe_p = "".join(c if c.isalnum() or c in "-_" else "_" for c in playlist_id.strip())[:120]
    safe_t = "".join(c if c.isalnum() or c in "-_" else "_" for c in track_id.strip())[:120]
    try:
        for p in _cover_tile_cache_dir.glob(f"{safe_p}_{safe_t}*.jpg"):
            p.unlink(missing_ok=True)
    except OSError:
        pass


def _cover_tiles_for_playlist(pl: Playlist) -> list[str]:
    return [f"/playlists/{pl.id}/tracks/{t.id}/cover" for t in pl.tracks[:4]]


def _library_pool_payload() -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    for pl in service.list_playlists():
        for t in pl.tracks:
            variants = track_play_variants(t)
            src = _resolve_track_play_src(t)
            if not src:
                continue
            pool.append(
                {
                    "playlist_id": pl.id,
                    "track_id": t.id,
                    "title": t.title,
                    "artist": t.artist,
                    "album": t.album or "",
                    "play_src": src,
                    "play_variants": variants,
                    "url": t.url or "",
                    "youtube_video_id": t.resolved_youtube_video_id(),
                }
            )
    return pool


@app.get("/", response_class=HTMLResponse)
async def index(request: Request, playlist_id: Optional[str] = None):
    pid = playlist_id.strip() if playlist_id else None
    playlists = service.list_playlists()
    is_home = not pid
    current: Optional[Playlist] = None
    current_tracks_payload: list[dict[str, Any]] = []
    current_cover_tiles: list[str] = []
    home_library_pool: list[dict[str, Any]] = []

    if pid:
        current = service.get_playlist(pid)
        if not current:
            is_home = True
        else:
            await asyncio.to_thread(service.hydrate_media_paths, current, fill_albums=False, persist=False)
            current_tracks_payload = [_track_payload_row(t) for t in current.tracks]
            current_cover_tiles = _cover_tiles_for_playlist(current)

    if is_home:
        for pl in playlists:
            await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
        home_library_pool = _library_pool_payload()

    nav_current = None if is_home else (current.id if current else None)
    playlist_nav = service.list_playlist_nav(nav_current)
    playlist_catalog = service.list_playlist_catalog()
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "playlist_nav": playlist_nav,
            "playlist_catalog": playlist_catalog,
            "current": current,
            "is_home": is_home,
            "current_cover_tiles": current_cover_tiles,
            "current_tracks_payload": current_tracks_payload,
            "home_library_pool": home_library_pool,
            "service": service,
            "liked_playlist_id": DownloadService.LIKED_SONGS_PLAYLIST_ID,
        },
    )


@app.get("/api/playlists/catalog")
async def api_playlists_catalog():
    return JSONResponse(service.list_playlist_catalog())


@app.get("/api/liked-keys")
async def api_liked_keys():
    return JSONResponse({"keys": service.list_liked_entry_keys()})


class CreatePlaylistBody(BaseModel):
    name: str = Field(..., min_length=1)


class TrackLikeBody(BaseModel):
    source_playlist_id: str = Field(..., min_length=1)
    source_track_id: str = Field(..., min_length=1)
    liked: bool


class TrackDetailsBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    artist: str = Field("", max_length=300)
    album: str = Field("", max_length=300)


@app.post("/api/track/like")
async def api_track_like(body: TrackLikeBody):
    ok = service.set_track_liked(body.source_playlist_id.strip(), body.source_track_id.strip(), body.liked)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="Could not update like. The track may not be downloaded yet, or it may already be in Liked Songs.",
        )
    return JSONResponse({"ok": True, "liked": body.liked})


@app.get("/api/playlists/{playlist_id}/tracks/{track_id}/info")
async def api_track_info(playlist_id: str, track_id: str):
    info = service.get_track_info(playlist_id, track_id)
    if not info:
        raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse(info)


@app.post("/api/playlists/{playlist_id}/tracks/{track_id}/details")
async def api_track_details(playlist_id: str, track_id: str, body: TrackDetailsBody):
    updated = await asyncio.to_thread(
        service.update_track_details,
        playlist_id,
        track_id,
        body.title,
        body.artist,
        body.album,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse({"ok": True, **updated})


@app.get("/api/playlists/{playlist_id}/tracks/{track_id}/loudness-gain")
async def api_track_loudness_gain(playlist_id: str, track_id: str):
    try:
        gain = await asyncio.to_thread(service.ensure_track_loudness_gain, playlist_id, track_id)
    except Exception:
        return JSONResponse({"loudness_gain_db": None})
    if gain is None:
        pl = service.get_playlist(playlist_id.strip())
        if not pl or not pl.get_track(track_id.strip()):
            raise HTTPException(status_code=404, detail="Track not found")
    return JSONResponse({"loudness_gain_db": gain})


@app.get("/api/playlist/state")
async def api_playlist_state(playlist_id: str):
    pl = service.get_playlist(playlist_id.strip())
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    return JSONResponse(
        {
            "playlist_id": pl.id,
            "tracks_payload": [_track_payload_row(t) for t in pl.tracks],
        },
    )


@app.get("/api/home/view")
async def api_home_view(request: Request):
    """HTML fragment for in-page home switching."""
    for pl in service.list_playlists():
        await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    tpl = templates.env.get_template("partials/home_main.html")
    html = tpl.render(request=request)
    return JSONResponse(
        {
            "html": html,
            "view": "home",
            "library_pool": _library_pool_payload(),
            "catalog": service.list_playlist_catalog(),
        }
    )


@app.post("/api/playlists")
async def api_create_playlist(body: CreatePlaylistBody):
    try:
        pl = service.create_playlist(body.name.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    tiles = [f"/playlists/{pl.id}/tracks/{t.id}/cover" for t in pl.tracks[:4]]
    return JSONResponse(
        {
            "ok": True,
            "playlist": {
                "id": pl.id,
                "name": pl.name,
                "bio": pl.bio or "",
                "cover_tiles": tiles,
                "system_locked": False,
            },
        }
    )


@app.get("/api/playlist/view")
async def api_playlist_view(request: Request, playlist_id: str):
    """HTML fragment + track payload for in-page playlist switching (query param avoids path parsing issues)."""
    pl = service.get_playlist(playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    await asyncio.to_thread(service.hydrate_media_paths, pl, fill_albums=False, persist=False)
    tracks_payload = [_track_payload_row(t) for t in pl.tracks]
    tpl = templates.env.get_template("partials/playlist_main.html")
    html = tpl.render(
        request=request,
        current=pl,
        current_cover_tiles=_cover_tiles_for_playlist(pl),
        liked_playlist_id=DownloadService.LIKED_SONGS_PLAYLIST_ID,
    )
    return JSONResponse(
        {"html": html, "tracks_payload": tracks_payload, "playlist_id": pl.id},
    )


@app.get("/api/playlist/recommendations")
async def api_playlist_recommendations(
    playlist_id: str,
    background_tasks: BackgroundTasks,
    limit: int = 12,
    fresh: int = 0,
):
    """YouTube Mix from playlist seeds; same hit shape as `/api/search/songs`."""
    pl = service.get_playlist(playlist_id.strip())
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    lim = max(1, min(int(limit), 30))
    seed_ids = [t.resolved_youtube_video_id() for t in (pl.tracks or [])]
    seed_key = ",".join(YoutubePlaylistMix().pick_seed_ids(seed_ids))
    cache_key = f"{pl.id}|{lim}|rdmix1|{seed_key}"

    now = _now_ts()
    cached_hits: list[dict[str, Any]] | None = None
    async with _recommendation_cache_lock:
        _recommendation_cache_cleanup(now)
        if fresh:
            _recommendation_cache.pop(cache_key, None)
        cached = _recommendation_cache.get(cache_key)
        if cached is not None:
            cached_hits = cached[0]

    if cached_hits is None:
        def _load_hits() -> list[dict[str, Any]]:
            return YoutubePlaylistMix(root).mix_for_seeds(seed_ids, lim)[:lim]

        loop = asyncio.get_event_loop()
        cached_hits = await loop.run_in_executor(None, _load_hits)
        async with _recommendation_cache_lock:
            _recommendation_cache[cache_key] = (cached_hits, now + _RECOMMENDATION_CACHE_TTL_SECONDS)

    out = [dict(h) for h in (cached_hits or [])][:lim]
    await _annotate_search_stream_src(out)
    _annotate_library_matches(out)
    prefetch_ids = [str(h.get("video_id") or "") for h in out]
    background_tasks.add_task(_prefetch_mix_stream_payloads, prefetch_ids)
    return JSONResponse(out)


@app.get("/api/track/mix")
async def api_track_mix(
    background_tasks: BackgroundTasks,
    vid: str = "",
    playlist_id: str = "",
    track_id: str = "",
    limit: int = 24,
):
    """YouTube Mix for one seed track. Hits are streams, same shape as search."""
    seed_title = ""
    seed_artist = ""
    video_id = (vid or "").strip()
    pid = (playlist_id or "").strip()
    tid = (track_id or "").strip()
    if pid and tid:
        pl = service.get_playlist(pid)
        if not pl:
            raise HTTPException(status_code=404, detail="Playlist not found")
        track = next((t for t in (pl.tracks or []) if str(t.id) == tid), None)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        video_id = track.resolved_youtube_video_id() or video_id
        seed_title = (track.title or "").strip()
        seed_artist = (track.artist or "").strip()
    if len(video_id) != 11:
        raise HTTPException(status_code=400, detail="No YouTube id for this song.")
    asyncio.create_task(_prefetch_one_preview(video_id))
    lim = max(1, min(int(limit), 30))
    cache_key = f"songmix|{video_id}|{lim}"
    now = _now_ts()
    cached_hits: list[dict[str, Any]] | None = None
    async with _recommendation_cache_lock:
        _recommendation_cache_cleanup(now)
        cached = _recommendation_cache.get(cache_key)
        if cached is not None:
            cached_hits = cached[0]

    if cached_hits is None:
        def _load_hits() -> list[dict[str, Any]]:
            related = YoutubePlaylistMix(root).mix_for_video(video_id, lim)
            seed = {
                "video_id": video_id,
                "title": seed_title or "Mix",
                "artist": seed_artist or "YouTube",
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "duration_sec": None,
                "channel": seed_artist,
                "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/default.jpg",
            }
            return [seed] + [h for h in related if h.get("video_id") != video_id]

        loop = asyncio.get_event_loop()
        cached_hits = await loop.run_in_executor(None, _load_hits)
        async with _recommendation_cache_lock:
            _recommendation_cache[cache_key] = (cached_hits, now + _RECOMMENDATION_CACHE_TTL_SECONDS)

    out = [dict(h) for h in (cached_hits or [])][: lim + 1]
    if seed_title and out:
        out[0]["title"] = seed_title
        out[0]["artist"] = seed_artist or out[0].get("artist") or ""
    await _annotate_search_stream_src(out)
    _annotate_library_matches(out)
    warm_ids: list[str] = []
    for hit in out:
        hid = str(hit.get("video_id") or "").strip()
        if len(hid) == 11 and hid not in warm_ids:
            warm_ids.append(hid)
    if warm_ids:
        asyncio.create_task(_prefetch_mix_stream_payloads(warm_ids))
    seed = out[0] if out else {
        "video_id": video_id,
        "title": seed_title,
        "artist": seed_artist,
    }
    return JSONResponse({"seed": seed, "hits": out})


@app.get("/api/search/songs")
async def api_search_songs(q: str = "", limit: int = 30, offset: int = 0, fresh: int = 0):
    q = (q or "").strip()
    if len(q) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters.")
    if offset < 0:
        offset = 0
    if limit < 1:
        limit = 1
    elif limit > _SEARCH_PREVIEW_LIMIT:
        limit = _SEARCH_PREVIEW_LIMIT
    normalized_q = _normalize_query(q)
    now = _now_ts()
    cache_key = normalized_q
    loop = asyncio.get_event_loop()

    hits_cache: list[dict[str, Any]] | None = None

    async with _search_cache_lock:
        _search_cache_cleanup(now)
        if fresh:
            _search_cache.pop(cache_key, None)
        cached = _search_cache.get(cache_key)
        if cached is not None:
            hits_cache = cached[0]

    if hits_cache is None:
        hits_cache = await loop.run_in_executor(None, search_youtube_tracks, root, normalized_q, _SEARCH_CACHE_MAX_RESULTS)
        async with _search_cache_lock:
            _search_cache[cache_key] = (hits_cache, now + _SEARCH_CACHE_TTL_SECONDS)

    start = min(offset, len(hits_cache))
    end = min(start + limit, len(hits_cache))
    hits = [dict(h) for h in hits_cache[start:end]]
    if hits:
        await _annotate_search_stream_src(hits)
        _annotate_library_matches(hits)

    return JSONResponse(
        {
            "hits": hits,
            "offset": start,
            "limit": limit,
            "has_more": end < len(hits_cache),
        }
    )


@app.get("/api/preview")
async def api_preview(vid: str):
    """Stream the first ~30 s of a YouTube video's best audio."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")

    MAX_BYTES = 512 * 1024  # ~30 s at 128 kbps

    async def generate() -> AsyncIterator[bytes]:
        async for chunk in _stream_ytdlp_audio_or_502(vid.strip(), max_bytes=MAX_BYTES, max_seconds=30):
            yield chunk

    return StreamingResponse(generate(), media_type="audio/webm")


@app.get("/api/stream/chapters")
async def api_stream_chapters(vid: str):
    """YouTube chapters for search/stream playback only (not downloaded tracks)."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    try:
        source = await _get_preview_payload(vid.strip())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    chapters = source.chapters or []
    lyrics = "\n".join(str(row.get("text") or "") for row in chapters)
    return JSONResponse(
        {
            "lyrics": lyrics,
            "source": "chapters" if chapters else "none",
            "has_audio": True,
            "lrc_data": chapters or None,
            "lrc_raw": None,
            "readonly": True,
        }
    )


@app.get("/api/stream/lyrics")
async def api_stream_lyrics(title: str = "", artist: str = ""):
    """Same LRCLIB lookup as after a download; nothing is written to disk."""
    from lyrics_files import payload_from_remote_lyrics

    artist_s = (artist or "").strip()
    title_s = (title or "").strip()
    if not title_s:
        raise HTTPException(status_code=400, detail="Title is required")
    plain, synced = await asyncio.to_thread(fetch_lrclib_sidecar_sync, artist_s, title_s)
    payload = payload_from_remote_lyrics(plain, synced)
    payload["readonly"] = True
    return JSONResponse(payload)


@app.post("/api/stream/release")
async def api_stream_release(vid: Optional[str] = Query(None)):
    if vid:
        if not vid.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(status_code=400, detail="Invalid video id")
        _release_preview_cache(vid.strip())
    else:
        _release_preview_cache(None)
    return JSONResponse({"ok": True})


@app.api_route("/api/stream", methods=["GET", "HEAD"])
async def api_stream(request: Request, vid: str, fresh: int = 0):
    """Proxy YouTube audio with Range so the player buffers/seeks like YouTube."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    if fresh:
        _preview_cache.pop(vid, None)
    return await YoutubeStreamProxy(vid).response_for(request)


@app.get("/api/thumb")
async def api_thumb(vid: str, q: str = "high"):
    """Same-origin YouTube thumbnail so canvas color extraction is not tainted."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    fetched = await _fetch_youtube_thumb_bytes(vid, YoutubeThumbQuality.parse(q))
    if fetched:
        raw, mime = fetched
        return Response(
            content=raw,
            media_type=mime,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    raise HTTPException(status_code=404, detail="Thumbnail not found")


@app.get("/api/stream/prepare")
async def api_stream_prepare(vid: str):
    """Resolve googlevideo URL only. Returns ext for MSE codec selection."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    try:
        source = await _get_preview_payload(vid.strip())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse({
        "ok": True,
        "ext": source.ext,
        "filesize": source.filesize,
        "duration_sec": source.duration_sec,
    })


@app.get("/api/stream/video/prepare")
async def api_stream_video_prepare(vid: str, height: int = 0, kbps: int = 0):
    """Resolve the DASH URL only. No media bytes until /api/stream/video."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    h = height if height in (360, 480, 720) else video_height_for_kbps(parse_quality_kbps(kbps))
    try:
        await _get_video_payload(vid, h)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse({"ok": True})


@app.api_route("/api/stream/video", methods=["GET", "HEAD"])
async def api_stream_video(request: Request, vid: str, height: int = 0, kbps: int = 0):
    """DASH/progressive video-only proxy. Loads only when the lyrics pane requests it."""
    if not vid or not vid.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid video id")
    vid = vid.strip()
    if height in (360, 480, 720):
        h = height
    else:
        h = video_height_for_kbps(parse_quality_kbps(kbps))
    return await YoutubeStreamProxy(vid, height=h).response_for(request)


@app.post("/playlists")
async def create_playlist(request: Request, name: str = Form(...)):
    wants_json = "application/json" in (request.headers.get("accept") or "").lower()
    try:
        pl = service.create_playlist(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if wants_json:
        return JSONResponse({"ok": True, "playlist_id": pl.id, "name": pl.name})
    return RedirectResponse("/", status_code=303)


@app.post("/playlists/import")
async def import_spotify(spotify_url: str = Form(...)):
    try:
        pl = service.import_spotify_playlist(spotify_url)
        return RedirectResponse(f"/?playlist_id={pl.id}", status_code=303)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/playlists/{playlist_id}/tracks")
async def add_track(
    request: Request,
    playlist_id: str,
    title: str = Form(...),
    artist: str = Form(...),
    url: Optional[str] = Form(None),
    album: Optional[str] = Form(None),
    skip_download: Optional[str] = Form(None),
    quality: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    raw = (skip_download or "").strip().lower()
    skip = raw in ("1", "true", "yes", "on")
    u = (url or "").strip() or None
    alb = (album or "").strip() or None
    dl_quality = (quality or "192").strip() or "192"
    wants_json = "application/json" in (request.headers.get("accept") or "").lower()
    try:
        track = service.add_track_to_playlist(
            pid,
            title.strip(),
            artist.strip(),
            url=u,
            album=alb,
            enqueue_download=not skip,
            download_quality=dl_quality,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Playlist not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if wants_json:
        return JSONResponse(
            {
                "ok": True,
                "playlist_id": pid,
                "track": _track_payload_row(track),
            }
        )
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/tracks/{track_id}/download")
async def start_download(
    playlist_id: str,
    track_id: str,
    redownload: Optional[str] = Form(None),
    quality: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    tid = track_id.strip()
    force = (redownload or "").strip().lower() in ("1", "true", "yes", "on")
    dl_quality = (quality or "192").strip() or "192"
    if not service.start_track_download(pid, tid, force_redownload=force, quality=dl_quality):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/tracks/{track_id}/delete")
async def delete_track(playlist_id: str, track_id: str):
    pid = playlist_id.strip()
    tid = track_id.strip()
    if not service.delete_track(pid, tid):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    _unlink_track_cover_caches(pid, tid)
    return RedirectResponse(f"/?playlist_id={pid}", status_code=303)


@app.post("/playlists/{playlist_id}/delete")
async def delete_playlist(playlist_id: str):
    pid = playlist_id.strip()
    if service.is_liked_songs_playlist(pid):
        raise HTTPException(status_code=403, detail="The Liked Songs playlist cannot be deleted.")
    if not service.delete_playlist(pid):
        raise HTTPException(status_code=404, detail="Playlist not found")
    return RedirectResponse("/", status_code=303)


@app.post("/playlists/{playlist_id}/edit")
async def edit_playlist(
    playlist_id: str,
    name: Optional[str] = Form(None),
    bio: Optional[str] = Form(None),
):
    pid = playlist_id.strip()
    pl = service.get_playlist(pid)
    if not pl:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if service.is_liked_songs_playlist(pid):
        raise HTTPException(status_code=403, detail="The Liked Songs playlist cannot be edited.")

    if name is None and bio is None:
        raise HTTPException(status_code=400, detail="Provide name and/or bio.")

    name_kw: Optional[str] = None
    if name is not None:
        n = name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="Playlist name cannot be empty.")
        name_kw = n

    bio_kw: Optional[str] = None
    if bio is not None:
        bio_kw = bio

    if not service.update_playlist_meta(pid, name=name_kw, bio=bio_kw):
        raise HTTPException(status_code=404, detail="Playlist not found")

    pl2 = service.get_playlist(pl.id)
    display_name = pl2.name if pl2 else pl.name
    display_bio = (pl2.bio or "") if pl2 else ""
    return JSONResponse(
        {
            "ok": True,
            "id": pl2.id if pl2 else pl.id,
            "name": display_name,
            "bio": display_bio,
        }
    )


@app.get("/playlists/{playlist_id}/tracks/{track_id}/cover")
async def track_cover(playlist_id: str, track_id: str, q: str = "high"):
    pid = playlist_id.strip()
    tid = track_id.strip()
    tier = YoutubeThumbQuality.parse(q)
    max_side = YoutubeThumbQuality.max_side(tier)
    jpeg_q = YoutubeThumbQuality.jpeg_quality(tier)
    cpath = cover_tile_cache_path(pid, tid, max_side=max_side)

    pl = service.get_playlist(pid)
    track = pl.get_track(tid) if pl else None
    yt_id = ""
    if track:
        yt_id = str(track.resolved_youtube_video_id() or "").strip()

    if tier == "low" and yt_id:
        fetched = await _fetch_youtube_thumb_bytes(yt_id, "low")
        if fetched:
            raw, mime = fetched
            return Response(
                content=raw,
                media_type=mime,
                headers={"Cache-Control": "public, max-age=86400"},
            )

    if cpath.is_file():
        return FileResponse(
            str(cpath),
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=604800"},
        )

    path = await asyncio.to_thread(service.get_track_audio_path, pid, tid)
    if path is None:
        raise HTTPException(status_code=404, detail="Track or file not found")

    blob = await asyncio.to_thread(extract_cover, path)
    raw: Optional[bytes] = blob[0] if blob else None
    orig_mime = blob[1] if blob else "image/jpeg"

    if raw is None and not yt_id and track:
        yt_id = await asyncio.to_thread(
            _youtube_video_id_from_track_metadata,
            track.artist,
            track.title,
        ) or ""
        yt_id = str(yt_id).strip()
    if raw is None and yt_id:
        fetched = await _fetch_youtube_thumb_bytes(yt_id, tier)
        if fetched:
            raw, orig_mime = fetched

    if not raw:
        raise HTTPException(status_code=404, detail="No embedded cover")

    processed = await asyncio.to_thread(
        square_thumb_jpeg,
        raw,
        max_side=max_side,
        quality=jpeg_q,
    )
    headers = {"Cache-Control": "public, max-age=604800"}
    if processed:
        try:
            cpath.parent.mkdir(parents=True, exist_ok=True)
            cpath.write_bytes(processed)
        except OSError:
            pass
        return Response(content=processed, media_type="image/jpeg", headers=headers)

    return Response(
        content=raw,
        media_type=orig_mime if orig_mime.startswith("image/") else "image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


class LyricsSaveBody(BaseModel):
    lyrics: str = Field(default="")


class LrcSaveBody(BaseModel):
    lines: list = Field(default_factory=list)


@app.get("/playlists/{playlist_id}/tracks/{track_id}/lyrics")
def track_lyrics(playlist_id: str, track_id: str):
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    return JSONResponse(service.get_lyrics_payload(playlist_id, track_id))


@app.post("/playlists/{playlist_id}/tracks/{track_id}/lyrics")
async def track_lyrics_save(playlist_id: str, track_id: str, body: LyricsSaveBody):
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if not service.save_track_lyrics_file(playlist_id, track_id, body.lyrics):
        raise HTTPException(
            status_code=400,
            detail="Lyrics are saved next to the audio file. Download or fix this track first.",
        )
    return JSONResponse({"ok": True})


@app.post("/playlists/{playlist_id}/tracks/{track_id}/lyrics/lrc")
async def track_lrc_save(playlist_id: str, track_id: str, body: LrcSaveBody):
    """Save LRC lyrics with timestamps."""
    pl = service.get_playlist(playlist_id.strip())
    if not pl or not pl.get_track(track_id.strip()):
        raise HTTPException(status_code=404, detail="Playlist or track not found")
    if not service.save_track_lrc_file(playlist_id, track_id, body.lines):
        raise HTTPException(
            status_code=400,
            detail="Lyrics are saved next to the audio file. Download or fix this track first.",
        )
    return JSONResponse({"ok": True})


@app.post("/api/downloads/retry-all-errors")
async def api_retry_all_errors():
    """Re-queue all tracks that are in error state (any playlist)."""
    n = service.retry_all_error_tracks()
    return JSONResponse({"ok": True, "queued": n})


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


@app.get("/playlists/{playlist_id}/tracks/{track_id}/file")
async def export_track_file(playlist_id: str, track_id: str):
    """Browser download of one track's audio file."""
    result = await asyncio.to_thread(service.get_track_export, playlist_id, track_id)
    if not result:
        raise HTTPException(
            status_code=404,
            detail="Track audio not found. Download the track in the library first.",
        )
    path, filename = result
    return FileResponse(
        path,
        media_type=_media_content_type(path),
        filename=filename,
        content_disposition_type="attachment",
    )


@app.get("/playlists/{playlist_id}/export.zip")
async def export_playlist_zip(playlist_id: str):
    """Browser download of a ZIP of all downloaded tracks in the playlist."""
    pid = playlist_id.strip()
    if not service.get_playlist(pid):
        raise HTTPException(status_code=404, detail="Playlist not found")

    built = await asyncio.to_thread(service.build_playlist_export_zip, pid)
    if not built:
        raise HTTPException(
            status_code=404,
            detail="No downloaded tracks to export. Download songs in this playlist first.",
        )
    tmp_path, zip_name, _count = built
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=zip_name,
        content_disposition_type="attachment",
        background=BackgroundTask(_unlink_quiet, tmp_path),
    )


class QualityDownloadBody(BaseModel):
    quality: str = Field(..., min_length=1)


@app.post("/api/playlists/{playlist_id}/downloads/quality")
async def api_playlist_quality_downloads(playlist_id: str, body: QualityDownloadBody):
    """Queue downloads for every track in a playlist missing the given quality variant."""
    result = service.queue_playlist_quality_downloads(playlist_id, body.quality)
    if result is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return JSONResponse({"ok": True, **result})


@app.post("/api/downloads/quality-all")
async def api_quality_downloads_all(body: QualityDownloadBody):
    """Queue missing quality variants for every track in every playlist."""
    result = service.queue_all_quality_downloads(body.quality)
    return JSONResponse({"ok": True, **result})


@app.get("/api/progress")
async def api_progress():
    """Live per-track download progress plus how many downloads are left in the queue."""
    return JSONResponse(service.progress_api_payload())


_manifest_path = _webapp_dir / "manifest.json"


@app.get("/manifest.json")
async def serve_web_app_manifest():
    """PWA manifest stored under ``webapp/manifest.json`` (linked from templates as ``manifest.json``)."""
    if not _manifest_path.is_file():
        raise HTTPException(status_code=404, detail="manifest.json missing")
    return FileResponse(
        _manifest_path,
        media_type="application/manifest+json; charset=utf-8",
    )


class JsMimeStaticFiles(StaticFiles):
    """Serve .js / .mjs / .css with correct MIME types on Windows.

    ``mimetypes`` often maps ``.js`` to ``text/plain``, which makes browsers reject
    scripts and ES module graphs. ``FileResponse`` uses ``guess_type`` unless
    ``media_type`` is set explicitly.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        request_headers = Headers(scope=scope)
        suffix = Path(full_path).suffix.lower()
        media_type = None
        if suffix in (".js", ".mjs"):
            media_type = "application/javascript; charset=utf-8"
        elif suffix == ".css":
            media_type = "text/css; charset=utf-8"
        response = FileResponse(
            full_path,
            status_code=status_code,
            stat_result=stat_result,
            media_type=media_type,
        )
        if self.is_not_modified(response.headers, request_headers):
            return NotModifiedResponse(response.headers)
        return response


_static_dir = _webapp_dir / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
_pwa_sw_path = _static_dir / "pwa" / "sw.js"


@app.get("/static/pwa/sw.js", include_in_schema=False)
async def pwa_service_worker():
    """Serve generated Workbox SW with full-site scope (SW lives under ``/static/pwa/``)."""
    if not _pwa_sw_path.is_file():
        raise HTTPException(status_code=404, detail="Run: npm run build:pwa")
    return FileResponse(
        _pwa_sw_path,
        media_type="application/javascript; charset=utf-8",
        headers={"Service-Worker-Allowed": "/"},
    )


app.mount("/static", JsMimeStaticFiles(directory=str(_static_dir)), name="static")

_media_root = root / "downloads"
_media_root.mkdir(parents=True, exist_ok=True)


def _media_content_type(file_path: Path) -> str:
    mime, _ = mimetypes.guess_type(file_path.name)
    if mime:
        return mime
    if file_path.suffix.lower() == ".m4a":
        return "audio/mp4"
    if file_path.suffix.lower() == ".mp3":
        return "audio/mpeg"
    if file_path.suffix.lower() == ".webm":
        return "audio/webm"
    return "application/octet-stream"


def _iter_media_range(file_path: Path, start: int, end: int):
    remaining = end - start + 1
    with file_path.open("rb") as f:
        f.seek(start)
        while remaining > 0:
            chunk = f.read(min(64 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.get("/media/{media_path:path}")
async def serve_media(media_path: str, request: Request):
    target = (_media_root / media_path).resolve()
    media_root = _media_root.resolve()
    try:
        target.relative_to(media_root)
    except ValueError:
        raise HTTPException(status_code=404, detail="Media file not found")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Media file not found")

    total = target.stat().st_size
    content_type = _media_content_type(target)
    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }

    range_header = request.headers.get("range")
    if not range_header:
        return StreamingResponse(
            _iter_media_range(target, 0, total - 1),
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
        _iter_media_range(target, start, end),
        media_type=content_type,
        status_code=206,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{total}",
            "Content-Length": str(end - start + 1),
        },
    )
