"""Unit tests for lyrics sidecar files and LRC parsing."""
from __future__ import annotations

from pathlib import Path

import pytest

from lyrics_files import (
    delete_lyrics_sidecars,
    lrc_path,
    lrc_to_plain,
    materialize_lyrics_file_if_needed,
    parse_lrc_lines,
    payload_from_remote_lyrics,
    read_raw_lrc,
    read_sidecar_lyrics,
    save_lrc,
    save_lrc_from_lines,
    save_user_lyrics,
    user_lyrics_path,
)


@pytest.fixture
def audio(tmp_path: Path) -> Path:
    p = tmp_path / "Artist - Song__192k.opus"
    p.write_bytes(b"fake audio")
    return p


class TestPaths:
    def test_user_lyrics_path(self, audio: Path) -> None:
        assert user_lyrics_path(audio).name == "Artist - Song__192k.lyrics.txt"

    def test_lrc_path(self, audio: Path) -> None:
        assert lrc_path(audio).name == "Artist - Song__192k.lrc"


class TestLrcToPlain:
    def test_strips_timestamps(self) -> None:
        raw = "[00:01.00]First line\n[00:02.50]Second line\n"
        assert lrc_to_plain(raw) == "First line\nSecond line"

    def test_drops_empty_lines(self) -> None:
        raw = "[00:01.00]\n[00:02.00]Text\n"
        assert lrc_to_plain(raw) == "Text"

    def test_handles_crlf(self) -> None:
        assert lrc_to_plain("[00:01.00]A\r\n[00:02.00]B\r\n") == "A\nB"


class TestParseLrcLines:
    def test_centiseconds(self) -> None:
        assert parse_lrc_lines("[00:01.50]Hello") == [{"time_ms": 1500, "text": "Hello"}]

    def test_milliseconds(self) -> None:
        assert parse_lrc_lines("[00:01.500]Hello") == [{"time_ms": 1500, "text": "Hello"}]

    def test_multiple_timestamps_on_one_line(self) -> None:
        parsed = parse_lrc_lines("[00:01.00][00:03.00]Chorus")
        assert parsed == [
            {"time_ms": 1000, "text": "Chorus"},
            {"time_ms": 3000, "text": "Chorus"},
        ]

    def test_sorts_by_time(self) -> None:
        parsed = parse_lrc_lines("[00:05.00]Later\n[00:01.00]Earlier")
        assert [row["text"] for row in parsed] == ["Earlier", "Later"]

    def test_deduplicates(self) -> None:
        parsed = parse_lrc_lines("[00:01.00]A\n[00:01.00]A")
        assert parsed == [{"time_ms": 1000, "text": "A"}]

    def test_ignores_lines_without_timestamps(self) -> None:
        assert parse_lrc_lines("no timestamp here\n[00:01.00]Yes") == [
            {"time_ms": 1000, "text": "Yes"}
        ]

    def test_ignores_empty_text(self) -> None:
        assert parse_lrc_lines("[00:01.00]   ") == []


