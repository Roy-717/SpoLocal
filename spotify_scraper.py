import logging
import os
from pathlib import Path

import yt_dlp
from yt_dlp.utils import sanitize_filename

from spotifydown_api import SpotifyEmbedAPI, TrackInfo, extract_playlist_id, extract_track_id


def _ffmpeg_bin_dir(root: Path) -> Path:
    return root / "ffmpeg-2026-05-06-git-f2e5eff3ff-essentials_build" / "bin"


def _ffmpeg_executable(bin_dir: Path) -> str:
    name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    return str(bin_dir / name)


def _sanitize_folder_name(name: str) -> str:
    """Safe filesystem name — strips reserved chars, collapses whitespace."""
    import re
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', name).strip(". ")
    s = re.sub(r'\s+', ' ', s)
    return s or "playlist"


def _env_truthy(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw == "":
        return default
    return raw not in ("0", "false", "no", "off")


def _configure_cli_logging() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    for name in ("urllib3", "urllib3.connectionpool", "requests"):
        logging.getLogger(name).setLevel(logging.WARNING)
    if _env_truthy("SPOTIFY_DEBUG", default=False):
        logging.getLogger("__main__").setLevel(logging.DEBUG)
        logging.getLogger("spotify_scraper").setLevel(logging.DEBUG)


def _is_spotify_url(line: str) -> bool:
    return "open.spotify.com" in line.lower()


def youtube_video_id_from_ytdlp_info(info: object) -> str | None:
    """Resolve a YouTube video id from yt-dlp extract_info result (playlist or single)."""
    if not isinstance(info, dict):
        return None
    etype = info.get("_type")
    if etype in ("playlist", "multi_video"):
        for ent in info.get("entries") or []:
            if ent is None:
                continue
            if isinstance(ent, dict):
                v = youtube_video_id_from_ytdlp_info(ent)
                if v:
                    return v
        return None
    iid = info.get("id")
    if not iid or not isinstance(iid, str):
        return None
    ext = str(info.get("extractor") or "").lower()
    if "youtube" in ext:
        return iid
    wu = str(info.get("webpage_url") or "").lower()
    if "youtube.com" in wu or "youtu.be" in wu:
        return iid
    return None


def _existing_file(path: Path) -> Path | None:
    if path.is_file():
        return path
    if path.suffix.lower() != ".mp3":
        mp3 = path.with_suffix(".mp3")
        if mp3.is_file():
            return mp3
    return None


def _filepath_from_ytdlp_info(info: object) -> Path | None:
    """Best-effort path to the final media file after yt-dlp download."""
    if not isinstance(info, dict):
        return None
    fp = info.get("filepath")
    if isinstance(fp, str) and fp:
        found = _existing_file(Path(fp))
        if found:
            return found
    etype = info.get("_type")
    if etype in ("playlist", "multi_video"):
        for ent in info.get("entries") or []:
            if not isinstance(ent, dict):
                continue
            inner = _filepath_from_ytdlp_info(ent)
            if inner is not None:
                return inner
        return None
    rds = info.get("requested_downloads")
    if isinstance(rds, list):
        for rd in reversed(rds):
            if not isinstance(rd, dict):
                continue
            f2 = rd.get("filepath")
            if isinstance(f2, str) and f2:
                found = _existing_file(Path(f2))
                if found:
                    return found
    return None


def _mp3_for_video_id(root: Path, video_id: str, quality_key: str) -> Path | None:
    """Only the file for this video id + kbps, never an unrelated newest mp3."""
    if not root.is_dir() or not video_id:
        return None
    needle = f"[{video_id}]"
    suffix = f"__{quality_key}k"
    matches: list[Path] = []
    for p in root.rglob("*.mp3"):
        if needle not in p.name:
            continue
        if suffix not in p.stem:
            continue
        matches.append(p)
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)


