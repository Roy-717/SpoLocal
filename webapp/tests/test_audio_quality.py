"""Unit tests for the quality-tier helpers."""
from __future__ import annotations

import pytest

from audio_quality import (
    DEFAULT_KBPS,
    QUALITY_HIGH_KBPS,
    QUALITY_LOW_KBPS,
    QUALITY_MID_KBPS,
    kbps_from_relpath,
    parse_quality_kbps,
    quality_file_stem,
    snap_kbps,
    variant_key,
    video_height_for_kbps,
    ytdlp_audio_format,
    ytdlp_extract_audio_opts,
)


class TestSnapKbps:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (0, QUALITY_LOW_KBPS),
            (32, QUALITY_LOW_KBPS),
            (64, QUALITY_LOW_KBPS),
            (96, QUALITY_LOW_KBPS),
            (112, QUALITY_LOW_KBPS),
            (120, QUALITY_HIGH_KBPS),  # retired Medium tier maps up
            (130, QUALITY_HIGH_KBPS),
            (192, QUALITY_HIGH_KBPS),
            (320, QUALITY_HIGH_KBPS),
        ],
    )
    def test_snaps_to_nearest_tier(self, value: int, expected: int) -> None:
        assert snap_kbps(value) == expected

    def test_exact_midpoint_ties_to_data_saver(self) -> None:
        # 128 is equidistant from 64 and 192; min() keeps the first tier.
        # This is worth knowing: a 128 kbps file is treated as Data Saver.
        assert snap_kbps(128) == QUALITY_LOW_KBPS


class TestParseQualityKbps:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (None, DEFAULT_KBPS),
            ("", DEFAULT_KBPS),
            ("low", QUALITY_LOW_KBPS),
            ("mid", QUALITY_HIGH_KBPS),
            ("medium", QUALITY_HIGH_KBPS),
            ("high", QUALITY_HIGH_KBPS),
            ("64", QUALITY_LOW_KBPS),
            ("64k", QUALITY_LOW_KBPS),
            ("192", QUALITY_HIGH_KBPS),
            ("192k", QUALITY_HIGH_KBPS),
            ("120", QUALITY_HIGH_KBPS),
            ("120k", QUALITY_HIGH_KBPS),
            ("garbage", DEFAULT_KBPS),
        ],
    )
    def test_parses_known_and_legacy_values(self, raw, expected: int) -> None:
        assert parse_quality_kbps(raw) == expected

    def test_accepts_int(self) -> None:
        assert parse_quality_kbps(64) == QUALITY_LOW_KBPS
        assert parse_quality_kbps(QUALITY_MID_KBPS) == QUALITY_HIGH_KBPS


class TestVariantKey:
    def test_normalizes_to_tier(self) -> None:
        assert variant_key(64) == "64"
        assert variant_key(120) == "192"
        assert variant_key(192) == "192"


class TestKbpsFromRelpath:
    @pytest.mark.parametrize(
        ("relpath", "expected"),
        [
            ("youtube/Song [abc]__64k.webm", 64),
            ("youtube/Song [abc]__192k.opus", 192),
            ("youtube/Song [abc]__120k.mp3", 192),
            ("youtube/Song [abc]__64k.m4a", 64),
            ("youtube/Song [abc].mp3", None),
            ("youtube/Song [abc]__64k.lrc", None),
            (None, None),
            ("", None),
        ],
    )
    def test_reads_suffix(self, relpath, expected) -> None:
        assert kbps_from_relpath(relpath) == expected

    def test_handles_windows_separators(self) -> None:
        assert kbps_from_relpath("youtube\\Song [abc]__64k.webm") == 64


class TestQualityFileStem:
    def test_appends_tier_suffix(self) -> None:
        assert quality_file_stem("Artist - Title", 64) == "Artist - Title__64k"
        assert quality_file_stem("Artist - Title", 192) == "Artist - Title__192k"


class TestYtdlpOptions:
    def test_data_saver_keeps_webm_and_skips_postprocessing(self) -> None:
        fmt = ytdlp_audio_format(64)
        assert "ext=webm" in fmt
        assert "abr<=80" in fmt
        opts = ytdlp_extract_audio_opts(64)
        assert opts["postprocessors"] == []

    def test_highest_remuxes_to_opus(self) -> None:
        fmt = ytdlp_audio_format(192)
        assert "acodec^=opus" in fmt
        opts = ytdlp_extract_audio_opts(192)
        assert opts["postprocessors"][0]["preferredcodec"] == "opus"


class TestVideoHeight:
    @pytest.mark.parametrize(
        ("kbps", "expected"),
        [(64, 360), (120, 720), (192, 720)],
    )
    def test_maps_tier_to_height(self, kbps: int, expected: int) -> None:
        # 120 is retired and snaps up to Highest, so the 480 branch is dead.
        assert video_height_for_kbps(kbps) == expected
