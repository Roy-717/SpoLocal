"""Thumbnail disk cache: Data Saver rows must not hit YouTube on every render."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from youtube_stream import YouTubeStreamingService


class TestThumbnailCache:
    @pytest.fixture
    def streaming(self, temp_root: Path) -> YouTubeStreamingService:
        return YouTubeStreamingService(temp_root)

    def test_write_then_read_roundtrip(self, streaming: YouTubeStreamingService):
        streaming._write_cached_thumb("roundtrip", "low", b"\xff\xd8jpeg", "image/jpeg")
        cached = streaming._read_cached_thumb("roundtrip", "low")
        assert cached == (b"\xff\xd8jpeg", "image/jpeg")

    def test_tiers_are_cached_separately(self, streaming: YouTubeStreamingService):
        streaming._write_cached_thumb("tiers", "low", b"low", "image/jpeg")
        streaming._write_cached_thumb("tiers", "high", b"high", "image/jpeg")
        assert streaming._read_cached_thumb("tiers", "low")[0] == b"low"
        assert streaming._read_cached_thumb("tiers", "high")[0] == b"high"

    def test_webp_extension_is_preserved(self, streaming: YouTubeStreamingService):
        streaming._write_cached_thumb("webpvid", "high", b"webp", "image/webp")
        assert streaming._read_cached_thumb("webpvid", "high") == (b"webp", "image/webp")

    def test_unknown_mime_falls_back_to_jpeg(self, streaming: YouTubeStreamingService):
        streaming._write_cached_thumb("unknownmime", "high", b"raw", "application/octet-stream")
        assert streaming._read_cached_thumb("unknownmime", "high") == (b"raw", "image/jpeg")

    def test_video_id_is_sanitized(self, streaming: YouTubeStreamingService):
        streaming._write_cached_thumb("../../etc/passwd", "low", b"x", "image/jpeg")
        prefix = streaming._thumb_cache_prefix("../../etc/passwd", "low")
        assert "/" not in prefix and ".." not in prefix
        written = list(streaming._thumb_cache_dir.glob(prefix + ".*"))
        assert len(written) == 1
        assert written[0].parent == streaming._thumb_cache_dir

    def test_fetch_returns_cache_without_network(self, streaming: YouTubeStreamingService, monkeypatch):
        streaming._write_cached_thumb("cachedvid", "low", b"cached", "image/jpeg")

        def fail(*args, **kwargs):
            raise AssertionError("network must not be used when the cache hits")

        monkeypatch.setattr("httpx.AsyncClient", fail)
        assert asyncio.run(streaming.fetch_thumbnail_bytes("cachedvid", "low")) == (b"cached", "image/jpeg")

    def test_missing_cache_returns_none_when_offline(self, streaming: YouTubeStreamingService, monkeypatch):
        class OfflineClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def get(self, *args, **kwargs):
                raise OSError("offline")

        monkeypatch.setattr("httpx.AsyncClient", OfflineClient)
        assert asyncio.run(streaming.fetch_thumbnail_bytes("missing", "low")) is None
