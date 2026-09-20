/**
 * Controller owning all transport concerns for the playlist page.
 */
import { PlaylistHomeViewController } from '../playlist/home_view_controller.js';

export class PlaylistTransportController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./queue_controller.js').PlaylistQueueController|null} */
        this.queue = null;
        /** @type {import('./lyrics_controller.js').PlaylistLyricsController|null} */
        this.lyrics = null;
        /** @type {import('../playlist/home_view_controller.js').PlaylistHomeViewController|null} */
        this.home = null;
        /** @type {import('./like_controller.js').PlaylistLikeController|null} */
        this.likes = null;
        /** @type {import('./shuffle_controller.js').PlaylistShuffleController|null} */
        this.shuffle = null;
        /** @type {import('./media_session_controller.js').PlaylistMediaSessionController|null} */
        this.mediaSession = null;
        /** @type {import('./playback_quality_controller.js').PlaybackQualityController|null} */
        this.quality = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.stallRecoveryTimer = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(queue, lyrics, home, likes, shuffle, mediaSession, quality) {
        this.queue = queue;
        this.lyrics = lyrics;
        this.home = home;
        this.likes = likes;
        this.shuffle = shuffle;
        this.mediaSession = mediaSession;
        this.quality = quality;
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

        document.addEventListener('keydown', (e) => this.on_space_play_pause(e));

        // Seek wiring
        if (hub.seek) {
            hub.seek.addEventListener('pointerdown', () => {
                hub.seeking = true;
            });
            hub.seek.addEventListener('input', () => {
                hub.seeking = true;
                if (hub.audio.duration) {
                    hub.timeEl.textContent = this.fmt(Math.floor((parseFloat(hub.seek.value) / 1000) * hub.audio.duration));
                }
                this.sync_seek_buffer_ui();
                if (this.lyrics) this.lyrics.sync_stream_video_clock(true);
            });
            hub.seek.addEventListener('change', () => {
                this.seek_to_time_from_slider();
                if (this.lyrics) this.lyrics.sync_stream_video_clock(true);
            });
        }

        // Volume wiring
        if (hub.volumeEl) {
            hub.volumeEl.addEventListener('input', () => {
                const v = parseFloat(hub.volumeEl.value) / 100;
                const norm = hub.audioNormalization;
                if (norm) norm.set_user_volume(v);
                else hub.audio.volume = v;
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
            this.shuffle.persistShuffle();
            if (hub.shuffleOn && hub.playable.length) this.shuffle.rebuildShuffledOrder();
            this.shuffle.updateShuffleRepeatUi();
        });
        if (hub.btnRepeat) hub.btnRepeat.addEventListener('click', () => {
            if (hub.repeatMode === 'off') hub.repeatMode = 'all';
            else if (hub.repeatMode === 'all') hub.repeatMode = 'one';
            else hub.repeatMode = 'off';
            this.shuffle.persistRepeat();
            this.shuffle.updateShuffleRepeatUi();
        });

        // Like wiring
        this.likes.attach_like_click_handler(hub.btnLike);
        this.likes.attach_like_click_handler(hub.btnLikeMobile);

        // Audio element events
        hub.audio.addEventListener('play', () => {
            this.setPlayUi(true);
            this.mediaSession.updateMediaSessionPlaybackState();
        });
        hub.audio.addEventListener('playing', (event) => {
            hub._mediaDecodeRetries = 0;
            this.record_playback_start(event);
        });
        hub.audio.addEventListener('pause', () => {
            if (this.stallRecoveryTimer) {
                clearTimeout(this.stallRecoveryTimer);
                this.stallRecoveryTimer = null;
            }
            this.setPlayUi(false);
            this.mediaSession.persistPlaybackProgress();
            this.mediaSession.updateMediaSessionPlaybackState();
        });
        hub.audio.addEventListener('ended', () => {
            if (window.SpolocalMse && window.SpolocalMse.is_active()) return;
            if (this.isSearchStreamPlayback()) {
                this.advance_search_stream();
                return;
            }
            this.playAtDelta(1);
        });
        hub.audio.addEventListener('seeked', () => {
            hub.seeking = false;
            this.mediaSession.persistPlaybackProgress();
            if (hub.lastLyricsPayload.lrc_data && hub.lyricsVisible && hub.lyricsMode === 'read' && this.lyrics) {
                this.lyrics.updateLyricsActiveLine();
            }
        });
        hub.audio.addEventListener('error', (event) => this.handleAudioElementError(event));

        hub.audio.addEventListener('loadstart', (event) => {
            hub._audioLoadStartTimestamp = event.timeStamp;
            this.release_stream_cache_for_src();
        });

        hub.audio.addEventListener('stalled', () => this.scheduleStallRecoveryIfStillHung());

        document.addEventListener('visibilitychange', () => this.handleVisibilityForBackgroundPlayback());
        window.addEventListener('pageshow', (ev) => {
            if (!ev.persisted) return;
            const h = this.state.hub;
            if (h && h.audio && h.audio.src && !h.audio.ended) {
                h.audio.play().catch(() => {});
            }
            this.mediaSession.updateMediaSessionPlaybackState();
        });

        hub.audio.addEventListener('timeupdate', () => {
            const isUserInteracting = hub.seeking;
            if (!isUserInteracting && hub.audio.duration) {
                hub.seek.value = String(Math.floor((hub.audio.currentTime / hub.audio.duration) * 1000));
            }
            hub.timeEl.textContent = this.fmt(hub.audio.currentTime);
            if (!hub.persistThrottle) {
                hub.persistThrottle = setTimeout(() => {
                    hub.persistThrottle = null;
                    this.mediaSession.persistPlaybackProgress();
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
            this.sync_seek_buffer_ui();
            if (this.lyrics) this.lyrics.sync_stream_video_clock();
        });

        hub.audio.addEventListener('progress', () => this.sync_seek_buffer_ui());
        hub.audio.addEventListener('loadedmetadata', () => this.sync_seek_buffer_ui());
        hub.audio.addEventListener('emptied', () => this.sync_seek_buffer_ui());

        hub.audio.addEventListener('durationchange', () => {
            hub.durEl.textContent = this.fmt(hub.audio.duration);
        });
        hub.audio.addEventListener('loadedmetadata', () => {
            hub.durEl.textContent = this.fmt(hub.audio.duration);
        });

        // Media Session
        this.mediaSession.initMediaSessionHandlers();

        hub._mediaDecodeRetries = 0;

        // Global row clicks
        document.body.addEventListener('click', (e) => {
            const homeRow = e.target.closest('.home-song-row');
            if (homeRow && !e.target.closest('.track-row-like')) {
                const tid = homeRow.getAttribute('data-track-id');
                const pid = homeRow.getAttribute('data-playlist-id');
                const src = homeRow.getAttribute('data-play-src');
                if (tid && pid && src) {
                    this.playLibraryEntry({
                        playlist_id: pid,
                        track_id: tid,
                        play_src: src,
                        title: homeRow.getAttribute('data-title') || '',
                        artist: homeRow.getAttribute('data-artist') || '',
                    });
                }
                return;
            }
            const playBtn = e.target.closest('.track-play');
            if (playBtn && !playBtn.disabled) {
                const row = playBtn.closest('tr.track-row');
                if (!row) return;
                const id = row.getAttribute('data-track-id');
                const src = row.getAttribute('data-play-src');
                if (!id || !src) return;
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
            if (hub.shuffleOn) this.shuffle.restore_shuffle_order_from_storage();
            this.shuffle.updateShuffleRepeatUi();
        } catch (e) {}
    }

    load_volume_pref() {
        const hub = this.state.hub;
        const norm = hub.audioNormalization;
        try {
            const s = localStorage.getItem(hub.LS_VOLUME);
            if (s != null && hub.volumeEl) {
                const n = Math.max(0, Math.min(1, parseFloat(s)));
                if (Number.isFinite(n)) {
                    if (norm) norm.set_user_volume(n);
                    else hub.audio.volume = n;
                    hub.volumeEl.value = String(Math.round(n * 100));
                }
            }
        } catch (e) {}
        this.update_volume_icon();
    }

    persist_volume() {
        const hub = this.state.hub;
        const norm = hub.audioNormalization;
        const v = norm ? norm.get_user_volume() : hub.audio.volume;
        try { localStorage.setItem(hub.LS_VOLUME, String(v)); } catch (e) {}
    }

    update_volume_icon() {
        const hub = this.state.hub;
        if (!hub.volumeIconEl) return;
        const norm = hub.audioNormalization;
        const v = norm ? norm.get_user_volume() : hub.audio.volume;
        hub.volumeIconEl.className =
            'fa-solid text-xs shrink-0 w-4 text-center ' +
            (v === 0 ? 'fa-volume-xmark' : v < 0.45 ? 'fa-volume-low' : 'fa-volume-high');
    }

    library_pool_playable() {
        const hub = this.state.hub;
        const prefs = window.SpolocalQualityPrefs;
        return (Array.isArray(hub.libraryPool) ? hub.libraryPool : []).filter((t) => {
            if (!t) return false;
            const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
            return !!src;
        });
    }

    pick_random_library_entry(exclude_track_id) {
        const pool = this.library_pool_playable();
        if (!pool.length) return null;
        if (pool.length === 1) return pool[0];
        let tries = 0;
        while (tries < 8) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (!exclude_track_id || String(pick.track_id) !== String(exclude_track_id)) return pick;
            tries++;
        }
        return pool[Math.floor(Math.random() * pool.length)];
    }

    play_random_from_library() {
        const entry = this.pick_random_library_entry(null);
        if (entry) void this.playLibraryEntry(entry);
    }

    async playLibraryEntry(entry) {
        const hub = this.state.hub;
        if (!hub.audio || !entry) return;
        const trackId = String(entry.track_id || '');
        const playlistId = String(entry.playlist_id || '');
        if (!trackId || !playlistId) return;
        const prefs = window.SpolocalQualityPrefs;

        if (hub.currentTrackId === trackId && hub.playingPlaylistId === playlistId && hub.audio.src) {
            if (hub.audio.paused) hub.audio.play().catch((err) => this.handlePlayError(err));
            else hub.audio.pause();
            this.likes.update_like_button_ui();
            return;
        }

        let packed = Object.assign({}, entry);
        let preliminarySrc = prefs ? prefs.resolvePlaySrc(packed) : (packed.play_src || '');
        if (!preliminarySrc || (prefs && !prefs.normalizeMediaPath(preliminarySrc))) {
            const row = await this.quality.fetchTrackPayload(playlistId, trackId);
            if (row) {
                this.quality.patchTrackInHub(row);
                packed = Object.assign({}, packed, row, { playlist_id: playlistId, track_id: trackId });
                preliminarySrc = prefs ? prefs.resolvePlaySrc(packed) : (packed.play_src || '');
            }
        }
        if (!preliminarySrc) return;

        this.leave_search_stream();

        this._playGeneration = (this._playGeneration || 0) + 1;
        const playGen = this._playGeneration;
        const playback_q = prefs ? String(prefs.playbackKbps()) : '192';

        let t = {
            id: trackId,
            title: packed.title || '',
            artist: packed.artist || '',
            album: packed.album || '',
            play_src: packed.play_src,
            play_variants: packed.play_variants || {},
            url: packed.url || '',
            youtube_video_id: packed.youtube_video_id || '',
        };

        hub.titleEl.textContent = t.title || '—';
        hub.subEl.textContent = t.artist || '—';

        if (prefs && !prefs.hasVariant(t, playback_q)) {
            const ready = await this.quality.ensurePlaybackVariantReady(t, playlistId, trackId, playback_q, playGen, prefs.streamFitsTier(playback_q));
            if (playGen !== this._playGeneration) return;
            const row = await this.quality.fetchTrackPayload(playlistId, trackId);
            if (row) {
                this.quality.patchTrackInHub(row);
                t = Object.assign({}, t, row, { id: trackId });
            }
            // Not ready and nothing to play at this tier: stop rather than quietly
            // falling back to the stream, which is best-quality audio.
            if (!ready && !prefs.hasVariant(t, playback_q) && !prefs.streamFitsTier(playback_q)) return;
        }

        const playSrc = prefs
            ? (prefs.resolveExactPlaySrc(t, playback_q) || prefs.resolvePlaybackPlaySrc(t, playback_q))
            : (t.play_src || preliminarySrc);
        if (!playSrc) return;

        if (hub.pendingRestoreOnMeta) {
            hub.audio.removeEventListener('loadedmetadata', hub.pendingRestoreOnMeta);
            hub.pendingRestoreOnMeta = null;
        }

        hub.playingPlaylistId = playlistId;
        hub.playingTracks = [{
            id: trackId,
            title: t.title || entry.title || '',
            artist: t.artist || entry.artist || '',
            album: t.album || entry.album || '',
            play_src: playSrc,
            play_variants: t.play_variants || entry.play_variants || {},
            url: t.url || entry.url || '',
            youtube_video_id: t.youtube_video_id || entry.youtube_video_id || '',
        }];
        hub.playingPlayable = hub.playingTracks.slice();
        hub.currentTrackId = trackId;
        hub.lastPlayedTrackSnapshot = {
            id: trackId,
            title: t.title || entry.title || '',
            artist: t.artist || entry.artist || '',
            album: (t.album != null ? String(t.album) : entry.album) || '',
            url: (t.url || entry.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || entry.youtube_video_id || '').trim(),
            source_playlist_id: playlistId,
        };
        hub.audio.src = playSrc;
        hub.titleEl.textContent = t.title || entry.title || '—';
        hub.subEl.textContent = t.artist || entry.artist || '—';
        void this.quality.apply_track_loudness(t, playlistId);
        if (this.lyrics) this.lyrics.loadCover(trackId, playlistId);
        this.updatePlayingRow();
        hub.audio.play().catch((err) => this.handlePlayError(err));
        if (hub.lyricsVisible && this.lyrics) this.lyrics.fetchLyrics(true);
        this.mediaSession.updateMediaSessionMetadata(hub.playingTracks[0], playlistId);
        this.likes.update_like_button_ui();
        if (hub.queueVisible && this.queue) this.queue.render_queue_list();
    }

    playAtDeltaRandomMode(delta) {
        const hub = this.state.hub;
        if (hub.repeatMode === 'one' && delta > 0 && hub.currentTrackId) {
            hub.audio.currentTime = 0;
            hub.audio.play().catch((err) => this.handlePlayError(err));
            return true;
        }
        if (delta <= 0) {
            if (hub.currentTrackId) {
                hub.audio.currentTime = 0;
                hub.audio.play().catch((err) => this.handlePlayError(err));
            }
            return true;
        }
        const next = this.pick_random_library_entry(hub.repeatMode === 'off' ? hub.currentTrackId : null);
        if (!next) {
            hub.audio.pause();
            return true;
        }
        void this.playLibraryEntry(next);
        return true;
    }

    sync_seek_buffer_ui() {
        const hub = this.state.hub;
        const host = hub.seekLoadedEl;
        const audio = hub.audio;
        if (!host || !audio) return;
        const duration = audio.duration;
        let played_pct = 0;
        if (duration && isFinite(duration) && duration > 0) {
            played_pct = Math.min(100, Math.max(0, (audio.currentTime / duration) * 100));
        } else if (hub.seek) {
            played_pct = Math.min(100, Math.max(0, parseFloat(hub.seek.value) / 10));
        }
        let n = 0;
        if (duration && isFinite(duration) && duration > 0) {
            try {
                n = audio.buffered.length;
            } catch (e) {
                n = 0;
            }
        }
        while (host.children.length > n + 1) {
            host.removeChild(host.lastChild);
        }
        while (host.children.length < n + 1) {
            host.appendChild(document.createElement('div'));
        }
        for (let i = 0; i < n; i++) {
            const el = host.children[i];
            el.className = 'player-seek-buf';
            const start = (audio.buffered.start(i) / duration) * 100;
            const end = (audio.buffered.end(i) / duration) * 100;
            el.style.left = start + '%';
            el.style.width = Math.max(0, end - start) + '%';
        }
        const played = host.children[n];
        played.className = 'player-seek-played';
        played.style.left = '0';
        played.style.width = played_pct + '%';
    }

    seek_audio_to(t) {
        const hub = this.state.hub;
        if (window.SpolocalMse && window.SpolocalMse.is_active()) {
            window.SpolocalMse.seek_to(t);
            return;
        }
        if (hub.audio) hub.audio.currentTime = t;
    }

    seek_to_time_from_slider() {
        const hub = this.state.hub;
        const dur = hub.audio && hub.audio.duration;
        if (!dur) return;
        const t = (parseFloat(hub.seek.value) / 1000) * dur;
        if (window.SpolocalMse && window.SpolocalMse.is_active()) {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                hub.seeking = false;
            };
            window.SpolocalMse.seek_to(t, finish);
            setTimeout(finish, 2500);
        } else {
            hub.audio.currentTime = t;
        }
        if (this.lyrics) this.lyrics.sync_stream_video_clock(true);
    }

    space_is_typing_target(el) {
        if (!el || el === document.body || el === document.documentElement) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (el.isContentEditable) return true;
        if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) return true;
        return false;
    }

    on_space_play_pause(e) {
        if (e.key !== ' ' && e.key !== 'Spacebar' && e.code !== 'Space') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.repeat) return;
        if (this.space_is_typing_target(e.target)) return;
        e.preventDefault();
        this.toggle_main_play();
    }

    toggle_main_play() {
        const hub = this.state.hub;
        if (this.isSearchStreamPlayback() && hub.searchStreamHit) {
            if (window.SpolocalMse && window.SpolocalMse.is_active()) {
                if (hub.audio.paused) hub.audio.play().catch(err => this.handlePlayError(err));
                else hub.audio.pause();
                return;
            }
            const vid = String(hub.searchStreamHit.video_id || '').trim();
            const want = typeof window.spolocalStreamSrc === 'function'
                ? window.spolocalStreamSrc(vid)
                : '/api/stream?vid=' + encodeURIComponent(vid);
            const cur = String(hub.audio.currentSrc || hub.audio.src || '');
            if (vid && want && cur.indexOf('vid=' + vid) === -1) {
                hub.audio.src = want;
            }
            if (hub.audio.paused) {
                hub.audio.play().catch(err => this.handlePlayError(err));
            } else {
                hub.audio.pause();
            }
            return;
        }
        if (!hub.audio.src) {
            if (hub.randomMode && this.library_pool_playable().length) {
                this.play_random_from_library();
                return;
            }
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
        if (this.isSearchStreamPlayback()) {
            if (delta < 0 && hub.audio) {
                try { hub.audio.currentTime = 0; } catch (e) {}
                hub.audio.play().catch(err => this.handlePlayError(err));
            } else {
                this.setPlayUi(false);
            }
            return;
        }
        if (hub.randomMode && this.library_pool_playable().length) {
            if (this.playAtDeltaRandomMode(delta)) return;
        }
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
            this.shuffle.syncShuffleOrderWithPlaylist();
            if (!hub.shuffledOrder.length) this.shuffle.rebuildShuffledOrder();
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
        const hub = this.state.hub;
        let row = hub.currentTrackId ? this.rowForTrack(hub.currentTrackId) : null;
        if (!row && hub.searchStreamActive) {
            const vid = String(
                (hub.searchStreamHit && hub.searchStreamHit.video_id)
                || this.stream_vid_from_src(hub.audio && (hub.audio.currentSrc || hub.audio.src))
                || ''
            ).trim();
            if (vid) {
                row = document.querySelector(
                    '#playlist-recommendations-table tr.track-row[data-youtube-video-id="' + CSS.escape(vid) + '"], #song-mix-table tr.track-row[data-youtube-video-id="' + CSS.escape(vid) + '"]'
                );
            }
        }
        if (row) row.classList.add('track-row-playing');
    }

    stream_vid_from_src(src) {
        try {
            const u = new URL(String(src || ''), window.location.href);
            if (!u.pathname.startsWith('/api/stream')) return '';
            return String(u.searchParams.get('vid') || '').trim();
        } catch (e) {
            return '';
        }
    }

    release_stream_cache_for_src() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return;
        const next = this.stream_vid_from_src(hub.audio.src || hub.audio.currentSrc || '');
        const prev = String(hub._active_stream_vid || '').trim();
        if (prev && prev !== next) {
            fetch('/api/stream/release?vid=' + encodeURIComponent(prev), {
                method: 'POST',
                credentials: 'same-origin',
                keepalive: true,
            }).catch(() => {});
        }
        hub._active_stream_vid = next;
    }

    isSearchStreamPlayback() {
        const hub = this.state.hub;
        return !!(hub && hub.searchStreamActive);
    }

    advance_search_stream() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return;
        if (hub.repeatMode === 'one' && hub.searchStreamHit) {
            hub.audio.currentTime = 0;
            hub.audio.play().catch(() => {});
            return;
        }
        const table = document.getElementById('song-mix-table');
        if (!table) {
            this.setPlayUi(false);
            return;
        }
        const current_vid = String((hub.searchStreamHit && hub.searchStreamHit.video_id) || '').trim();
        const rows = Array.from(table.querySelectorAll('tr.track-row[data-youtube-video-id]'));
        if (!rows.length) {
            this.setPlayUi(false);
            return;
        }
        let next_row = null;
        if (hub.shuffleOn) {
            next_row = rows[Math.floor(Math.random() * rows.length)];
        } else {
            const idx = rows.findIndex((r) => r.getAttribute('data-youtube-video-id') === current_vid);
            if (idx < 0) {
                next_row = rows[0];
            } else if (idx + 1 < rows.length) {
                next_row = rows[idx + 1];
            } else if (hub.repeatMode === 'all') {
                next_row = rows[0];
            }
        }
        if (!next_row) {
            this.setPlayUi(false);
            return;
        }
        const vid = String(next_row.getAttribute('data-youtube-video-id') || '').trim();
        const hit = {
            video_id: vid,
            title: next_row.getAttribute('data-title') || '',
            artist: next_row.getAttribute('data-artist') || '',
            channel: next_row.getAttribute('data-artist') || '',
        };
        const btn = next_row.querySelector('.track-play');
        if (typeof window.playPreview === 'function') {
            window.playPreview(hit, btn);
        } else {
            this.setPlayUi(false);
        }
    }

    isStreamingPlayback() {
        const hub = this.state.hub;
        if (!hub || !hub.audio) return false;
        const raw_src = String(hub.audio.currentSrc || hub.audio.src || '').trim();
        if (!raw_src) return false;
        const prefs = window.SpolocalQualityPrefs;
        if (prefs && prefs.normalizeMediaPath(raw_src)) return false;
        try {
            const u = new URL(raw_src, window.location.href);
            if (u.pathname.startsWith('/media/')) return false;
            if (u.pathname.startsWith('/api/preview')) return true;
            if (u.pathname.startsWith('/api/stream')) return true;
            return u.origin !== window.location.origin;
        } catch (e) {
            return false;
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
        this.updatePlayingRow();
        if (playing) {
            const rec_icon = document.querySelector('tr.track-row-playing .track-play i');
            if (rec_icon) {
                rec_icon.classList.remove('fa-play', 'fa-stop', 'pl-0.5');
                rec_icon.classList.add('fa-pause', 'pl-0.5');
            }
        }
        const streamBadge = hub.streamBadgeEl;
        if (streamBadge) {
            const isStream = playing && this.isStreamingPlayback();
            if (isStream) {
                streamBadge.classList.remove('hidden');
                streamBadge.style.opacity = '1';
                streamBadge.title = 'Stream';
            } else {
                streamBadge.classList.add('hidden');
                streamBadge.style.opacity = '0';
            }
        }
        this.mediaSession.updateMediaSessionPlaybackState();
    }

    handlePlayError(err) {
        if (err && err.name === 'AbortError') return;
        this.setPlayUi(false);
    }

    record_playback_start(event) {
        const hub = this.state.hub;
        if (!hub || this.isSearchStreamPlayback()) return;
        if (
            event &&
            Number.isFinite(event.timeStamp) &&
            Number.isFinite(hub._audioLoadStartTimestamp) &&
            event.timeStamp < hub._audioLoadStartTimestamp
        ) {
            return;
        }
        const playlist_id = String(hub.playingPlaylistId || hub.playlistId || '').trim();
        const track_id = String(hub.currentTrackId || '').trim();
        if (!playlist_id || !track_id) return;

        const key = playlist_id + '|' + track_id;
        if (hub._playCountedKey === key) return;
        hub._playCountedKey = key;
        PlaylistHomeViewController.record_track_play(playlist_id, track_id);
        if (hub.isHomeView && this.home) this.home.render();
    }

    leave_search_stream() {
        const hub = this.state.hub;
        if (!hub.searchStreamActive && !hub.searchStreamHit) return;
        if (typeof window.nextSpolocalStreamLoadGen === 'function') {
            window.nextSpolocalStreamLoadGen();
        } else {
            hub._streamLoadGen = (hub._streamLoadGen || 0) + 1;
        }
        hub.searchStreamActive = false;
        hub.searchStreamHit = null;
        if (typeof window.resetSpolocalSearchCards === 'function') {
            window.resetSpolocalSearchCards();
        }
    }

    async playTrackById(trackId) {
        const hub = this.state.hub;
        if (!hub.audio) return;
        this.leave_search_stream();

        let t = hub.tracks.find(x => x.id === trackId);
        const fromViewed = !!t;
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find(x => x.id === trackId);
        }
        if (!t) return;

        const prefs = window.SpolocalQualityPrefs;
        const playback_q = prefs ? String(prefs.playbackKbps()) : '192';
        const desired_src = prefs ? prefs.resolvePlaybackPlaySrc(t, playback_q) : (t.play_src || '');
        const current_path = prefs ? prefs.normalizeMediaPath(hub.audio.currentSrc || hub.audio.src) : '';
        const desired_path = prefs ? prefs.normalizeMediaPath(desired_src) : '';

        if (hub.currentTrackId === trackId && hub.audio.src) {
            if (!desired_src || (current_path && desired_path && current_path === desired_path)) {
                if (!hub.playingPlaylistId) hub.playingPlaylistId = hub.playlistId;
                if (hub.audio.paused) {
                    hub.audio.play().catch(err => this.handlePlayError(err));
                } else {
                    hub.audio.pause();
                }
                this.likes.update_like_button_ui();
                return;
            }
        }

        this._playGeneration = (this._playGeneration || 0) + 1;
        const playGen = this._playGeneration;

        if (fromViewed) {
            const playingPidChanged = String(hub.playingPlaylistId || '') !== String(hub.playlistId || '');
            hub.playingPlaylistId = hub.playlistId;
            hub.playingTracks = hub.tracks.slice();
            hub.playingPlayable = hub.playable.slice();
            if (playingPidChanged && hub.shuffleOn && hub.playable.length) {
                this.shuffle.rebuildShuffledOrder();
            }
        }
        const sourcePid = fromViewed ? hub.playlistId : (hub.playingPlaylistId || hub.playlistId);
        const sourcePidFinal = sourcePid;
        hub.currentTrackId = trackId;
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist || '';
        this.updatePlayingRow();

        if (prefs && !prefs.hasVariant(t, playback_q) && sourcePid) {
            const ready = await this.quality.ensurePlaybackVariantReady(t, sourcePid, trackId, playback_q, playGen, prefs.streamFitsTier(playback_q));
            if (playGen !== this._playGeneration) return;
            if (!ready) return;
            t = this.quality.findTrackInHub(trackId) || t;
        }

        const playSrc = prefs ? prefs.resolvePlaybackPlaySrc(t, playback_q) : (t.play_src || '');
        if (!playSrc) return;

        if (hub.pendingRestoreOnMeta) {
            hub.audio.removeEventListener('loadedmetadata', hub.pendingRestoreOnMeta);
            hub.pendingRestoreOnMeta = null;
        }

        hub.lastPlayedTrackSnapshot = {
            id: trackId,
            title: t.title || '',
            artist: t.artist || '',
            album: t.album != null ? String(t.album) : '',
            url: (t.url || '').trim(),
            youtube_video_id: (t.youtube_video_id || '').trim(),
            source_playlist_id: sourcePidFinal,
        };
        hub.audio.src = playSrc;
        hub.titleEl.textContent = t.title;
        hub.subEl.textContent = t.artist;
        void this.quality.apply_track_loudness(t, sourcePidFinal);
        if (this.lyrics) this.lyrics.loadCover(trackId);
        this.updatePlayingRow();
        try {
            hub.audio.play().catch(err => this.handlePlayError(err));
        } catch (e) {
            this.handlePlayError(e);
        }
        if (hub.lyricsVisible && this.lyrics) this.lyrics.fetchLyrics(true);
        this.mediaSession.updateMediaSessionMetadata(t);
        this.likes.update_like_button_ui();
        if (hub.queueVisible && this.queue) this.queue.render_queue_list();
    }

    resolveCurrentPlaySrc() {
        return this.quality.resolveCurrentPlaySrc();
    }

    handleAudioElementError(event) {
        const hub = this.state.hub;
        if (
            event &&
            Number.isFinite(event.timeStamp) &&
            Number.isFinite(hub._audioLoadStartTimestamp) &&
            event.timeStamp < hub._audioLoadStartTimestamp
        ) {
            return;
        }
        if (this.isSearchStreamPlayback()) {
            this.setPlayUi(false);
            return;
        }
        this.setPlayUi(false);
        if (hub.subEl && hub.currentTrackId) {
            hub.subEl.textContent = 'Playback unavailable. Check the connection or certificate.';
        }
    }

    scheduleStallRecoveryIfStillHung() {
        const hub = this.state.hub;
        if (this.isSearchStreamPlayback() || this.isStreamingPlayback()) return;
        if (this.stallRecoveryTimer) clearTimeout(this.stallRecoveryTimer);
        this.stallRecoveryTimer = setTimeout(() => {
            this.stallRecoveryTimer = null;
            if (!hub.audio || hub.audio.paused || hub.audio.ended) return;
            if (hub.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
            if (!this.quality.resolveCurrentPlaySrc()) return;
            hub._mediaDecodeRetries = Math.max(hub._mediaDecodeRetries || 0, 1);
            this.quality.trySoftReloadCurrentAudioSource();
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
            this.mediaSession.updateMediaSessionPlaybackState();
        }
    }

}

