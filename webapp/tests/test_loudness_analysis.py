"""Unit tests for the loudness helpers."""
from __future__ import annotations

from loudness_analysis import _integrated_lufs, clamp_gain_db


def test_integrated_lufs_returns_last_value() -> None:
    text = (
        "[Parsed_ebur128_0] t: 1.0  M: -9.0 S: -9.0 I: -9.0 LUFS\n"
        "[Parsed_ebur128_0] t: 2.0  M: -8.0 S: -8.0 I: -8.0 LUFS\n"
        "  Integrated loudness:\n"
        "    I:          -6.5 LUFS\n"
    )
    assert _integrated_lufs(text) == -6.5


def test_integrated_lufs_ignores_unrelated_lines() -> None:
    assert _integrated_lufs("no loudness here") is None


def test_clamp_gain_db_bounds() -> None:
    assert clamp_gain_db(-20.0) == -12.0
    assert clamp_gain_db(20.0) == 12.0
    assert clamp_gain_db(-7.5) == -7.5
