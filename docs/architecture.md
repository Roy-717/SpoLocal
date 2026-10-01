# SpoLocal architecture

Class-level overview of the app. Backend is FastAPI + Python services, frontend is
vanilla JS ES modules (OOP controllers). The two halves talk only over HTTP
(`/api/...`, `/media/...`), so no class in one diagram depends on a class in the
other.

Module-level helpers are not classes and are left out: `audio_quality.py`,
`tag_metadata.py`, `cover_image.py`, `lyrics_files.py`, `lyrics_fetch.py`,
`lyrics_text.py`, `loudness_analysis.py`, and the pydantic request bodies in
`main.py`.

## Backend

`main.py` is a thin router. All work lives in the service classes below.

```mermaid
classDiagram
    direction TB

    class MainApp {
        +index()
        +api_stream()
        +serve_media()
        +api_media_prepare()
        +export_track_file()
        +export_playlist_zip()
    }

    class DownloadService {
        +playlists
        +progress
        +create_playlist()
        +add_track_to_playlist()
        +start_track_download()
        +queue_playlist_quality_downloads()
        +hydrate_media_paths()
        +get_track_audio_path()
        +set_track_liked()
    }

    class LyricsService {
        +get_lyrics_payload()
        +save_track_lyrics_file()
        +save_track_lrc_file()
        +remote_payload()
        +materialize_after_download()
    }

    class ExportService {
        +get_track_export()
        +build_playlist_export_zip()
    }

    class MediaServer {
        +media_root
        +serve(sliced)
        +prepare(media_path)
        +content_type(path)
    }

    class YouTubeStreamingService {
        +get_preview_payload()
        +get_video_payload()
        +resolve_track_play_src()
        +proxy(vid)
        +prefetch_mix_stream_payloads()
        +fetch_thumbnail_bytes()
    }

    class YoutubeStreamProxy {
        +response_for(request)
    }

    class YoutubeCdnAudio {
        +url
        +ext
        +filesize
        +duration_sec
        +slice_for_range_header()
    }

    class YoutubeThumbQuality {
        +parse(q)
    }

    class YtDlpAudioDownloader {
        +download_from_line()
        +download_urls()
    }

    class SpotifyEmbedDownloader {
        +download_track()
        +get_track_info()
        +get_playlist_info()
    }

    class YoutubePlaylistMix {
        +mix_url(vid)
    }

    class SpotifyEmbedAPI {
        +get_track()
        +get_playlist()
    }

    class Playlist {
        +id
        +name
        +tracks
        +add_track()
        +get_track()
        +update_track_status()
    }

    class Track {
        +id
        +title
        +artist
        +status
        +media_relpath
        +media_variants
        +play_src()
        +set_media_variant()
        +resolved_youtube_video_id()
    }

    class DownloadStatus {
        <<enumeration>>
        queued
        downloading
        done
        error
        pending
    }

    MainApp --> DownloadService
    MainApp --> LyricsService
    MainApp --> ExportService
    MainApp --> MediaServer
    MainApp --> YouTubeStreamingService
    MainApp --> YtDlpAudioDownloader
    MainApp --> SpotifyEmbedDownloader
    MainApp --> YoutubePlaylistMix

    DownloadService *-- LyricsService : self.lyrics
    DownloadService *-- SpotifyEmbedDownloader : self._embed
    DownloadService *-- Playlist : playlists
    DownloadService ..> YtDlpAudioDownloader : download jobs
    Playlist *-- Track : tracks
    Track --> DownloadStatus
    LyricsService --> DownloadService : download
    ExportService --> DownloadService : download
    SpotifyEmbedDownloader --> SpotifyEmbedAPI : self._api
    YouTubeStreamingService *-- YoutubeCdnAudio : preview and video caches
    YouTubeStreamingService ..> YoutubeStreamProxy : creates
    YouTubeStreamingService --> YoutubeThumbQuality
    YoutubeStreamProxy --> YouTubeStreamingService : service
```

`DownloadService` also keeps a private hydration cache (`_HydrationCacheEntry`:
stem-to-path map plus lazy albums) that is not shown above.

## Frontend: session and player

`PlaylistSession.mjs` builds `PlaylistPlayerState`, `PlaylistSessionController`,
and the shared `MseStreamController` (exposed as `window.SpolocalMse`).
`PlaylistSessionController` creates every sub-controller and then wires the
cross-references each one needs.