# ---------------------------------------------------------------------------
# YouTube downloader (unchanged)
# ---------------------------------------------------------------------------

class YtDlpAudioDownloader:
    def __init__(self, project_root: Path | None = None) -> None:
        self._root = (project_root or Path(__file__).resolve().parent)
        self._ffmpeg_bin = _ffmpeg_bin_dir(self._root)
        self._youtube_dir = self._root / "downloads" / "youtube"
        self._youtube_dir.mkdir(parents=True, exist_ok=True)

    def _ydl_opts(self, outtmpl: str, quality: str | int = 192) -> dict:
        from webapp.audio_quality import parse_quality_kbps, ytdlp_audio_postprocessor, ytdlp_youtube_opts

        kbps = parse_quality_kbps(quality)
        opts = ytdlp_youtube_opts()
        opts.update({
            "format": "bestaudio/best",
            "ffmpeg_location": str(self._ffmpeg_bin),
            "outtmpl": {"default": outtmpl},
            "postprocessors": [ytdlp_audio_postprocessor(kbps)],
        })
        return opts

    def download_urls(self, urls: list[str], *, quality: str | int = 192) -> None:
        from webapp.audio_quality import parse_quality_kbps, variant_key

        kbps = parse_quality_kbps(quality)
        with yt_dlp.YoutubeDL(
            self._ydl_opts(str(self._youtube_dir / "%(title)s [%(id)s].%(ext)s"), quality=kbps)
        ) as ydl:
            for url in urls:
                ydl.download([url])

    def download_from_line(self, line: str, progress_hook=None, *, quality: str | int = 192) -> tuple[str | None, Path | None]:
        from webapp.audio_quality import parse_quality_kbps, variant_key

        kbps = parse_quality_kbps(quality)
        qk = variant_key(kbps)
        raw = line.strip()
        if not raw:
            return (None, None)
        if raw.lower().startswith(("http://", "https://")):
            target = raw
        else:
            target = f"ytsearch1:{raw}"

        playlist_folder: str | None = None
        if target.lower().startswith(("http://", "https://")):
            try:
                probe_opts = {"quiet": True, "no_warnings": True, "extract_flat": True, "skip_download": True}
                with yt_dlp.YoutubeDL(probe_opts) as ydl_probe:
                    info = ydl_probe.extract_info(target, download=False)
                if info and info.get("_type") in ("playlist", "multi_video"):
                    title = str(info.get("title") or info.get("id") or "playlist")
                    playlist_folder = _sanitize_folder_name(title)
            except Exception:
                playlist_folder = None

        if playlist_folder:
            pl_dir = self._youtube_dir / playlist_folder
            pl_dir.mkdir(parents=True, exist_ok=True)
            outtmpl = str(pl_dir / f"%(title)s [%(id)s]__{qk}k.%(ext)s")
        else:
            outtmpl = str(self._youtube_dir / f"%(title)s [%(id)s]__{qk}k.%(ext)s")

        opts = self._ydl_opts(outtmpl, quality=kbps)
        if progress_hook:
            opts["progress_hooks"] = [progress_hook]
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(target, download=True)
            vid = youtube_video_id_from_ytdlp_info(info)
            out_path = _filepath_from_ytdlp_info(info)
            if out_path is None and vid:
                out_path = _mp3_for_video_id(self._youtube_dir, vid, qk)
            return (vid, out_path)
        except Exception:
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(target, download=True)
                vid = youtube_video_id_from_ytdlp_info(info)
                out_path = _filepath_from_ytdlp_info(info)
                if out_path is None and vid:
                    out_path = _mp3_for_video_id(self._youtube_dir, vid, qk)
                return (vid, out_path)
            except Exception:
                return (None, None)


