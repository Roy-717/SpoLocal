"""Unit tests for range serving and MIME handling."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from media_server import MediaServer


def make_request(headers: dict[str, str] | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/media/x",
            "headers": raw,
            "query_string": b"",
        }
    )


async def body_of(response) -> bytes:
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.fixture
def media(tmp_path: Path) -> tuple[MediaServer, Path]:
    root = tmp_path / "downloads"
    root.mkdir()
    f = root / "song.webm"
    f.write_bytes(bytes(range(256)) * 8)  # 2048 bytes
    return MediaServer(root, tmp_path), f


class TestContentType:
    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("a.mp3", "audio/mpeg"),
            ("a.webm", "audio/webm"),
            ("a.opus", "audio/ogg"),
            ("a.ogg", "audio/ogg"),
            ("a.m4a", "audio/mp4"),
        ],
    )
    def test_known_types(self, media, name: str, expected: str) -> None:
        server, _ = media
        assert server.content_type(Path(name)) == expected

    def test_unknown_falls_back(self, media) -> None:
        server, _ = media
        assert server.content_type(Path("a.zzz")) == "application/octet-stream"


class TestResolveTarget:
    def test_resolves_existing_file(self, media) -> None:
        server, f = media
        assert server._resolve_target("song.webm") == f.resolve()

    def test_rejects_missing_file(self, media) -> None:
        server, _ = media
        with pytest.raises(HTTPException) as exc:
            server._resolve_target("nope.webm")
        assert exc.value.status_code == 404

    def test_rejects_path_traversal(self, media) -> None:
        server, _ = media
        with pytest.raises(HTTPException) as exc:
            server._resolve_target("../outside.webm")
        assert exc.value.status_code == 404


class TestServe:
    def test_full_response_without_range(self, media) -> None:
        server, f = media
        response = server.serve("song.webm", make_request())
        assert response.status_code == 200
        assert response.headers["content-length"] == str(f.stat().st_size)
        assert response.headers["accept-ranges"] == "bytes"
        assert asyncio.run(body_of(response)) == f.read_bytes()

    def test_explicit_range(self, media) -> None:
        server, f = media
        response = server.serve("song.webm", make_request({"range": "bytes=0-9"}))
        assert response.status_code == 206
        assert response.headers["content-range"] == f"bytes 0-9/{f.stat().st_size}"
        assert asyncio.run(body_of(response)) == f.read_bytes()[:10]

    def test_open_ended_range(self, media) -> None:
        server, f = media
        response = server.serve("song.webm", make_request({"range": "bytes=10-"}))
        assert response.status_code == 206
        assert asyncio.run(body_of(response)) == f.read_bytes()[10:]

    def test_suffix_range(self, media) -> None:
        server, f = media
        response = server.serve("song.webm", make_request({"range": "bytes=-10"}))
        assert response.status_code == 206
        assert asyncio.run(body_of(response)) == f.read_bytes()[-10:]

    def test_range_past_end_is_clamped(self, media) -> None:
        server, f = media
        response = server.serve("song.webm", make_request({"range": "bytes=2000-99999"}))
        assert response.status_code == 206
        assert response.headers["content-range"] == f"bytes 2000-{f.stat().st_size - 1}/{f.stat().st_size}"

    def test_start_past_end_is_416(self, media) -> None:
        server, _ = media
        with pytest.raises(HTTPException) as exc:
            server.serve("song.webm", make_request({"range": "bytes=99999-"}))
        assert exc.value.status_code == 416

    @pytest.mark.parametrize("header", ["items=0-1", "bytes=0-1,3-4", "bytes=-", "bytes=a-b", "bytes=0-x"])
    def test_invalid_ranges_are_416(self, media, header: str) -> None:
        server, _ = media
        with pytest.raises(HTTPException) as exc:
            server.serve("song.webm", make_request({"range": header}))
        assert exc.value.status_code == 416

    def test_sliced_caps_response(self, media) -> None:
        server, _ = media
        big = server.media_root / "big.webm"
        big.write_bytes(b"x" * (server.DATA_SAVER_SLICE_BYTES + 1000))
        response = server.serve("big.webm", make_request(), sliced=True)
        assert response.status_code == 206
        assert response.headers["cache-control"] == "no-store"
        body = asyncio.run(body_of(response))
        assert len(body) == server.DATA_SAVER_SLICE_BYTES
        assert body == big.read_bytes()[: server.DATA_SAVER_SLICE_BYTES]

    def test_sliced_respects_smaller_requested_range(self, media) -> None:
        server, f = media
        response = server.serve("song.webm", make_request({"range": "bytes=0-99"}), sliced=True)
        assert response.status_code == 206
        assert asyncio.run(body_of(response)) == f.read_bytes()[:100]


class TestPrepare:
    def test_returns_metadata(self, media, monkeypatch: pytest.MonkeyPatch) -> None:
        server, f = media
        monkeypatch.setattr("media_server.read_audio_file_stats", lambda p: {"duration_sec": 12.5})
        info = server.prepare("song.webm")
        assert info == {"ok": True, "ext": "webm", "filesize": f.stat().st_size, "duration_sec": 12.5}

    def test_falls_back_to_ffprobe(self, media, monkeypatch: pytest.MonkeyPatch) -> None:
        server, _ = media
        monkeypatch.setattr("media_server.read_audio_file_stats", lambda p: {"duration_sec": None})
        monkeypatch.setattr("media_server.probe_duration_seconds", lambda p, r: 7.0)
        assert server.prepare("song.webm")["duration_sec"] == 7.0