```mermaid
classDiagram
    direction TB

    class PlaylistSessionController {
        +state
        +transport
        +queue
        +lyrics
        +quality
        +home
        +download
        +contextMenu
        +editModal
        +settings
        +trackInfo
        +trackEdit
        +songMix
        +bootstrap()
        +navigatePlaylist()
        +restoreLastPlayback()
    }

    class PlaylistPlayerState {
        +hub
        +currentTrackId
        +audio
        +tracks
        +playingTracks
    }

    class PlaylistTransportController {
        +playLibraryEntry()
        +playTrackById()
        +playAtDelta()
        +toggle_main_play()
        +seek_to_time_from_slider()
        +advance_search_stream()
        +_attach_playback_source()
    }

    class PlaybackQualityController {
        +ensurePlaybackVariantReady()
        +switchPlaybackQuality()
        +apply_track_loudness()
        +replace_audio_src()
    }

    class PlaylistQueueController {
        +render_queue_list()
        +play_track_from_queue_entry()
        +restore_manual_queue_from_storage()
    }

    class MseStreamController {
        +play(vid)
        +play_media(src)
        +seek_to()
        +stop()
        +is_active()
    }

    class AudioNormalizationController {
        +set_track_gain()
        +set_user_volume()
    }

    class SpolocalQualityPrefs {
        +playbackKbps()
        +downloadKbps()
        +resolvePlaybackPlaySrc()
        +normalizeMediaPath()
        +streamFitsTier()
    }

    class SpolocalCoverUrls {
        +trackCoverUrl()
        +youtubeThumbApiUrl()
    }

    class PlaylistLikeController
    class PlaylistShuffleController
    class PlaylistMediaSessionController
    class PlaylistHomeViewController
    class PlaylistLyricsController
    class PlaylistDownloadController
    class PlaylistContextMenuController
    class PlaylistEditModalController
    class SettingsController
    class TrackInfoController
    class TrackEditController
    class SongMixController
    class PlaylistColumnResizer
    class AppShellController {
        +boot()
        +playPreview()
        +stopPreview()
    }
    class SpolocalMobileSheetDrawers

    PlaylistSessionController *-- PlaylistPlayerState : state
    PlaylistSessionController *-- PlaylistTransportController : transport
    PlaylistSessionController *-- PlaybackQualityController : quality
    PlaylistSessionController *-- PlaylistQueueController : queue
    PlaylistSessionController *-- PlaylistLyricsController : lyrics
    PlaylistSessionController *-- PlaylistLikeController : likes
    PlaylistSessionController *-- PlaylistShuffleController : shuffle
    PlaylistSessionController *-- PlaylistMediaSessionController : mediaSession
    PlaylistSessionController *-- PlaylistHomeViewController : home
    PlaylistSessionController *-- PlaylistDownloadController : download
    PlaylistSessionController *-- PlaylistContextMenuController : contextMenu
    PlaylistSessionController *-- PlaylistEditModalController : editModal
    PlaylistSessionController *-- SettingsController : settings
    PlaylistSessionController *-- TrackInfoController : trackInfo
    PlaylistSessionController *-- TrackEditController : trackEdit
    PlaylistSessionController *-- SongMixController : songMix
    PlaylistSessionController ..> AudioNormalizationController : hub.audioNormalization
    PlaylistSessionController ..> PlaylistColumnResizer : init()

    PlaylistTransportController --> PlaybackQualityController : quality
    PlaylistTransportController --> PlaylistQueueController : queue
    PlaylistTransportController --> PlaylistLyricsController : lyrics
    PlaylistTransportController --> PlaylistHomeViewController : home
    PlaylistTransportController --> MseStreamController : window.SpolocalMse
    PlaylistTransportController ..> AudioNormalizationController : hub.audioNormalization
    PlaylistTransportController --> SpolocalQualityPrefs
    PlaybackQualityController --> PlaylistTransportController : transport
    PlaylistQueueController --> PlaylistTransportController : transport
    PlaylistLyricsController --> PlaylistTransportController : transport
    SettingsController --> PlaylistTransportController
    SettingsController --> PlaylistDownloadController
    PlaylistContextMenuController --> PlaylistTransportController
    PlaylistContextMenuController --> PlaylistQueueController
    PlaylistContextMenuController --> SongMixController
    PlaylistContextMenuController --> TrackInfoController
    TrackEditController --> PlaylistTransportController
    PlaylistDownloadController --> PlaylistSessionController : session
    AppShellController ..> MseStreamController : preview playback
    AppShellController *-- SpolocalMobileSheetDrawers
    SpolocalCoverUrls ..> SpolocalQualityPrefs
```

`SpolocalQualityPrefs` and `SpolocalCoverUrls` are a namespace object and a
small class in `audio_quality_prefs.js`, not ES module exports.
`AppShellController` is a classic script booted separately from the module graph
(`window.AppShell.boot()`); it handles the global UI (search, preview,
recommendations) and shares the same `window.SpolocalMse` instance.

## Lyrics subsystem

`PlaylistLyricsController` owns the LRC editor, the background visualizer, and the
palette math extracted from the cover art.

```mermaid
classDiagram
    direction TB

    class PlaylistLyricsController {
        +colors
        +visualizer
        +editor
        +fetchLyrics()
        +renderLyrics()
        +setLyricsMode()
        +sync_stream_video_clock()
        +extractCoverColors()
    }

    class LyricsEditorController {
        +renderLrcEditor()
        +renderLrcLinesInEditor()
        +formatLrcTimestamp()
        +parseLrcTimestamp()
        +adjust_timestamp()
        +shiftAllTimestamps()
        +saveLyrics()
    }

    class LyricsVisualizerController {
        +paper_shaders
        +wave_field
        +milkdrop
        +init()
        +bind_visualizer_mode()
        +sync_visualizer_mode_ui()
        +current_visualizer_track()
    }

    class LyricsColorExtractor {
        +isColorDark()
        +rgb_to_hsl()
        +hsl_to_rgb()
        +ranked_cover_hues()
        +pick_cover_hues()
        +calculateLyricsColors()
    }

    class LyricsWaveField {
        +start()
        +stop()
    }

    class LyricsMilkdrop {
        +PACKS
        +start()
        +stop()
    }

    class LyricsPaperShaders {
        +MOOD
        +start()
        +stop()
    }

    PlaylistLyricsController *-- LyricsEditorController : editor
    PlaylistLyricsController *-- LyricsVisualizerController : visualizer
    PlaylistLyricsController *-- LyricsColorExtractor : colors
    LyricsVisualizerController *-- LyricsWaveField : wave_field
    LyricsVisualizerController *-- LyricsMilkdrop : milkdrop
    LyricsVisualizerController *-- LyricsPaperShaders : paper_shaders
```