class TestSaveAndRead:
    def test_save_user_lyrics_round_trip(self, audio: Path) -> None:
        save_user_lyrics(audio, "Line one\nLine two")
        assert read_sidecar_lyrics(audio) == ("Line one\nLine two", "file")

    def test_empty_text_removes_file(self, audio: Path) -> None:
        save_user_lyrics(audio, "Text")
        save_user_lyrics(audio, "")
        assert not user_lyrics_path(audio).exists()

    def test_save_lrc_round_trip(self, audio: Path) -> None:
        save_lrc(audio, "[00:01.00]Hello")
        assert read_sidecar_lyrics(audio) == ("Hello", "lrc")
        assert read_raw_lrc(audio) == "[00:01.00]Hello\n"

    def test_lrc_without_timestamps_is_read_as_plain_text(self, audio: Path) -> None:
        # Oddity: read_raw_lrc does not require timestamps, so a .lrc file that
        # is really plain text is accepted and reported as source "lrc".
        save_lrc(audio, "just text, no timestamps")
        assert read_sidecar_lyrics(audio) == ("just text, no timestamps", "lrc")
        assert read_raw_lrc(audio) == "just text, no timestamps\n"

    def test_placeholder_sidecar_is_ignored(self, audio: Path) -> None:
        save_user_lyrics(audio, "https://example.com")
        assert read_sidecar_lyrics(audio) is None

    def test_user_lyrics_take_precedence_over_lrc(self, audio: Path) -> None:
        save_lrc(audio, "[00:01.00]LRC text")
        save_user_lyrics(audio, "Plain text")
        assert read_sidecar_lyrics(audio) == ("Plain text", "file")

    def test_save_lrc_from_lines_round_trip(self, audio: Path) -> None:
        save_lrc_from_lines(audio, [{"time_ms": 1500, "text": "Hello"}])
        assert read_raw_lrc(audio) == "[00:01.50]Hello\n"

    def test_save_lrc_from_lines_empty_removes(self, audio: Path) -> None:
        save_lrc_from_lines(audio, [{"time_ms": 1000, "text": "Hello"}])
        save_lrc_from_lines(audio, [])
        assert not lrc_path(audio).exists()

    def test_delete_sidecars(self, audio: Path) -> None:
        save_user_lyrics(audio, "Text")
        save_lrc(audio, "[00:01.00]Text")
        delete_lyrics_sidecars(audio)
        assert not user_lyrics_path(audio).exists()
        assert not lrc_path(audio).exists()


class TestMaterialize:
    def test_prefers_remote_synced(self, audio: Path) -> None:
        materialize_lyrics_file_if_needed(audio, "embedded", "plain", "[00:01.00]synced")
        assert read_raw_lrc(audio) == "[00:01.00]synced\n"
        assert not user_lyrics_path(audio).exists()

    def test_remote_plain_when_no_synced(self, audio: Path) -> None:
        materialize_lyrics_file_if_needed(audio, "embedded", "plain text", None)
        assert read_sidecar_lyrics(audio) == ("plain text", "file")

    def test_embedded_when_no_remote(self, audio: Path) -> None:
        materialize_lyrics_file_if_needed(audio, "embedded text", None, None)
        assert read_sidecar_lyrics(audio) == ("embedded text", "file")

    def test_existing_file_is_kept(self, audio: Path) -> None:
        save_user_lyrics(audio, "existing")
        materialize_lyrics_file_if_needed(audio, "embedded", "plain", "[00:01.00]synced")
        assert read_sidecar_lyrics(audio) == ("existing", "file")

    def test_placeholder_existing_file_is_replaced(self, audio: Path) -> None:
        save_user_lyrics(audio, "https://example.com")
        materialize_lyrics_file_if_needed(audio, None, "plain text", None)
        assert read_sidecar_lyrics(audio) == ("plain text", "file")

    def test_existing_lrc_blocks_materialize(self, audio: Path) -> None:
        save_lrc(audio, "[00:01.00]existing")
        materialize_lyrics_file_if_needed(audio, None, "plain", "[00:02.00]new")
        assert read_raw_lrc(audio) == "[00:01.00]existing\n"


class TestPayloadFromRemote:
    def test_synced(self) -> None:
        payload = payload_from_remote_lyrics(None, "[00:01.00]Hello")
        assert payload["source"] == "lrc"
        assert payload["lyrics"] == "Hello"
        assert payload["lrc_data"] == [{"time_ms": 1000, "text": "Hello"}]
        assert payload["has_audio"] is True

    def test_plain(self) -> None:
        payload = payload_from_remote_lyrics("Plain text", None)
        assert payload["source"] == "file"
        assert payload["lyrics"] == "Plain text"
        assert payload["lrc_data"] is None

    def test_none(self) -> None:
        payload = payload_from_remote_lyrics(None, None)
        assert payload["source"] == "none"
        assert payload["lyrics"] == ""

    def test_placeholder_is_dropped(self) -> None:
        payload = payload_from_remote_lyrics("https://example.com", None)
        assert payload["source"] == "none"
        assert payload["lyrics"] == ""