def search_youtube_tracks(project_root: Path, query: str, limit: int = 12) -> list[dict]:
    """
    Resolve YouTube search hits via yt-dlp without downloading audio.
    Returns dicts: video_id, title, artist, url, duration_sec, channel,
    thumbnail_url, year (optional).
    """
    q = (query or "").strip()
    if len(q) < 2:
        return []
    limit = max(1, min(int(limit), 30))

    def _best_thumbnail_url(entry: dict, video_id: str) -> str:
        thumbs = entry.get("thumbnails")
        if isinstance(thumbs, list) and thumbs:
            def _area(t: dict) -> int:
                return (t.get("width") or 0) * (t.get("height") or 0)

            best = max(thumbs, key=_area)
            u = best.get("url")
            if u:
                return str(u)
        t = entry.get("thumbnail")
        if t:
            return str(t)
        return f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"

    def _year_from_entry(entry: dict) -> str | None:
        ud = entry.get("upload_date")
        if isinstance(ud, str) and len(ud) >= 4 and ud[:4].isdigit():
            return ud[:4]
        ry = entry.get("release_year")
        if ry is not None:
            try:
                return str(int(ry))
            except (TypeError, ValueError):
                pass
        return None

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "socket_timeout": 20,
    }
    results: list[dict] = []
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
        entries = info.get("entries") or []
        for e in entries:
            if not e:
                continue
            vid = e.get("id")
            if not vid:
                continue
            raw_title = (e.get("title") or "").strip() or "(no title)"
            channel = (e.get("uploader") or e.get("channel") or "").strip()
            artist = channel or "YouTube"
            song_title = raw_title
            if " - " in raw_title:
                left, right = raw_title.split(" - ", 1)
                if left.strip() and right.strip():
                    artist = left.strip()
                    song_title = right.strip()
            dur = e.get("duration")
            yr = _year_from_entry(e)
            _album = None
            _ar = e.get("album")
            if _ar is not None:
                _s = str(_ar).strip()
                if _s:
                    _album = _s[:500]
            results.append(
                {
                    "video_id": vid,
                    "title": song_title,
                    "artist": artist,
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "duration_sec": int(dur) if isinstance(dur, (int, float)) else None,
                    "channel": channel,
                    "thumbnail_url": _best_thumbnail_url(e, vid),
                    "year": yr,
                    "album": _album,
                }
            )
    except Exception:
        pass
    return results


# ---------------------------------------------------------------------------
# Spotify embed downloader — no API credentials required
# ---------------------------------------------------------------------------

