"""File exports for SpoLocal tracks and playlists (single file and ZIP)."""

from __future__ import annotations

import os
import tempfile
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from spotify_scraper import _sanitize_folder_name

if TYPE_CHECKING:
    from download_service import DownloadService
    from models import Track


class ExportService:
    """Builds browser-downloadable files: one track or a whole playlist ZIP."""

    def __init__(self, download: "DownloadService"):
        self.download = download

    @staticmethod
    def export_filename_for_track(track: "Track", audio_path: Path) -> str:
        """Human-readable attachment name: Artist - Title.ext."""
        artist = _sanitize_folder_name((track.artist or "").strip()) or "Unknown"
        title = _sanitize_folder_name((track.title or "").strip()) or "Track"
        stem = f"{artist} - {title}"
        if len(stem) > 180:
            stem = stem[:180].rstrip(". ")
        suffix = audio_path.suffix.lower() or ".mp3"
        return stem + suffix

    def get_track_export(self, playlist_id: str, track_id: str) -> Optional[Tuple[Path, str]]:
        """Audio path plus browser download filename, or None if missing."""
        pl = self.download.get_playlist(playlist_id.strip())
        if not pl:
            return None
        track = pl.get_track(track_id.strip())
        if not track:
            return None
        path = self.download.get_track_audio_path(playlist_id, track_id)
        if not path:
            return None
        return path, self.export_filename_for_track(track, path)

    def build_playlist_export_zip(self, playlist_id: str) -> Optional[Tuple[Path, str, int]]:
        """Zip downloaded tracks. Returns (temp_zip, zip_name, file_count) or None if playlist missing."""
        pl = self.download.get_playlist(playlist_id.strip())
        if not pl:
            return None
        self.download.hydrate_media_paths(pl, persist=False)
        entries: List[Tuple[Path, str]] = []
        used_names: Dict[str, int] = {}
        for track in pl.tracks:
            path = self.download.get_track_audio_path(pl.id, track.id)
            if not path:
                continue
            name = self.export_filename_for_track(track, path)
            key = name.lower()
            n = used_names.get(key, 0)
            used_names[key] = n + 1
            if n:
                stem = Path(name).stem
                suffix = Path(name).suffix
                name = f"{stem} ({n + 1}){suffix}"
            entries.append((path, name))
        if not entries:
            return None
        pl_name = _sanitize_folder_name(pl.name) or "playlist"
        zip_name = f"{pl_name}.zip"
        fd, tmp_name = tempfile.mkstemp(suffix=".zip", prefix="spolocal_export_")
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for path, name in entries:
                    zf.write(path, arcname=name)
        except Exception:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        return tmp_path, zip_name, len(entries)
