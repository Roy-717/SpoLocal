"""Tests for playlist seed selection and mix merging (no network calls)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from spotify_scraper import YoutubePlaylistMix  # noqa: E402


def vid(n: int) -> str:
    return f"vid{n:08d}"


def hit(video_id: str) -> dict:
    return {"video_id": video_id, "title": video_id, "artist": "x"}


class TestPickSeedIds:
    def test_drops_invalid_and_duplicate_ids(self) -> None:
        mix = YoutubePlaylistMix()
        picks = mix.pick_seed_ids(["short", vid(1), vid(1), "", vid(2)])
        assert picks == [vid(1), vid(2)]

    def test_returns_all_when_playlist_is_small(self) -> None:
        mix = YoutubePlaylistMix()
        ids = [vid(i) for i in range(4)]
        assert mix.pick_seed_ids(ids) == ids

    def test_spreads_across_the_playlist(self) -> None:
        mix = YoutubePlaylistMix()
        ids = [vid(i) for i in range(50)]
        picks = mix.pick_seed_ids(ids, max_seeds=6)
        assert len(picks) == 6
        assert picks[0] == ids[0]
        assert picks[-1] == ids[-1]
        assert picks == sorted(picks, key=ids.index)

    def test_default_covers_more_than_three_songs(self) -> None:
        mix = YoutubePlaylistMix()
        ids = [vid(i) for i in range(50)]
        assert len(mix.pick_seed_ids(ids)) == YoutubePlaylistMix.DEFAULT_MAX_SEEDS
        assert YoutubePlaylistMix.DEFAULT_MAX_SEEDS > 3

    def test_max_seeds_one_returns_first(self) -> None:
        mix = YoutubePlaylistMix()
        ids = [vid(i) for i in range(10)]
        assert mix.pick_seed_ids(ids, max_seeds=1) == [ids[0]]

    def test_prefers_distinct_artists(self) -> None:
        mix = YoutubePlaylistMix()
        ids = [vid(i) for i in range(10)]
        artists = ["A", "A", "A", "B", "B", "C", "C", "D", "D", "E"]
        picks = mix.pick_seed_ids(ids, max_seeds=5, artists=artists)
        picked_artists = [artists[ids.index(p)] for p in picks]
        assert len(picks) == 5
        assert len(set(picked_artists)) == 5

    def test_artist_filter_still_fills_every_slot(self) -> None:
        mix = YoutubePlaylistMix()
        ids = [vid(i) for i in range(10)]
        artists = ["A"] * 10
        picks = mix.pick_seed_ids(ids, max_seeds=4, artists=artists)
        assert len(picks) == 4
        assert len(set(picks)) == 4

    def test_empty_playlist_returns_nothing(self) -> None:
        assert YoutubePlaylistMix().pick_seed_ids([]) == []


class TestMixForSeeds:
    def test_no_valid_seeds_returns_empty(self) -> None:
        assert YoutubePlaylistMix().mix_for_seeds(["bad", ""]) == []

    def test_merges_buckets_round_robin_and_skips_duplicates(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mix = YoutubePlaylistMix()
        seeds = [vid(1), vid(2)]
        monkeypatch.setattr(mix, "pick_seed_ids", lambda *a, **k: seeds)
        buckets = {
            vid(1): [hit(vid(1)), hit(vid(3)), hit(vid(5))],
            vid(2): [hit(vid(2)), hit(vid(3)), hit(vid(6))],
        }
        monkeypatch.setattr(mix, "mix_for_video", lambda seed, limit: list(buckets[seed]))
        merged = mix.mix_for_seeds([vid(1), vid(2)], limit=4)
        assert [h["video_id"] for h in merged] == [vid(3), vid(5), vid(6)]

    def test_queries_every_seed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mix = YoutubePlaylistMix()
        seeds = [vid(i) for i in range(6)]
        monkeypatch.setattr(mix, "pick_seed_ids", lambda *a, **k: seeds)
        seen: list[str] = []

        def fake_mix(seed: str, limit: int) -> list[dict]:
            seen.append(seed)
            return [hit(f"out{seed}")]

        monkeypatch.setattr(mix, "mix_for_video", fake_mix)
        merged = mix.mix_for_seeds([vid(i) for i in range(6)], limit=6)
        assert sorted(seen) == sorted(seeds)
        assert len(merged) == 6

    def test_respects_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mix = YoutubePlaylistMix()
        seeds = [vid(1), vid(2)]
        monkeypatch.setattr(mix, "pick_seed_ids", lambda *a, **k: seeds)
        monkeypatch.setattr(
            mix,
            "mix_for_video",
            lambda seed, limit: [hit(f"{seed}-{i}") for i in range(10)],
        )
        assert len(mix.mix_for_seeds([vid(1), vid(2)], limit=5)) == 5

    def test_passes_artists_to_seed_picker(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mix = YoutubePlaylistMix()
        captured: dict = {}

        def fake_pick(video_ids, max_seeds=None, artists=None):
            captured["artists"] = artists
            return [vid(1)]

        monkeypatch.setattr(mix, "pick_seed_ids", fake_pick)
        monkeypatch.setattr(mix, "mix_for_video", lambda seed, limit: [hit(vid(9))])
        mix.mix_for_seeds([vid(1)], limit=1, artists=["Artist"])
        assert captured["artists"] == ["Artist"]
