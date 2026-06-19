"""Domain models and state events for SpoLocal.

Defines track and playlist data shapes.
Publishes status-change notifications used by UI refresh logic."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Callable, List, Optional
from urllib.parse import quote
from uuid import uuid4


class DownloadStatus(str, Enum):
    queued = "queued"
    downloading = "downloading"
    done = "done"
    error = "error"
    pending = "pending"  # saved from search / manual add; no download started yet


_on_track_status_changed: Optional[Callable[[], None]] = None


def set_track_status_change_listener(cb: Optional[Callable[[], None]]) -> None:
    global _on_track_status_changed
    _on_track_status_changed = cb


def notify_track_status_changed() -> None:
    if _on_track_status_changed is not None:
        _on_track_status_changed()


@dataclass(slots=True)
class Track:
    id: str
    title: str
    artist: str
    url: Optional[str] = None
    status: DownloadStatus = DownloadStatus.queued
    error: Optional[str] = None
    added_at: datetime = field(default_factory=datetime.utcnow)
    media_relpath: Optional[str] = None
    cover_url: Optional[str] = None
    youtube_video_id: Optional[str] = None
    album: Optional[str] = None
    # When this row lives in the Liked Songs playlist, references the original list + track id.
    liked_source_playlist_id: Optional[str] = None
    liked_source_track_id: Optional[str] = None

    @classmethod
    def create(cls, title: str, artist: str, url: Optional[str] = None) -> "Track":
        return cls(id=str(uuid4()), title=title, artist=artist, url=url)

    def play_src(self) -> Optional[str]:
        if self.status != DownloadStatus.done:
            return None
        if not self.media_relpath:
            return None
        return "/media/" + quote(self.media_relpath, safe="/")


@dataclass(slots=True)
class Playlist:
    id: str
    name: str
    tracks: List[Track] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    spotify_catalog_key: Optional[str] = None
    spotify_snapshot_id: Optional[str] = None
    bio: Optional[str] = None

    @classmethod
    def create(cls, name: str) -> "Playlist":
        return cls(id=str(uuid4()), name=name.strip() or "Untitled", bio=None)

    def add_track(self, track: Track) -> None:
        self.tracks.append(track)

    def get_track(self, track_id: str) -> Optional[Track]:
        return next((t for t in self.tracks if t.id == track_id), None)

    def update_track_status(self, track_id: str, status: DownloadStatus, error: Optional[str] = None) -> None:
        track = self.get_track(track_id)
        if track:
            track.status = status
            track.error = error
            notify_track_status_changed()

    def remove_track(self, track_id: str) -> bool:
        n = len(self.tracks)
        self.tracks = [t for t in self.tracks if t.id != track_id]
        if len(self.tracks) < n:
            notify_track_status_changed()
            return True
        return False
