"""Lyrics read/save/remote-fetch for SpoLocal tracks.

Owns the lyrics concern that previously lived on `DownloadService`: reading
sidecar/embedded lyrics, saving user lyrics (plain and LRC), materializing
remote lyrics after a download, and fetching LRCLIB payloads for stream playback.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from lyrics_files import (
    delete_lyrics_sidecars,
    materialize_lyrics_file_if_needed,
    parse_lrc_lines,
    payload_from_remote_lyrics,
    read_raw_lrc,
    read_sidecar_lyrics,
    save_lrc_from_lines,
    save_user_lyrics,
)
from lyrics_fetch import fetch_lrclib_sidecar_sync, on_demand_lyrics_fetch_enabled
from tag_metadata import extract_lyrics

if TYPE_CHECKING:
    from download_service import DownloadService
    from models import Track


class LyricsService:
    """Reads and writes lyrics next to a track's audio file."""

    def __init__(self, download: "DownloadService"):
        self.download = download

    def get_lyrics_payload(self, playlist_id: str, track_id: str) -> dict:
        pl = self.download.get_playlist(playlist_id.strip())
        tid = track_id.strip()
        if not pl or not pl.get_track(tid):
            return {"lyrics": "", "source": "none", "has_audio": False, "lrc_data": None, "lrc_raw": None}
        path = self.download.get_track_audio_path(playlist_id, track_id)
        if not path:
            return {"lyrics": "", "source": "none", "has_audio": False, "lrc_data": None, "lrc_raw": None}
        side = read_sidecar_lyrics(path)
        if side:
            result = {"lyrics": side[0], "source": side[1], "has_audio": True, "lrc_data": None, "lrc_raw": None}
            # Include parsed LRC data and raw content for synced lyrics
            if side[1] == "lrc":
                raw_lrc = read_raw_lrc(path)
                if raw_lrc:
                    result["lrc_data"] = parse_lrc_lines(raw_lrc)
                    result["lrc_raw"] = raw_lrc
            return result
        emb = extract_lyrics(path)
        if emb and emb.strip():
            return {"lyrics": emb.strip(), "source": "embedded", "has_audio": True, "lrc_data": None, "lrc_raw": None}
        track = pl.get_track(tid)
        if track and on_demand_lyrics_fetch_enabled():
            plain, synced = fetch_lrclib_sidecar_sync(track.artist, track.title, force=True)
            if (plain and plain.strip()) or (synced and synced.strip()):
                materialize_lyrics_file_if_needed(path, None, plain, synced)
                again = read_sidecar_lyrics(path)
                if again:
                    result = {"lyrics": again[0], "source": again[1], "has_audio": True, "lrc_data": None, "lrc_raw": None}
                    if again[1] == "lrc":
                        raw_lrc = read_raw_lrc(path)
                        if raw_lrc:
                            result["lrc_data"] = parse_lrc_lines(raw_lrc)
                            result["lrc_raw"] = raw_lrc
                    return result
        return {"lyrics": "", "source": "none", "has_audio": True, "lrc_data": None, "lrc_raw": None}

    def save_track_lyrics_file(self, playlist_id: str, track_id: str, text: str) -> bool:
        path = self.download.get_track_audio_path(playlist_id, track_id)
        if not path:
            return False
        save_user_lyrics(path, text)
        return True

    def save_track_lrc_file(self, playlist_id: str, track_id: str, lines: list) -> bool:
        path = self.download.get_track_audio_path(playlist_id, track_id)
        if not path:
            return False
        save_lrc_from_lines(path, lines)
        return True

    def materialize_after_download(self, track: "Track") -> None:
        if not track.media_relpath:
            return
        ap = (self.download.root / "downloads" / track.media_relpath).resolve()
        if not ap.is_file():
            return
        remote_plain, remote_synced = fetch_lrclib_sidecar_sync(track.artist, track.title)
        has_remote = (remote_plain and remote_plain.strip()) or (remote_synced and remote_synced.strip())
        emb = extract_lyrics(ap) if not has_remote else None
        materialize_lyrics_file_if_needed(ap, emb, remote_plain, remote_synced)

    def remote_payload(self, artist: str, title: str) -> dict:
        """LRCLIB lookup for stream playback; nothing is written to disk."""
        plain, synced = fetch_lrclib_sidecar_sync(artist.strip(), title.strip())
        payload = payload_from_remote_lyrics(plain, synced)
        payload["readonly"] = True
        return payload

    def delete_sidecars(self, path: Path) -> None:
        delete_lyrics_sidecars(path)
