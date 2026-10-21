"""Unit tests for lyric placeholder detection."""
from __future__ import annotations

import pytest

from lyrics_text import filter_real_lyrics, is_placeholder_lyrics


class TestIsPlaceholderLyrics:
    @pytest.mark.parametrize(
        "text",
        [
            "",
            "   ",
            "\n\n",
            "https://music.youtube.com/watch?v=abc",
            "http://example.com/lyrics",
            "https://a.example\nhttps://b.example",
            "spotify:track:abc",
            "applemusic://track/1",
            "itunes:something",
        ],
    )
    def test_placeholders(self, text: str) -> None:
        assert is_placeholder_lyrics(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "Hello darkness my old friend",
            "Line one\nLine two",
            "Check https://example.com for more\nBut this is a lyric line",
            "I love you\nhttps://example.com",
        ],
    )
    def test_real_lyrics(self, text: str) -> None:
        assert is_placeholder_lyrics(text) is False


class TestFilterRealLyrics:
    def test_none_and_empty(self) -> None:
        assert filter_real_lyrics(None) is None
        assert filter_real_lyrics("") is None
        assert filter_real_lyrics("   ") is None

    def test_strips_real_lyrics(self) -> None:
        assert filter_real_lyrics("  Hello  ") == "Hello"

    def test_drops_placeholder(self) -> None:
        assert filter_real_lyrics("https://example.com") is None
