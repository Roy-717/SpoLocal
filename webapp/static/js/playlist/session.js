import { PlaylistTransportController } from '../player/transport_controller.js';
import { PlaylistQueueController } from '../player/queue_controller.js';
import { PlaylistLyricsController } from '../player/lyrics_controller.js';
import { PlaylistEditModalController } from '../ui/edit_modal_controller.js';
import { PlaylistContextMenuController } from '../ui/context_menu_controller.js';
import { PlaylistDownloadController } from '../services/download_controller.js';
import { PlaylistColumnResizer } from '../ui/column_resizer.js';

/**
 * Main orchestrator for the playlist page session.
 * Responsibilities:
 * - Initialize and start all sub-controllers
 * - Handle SPA-style playlist navigation
 * - Restore last known playback state on boot
 */
export class PlaylistSessionController {
    /** @param {import('./state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./state.js').PlaylistPlayerState} */
        this.state = state;

        this.transport = new PlaylistTransportController(state);
        this.queue = new PlaylistQueueController(state, this.transport);
        this.lyrics = new PlaylistLyricsController(state, this.transport, this.queue);
        this.editModal = new PlaylistEditModalController(state);
        this.contextMenu = new PlaylistContextMenuController(state);
        this.download = new PlaylistDownloadController(state);

        // Wire cross-controller references so each controller can call its peers
        this.transport.setCrossRefs(this.queue, this.lyrics);
        this.queue.setCrossRefs(this.lyrics);
        this.editModal.setCrossRefs(this.contextMenu);
        this.contextMenu.setCrossRefs(this.queue, this.editModal, this.transport);
        this.download.setCrossRefs(this);
    }

    /** Initialize playlist DOM state and start all controllers. */
    bootstrap() {
        this.initialize_playlist_state();
        this.start();
    }

    /** Start all controllers and restore state. */
    start() {
        this.transport.init();
        this.queue.init();
        this.lyrics.init();
        this.editModal.init();
        this.contextMenu.init();
        this.download.init();

        this.restoreLastPlayback().then(async () => {
            this.queue.restore_manual_queue_from_storage();
            this.transport.syncShuffleOrderWithPlaylist();
            await this.transport.refresh_liked_keys_from_server();
            this.transport.update_like_button_ui();
            if (this.state.hub.queueVisible) this.queue.render_queue_list();
        }).catch(async () => {
            this.queue.restore_manual_queue_from_storage();
            this.transport.syncShuffleOrderWithPlaylist();
            await this.transport.refresh_liked_keys_from_server();
            this.transport.update_like_button_ui();
            if (this.state.hub.queueVisible) this.queue.render_queue_list();
        });

        window.addEventListener('popstate', () => {
            const pid = new URLSearchParams(location.search).get('playlist_id');
            if (pid) this.navigatePlaylist(pid, false);
        });

        window.addEventListener('beforeunload', () => this.transport.persistPlaybackProgress());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.transport.persistPlaybackProgress();
            } else {
                if (this.state.hub.currentTrackId && !this.state.hub.audio.paused) {
                    this.transport.updateMediaSessionPlaybackState();
                }
            }
        });

        document.addEventListener('click', (e) => {
            const a = e.target.closest('a.playlist-spa-nav');
            if (!a) return;
            let url;
            try { url = new URL(a.getAttribute('href'), location.origin); } catch (x) { return; }
            if (url.pathname !== '/' || !url.searchParams.get('playlist_id')) return;
            e.preventDefault();
            this.navigatePlaylist(url.searchParams.get('playlist_id'), true);
        }, true);
    }

    initialize_playlist_state() {
        const hub = this.state.hub || (this.state.hub = {});
        this.state.hub = hub;

        hub.playlistId = (function () {
            try {
                const el = document.getElementById('spolocal-player-boot');
                if (!el) return null;
                const o = JSON.parse(el.textContent || '{}');
                return o.playlistId != null ? o.playlistId : null;
            } catch (e) { return null; }
        })();
        try { window.__spaPlaylistId = hub.playlistId; } catch (e) {}
        window.__playlistsCatalog = window.__playlistsCatalog || [];

        hub.tracks = [];
        hub.playlistJsonEl = document.getElementById('playlist-json');
        if (hub.playlistJsonEl) {
            try {
                const parsed = JSON.parse(hub.playlistJsonEl.textContent || '[]');
                hub.tracks = Array.isArray(parsed) ? parsed : [];
            } catch (e) { hub.tracks = []; }
        }
        if (hub.playlistJsonEl) hub.playlistJsonEl.textContent = JSON.stringify(hub.tracks);
        hub.playable = hub.tracks.filter(t => t.play_src);

        hub.audio = document.getElementById('player-audio');
        hub.seek = document.getElementById('player-seek');
        hub.volumeEl = document.getElementById('player-volume');
        hub.volumeIconEl = document.getElementById('player-volume-icon');
        hub.timeEl = document.getElementById('player-time');
        hub.durEl = document.getElementById('player-duration');
        hub.titleEl = document.getElementById('player-title');
        hub.subEl = document.getElementById('player-subtitle');
        hub.coverImg = document.getElementById('player-cover');
        hub.coverWrap = document.getElementById('player-cover-wrap');
        hub.lyricsPanel = document.getElementById('lyrics-panel');
        hub.lyricsBody = document.getElementById('lyrics-body');
        hub.lyricsEmptyHint = document.getElementById('lyrics-empty-hint');
        hub.lyricsNoAudioHint = document.getElementById('lyrics-no-audio-hint');
        hub.lyricsViewWrap = document.getElementById('lyrics-view-wrap');
        hub.lyricsEditWrap = document.getElementById('lyrics-edit-wrap');
        hub.lyricsEditor = document.getElementById('lyrics-editor');
        hub.lyricsEditDisabled = document.getElementById('lyrics-edit-disabled');
        hub.lyricsEditActions = document.getElementById('lyrics-edit-actions');
        hub.lyricsSaveBtn = document.getElementById('lyrics-save-btn');
        hub.lyricsCancelEdit = document.getElementById('lyrics-cancel-edit');
        hub.lyricsSaveStatus = document.getElementById('lyrics-save-status');
        hub.lyricsTabRead = document.getElementById('lyrics-tab-read');
        hub.lyricsTabEdit = document.getElementById('lyrics-tab-edit');
        hub.btnLyricsMobile = document.getElementById('btn-lyrics-mobile');
        hub.btnLyricsDesktop = document.getElementById('btn-lyrics-desktop');
        hub.lyricsToggleButtons = [hub.btnLyricsMobile, hub.btnLyricsDesktop].filter(function (b) { return !!b; });
        hub.queuePanel = document.getElementById('sidebar-queue');
        hub.queueList = document.getElementById('queue-list');
        hub.queueClose = document.getElementById('queue-close');
        hub.queueReload = document.getElementById('queue-reload');
        hub.btnQueueMobile = document.getElementById('btn-queue-mobile');
        hub.btnQueueDesktop = document.getElementById('btn-queue-desktop');
        hub.lrcEditor = document.getElementById('lrc-editor');
        hub.lrcLinesContainer = document.getElementById('lrc-lines-container');
        hub.lrcShiftMinus = document.getElementById('lrc-shift-minus');
        hub.lrcShiftPlus = document.getElementById('lrc-shift-plus');
        hub.btnMainPlay = document.getElementById('player-main-play');
        hub.iconMainPlay = document.getElementById('player-main-play-icon');
        hub.btnPrev = document.getElementById('player-prev');
        hub.btnNext = document.getElementById('player-next');
        hub.btnShuffle = document.getElementById('player-shuffle');
        hub.btnRepeat = document.getElementById('player-repeat');
        hub.repeatOneBadge = document.getElementById('player-repeat-one-badge');
        hub.btnLike = document.getElementById('player-like');
        hub.btnLikeMobile = document.getElementById('player-like-mobile');
        hub.likeIconEl = document.getElementById('player-like-icon');
        hub.likeIconMobileEl = document.getElementById('player-like-icon-mobile');
        hub.lyricsClose = document.getElementById('lyrics-close');
        hub.playlistEditModal = document.getElementById('playlist-edit-modal');
        hub.playlistEditBackdrop = document.getElementById('playlist-edit-modal-backdrop');
        hub.playlistEditCloseX = document.getElementById('playlist-edit-close-x');
        hub.playlistEditCancel = document.getElementById('playlist-edit-cancel');
        hub.playlistEditSave = document.getElementById('playlist-edit-save');
        hub.playlistEditDelete = document.getElementById('playlist-edit-delete');
        hub.playlistEditId = document.getElementById('playlist-edit-id');
        hub.playlistEditNameInput = document.getElementById('playlist-edit-name-input');
        hub.playlistEditBioInput = document.getElementById('playlist-edit-bio-input');
        hub.playlistEditError = document.getElementById('playlist-edit-error');
        hub.contextMenuEl = document.getElementById('context-menu');
        hub.contextMenuItemsEl = document.getElementById('context-menu-items');
        hub.dlList = document.getElementById('dl-progress-list');
        hub.dlIdle = document.getElementById('dl-idle-msg');
        hub.dlCount = document.getElementById('dl-queue-count');
        hub.dlErrorList = document.getElementById('dl-error-list');
        hub.dlErrorCount = document.getElementById('dl-error-count');
        hub.dlRetryAllErrors = document.getElementById('dl-retry-all-errors');

        hub.LS_SHUFFLE = 'spolocal_shuffle';
        hub.LS_SHUFFLE_ORDER = 'spolocal_shuffle_order_v1';
        hub.LS_REPEAT = 'spolocal_repeat';
        hub.LS_VOLUME = 'spolocal_volume';
        hub.LS_LAST_PL = 'spolocal_last_playlist_id';
        hub.LS_LAST_TR = 'spolocal_last_track_id';
        hub.LS_LAST_POS = 'spolocal_last_time_sec';
        hub.LS_MANUAL_QUEUE = 'spolocal_manual_queue_v1';

        hub.shuffleOn = false;
        hub.repeatMode = 'off';
        hub.shuffledOrder = [];
        hub.queueVisible = false;
        hub.manual_up_next_queue = [];
        hub.resume_anchor_track_id = null;
        hub.currentTrackId = null;
        hub.lastPlayedTrackSnapshot = null;
        hub.playingPlaylistId = null;
        hub.playingTracks = [];
        hub.playingPlayable = [];
        hub.seeking = false;
        hub.lyricsVisible = false;
        hub.lyricsMode = 'read';
        hub.lastLyricsPayload = { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null };
        hub.lyricsAbortController = null;
        hub.lyricsFetchGen = 0;
        hub.lrcEditLines = [];
        hub.LIKED_PLAYLIST_ID = String(typeof window !== 'undefined' && window.__likedPlaylistId ? window.__likedPlaylistId : '').trim();
        hub.likedKeysSet = new Set();
        hub.pendingRestoreOnMeta = null;
        hub.persistThrottle = null;
        hub.mediaSessionPositionThrottle = null;
        hub.lyricsActiveLineThrottle = null;
        hub.lyricsScrollDebounce = null;
        hub.progressInFlight = false;
        hub.progressTimer = null;
        hub.__dlJobsDomKey = '';
        hub.__dlErrDomKey = '';
    }

    updateSidebarActive(pid) {
        document.querySelectorAll('.playlist-card').forEach(card => {
            const a = card.querySelector('a.playlist-spa-nav');
            if (!a) return;
            let u;
            try { u = new URL(a.getAttribute('href'), location.origin); } catch (x) { return; }
            const id = u.searchParams.get('playlist_id') || '';
            card.classList.toggle('nav-active', id === pid);
        });
    }

    applySpaPlaylist(data) {
        const hub = this.state.hub;
        hub.playlistId = data.playlist_id;
        try { window.__spaPlaylistId = hub.playlistId; } catch (e) {}
        hub.tracks = data.tracks_payload || [];
        hub.playable = hub.tracks.filter(t => t.play_src);

        const shell = document.getElementById('spa-main');
        if (shell) shell.innerHTML = data.html || '';

        if (hub.playlistJsonEl) hub.playlistJsonEl.textContent = JSON.stringify(hub.tracks);

        PlaylistColumnResizer.init();
        this.updateSidebarActive(hub.playlistId);

        this.transport.updatePlayingRow();
        this.transport.setPlayUi(!!(hub.currentTrackId && !hub.audio.paused));

        if (hub.queueVisible) this.queue.render_queue_list();

        if (typeof window.loadPlaylistRecommendations === 'function') {
            window.loadPlaylistRecommendations(hub.playlistId);
        }
        if (typeof window.syncPlaylistEditModalFromFragment === 'function') window.syncPlaylistEditModalFromFragment();

        void this.transport.refresh_liked_keys_from_server().then(() => {
            this.transport.update_like_button_ui();
            if (hub.queueVisible) this.queue.render_queue_list();
        });
    }

    async navigatePlaylist(pid, pushHistory, onLoaded) {
        const hub = this.state.hub;
        if (!pid || pid === hub.playlistId) return;
        try {
            const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(pid));
            if (!r.ok) {
                window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
                return;
            }
            const data = await r.json();
            this.applySpaPlaylist(data);
            if (pushHistory) {
                history.pushState({ playlistId: pid }, '', '/?playlist_id=' + encodeURIComponent(pid));
            }
            if (typeof onLoaded === 'function') {
                requestAnimationFrame(() => {
                    onLoaded();
                });
            }
        } catch (x) {
            window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
        }
    }

    async restoreLastPlayback() {
        const hub = this.state.hub;
        let pls, trs, posStr;
        try {
            pls = localStorage.getItem(hub.LS_LAST_PL);
            trs = localStorage.getItem(hub.LS_LAST_TR);
            posStr = localStorage.getItem(hub.LS_LAST_POS);
        } catch (e) { return; }
        if (!pls || !trs) return;
        let pos = parseFloat(posStr);
        if (!isFinite(pos) || pos < 0) pos = 0;

        if (pls !== hub.playlistId) {
            try {
                const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(pls));
                if (!r.ok) return;
                const data = await r.json();
                this.applySpaPlaylist(data);
            } catch (e) { return; }
        }

        try {
            const urlPid = new URLSearchParams(location.search).get('playlist_id') || '';
            if (urlPid !== pls) {
                history.replaceState(null, '', '/?playlist_id=' + encodeURIComponent(pls));
            }
        } catch (e) {}

        const t = hub.tracks.find(x => x.id === trs && x.play_src);
        if (!t) return;

        hub.playingPlaylistId = pls;
        hub.playingTracks = hub.tracks.slice();
        hub.playingPlayable = hub.playable.slice();
        hub.currentTrackId = trs;
        hub.lastPlayedTrackSnapshot = {
            id: trs,
            title: t.title || '',
            artist: t.artist || '',
            album: t.album != null ? String(t.album) : '',
            url: (t.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || '').trim(),
            source_playlist_id: pls,
        };
        hub.audio.src = t.play_src;
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist;
        if (typeof window.loadCover === 'function') window.loadCover(trs);
        this.transport.updatePlayingRow();
        this.transport.setPlayUi(false);
        this.transport.update_like_button_ui();

        const onMeta = () => {
            hub.audio.removeEventListener('loadedmetadata', onMeta);
            hub.pendingRestoreOnMeta = null;
            let tpos = pos;
            if (hub.audio.duration && isFinite(hub.audio.duration)) {
                if (tpos > hub.audio.duration - 0.35) tpos = 0;
                if (tpos > 0.25) hub.audio.currentTime = tpos;
            }
            hub.timeEl.textContent = this.transport.fmt(hub.audio.currentTime);
            hub.durEl.textContent = this.transport.fmt(hub.audio.duration);
            if (hub.audio.duration) {
                hub.seek.value = String(Math.floor((hub.audio.currentTime / hub.audio.duration) * 1000));
            }
        };
        hub.pendingRestoreOnMeta = onMeta;
        hub.audio.addEventListener('loadedmetadata', onMeta);
    }

    attachHelpers() {
        const self = this;
        try {
            if (typeof window !== 'undefined') {
                window.navigatePlaylist = (pid, push, cb) => self.navigatePlaylist(pid, push, cb);
                window.applySpaPlaylist = (data) => self.applySpaPlaylist(data);
            }
        } catch (e) {}
    }
}
