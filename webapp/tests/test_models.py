"""Unit tests for the Track / Playlist domain models."""
from __future__ import annotations

import pytest

from models import (
    DownloadStatus,
    Playlist,
    Track,
    notify_track_status_changed,
    set_track_status_change_listener,
    track_play_variants,
)


class TestTrackCreate:
    def test_generates_unique_ids(self) -> None:
        a = Track.create("Song", "Artist")
        b = Track.create("Song", "Artist")
        assert a.id != b.id
        assert a.status == DownloadStatus.queued

    def test_keeps_url(self) -> None:
        t = Track.create("Song", "Artist", url="https://youtu.be/abcdefghijk")
        assert t.url == "https://youtu.be/abcdefghijk"


class TestResolvedYoutubeVideoId:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://example.com/watch?foo=1&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ],
    )
    def test_from_url(self, url: str, expected: str) -> None:
        t = Track.create("Song", "Artist", url=url)
        assert t.resolved_youtube_video_id() == expected

    def test_explicit_id_wins(self) -> None:
        t = Track.create("Song", "Artist", url="https://youtu.be/aaaaaaaaaaa")
        t.youtube_video_id = "bbbbbbbbbbb"
        assert t.resolved_youtube_video_id() == "bbbbbbbbbbb"

    def test_from_media_filename(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_relpath = "youtube/Song [dQw4w9WgXcQ]__192k.opus"
        assert t.resolved_youtube_video_id() == "dQw4w9WgXcQ"

    def test_from_variant_filename(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_variants = {"64": "youtube/Song [dQw4w9WgXcQ]__64k.webm"}
        assert t.resolved_youtube_video_id() == "dQw4w9WgXcQ"

    def test_empty_when_unknown(self) -> None:
        assert Track.create("Song", "Artist").resolved_youtube_video_id() == ""


class TestPlaySrc:
    def test_done_track_with_media(self) -> None:
        t = Track.create("Song", "Artist")
        t.status = DownloadStatus.done
        t.media_relpath = "youtube/Song [abc]__192k.opus"
        assert t.play_src() == "/media/youtube/Song%20%5Babc%5D__192k.opus"

    def test_pending_track_without_media_has_no_src(self) -> None:
        t = Track.create("Song", "Artist")
        t.status = DownloadStatus.pending
        assert t.play_src() is None

    def test_pending_track_with_media_still_plays(self) -> None:
        t = Track.create("Song", "Artist")
        t.status = DownloadStatus.pending
        t.media_relpath = "youtube/Song [abc]__192k.opus"
        assert t.play_src() is not None

    def test_quality_selection(self) -> None:
        t = Track.create("Song", "Artist")
        t.status = DownloadStatus.done
        t.media_variants = {
            "64": "youtube/Song [abc]__64k.webm",
            "192": "youtube/Song [abc]__192k.opus",
        }
        assert t.play_src("64").endswith("__64k.webm")
        assert t.play_src("192").endswith("__192k.opus")

    def test_legacy_quality_names(self) -> None:
        t = Track.create("Song", "Artist")
        t.status = DownloadStatus.done
        t.media_variants = {"64": "a__64k.webm", "192": "a__192k.opus"}
        assert t.play_src("low").endswith("__64k.webm")
        assert t.play_src("high").endswith("__192k.opus")

    def test_stream_src(self) -> None:
        t = Track.create("Song", "Artist", url="https://youtu.be/dQw4w9WgXcQ")
        assert t.stream_play_src() == "/api/stream?vid=dQw4w9WgXcQ"

    def test_playback_src_prefers_local(self) -> None:
        t = Track.create("Song", "Artist", url="https://youtu.be/dQw4w9WgXcQ")
        t.status = DownloadStatus.done
        t.media_relpath = "youtube/Song [dQw4w9WgXcQ]__192k.opus"
        assert t.playback_src().startswith("/media/")


class TestSetMediaVariant:
    def test_192_sets_primary_relpath(self) -> None:
        t = Track.create("Song", "Artist")
        t.set_media_variant("192", "a__192k.opus")
        assert t.media_relpath == "a__192k.opus"
        assert t.media_variants == {"192": "a__192k.opus"}

    def test_64_does_not_overwrite_primary(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_relpath = "a__192k.opus"
        t.set_media_variant("64", "a__64k.webm")
        assert t.media_relpath == "a__192k.opus"
        assert t.media_variants == {"64": "a__64k.webm"}

    def test_64_sets_primary_when_empty(self) -> None:
        t = Track.create("Song", "Artist")
        t.set_media_variant("64", "a__64k.webm")
        assert t.media_relpath == "a__64k.webm"

    def test_ignores_empty_values(self) -> None:
        t = Track.create("Song", "Artist")
        t.set_media_variant("", "a")
        t.set_media_variant("64", None)
        assert t.media_variants == {}

    def test_has_media_variant(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_variants = {"64": "a__64k.webm"}
        assert t.has_media_variant("64")
        assert not t.has_media_variant("192")
        t.media_relpath = "a__192k.opus"
        assert t.has_media_variant("192")


class TestTrackPlayVariants:
    def test_returns_variants(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_variants = {"64": "a__64k.webm", "192": "a__192k.opus"}
        assert track_play_variants(t) == {
            "64": "/media/a__64k.webm",
            "192": "/media/a__192k.opus",
        }

    def test_falls_back_to_media_relpath(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_relpath = "a__64k.webm"
        assert track_play_variants(t) == {"64": "/media/a__64k.webm"}

    def test_unknown_suffix_defaults_to_192(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_relpath = "legacy.mp3"
        assert track_play_variants(t) == {"192": "/media/legacy.mp3"}

    def test_primary_file_stays_visible_when_variants_exist(self) -> None:
        """A hydrated primary file must not disappear when a variant is added.

        ``hydrate_media_paths`` fills ``media_relpath`` without touching
        ``media_variants``. Adding a 64k variant used to make
        ``track_play_variants`` return only the 64k entry, so the frontend never
        saw the existing 192k file and re-downloaded it on a tier switch.
        """
        t = Track.create("Song", "Artist")
        t.media_relpath = "legacy__192k.opus"
        t.set_media_variant("64", "legacy__64k.webm")
        assert track_play_variants(t) == {
            "64": "/media/legacy__64k.webm",
            "192": "/media/legacy__192k.opus",
        }

    def test_primary_file_does_not_duplicate_an_existing_key(self) -> None:
        t = Track.create("Song", "Artist")
        t.media_relpath = "a__192k.opus"
        t.media_variants = {"192": "a__192k.opus"}
        assert track_play_variants(t) == {"192": "/media/a__192k.opus"}


class TestPlaylist:
    def test_add_and_get_track(self) -> None:
        pl = Playlist.create("Mix")
        t = Track.create("Song", "Artist")
        pl.add_track(t)
        assert pl.get_track(t.id) is t
        assert pl.get_track("missing") is None

    def test_update_track_status_notifies(self) -> None:
        calls: list[int] = []
        set_track_status_change_listener(lambda: calls.append(1))
        try:
            pl = Playlist.create("Mix")
            t = Track.create("Song", "Artist")
            pl.add_track(t)
            pl.update_track_status(t.id, DownloadStatus.error, "boom")
            assert t.status == DownloadStatus.error
            assert t.error == "boom"
            assert calls == [1]
        finally:
            set_track_status_change_listener(None)

    def test_update_missing_track_is_noop(self) -> None:
        pl = Playlist.create("Mix")
        pl.update_track_status("missing", DownloadStatus.done)
        assert pl.tracks == []

    def test_remove_track(self) -> None:
        pl = Playlist.create("Mix")
        t = Track.create("Song", "Artist")
        pl.add_track(t)
        assert pl.remove_track(t.id) is True
        assert pl.remove_track(t.id) is False
        assert pl.tracks == []

    def test_create_defaults_name(self) -> None:
        assert Playlist.create("   ").name == "Untitled"

    def test_notify_without_listener_is_safe(self) -> None:
        set_track_status_change_listener(None)
        notify_track_status_changed()
