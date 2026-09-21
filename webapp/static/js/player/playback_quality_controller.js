/**
 * Playback-source resolution: quality variants, on-demand downloads, stream
 * preparation, audio-source reloads, and loudness gain application.
 * Holds no direct DOM event wiring - the transport controller drives it.
 */
export class PlaybackQualityController {
    /**
     * @param {import('./player_state.js').PlaylistPlayerState} state
     * @param {import('./transport_controller.js').PlaylistTransportController} transport
     */
    constructor(state, transport) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        this.transport = transport;
        /** @type {import('./lyrics_controller.js').PlaylistLyricsController|null} */
        this.lyrics = null;
        this._audioSrcGen = 0;
    }

    setLyricsRef(lyrics) {
        this.lyrics = lyrics;
    }

    async request_quality_download(playlist_id, track_id, quality) {
        const pid = String(playlist_id || '').trim();
        const tid = String(track_id || '').trim();
        const q = quality || (window.SpolocalQualityPrefs ? String(window.SpolocalQualityPrefs.playbackKbps()) : '192');
        if (!pid || !tid) return false;
        try {
            const fd = new FormData();
            fd.append('quality', q);
            const resp = await fetch('/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(tid) + '/download', {
                method: 'POST',
                body: fd,
                credentials: 'same-origin',
                redirect: 'manual',
            });
            return resp.ok || resp.status === 303;
        } catch (e) {
            return false;
        } finally {
            if (typeof window.watchSpolocalDownloads === 'function') window.watchSpolocalDownloads();
        }
    }

    findTrackInHub(track_id) {
        const hub = this.state.hub;
        const tid = String(track_id || '');
        let t = hub.tracks && hub.tracks.find((x) => x.id === tid);
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find((x) => x.id === tid);
        }
        return t || null;
    }

    patchTrackInHub(track_payload) {
        if (!track_payload || !track_payload.id) return;
        const hub = this.state.hub;
        const patch = (list) => {
            if (!Array.isArray(list)) return;
            const idx = list.findIndex((x) => x.id === track_payload.id);
            if (idx >= 0) list[idx] = Object.assign({}, list[idx], track_payload);
        };
        patch(hub.tracks);
        patch(hub.playingTracks);
        const prefs = window.SpolocalQualityPrefs;
        hub.playable = (hub.tracks || []).filter((t) => {
            const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
            return !!src;
        });
        if (Array.isArray(hub.libraryPool)) {
            const tid = String(track_payload.id || '');
            const idx = hub.libraryPool.findIndex((e) => String(e.track_id) === tid);
            if (idx >= 0) {
                hub.libraryPool[idx] = Object.assign({}, hub.libraryPool[idx], {
                    play_src: track_payload.play_src,
                    play_variants: track_payload.play_variants,
                    title: track_payload.title,
                    artist: track_payload.artist,
                    album: track_payload.album,
                    loudness_gain_db: track_payload.loudness_gain_db,
                });
            }
        }
    }

    async fetchTrackPayload(playlist_id, track_id) {
        const pid = String(playlist_id || '').trim();
        const tid = String(track_id || '').trim();
        if (!pid || !tid) return null;
        try {
            const resp = await fetch('/api/playlist/state?playlist_id=' + encodeURIComponent(pid), {
                headers: { Accept: 'application/json' },
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            const rows = Array.isArray(data.tracks_payload) ? data.tracks_payload : [];
            return rows.find((x) => x.id === tid) || null;
        } catch (e) {
            return null;
        }
    }

    async waitForPlaybackVariant(playlist_id, track_id, kbps, play_gen) {
        const prefs = window.SpolocalQualityPrefs;
        const q = prefs ? String(prefs.clampKbps(kbps)) : String(kbps);
        const deadline = Date.now() + 300000;
        let saw_job = false;
        while (Date.now() < deadline) {
            if (play_gen != null && play_gen !== this.transport._playGeneration) return false;
            const row = await this.fetchTrackPayload(playlist_id, track_id);
            if (row && prefs && prefs.hasVariant(row, q)) {
                this.patchTrackInHub(row);
                return true;
            }
            try {
                const prog = await fetch('/api/progress').then((r) => r.json());
                const jobs = prog && prog.jobs ? prog.jobs : {};
                if (jobs[track_id]) saw_job = true;
                else if (saw_job) {
                    const row2 = await this.fetchTrackPayload(playlist_id, track_id);
                    if (row2 && prefs && prefs.hasVariant(row2, q)) {
                        this.patchTrackInHub(row2);
                        return true;
                    }
                    return false;
                }
            } catch (e) {}
            await new Promise((resolve) => setTimeout(resolve, 750));
        }
        return false;
    }

    async ensurePlaybackVariantReady(track, playlist_id, track_id, playback_q, play_gen, allow_stream) {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs || prefs.hasVariant(track, playback_q)) return true;
        const stream_src = prefs.streamPlaySrc(track);
        if (allow_stream !== false && stream_src) {
            void this.request_quality_download(playlist_id, track_id, playback_q);
            return true;
        }
        const pid = String(playlist_id || '').trim();
        if (!pid) return false;
        const hub = this.state.hub;
        const artist_label = track.artist || '';
        if (hub.subEl) {
            hub.subEl.textContent = 'Downloading ' + prefs.formatLabel(playback_q) + '…';
        }
        this.transport.setPlayUi(false);
        if (hub.audio && !hub.audio.paused) hub.audio.pause();
        await this.request_quality_download(pid, track_id, playback_q);
        if (play_gen != null && play_gen !== this.transport._playGeneration) return false;
        const ok = await this.waitForPlaybackVariant(pid, track_id, playback_q, play_gen);
        if (play_gen != null && play_gen !== this.transport._playGeneration) return false;
        if (!ok && hub.subEl) hub.subEl.textContent = artist_label;
        return ok;
    }

    async onPlaybackQualityChanged() {
        const hub = this.state.hub;
        if (this.lyrics) {
            this.lyrics.reload_stream_video_if_loaded();
            this.lyrics.loadCover(hub.currentTrackId, hub.playingPlaylistId || hub.playlistId);
        }
        if (!hub.currentTrackId) return;
        const prefs = window.SpolocalQualityPrefs;
        const playback_q = prefs ? String(prefs.playbackKbps()) : '192';
        const pid = hub.playingPlaylistId || hub.playlistId;
        if (!prefs || !pid) return;

        const row = await this.fetchTrackPayload(pid, hub.currentTrackId);
        if (row) this.patchTrackInHub(row);
        let t = this.findTrackInHub(hub.currentTrackId) || row;
        if (!t) return;

        if (!prefs.hasVariant(t, playback_q)) {
            const ok = await this.ensurePlaybackVariantReady(t, pid, hub.currentTrackId, playback_q, this.transport._playGeneration, false);
            if (!ok) return;
            const row2 = await this.fetchTrackPayload(pid, hub.currentTrackId);
            if (row2) this.patchTrackInHub(row2);
            t = this.findTrackInHub(hub.currentTrackId) || t;
        }

        const desired = prefs.resolveExactPlaySrc(t, playback_q);
        if (!desired) return;
        const src = desired + (desired.indexOf('?') >= 0 ? '&' : '?') + 'kbps=' + encodeURIComponent(playback_q);
        this.replace_audio_src(src, Math.max(0, hub.audio.currentTime || 0));
        void this.apply_track_loudness(t, pid);
    }

    replace_audio_src(src, resume_time) {
        const hub = this.state.hub;
        if (!hub.audio || !src) return;
        if (window.SpolocalMse) window.SpolocalMse.stop();
        this._audioSrcGen = (this._audioSrcGen || 0) + 1;
        const gen = this._audioSrcGen;
        hub.audio.pause();
        hub.audio.removeAttribute('src');
        try { hub.audio.load(); } catch (e) {}
        hub.audio.src = src;
        const want = src.split('?')[0];
        const on_ready = () => {
            if (gen !== this._audioSrcGen) return;
            const cur = String(hub.audio.currentSrc || '');
            if (want && cur && cur.indexOf(want) === -1) return;
            if (resume_time > 0.25 && hub.audio.duration && resume_time < hub.audio.duration - 0.35) {
                try { hub.audio.currentTime = resume_time; } catch (e) { /* ignore */ }
            }
            hub.audio.play().catch(() => {});
            this.transport.setPlayUi(true);
            this.transport.mediaSession.updateMediaSessionPlaybackState();
        };
        hub.audio.addEventListener('canplay', on_ready, { once: true });
    }

    resolveCurrentPlaySrc() {
        const hub = this.state.hub;
        if (!hub || !hub.currentTrackId) return '';
        let t = hub.tracks && hub.tracks.find((x) => x.id === hub.currentTrackId);
        if (!t && hub.playingTracks) {
            t = hub.playingTracks.find((x) => x.id === hub.currentTrackId);
        }
        const prefs = window.SpolocalQualityPrefs;
        const q = prefs ? prefs.playbackKbps() : 192;
        return prefs ? prefs.resolvePlaybackPlaySrc(t, q) : (t && t.play_src ? String(t.play_src).trim() : '');
    }

    trySoftReloadCurrentAudioSource() {
        const hub = this.state.hub;
        if (this.transport.isSearchStreamPlayback() || this.transport.isStreamingPlayback()) return false;
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
        const t = this.findTrackInHub(hub.currentTrackId);
        const pid = hub.playingPlaylistId || hub.playlistId;
        if (t && pid) void this.apply_track_loudness(t, pid);
        const onReady = () => {
            if (resumeTime > 0.25 && hub.audio.duration && resumeTime < hub.audio.duration - 0.35) {
                try {
                    hub.audio.currentTime = resumeTime;
                } catch (e) { /* ignore */ }
            }
            hub.audio.play().catch(() => {});
            this.transport.setPlayUi(true);
            this.transport.mediaSession.updateMediaSessionPlaybackState();
        };
        if (hub.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            onReady();
        } else {
            hub.audio.addEventListener('canplay', onReady, { once: true });
        }
        return true;
    }

    async apply_track_loudness(track, playlist_id) {
        const hub = this.state.hub;
        const norm = hub.audioNormalization;
        if (!norm) return;
        const src = hub.audio ? String(hub.audio.currentSrc || hub.audio.src || '') : '';
        const prefs = window.SpolocalQualityPrefs;
        const is_local = !!(prefs && prefs.normalizeMediaPath(src));
        if (!is_local) {
            norm.set_track_gain_db(0);
            return;
        }
        norm.wire();
        let db = track && track.loudness_gain_db;
        const pid = String(playlist_id || '').trim();
        const tid = track && track.id ? String(track.id).trim() : '';
        if (db == null && pid && tid) {
            try {
                const r = await fetch(
                    '/api/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(tid) + '/loudness-gain',
                    { credentials: 'same-origin' },
                );
                if (r.ok) {
                    const j = await r.json();
                    db = j.loudness_gain_db;
                    if (db != null) {
                        track.loudness_gain_db = db;
                        this.patchTrackInHub({ id: tid, loudness_gain_db: db });
                    } else if (j.pending) {
                        this.poll_track_loudness(pid, tid, track, norm);
                    }
                }
            } catch (e) {}
            // Out-of-order guard: only apply if this track is still the one playing.
            if (!(hub.currentTrackId === tid)) return;
        }
        norm.set_track_gain_db(db != null ? db : 0);
    }

    isCurrentTrackFor(tid) {
        const hub = this.state.hub;
        return !!(hub && hub.currentTrackId === tid);
    }

    async poll_track_loudness(pid, tid, track, norm) {
        // Background analysis takes a few seconds; pick up the cached gain once ready.
        let attempts = 0;
        while (attempts < 10 && this.isCurrentTrackFor(tid)) {
            await new Promise((res) => setTimeout(res, 2000));
            try {
                const r = await fetch(
                    '/api/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(tid) + '/loudness-gain',
                    { credentials: 'same-origin' },
                );
                if (!r.ok) return;
                const j = await r.json();
                if (j.loudness_gain_db != null) {
                    track.loudness_gain_db = j.loudness_gain_db;
                    this.patchTrackInHub({ id: tid, loudness_gain_db: j.loudness_gain_db });
                    if (this.isCurrentTrackFor(tid)) {
                        norm.set_track_gain_db(j.loudness_gain_db);
                    }
                    return;
                }
            } catch (e) {
                return;
            }
            attempts += 1;
        }
    }
}