class SpotifyEmbedDownloader:
    """
    Fetches Spotify metadata from embed pages (no credentials needed),
    then downloads audio via YouTube Music search with yt-dlp.
    """

    def __init__(self, project_root: Path | None = None) -> None:
        self._root = project_root or Path(__file__).resolve().parent
        self._downloads = self._root / "downloads"
        self._downloads.mkdir(exist_ok=True)
        self._bin_dir = _ffmpeg_bin_dir(self._root)
        self._ffmpeg_exe = _ffmpeg_executable(self._bin_dir)
        self._api = SpotifyEmbedAPI()

    def get_playlist_info(self, playlist_url: str) -> tuple:
        """Returns (PlaylistInfo, list[TrackInfo])."""
        pid = extract_playlist_id(playlist_url)
        meta = self._api.get_playlist_metadata(pid)
        tracks = list(self._api.iter_playlist_tracks(pid))
        return meta, tracks

    def get_track_info(self, track_url: str) -> TrackInfo:
        tid = extract_track_id(track_url)
        return self._api.get_track(tid)

    def download_track(
        self,
        artist: str,
        title: str,
        out_dir: Path,
        cover_url: str | None = None,
        progress_hook=None,
        *,
        quality: str | int = 192,
    ) -> tuple[Path | None, str | None]:
        """
        Search YouTube Music for '{artist} - {title}', download as mp3,
        write basic ID3 tags, return (Path | None, youtube_video_id | None).
        Falls back to regular YouTube search if YT Music fails.
        """
        from webapp.audio_quality import (
            parse_quality_kbps,
            quality_file_stem,
            ytdlp_audio_postprocessor,
            ytdlp_youtube_opts,
        )

        kbps = parse_quality_kbps(quality)
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = sanitize_filename(f"{artist} - {title}", restricted=False)
        stem = quality_file_stem(safe, kbps)
        outtmpl = str(out_dir / f"{stem}.%(ext)s")
        expected = out_dir / f"{stem}.mp3"

        for provider in ("ytsearch1", "ytmsearch1"):
            query = f"{provider}:{artist} - {title}"
            opts = ytdlp_youtube_opts()
            opts.update({
                "format": "bestaudio/best",
                "ffmpeg_location": self._ffmpeg_exe,
                "outtmpl": {"default": outtmpl},
                "postprocessors": [ytdlp_audio_postprocessor(kbps)],
                "quiet": True,
                "no_warnings": True,
                "socket_timeout": 30,
            })
            if progress_hook:
                opts["progress_hooks"] = [progress_hook]
            vid: str | None = None
            info: dict | None = None
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(query, download=True)
                vid = youtube_video_id_from_ytdlp_info(info)
            except Exception as exc:
                print(f"yt-dlp [{provider}] extract_info failed for '{artist} - {title}': {exc}")
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(query, download=True)
                    vid = youtube_video_id_from_ytdlp_info(info)
                except Exception as exc2:
                    print(f"yt-dlp [{provider}] download failed for '{artist} - {title}': {exc2}")
                    continue

            if expected.is_file():
                self._tag_file(expected, artist, title, cover_url)
                return expected, vid

            found = _filepath_from_ytdlp_info(info)
            if found is not None:
                self._tag_file(found, artist, title, cover_url)
                return found, vid

        return None, None

    def _tag_file(self, path: Path, artist: str, title: str, cover_url: str | None) -> None:
        try:
            from mutagen.id3 import ID3, TIT2, TPE1, APIC
            from mutagen.mp3 import MP3
            import urllib.request

            audio = MP3(str(path), ID3=ID3)
            try:
                audio.add_tags()
            except Exception:
                pass

            audio.tags["TIT2"] = TIT2(encoding=3, text=title)
            audio.tags["TPE1"] = TPE1(encoding=3, text=artist)

            if cover_url:
                try:
                    req = urllib.request.Request(cover_url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        cover_data = resp.read()
                    audio.tags["APIC"] = APIC(
                        encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_data
                    )
                except Exception:
                    pass

            audio.save()
        except Exception as exc:
            print(f"Tagging failed for {path.name}: {exc}")


if __name__ == "__main__":
    _configure_cli_logging()
    root = Path(__file__).resolve().parent
    ytdlp_dl = YtDlpAudioDownloader(root)
    embed_dl = SpotifyEmbedDownloader(root)
    print(
        "YouTube: title or non-Spotify URL. "
        "Spotify: playlist/track URL — no API credentials needed. "
        "Empty line exits."
    )
    while True:
        try:
            line = input("URL / search: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            break
        try:
            if _is_spotify_url(line):
                from spotifydown_api import detect_spotify_url_type
                url_type, sid = detect_spotify_url_type(line)
                if url_type == "playlist":
                    meta, tracks = embed_dl.get_playlist_info(line)
                    print(f"Playlist: {meta.name} ({len(tracks)} tracks)")
                    out = root / "downloads" / _sanitize_folder_name(meta.name)
                    for t in tracks:
                        print(f"  Downloading: {t.artists} - {t.title}")
                        embed_dl.download_track(t.artists, t.title, out, t.cover_url)
                else:
                    info = embed_dl.get_track_info(line)
                    embed_dl.download_track(info.artists, info.title, root / "downloads", info.cover_url)
            else:
                ytdlp_dl.download_from_line(line)
        except Exception as err:
            print(f"Error: {err}")
        print("Done.\n")
