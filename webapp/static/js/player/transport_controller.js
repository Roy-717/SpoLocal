/**
 * Controller owning all transport concerns for the playlist page.
 * Responsibilities:
 * - Handle play/pause, prev/next, seek, and volume changes
 * - Manage shuffle and repeat modes and their persistence
 * - Sync UI state (buttons, sliders) with the audio element
 */
export class PlaylistTransportController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./queue_controller.js').PlaylistQueueController|null} */
        this.queue = null;
        /** @type {import('./lyrics_controller.js').PlaylistLyricsController|null} */
        this.lyrics = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.stallRecoveryTimer = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(queue, lyrics) {
        this.queue = queue;
        this.lyrics = lyrics;
    }

    /** Wire up transport-related event listeners and load preferences. */
    init() {
        const hub = this.state.hub;
        if (!hub) return;

        // Avoid double-binding
        if (hub._transport_controller_bound) return;
        hub._transport_controller_bound = true;

        this.loadTransportPrefs();
        if (typeof this.load_volume_pref === 'function') this.load_volume_pref();

        // Seek wiring
        if (hub.seek) {
            hub.seek.addEventListener('input', () => {
                hub.seeking = true;
                if (hub.audio.duration) {
                    hub.timeEl.textContent = this.fmt(Math.floor((parseFloat(hub.seek.value) / 1000) * hub.audio.duration));
                }
            });
            hub.seek.addEventListener('change', () => {
                this.seek_to_time_from_slider();
            });
        }

        // Volume wiring
        if (hub.volumeEl) {
            hub.volumeEl.addEventListener('input', () => {
                const v = parseFloat(hub.volumeEl.value) / 100;
                hub.audio.volume = v;
                this.update_volume_icon();
                this.persist_volume();
            });
        }

        // Play/Pause controls
        if (hub.btnMainPlay) hub.btnMainPlay.addEventListener('click', () => this.toggle_main_play());
        if (hub.btnPrev) hub.btnPrev.addEventListener('click', () => {
            try { console.debug('[PlaylistTransport] Prev clicked'); } catch (e) {}
            this.playAtDelta(-1);
        });
        if (hub.btnNext) hub.btnNext.addEventListener('click', () => {
            try { console.debug('[PlaylistTransport] Next clicked'); } catch (e) {}
            this.playAtDelta(1);
        });

        // Shuffle/Repeat
        if (hub.btnShuffle) hub.btnShuffle.addEventListener('click', () => {
            hub.shuffleOn = !hub.shuffleOn;
            this.persistShuffle();
            if (hub.shuffleOn && hub.playable.length) this.rebuildShuffledOrder();
            this.updateShuffleRepeatUi();
        });
        if (hub.btnRepeat) hub.btnRepeat.addEventListener('click', () => {
            if (hub.repeatMode === 'off') hub.repeatMode = 'all';
            else if (hub.repeatMode === 'all') hub.repeatMode = 'one';
            else hub.repeatMode = 'off';
            this.persistRepeat();
            this.updateShuffleRepeatUi();
        });

        // Like wiring
        this.attach_like_click_handler(hub.btnLike);
        this.attach_like_click_handler(hub.btnLikeMobile);

        // Audio element events
        hub.audio.addEventListener('play', () => {
            this.setPlayUi(true);
            this.updateMediaSessionPlaybackState();
        });
        hub.audio.addEventListener('playing', () => {
            hub._mediaDecodeRetries = 0;
        });
        hub.audio.addEventListener('pause', () => {
            if (this.stallRecoveryTimer) {
                clearTimeout(this.stallRecoveryTimer);
                this.stallRecoveryTimer = null;
            }
            this.setPlayUi(false);
            this.persistPlaybackProgress();
            this.updateMediaSessionPlaybackState();
        });
        hub.audio.addEventListener('ended', () => this.playAtDelta(1));
        hub.audio.addEventListener('seeked', () => {
            hub.seeking = false;
            this.persistPlaybackProgress();
            if (hub.lastLyricsPayload.lrc_data && hub.lyricsVisible && hub.lyricsMode === 'read' && this.lyrics) {
                this.lyrics.updateLyricsActiveLine();
            }
        });
        hub.audio.addEventListener('error', () => this.handleAudioElementError());

        hub.audio.addEventListener('stalled', () => this.scheduleStallRecoveryIfStillHung());

        document.addEventListener('visibilitychange', () => this.handleVisibilityForBackgroundPlayback());
        window.addEventListener('pageshow', (ev) => {
            if (!ev.persisted) return;
            const h = this.state.hub;
            if (h && h.audio && h.audio.src && !h.audio.ended) {
                h.audio.play().catch(() => {});
            }
            this.updateMediaSessionPlaybackState();
        });

        hub.audio.addEventListener('timeupdate', () => {
            const isUserInteracting = hub.seeking || document.activeElement === hub.seek;
            if (!isUserInteracting && hub.audio.duration) {
                hub.seek.value = String(Math.floor((hub.audio.currentTime / hub.audio.duration) * 1000));
            }
            hub.timeEl.textContent = this.fmt(hub.audio.currentTime);
            if (!hub.persistThrottle) {
                hub.persistThrottle = setTimeout(() => {
                    hub.persistThrottle = null;
                    this.persistPlaybackProgress();
                }, 2000);
            }
            if (!hub.mediaSessionPositionThrottle && navigator.mediaSession && navigator.mediaSession.setPositionState && hub.audio.duration) {
                hub.mediaSessionPositionThrottle = setTimeout(() => {
                    hub.mediaSessionPositionThrottle = null;
                    try {
                        navigator.mediaSession.setPositionState({
                            duration: hub.audio.duration,
                            playbackRate: hub.audio.playbackRate || 1,
                            position: hub.audio.currentTime || 0
                        });
                    } catch (e) {}
                }, 1000);
            }
            if (!hub.lyricsActiveLineThrottle && hub.lastLyricsPayload.lrc_data && hub.lastLyricsPayload.lrc_data.length && hub.lyricsVisible && hub.lyricsMode === 'read' && this.lyrics) {
                hub.lyricsActiveLineThrottle = setTimeout(() => {
                    hub.lyricsActiveLineThrottle = null;
                    this.lyrics.updateLyricsActiveLine();
                }, 100);
            }
        });

        hub.audio.addEventListener('durationchange', () => {
            hub.durEl.textContent = this.fmt(hub.audio.duration);
        });
        hub.audio.addEventListener('loadedmetadata', () => {
            hub.durEl.textContent = this.fmt(hub.audio.duration);
        });

        // Media Session
        this.initMediaSessionHandlers();

        hub._mediaDecodeRetries = 0;

        // Global row clicks
        document.body.addEventListener('click', (e) => {
            const playBtn = e.target.closest('.track-play');
            if (playBtn && !playBtn.disabled) {
                const row = playBtn.closest('tr.track-row');
                if (!row) return;
                const id = row.getAttribute('data-track-id');
                const src = row.getAttribute('data-play-src');
                if (!src) return;
                this.playTrackById(id);
                return;
            }
            const row = e.target.closest('tr.track-row.track-row--playable');
            if (!row) return;
            if (e.target.closest('a, button, input, select, textarea, label')) return;
            const id = row.getAttribute('data-track-id');
            const src = row.getAttribute('data-play-src');
            if (!id || !src) return;
            this.playTrackById(id);
        });

        // Header play
        document.body.addEventListener('click', (e) => {
            const headerPlayBtn = e.target.closest('#playlist-header-play');
            if (headerPlayBtn) {
                e.preventDefault();
                this.handle_playlist_header_play();
            }
        });
    }

    loadTransportPrefs() {
        const hub = this.state.hub;
        try {
            const s = localStorage.getItem(hub.LS_SHUFFLE);
            hub.shuffleOn = s === 'true';
            const r = localStorage.getItem(hub.LS_REPEAT);
            hub.repeatMode = (r === 'all' || r === 'one') ? r : 'off';
            if (hub.shuffleOn) this.restore_shuffle_order_from_storage();
            this.updateShuffleRepeatUi();
        } catch (e) {}
    }

    load_volume_pref() {
        const hub = this.state.hub;
        try {
            const s = localStorage.getItem(hub.LS_VOLUME);
            if (s != null && hub.volumeEl) {
                const n = Math.max(0, Math.min(1, parseFloat(s)));
                if (Number.isFinite(n)) {
                    hub.audio.volume = n;
                    hub.volumeEl.value = String(Math.round(n * 100));
                }
            }
        } catch (e) {}
        this.update_volume_icon();
    }

    persist_volume() {
        try { localStorage.setItem(this.state.hub.LS_VOLUME, String(this.state.hub.audio.volume)); } catch (e) {}
    }

    update_volume_icon() {
        const hub = this.state.hub;
        if (!hub.volumeIconEl) return;
        const v = hub.audio.volume;
        hub.volumeIconEl.className =
            'fa-solid text-xs shrink-0 w-4 text-center ' +
            (v === 0 ? 'fa-volume-xmark' : v < 0.45 ? 'fa-volume-low' : 'fa-volume-high');
    }

    liked_entry_key(playlist_id, track_id) {
        return String(playlist_id || '').trim() + '|' + String(track_id || '').trim();
    }

    async refresh_liked_keys_from_server() {
        const hub = this.state.hub;
        try {
            const r = await fetch('/api/liked-keys', { credentials: 'same-origin' });
            if (!r.ok) return;
            const j = await r.json();
            hub.likedKeysSet.clear();
            if (j && Array.isArray(j.keys)) {
                j.keys.forEach((k) => {
                    if (typeof k === 'string' && k) hub.likedKeysSet.add(k);
                });
            }
        } catch (e) {}
    }

    is_current_track_liked() {
        const hub = this.state.hub;
        const pid = (hub.playingPlaylistId != null && String(hub.playingPlaylistId).trim() !== '')
            ? String(hub.playingPlaylistId).trim()
            : String(hub.playlistId || '').trim();
        const tid = hub.currentTrackId != null ? String(hub.currentTrackId).trim() : '';
        if (!tid || !pid) return false;
        if (hub.LIKED_PLAYLIST_ID && pid === hub.LIKED_PLAYLIST_ID) return true;
        return hub.likedKeysSet.has(this.liked_entry_key(pid, tid));
    }

    update_like_button_ui() {
        const hub = this.state.hub;
        const pid = (hub.playingPlaylistId != null && String(hub.playingPlaylistId).trim() !== '')
            ? String(hub.playingPlaylistId).trim()
            : String(hub.playlistId || '').trim();
        const tid = hub.currentTrackId != null ? String(hub.currentTrackId).trim() : '';
        const noTrack = !tid || !pid;
        const on = !noTrack && this.is_current_track_liked();

        const apply_one = (btn, icon) => {
            if (!btn || !icon) return;
            if (noTrack) {
                btn.disabled = true;
                btn.classList.remove('player-control-btn--active');
                btn.classList.add('player-control-btn--muted');
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('title', 'Like');
                btn.setAttribute('aria-label', 'Like');
                icon.classList.remove('fa-solid');
                icon.classList.add('fa-regular');
                return;
            }
            btn.disabled = false;
            btn.setAttribute('title', on ? 'Unlike' : 'Like');
            btn.setAttribute('aria-label', on ? 'Unlike' : 'Like');
            btn.classList.toggle('player-control-btn--active', on);
            btn.classList.toggle('player-control-btn--muted', !on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            if (on) {
                icon.classList.remove('fa-regular');
                icon.classList.add('fa-solid');
            } else {
                icon.classList.remove('fa-solid');
                icon.classList.add('fa-regular');
            }
        };

        apply_one(hub.btnLike, hub.likeIconEl);
        apply_one(hub.btnLikeMobile, hub.likeIconMobileEl);
    }

    attach_like_click_handler(btn) {
        if (!btn) return;
        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            const hub = this.state.hub;
            const pid = (hub.playingPlaylistId != null && String(hub.playingPlaylistId).trim() !== '')
                ? String(hub.playingPlaylistId).trim()
                : String(hub.playlistId || '').trim();
            const tid = hub.currentTrackId != null ? String(hub.currentTrackId).trim() : '';
            if (!tid || !pid) return;
            const want = !this.is_current_track_liked();
            try {
                const r = await fetch('/api/track/like', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_playlist_id: pid,
                        source_track_id: tid,
                        liked: want,
                    }),
                });
                if (!r.ok) return;
                await this.refresh_liked_keys_from_server();
                this.update_like_button_ui();
                try {
                    const cr = await fetch('/api/playlists/catalog', { credentials: 'same-origin' });
                    if (cr.ok) {
                        const data = await cr.json();
                        if (Array.isArray(data)) window.__playlistsCatalog = data;
                    }
                } catch (e2) {}
            } catch (e) {}
        });
    }

    persistShuffle() {
        try { localStorage.setItem(this.state.hub.LS_SHUFFLE, String(this.state.hub.shuffleOn)); } catch (e) {}
    }

    persistRepeat() {
        try { localStorage.setItem(this.state.hub.LS_REPEAT, this.state.hub.repeatMode); } catch (e) {}
    }

    shuffleArrayInPlace(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    }

    persist_shuffle_order_state() {
        const hub = this.state.hub;
        try {
            if (!hub.shuffleOn || !hub.playable.length) {
                localStorage.removeItem(hub.LS_SHUFFLE_ORDER);
                return;
            }
            const pid = String(hub.playlistId || '').trim();
            if (!pid || !hub.shuffledOrder.length) return;
            localStorage.setItem(hub.LS_SHUFFLE_ORDER, JSON.stringify({
                playlist_id: pid,
                order: hub.shuffledOrder.map(function (id) { return String(id); }),
            }));
        } catch (e) {}
    }

    shuffle_order_matches_playable(saved) {
        const hub = this.state.hub;
        if (!Array.isArray(saved) || !hub.playable.length) return false;
        const want = hub.playable.map(function (t) { return String(t.id); }).sort();
        const got = saved.map(function (id) { return String(id); }).sort();
        if (want.length !== got.length) return false;
        for (let i = 0; i < want.length; i++) {
            if (want[i] !== got[i]) return false;
        }
        return true;
    }

    restore_shuffle_order_from_storage() {
        const hub = this.state.hub;
        if (!hub.shuffleOn || !hub.playable.length) return false;
        try {
            const raw = localStorage.getItem(hub.LS_SHUFFLE_ORDER);
            if (!raw) return false;
            const o = JSON.parse(raw);
            if (!o || String(o.playlist_id || '') !== String(hub.playlistId || '')) {
                try { localStorage.removeItem(hub.LS_SHUFFLE_ORDER); } catch (e2) {}
                return false;
            }
            const saved = Array.isArray(o.order) ? o.order : [];
            if (!this.shuffle_order_matches_playable(saved)) {
                try { localStorage.removeItem(hub.LS_SHUFFLE_ORDER); } catch (e2) {}
                return false;
            }
            const mapped = [];
            for (let si = 0; si < saved.length; si++) {
                const sid = String(saved[si]);
                let hit = null;
                for (let pi = 0; pi < hub.playable.length; pi++) {
                    if (String(hub.playable[pi].id) === sid) {
                        hit = hub.playable[pi].id;
                        break;
                    }
                }
                if (hit == null) return false;
                mapped.push(hit);
            }
            hub.shuffledOrder = mapped;
            return true;
        } catch (e) {
            try { localStorage.removeItem(hub.LS_SHUFFLE_ORDER); } catch (e2) {}
            return false;
        }
    }

    rebuildShuffledOrder() {
        const hub = this.state.hub;
        hub.shuffledOrder = hub.playable.map(function (t) { return t.id; });
        this.shuffleArrayInPlace(hub.shuffledOrder);
        this.persist_shuffle_order_state();
    }

    syncShuffleOrderWithPlaylist() {
        const hub = this.state.hub;
        if (!hub.shuffleOn || !hub.playable.length) return;
        const ids = new Set(hub.playable.map(function (t) { return t.id; }));
        if (hub.shuffledOrder.length !== hub.playable.length || hub.shuffledOrder.some(function (id) { return !ids.has(id); })) {
            this.rebuildShuffledOrder();
        }
    }

    updateShuffleRepeatUi() {
        const hub = this.state.hub;
        if (hub.btnShuffle) {
            hub.btnShuffle.classList.toggle('player-control-btn--active', hub.shuffleOn);
            hub.btnShuffle.classList.toggle('player-control-btn--muted', !hub.shuffleOn);
            hub.btnShuffle.setAttribute('aria-pressed', hub.shuffleOn ? 'true' : 'false');
        }
        if (hub.btnRepeat) {
            const active = hub.repeatMode !== 'off';
            hub.btnRepeat.classList.toggle('player-control-btn--active', active);
            hub.btnRepeat.classList.toggle('player-control-btn--muted', !active);
            hub.btnRepeat.setAttribute('aria-pressed', active ? 'true' : 'false');
            let title = 'Repeat: off';
            if (hub.repeatMode === 'all') title = 'Repeat: all';
            else if (hub.repeatMode === 'one') title = 'Repeat one';
            hub.btnRepeat.setAttribute('title', title);
        }
        if (hub.repeatOneBadge) {
            hub.repeatOneBadge.classList.toggle('hidden', hub.repeatMode !== 'one');
        }
        if (hub.queueVisible && this.queue) {
            this.queue.render_queue_list();
        }
    }

    seek_to_time_from_slider() {
        const hub = this.state.hub;
        if (hub.audio.duration) {
            hub.audio.currentTime = (parseFloat(hub.seek.value) / 1000) * hub.audio.duration;
        }
    }

    toggle_main_play() {
        const hub = this.state.hub;
        if (!hub.audio.src) {
            if (hub.playable.length) {
                this.playTrackById(hub.playable[0].id);
            }
            return;
        }
        if (hub.audio.paused) {
            hub.audio.play().catch(err => this.handlePlayError(err));
        } else {
            hub.audio.pause();
        }
    }

    playAtDelta(delta) {
        const hub = this.state.hub;
        try { console.debug('[Playlist] playAtDelta', { delta: delta, current: hub.currentTrackId }); } catch (e) {}
        if (hub.repeatMode === 'one' && delta > 0 && hub.currentTrackId) {
            hub.audio.currentTime = 0;
            hub.audio.play().catch(err => this.handlePlayError(err));
            return;
        }

        if (delta > 0 && hub.manual_up_next_queue.length > 0 && this.queue) {
            const nextEnt = hub.manual_up_next_queue.shift();
            this.queue.persist_manual_queue_state();
            this.queue.play_track_from_queue_entry(nextEnt);
            return;
        }

        if (!hub.playable.length) {
            if (delta > 0 && hub.manual_up_next_queue.length > 0 && this.queue) {
                const nextEnt = hub.manual_up_next_queue.shift();
                this.queue.persist_manual_queue_state();
                this.queue.play_track_from_queue_entry(nextEnt);
            }
            return;
        }

        const curInPl = hub.playable.some(function (t) { return t.id === hub.currentTrackId; });
        if (!curInPl) {
            if (delta > 0) {
                if (this.queue) {
                    this.queue.play_next_from_resume_anchor();
                }
                return;
            }
            if (delta < 0) {
                if (hub.resume_anchor_track_id && hub.playable.some(function (t) { return t.id === hub.resume_anchor_track_id; })) {
                    this.playTrackById(hub.resume_anchor_track_id);
                } else {
                    this.playAtDeltaPlaylistBody(delta);
                }
                return;
            }
        }

        this.playAtDeltaPlaylistBody(delta);
    }

    playAtDeltaPlaylistBody(delta) {
        const hub = this.state.hub;
        if (!hub.playable.length) return;

        if (hub.shuffleOn) {
            this.syncShuffleOrderWithPlaylist();
            if (!hub.shuffledOrder.length) this.rebuildShuffledOrder();
            const n = hub.shuffledOrder.length;
            if (!n) return;
            let idx = hub.currentTrackId ? hub.shuffledOrder.indexOf(hub.currentTrackId) : -1;
            if (idx < 0) idx = delta > 0 ? -1 : 0;
            let nextIdx = idx + delta;
            if (hub.repeatMode === 'all') {
                nextIdx = (nextIdx % n + n) % n;
            } else {
                if (delta > 0 && hub.repeatMode === 'off' && idx === n - 1) {
                    hub.audio.pause();
                    return;
                }
                if (nextIdx >= n) nextIdx = n - 1;
                if (nextIdx < 0) nextIdx = n - 1;
            }
            this.playTrackById(hub.shuffledOrder[nextIdx]);
            return;
        }

        let idx = hub.playable.findIndex(function (t) { return t.id === hub.currentTrackId; });
        if (idx < 0) idx = delta > 0 ? -1 : 0;

        if (delta > 0 && hub.repeatMode === 'off' && idx === hub.playable.length - 1) {
            hub.audio.pause();
            return;
        }

        let nextIdx;
        if (hub.repeatMode === 'all') {
            nextIdx = (idx + delta + hub.playable.length) % hub.playable.length;
        } else {
            nextIdx = idx + delta;
            if (nextIdx >= hub.playable.length) nextIdx = hub.playable.length - 1;
            if (nextIdx < 0) nextIdx = hub.playable.length - 1;
        }
        this.playTrackById(hub.playable[nextIdx].id);
    }

    fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    updateMediaSessionMetadata(track, artworkPlaylistIdOpt) {
        const hub = this.state.hub;
        if (!('mediaSession' in navigator)) return;
        const baseUrl = location.origin;
        const plArt = (artworkPlaylistIdOpt != null && String(artworkPlaylistIdOpt).trim() !== '')
            ? String(artworkPlaylistIdOpt).trim()
            : String(hub.playingPlaylistId || hub.playlistId || '').trim();
        const artworkUrl = track.id && plArt
            ? baseUrl + '/playlists/' + encodeURIComponent(plArt) + '/tracks/' + encodeURIComponent(track.id) + '/cover'
            : '';
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title || '',
                artist: track.artist || '',
                album: track.album || '',
                artwork: artworkUrl ? [
                    { src: artworkUrl, sizes: '96x96',  type: 'image/jpeg' },
                    { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
                    { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }
                ] : []
            });
        } catch (e) {}
        this.updateMediaSessionPlaybackState();
    }

    updateMediaSessionPlaybackState() {
        const hub = this.state.hub;
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.playbackState = hub.audio.paused ? 'paused' : 'playing';
        } catch (e) {}
        if (navigator.mediaSession.setPositionState && hub.audio.duration && !hub.audio.paused) {
            try {
                navigator.mediaSession.setPositionState({
                    duration: hub.audio.duration,
                    playbackRate: hub.audio.playbackRate || 1,
                    position: hub.audio.currentTime || 0
                });
            } catch (e) {}
        }
    }

    initMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        const actions = [
            ['play', () => {
                if (this.state.hub.currentTrackId) this.playTrackById(this.state.hub.currentTrackId);
                else if (this.state.hub.playable.length) this.playTrackById(this.state.hub.playable[0].id);
            }],
            ['pause', () => this.state.hub.audio.pause()],
            ['previoustrack', () => this.playAtDelta(-1)],
            ['nexttrack', () => this.playAtDelta(1)],
            ['seekbackward', (d) => {
                this.state.hub.audio.currentTime = Math.max(0, this.state.hub.audio.currentTime - (d.seekOffset || 10));
                this.updateMediaSessionPlaybackState();
            }],
            ['seekforward', (d) => {
                this.state.hub.audio.currentTime = Math.min(this.state.hub.audio.duration || 0, this.state.hub.audio.currentTime + (d.seekOffset || 10));
                this.updateMediaSessionPlaybackState();
            }],
            ['seekto', (d) => {
                this.state.hub.audio.currentTime = d.seekTime;
                this.updateMediaSessionPlaybackState();
            }]
        ];
        actions.forEach((pair) => {
            try { navigator.mediaSession.setActionHandler(pair[0], pair[1]); } catch (e) {}
        });
    }

    get_header_play_icon() {
        const headerPlayButton = document.getElementById('playlist-header-play');
        return headerPlayButton ? headerPlayButton.querySelector('i') : null;
    }

    is_header_playlist_active() {
        const hub = this.state.hub;
        const currentPlaylistTracks = Array.isArray(hub.tracks) ? hub.tracks : [];
        return !!(
            hub.playingPlaylistId &&
            hub.playlistId &&
            String(hub.playingPlaylistId) === String(hub.playlistId) &&
            hub.currentTrackId &&
            currentPlaylistTracks.some((t) => t.id === hub.currentTrackId)
        );
    }

    /** Pick a random playable track id from the currently viewed playlist. */
    random_playable_track_id() {
        const hub = this.state.hub;
        if (!hub.playable.length) return null;
        const i = Math.floor(Math.random() * hub.playable.length);
        return hub.playable[i].id;
    }

    handle_playlist_header_play() {
        const hub = this.state.hub;
        if (!hub.playable || !hub.playable.length) return;
        if (this.is_header_playlist_active()) {
            if (hub.audio.paused) {
                this.playTrackById(hub.currentTrackId);
            } else {
                hub.audio.pause();
            }
            return;
        }
        const trackId = hub.shuffleOn ? this.random_playable_track_id() : (hub.playable[0] && hub.playable[0].id);
        if (!trackId) return;
        this.playTrackById(trackId);
    }

    persistPlaybackProgress() {
        const hub = this.state.hub;
        try {
            if (!hub.currentTrackId || !hub.playingPlaylistId) return;
            localStorage.setItem(hub.LS_LAST_PL, hub.playingPlaylistId);
            localStorage.setItem(hub.LS_LAST_TR, hub.currentTrackId);
            localStorage.setItem(hub.LS_LAST_POS, String(Math.max(0, hub.audio.currentTime || 0)));
        } catch (e) {}
    }

    rowForTrack(id) {
        return document.querySelector('tr.track-row[data-track-id="' + CSS.escape(id) + '"]');
    }

    scrollTrackIntoView(trackId) {
        if (!trackId) return false;
        const row = this.rowForTrack(trackId);
        if (!row) return false;

        const getScrollContainer = (el) => {
            let n = el.parentElement;
            while (n) {
                const style = window.getComputedStyle(n);
                const overY = style.overflowY;
                if ((overY === 'auto' || overY === 'scroll') && n.scrollHeight > n.clientHeight) {
                    return n;
                }
                n = n.parentElement;
            }
            return null;
        };

        const container = getScrollContainer(row);
        if (container) {
            const rowRect = row.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const desiredTopGap = 48;
            const targetTop = container.scrollTop + rowRect.top - containerRect.top - desiredTopGap;
            const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
            container.scrollTop = Math.min(maxTop, Math.max(0, targetTop));
            return true;
        }

        row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        return true;
    }

    updatePlayingRow() {
        document.querySelectorAll('tr.track-row-playing').forEach(r => r.classList.remove('track-row-playing'));
        if (this.state.hub.currentTrackId) {
            const r = this.rowForTrack(this.state.hub.currentTrackId);
            if (r) r.classList.add('track-row-playing');
        }
    }

    setPlayUi(playing) {
        const hub = this.state.hub;
        document.querySelectorAll('.track-play i').forEach(icon => {
            icon.classList.remove('fa-pause');
            icon.classList.remove('pl-0.5');
            icon.classList.add('fa-play', 'pl-0.5');
        });

        const headerPlayIcon = this.get_header_play_icon();
        const isActivePlaylistPlaying = !!(playing && this.is_header_playlist_active());
        if (headerPlayIcon) {
            headerPlayIcon.classList.remove('fa-play', 'fa-pause', 'pl-0.5');
            if (isActivePlaylistPlaying) {
                headerPlayIcon.classList.add('fa-pause', 'pl-1');
            } else {
                headerPlayIcon.classList.add('fa-play', 'pl-1');
            }
        }

        if (playing) {
            hub.iconMainPlay.classList.remove('fa-play', 'pl-0.5', 'sm:pl-1', 'pl-1');
            hub.iconMainPlay.classList.add('fa-pause');
        } else {
            hub.iconMainPlay.classList.remove('fa-pause');
            hub.iconMainPlay.classList.add('fa-play', 'pl-0.5', 'sm:pl-1');
        }
        if (playing && hub.currentTrackId) {
            const r = this.rowForTrack(hub.currentTrackId);
            const icon = r && r.querySelector('.track-play i');
            if (icon) {
                icon.classList.remove('fa-play', 'pl-0.5');
                icon.classList.add('fa-pause', 'pl-0.5');
            }
        }
        const streamBadge = hub.streamBadgeEl;
        if (streamBadge) {
            const isStream = playing && hub.currentTrackId && hub.currentTrackId !== hub.resolveCurrentPlaySrc();
            if (isStream) {
                streamBadge.classList.remove('hidden');
                streamBadge.style.opacity = '1';
                streamBadge.title = 'Stream';
            } else {
                streamBadge.classList.add('hidden');
                streamBadge.style.opacity = '0';
            }
        }
        this.updateMediaSessionPlaybackState();
    }

    handlePlayError(err) {
        if (err && err.name === 'AbortError') return;
        this.setPlayUi(false);
    }

    _resetLikeButtons(hub) {
        if (hub.btnLike) {
            hub.btnLike.disabled = false;
            hub.btnLike.classList.add('player-control-btn--muted');
            hub.btnLike.classList.remove('player-control-btn--active');
            const icon = hub.likeIconEl;
            if (icon) {
                icon.classList.remove('fa-solid');
                icon.classList.add('fa-regular');
            }
        }
        if (hub.btnLikeMobile) {
            hub.btnLikeMobile.disabled = false;
            const iconMobile = hub.likeIconMobileEl;
            if (iconMobile) {
                iconMobile.classList.remove('fa-solid');
                iconMobile.classList.add('fa-regular');
            }
        }
        const lyricsBtn = document.getElementById('btn-lyrics-mobile');
        const lyricsDesktopBtn = document.getElementById('btn-lyrics-desktop');
        if (lyricsBtn) {
            lyricsBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
        if (lyricsDesktopBtn) {
            lyricsDesktopBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    playTrackById(trackId) {
        const hub = this.state.hub;
        if (!hub.audio) return;
        if (hub.currentTrackId === trackId && hub.audio.src) {
            if (!hub.playingPlaylistId) hub.playingPlaylistId = hub.playlistId;
            if (hub.audio.paused) {
                hub.audio.play().catch(err => this.handlePlayError(err));
            } else {
                hub.audio.pause();
            }
            this.update_like_button_ui();
            return;
        }

        let t = hub.tracks.find(x => x.id === trackId);
        const fromViewed = !!t;
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find(x => x.id === trackId);
        }
        if (!t || !t.play_src) return;

        if (hub.pendingRestoreOnMeta) {
            hub.audio.removeEventListener('loadedmetadata', hub.pendingRestoreOnMeta);
            hub.pendingRestoreOnMeta = null;
        }

        if (fromViewed) {
            const playingPidChanged = String(hub.playingPlaylistId || '') !== String(hub.playlistId || '');
            hub.playingPlaylistId = hub.playlistId;
            hub.playingTracks = hub.tracks.slice();
            hub.playingPlayable = hub.playable.slice();
            if (playingPidChanged && hub.shuffleOn && hub.playable.length) {
                this.rebuildShuffledOrder();
            }
        }
        const sourcePid = fromViewed ? hub.playlistId : (hub.playingPlaylistId || hub.playlistId);
        hub.currentTrackId = trackId;
        hub.lastPlayedTrackSnapshot = {
            id: trackId,
            title: t.title || '',
            artist: t.artist || '',
            album: t.album != null ? String(t.album) : '',
            url: (t.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || '').trim(),
            source_playlist_id: sourcePid,
        };
        hub.audio.src = t.play_src;
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist;
        if (this.lyrics) this.lyrics.loadCover(trackId);
        this.updatePlayingRow();
        try {
            hub.audio.play().catch(err => this.handlePlayError(err));
        } catch (e) {
            this.handlePlayError(e);
        }
        if (hub.lyricsVisible && this.lyrics) this.lyrics.fetchLyrics(true);
        this.updateMediaSessionMetadata(t);
        this.update_like_button_ui();
        if (hub.queueVisible && this.queue) this.queue.render_queue_list();
    }

    resolveCurrentPlaySrc() {
        const hub = this.state.hub;
        if (!hub || !hub.currentTrackId) return '';
        let t = hub.tracks && hub.tracks.find((x) => x.id === hub.currentTrackId);
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find((x) => x.id === hub.currentTrackId);
        }
        return t && t.play_src ? String(t.play_src).trim() : '';
    }

    trySoftReloadCurrentAudioSource() {
        const hub = this.state.hub;
        const src = this.resolveCurrentPlaySrc();
        if (!src || !hub.currentTrackId) return false;
        hub._mediaDecodeRetries = (hub._mediaDecodeRetries || 0) + 1;
        if (hub._mediaDecodeRetries > 2) {
            hub._mediaDecodeRetries = 0;
            return false;
        }
        const resumeTime = Math.max(0, hub.audio.currentTime || 0);
        hub.audio.pause();
        hub.audio.removeAttribute('src');
        hub.audio.load();
        hub.audio.src = src;
        const onReady = () => {
            if (resumeTime > 0.25 && hub.audio.duration && resumeTime < hub.audio.duration - 0.35) {
                try {
                    hub.audio.currentTime = resumeTime;
                } catch (e) { /* ignore */ }
            }
            hub.audio.play().catch(() => {});
            this.setPlayUi(true);
            this.updateMediaSessionPlaybackState();
        };
        if (hub.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            onReady();
        } else {
            hub.audio.addEventListener('canplay', onReady, { once: true });
        }
        return true;
    }

    handleAudioElementError() {
        const hub = this.state.hub;
        const err = hub.audio.error;
        const unsupported = err && (err.code === 4 || (typeof MediaError !== 'undefined' && err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED));
        if (unsupported) {
            this.setPlayUi(false);
            if (hub.playable.length > 1) this.playAtDelta(1);
            return;
        }
        this.setPlayUi(false);
        if (this.trySoftReloadCurrentAudioSource()) return;
        if (hub.playable.length > 1) this.playAtDelta(1);
    }

    scheduleStallRecoveryIfStillHung() {
        const hub = this.state.hub;
        if (this.stallRecoveryTimer) clearTimeout(this.stallRecoveryTimer);
        this.stallRecoveryTimer = setTimeout(() => {
            this.stallRecoveryTimer = null;
            if (!hub.audio || hub.audio.paused || hub.audio.ended) return;
            if (hub.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
            if (!this.resolveCurrentPlaySrc()) return;
            hub._mediaDecodeRetries = Math.max(hub._mediaDecodeRetries || 0, 1);
            this.trySoftReloadCurrentAudioSource();
        }, 6500);
    }

    handleVisibilityForBackgroundPlayback() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return;
        if (document.visibilityState === 'hidden') {
            hub._spolocalWasPlayingWhileHidden = !hub.audio.paused && !!hub.audio.src && !hub.audio.ended;
            return;
        }
        if (hub._spolocalWasPlayingWhileHidden) {
            hub._spolocalWasPlayingWhileHidden = false;
            if (hub.audio.src && !hub.audio.ended) {
                hub.audio.play().catch(() => {});
            }
        }
        if (hub.currentTrackId) {
            this.updateMediaSessionPlaybackState();
        }
    }

}

