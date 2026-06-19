/**
 * Controller for the manual/visual queue shown in the sidebar.
 * Responsibilities:
 * - Render queue items and handle remove/reorder actions
 * - Persist/restore manual queue state to localStorage
 */
export class PlaylistQueueController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state, transport) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./transport_controller.js').PlaylistTransportController} */
        this.transport = transport;
        /** @type {import('./lyrics_controller.js').PlaylistLyricsController|null} */
        this.lyrics = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(lyrics) {
        this.lyrics = lyrics;
    }

    /** Wire queue-related events and restore persisted queue. */
    init() {
        this.restore_manual_queue_from_storage();
        if (this.state.hub.queueVisible) this.render_queue_list();
        this._wireQueueToggleButtons();
        this._wireQueueCloseButton();
        this._listenForceCloseQueue();
    }

    _wireQueueToggleButtons() {
        const hub = this.state.hub;
        const toggleHandler = () => this.toggleQueue();
        if (hub.btnQueueMobile && !hub.btnQueueMobile.dataset.queueBound) {
            hub.btnQueueMobile.dataset.queueBound = '1';
            hub.btnQueueMobile.addEventListener('click', toggleHandler);
        }
        if (hub.btnQueueDesktop && !hub.btnQueueDesktop.dataset.queueBound) {
            hub.btnQueueDesktop.dataset.queueBound = '1';
            hub.btnQueueDesktop.addEventListener('click', toggleHandler);
        }
    }

    _wireQueueCloseButton() {
        const hub = this.state.hub;
        if (hub.queueClose && !hub.queueClose.dataset.queueCloseBound) {
            hub.queueClose.dataset.queueCloseBound = '1';
            hub.queueClose.addEventListener('click', () => {
                if (hub.queueVisible) this.toggleQueue();
            });
        }
    }

    _listenForceCloseQueue() {
        window.addEventListener('spolocal:force-close-queue', () => {
            const hub = this.state.hub;
            if (hub.queueVisible) {
                hub.queueVisible = false;
                this._applyQueueVisibility();
            }
        });
        // Close queue when clicking outside the queue panel
        if (!this._outsideClickBound) {
            this._outsideClickBound = true;
            document.addEventListener('click', (e) => {
                const hub = this.state.hub;
                if (!hub) return;
                if (!hub.queueVisible) return;
                const panel = hub.queuePanel;
                const btnMobile = hub.btnQueueMobile;
                const btnDesktop = hub.btnQueueDesktop;
                const clickedInsidePanel = panel && panel.contains(e.target);
                const clickedToggle = (btnMobile && btnMobile.contains(e.target)) || (btnDesktop && btnDesktop.contains(e.target));
                if (!clickedInsidePanel && !clickedToggle) {
                    hub.queueVisible = false;
                    this._applyQueueVisibility();
                }
            }, true);
        }
    }

    toggleQueue() {
        const hub = this.state.hub;
        hub.queueVisible = !hub.queueVisible;
        this._applyQueueVisibility();
        if (hub.queueVisible) this.render_queue_list();
    }

    _applyQueueVisibility() {
        const hub = this.state.hub;
        if (hub.queuePanel) {
            hub.queuePanel.classList.toggle('hidden', !hub.queueVisible);
            hub.queuePanel.setAttribute('aria-hidden', String(!hub.queueVisible));
        }
        document.body.classList.toggle('mobile-queue-open', hub.queueVisible);
        this.sync_queue_button_ui();
    }

    sync_queue_button_ui() {
        const hub = this.state.hub;
        const updateBtn = (btn) => {
            if (!btn) return;
            btn.setAttribute('aria-pressed', String(hub.queueVisible));
            btn.classList.toggle('player-control-btn--active', hub.queueVisible);
        };
        updateBtn(hub.btnQueueMobile);
        updateBtn(hub.btnQueueDesktop);
    }

    normalize_queue_entry(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const play_src = (entry.play_src || '').trim();
        const track_id = String(entry.track_id || '').trim();
        const source_playlist_id = String(entry.source_playlist_id || '').trim();
        if (!play_src || !track_id || !source_playlist_id) return null;
        return {
            source_playlist_id: source_playlist_id,
            track_id: track_id,
            play_src: play_src,
            title: entry.title != null ? String(entry.title) : '',
            artist: entry.artist != null ? String(entry.artist) : '',
            album: entry.album != null ? String(entry.album) : '',
            youtube_video_id: (entry.youtube_video_id || '').trim(),
            url: (entry.url || '').trim(),
        };
    }

    persist_manual_queue_state() {
        const hub = this.state.hub;
        try {
            const pid = String(hub.playlistId || '').trim();
            if (!pid) return;
            localStorage.setItem(hub.LS_MANUAL_QUEUE, JSON.stringify({
                context_playlist_id: pid,
                items: hub.manual_up_next_queue.map(function (x) {
                    return {
                        source_playlist_id: x.source_playlist_id,
                        track_id: x.track_id,
                        play_src: x.play_src,
                        title: x.title,
                        artist: x.artist,
                        album: x.album,
                        youtube_video_id: x.youtube_video_id,
                        url: x.url,
                    };
                }),
                resume_anchor_track_id: hub.resume_anchor_track_id || null,
            }));
        } catch (e) {}
    }

    restore_manual_queue_from_storage() {
        const hub = this.state.hub;
        try {
            const raw = localStorage.getItem(hub.LS_MANUAL_QUEUE);
            if (!raw) return;
            const o = JSON.parse(raw);
            if (!o || String(o.context_playlist_id || '') !== String(hub.playlistId || '')) {
                try { localStorage.removeItem(hub.LS_MANUAL_QUEUE); } catch (e2) {}
                return;
            }
            hub.manual_up_next_queue.length = 0;
            if (Array.isArray(o.items)) {
                o.items.forEach((item) => {
                    const e = this.normalize_queue_entry(item);
                    if (e) hub.manual_up_next_queue.push(e);
                });
            }
            const ra = o.resume_anchor_track_id;
            hub.resume_anchor_track_id = (ra && String(ra).trim()) ? String(ra).trim() : null;
        } catch (e) {
            try { localStorage.removeItem(hub.LS_MANUAL_QUEUE); } catch (e2) {}
        }
    }

    clear_manual_play_next_queue() {
        const hub = this.state.hub;
        hub.manual_up_next_queue.length = 0;
        hub.resume_anchor_track_id = null;
        this.persist_manual_queue_state();
    }

    enqueue_manual_play_next(entry) {
        const hub = this.state.hub;
        const e = this.normalize_queue_entry(entry);
        if (!e) return false;
        if (!hub.manual_up_next_queue.length) {
            if (hub.currentTrackId && hub.playable.some(function (t) { return t.id === hub.currentTrackId; })) {
                hub.resume_anchor_track_id = hub.currentTrackId;
            }
        }
        hub.manual_up_next_queue.push(e);
        this.persist_manual_queue_state();
        if (hub.queueVisible) this.render_queue_list();
        return true;
    }

    play_track_from_queue_entry(entry) {
        const hub = this.state.hub;
        const e = this.normalize_queue_entry(entry);
        if (!e) return;
        if (hub.pendingRestoreOnMeta) {
            hub.audio.removeEventListener('loadedmetadata', hub.pendingRestoreOnMeta);
            hub.pendingRestoreOnMeta = null;
        }
        hub.playingPlaylistId = e.source_playlist_id;
        if (String(e.source_playlist_id) === String(hub.playlistId)) {
            hub.playingTracks = hub.tracks.slice();
            hub.playingPlayable = hub.playable.slice();
        }
        hub.currentTrackId = e.track_id;
        hub.lastPlayedTrackSnapshot = {
            id: e.track_id,
            title: e.title || '',
            artist: e.artist || '',
            album: e.album != null ? String(e.album) : '',
            url: e.url,
            youtube_video_id: e.youtube_video_id,
            source_playlist_id: e.source_playlist_id,
        };
        hub.audio.src = e.play_src;
        hub.titleEl.textContent = e.title || '—';
        hub.subEl.textContent = e.artist || '—';
        if (this.lyrics) this.lyrics.loadCover(e.track_id, e.source_playlist_id);
        if (this.transport) this.transport.updatePlayingRow();
        hub.audio.play().catch(err => { if (this.transport) this.transport.handlePlayError(err); });
        if (hub.lyricsVisible && this.lyrics) this.lyrics.fetchLyrics(true);
        if (this.transport) {
            this.transport.updateMediaSessionMetadata({
                id: e.track_id,
                title: e.title,
                artist: e.artist,
                album: e.album,
            }, e.source_playlist_id);
        }
        if (this.transport) this.transport.update_like_button_ui();
        if (hub.queueVisible) this.render_queue_list();
    }

    play_next_from_resume_anchor() {
        const hub = this.state.hub;
        if (!hub.playable.length) {
            hub.audio.pause();
            return;
        }
        const anchor = (hub.resume_anchor_track_id && hub.playable.some(function (t) { return t.id === hub.resume_anchor_track_id; }))
            ? hub.resume_anchor_track_id
            : (hub.playable[0] && hub.playable[0].id);
        if (!anchor) {
            hub.audio.pause();
            return;
        }
        hub.resume_anchor_track_id = null;

        if (hub.shuffleOn) {
            if (this.transport) {
                this.transport.syncShuffleOrderWithPlaylist();
                if (!hub.shuffledOrder.length) this.transport.rebuildShuffledOrder();
            }
            const ord = hub.shuffledOrder;
            const n = ord.length;
            if (!n) return;
            let idx = ord.indexOf(anchor);
            if (idx < 0) idx = 0;
            let nextIdx = idx + 1;
            if (hub.repeatMode === 'off' && nextIdx >= n) {
                hub.audio.pause();
                return;
            }
            if (hub.repeatMode === 'all') {
                nextIdx = (nextIdx % n + n) % n;
            } else if (nextIdx >= n) {
                nextIdx = n - 1;
            }
            if (this.transport) this.transport.playTrackById(ord[nextIdx]);
            return;
        }

        let idx = hub.playable.findIndex(function (t) { return t.id === anchor; });
        if (idx < 0) idx = 0;
        let nextIdx = idx + 1;
        if (hub.repeatMode === 'off' && nextIdx >= hub.playable.length) {
            hub.audio.pause();
            return;
        }
        if (hub.repeatMode === 'all') {
            nextIdx = (nextIdx % hub.playable.length + hub.playable.length) % hub.playable.length;
        } else if (nextIdx >= hub.playable.length) {
            nextIdx = hub.playable.length - 1;
        }
        if (this.transport) this.transport.playTrackById(hub.playable[nextIdx].id);
    }

    get_queue_track_ids() {
        const hub = this.state.hub;
        const viewingPlaying = String(hub.playingPlaylistId || '') === String(hub.playlistId || '');
        const playable = (!viewingPlaying && hub.playingPlayable && hub.playingPlayable.length)
            ? hub.playingPlayable
            : hub.playable;
        if (!playable.length) return [];
        if (hub.shuffleOn) {
            const ids = new Set(playable.map(function (t) { return t.id; }));
            const shuffledOrderMatches = hub.shuffledOrder.length === playable.length
                && hub.shuffledOrder.every(function (id) { return ids.has(id); });
            if (viewingPlaying && this.transport && !shuffledOrderMatches) {
                this.transport.syncShuffleOrderWithPlaylist();
                if (!hub.shuffledOrder.length) this.transport.rebuildShuffledOrder();
            }
            const order = (shuffledOrderMatches || viewingPlaying)
                ? hub.shuffledOrder.slice()
                : playable.map(function (t) { return t.id; });
            if (!order.length) return [];
            if (!hub.currentTrackId) return order.slice();
            const i = order.indexOf(hub.currentTrackId);
            if (i < 0) return order.slice();
            if (hub.repeatMode === 'off') {
                return order.slice(i);
            }
            return order.slice(i).concat(order.slice(0, i));
        }
        const order = playable.map(function (t) { return t.id; });
        if (!hub.currentTrackId) return order.slice();
        const i = order.indexOf(hub.currentTrackId);
        if (i < 0) return order.slice();
        if (hub.repeatMode === 'off') {
            return order.slice(i);
        }
        return order.slice(i).concat(order.slice(0, i));
    }

    render_queue_list() {
        const hub = this.state.hub;
        if (!hub.queueList) return;
        hub.queueList.innerHTML = '';
        let any = false;

        const append_thumb_meta = (row, coverPid, trackId, title, artist, isCurrent) => {
            if (isCurrent) {
                row.classList.add('queue-row--current');
            }
            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'queue-thumb-wrap';
            const qImg = document.createElement('img');
            qImg.className = 'queue-thumb';
            qImg.alt = '';
            qImg.loading = 'lazy';
            qImg.decoding = 'async';
            qImg.src = '/playlists/' + encodeURIComponent(coverPid) + '/tracks/' + encodeURIComponent(trackId) + '/cover';
            qImg.addEventListener('error', function () {
                this.onerror = null;
                this.style.opacity = '0';
            });
            thumbWrap.appendChild(qImg);
            row.appendChild(thumbWrap);
            const meta = document.createElement('div');
            meta.className = 'min-w-0 flex-1';
            const titleDiv = document.createElement('div');
            titleDiv.className = 'queue-row-title truncate text-sm font-medium';
            titleDiv.textContent = title || '—';
            const artistDiv = document.createElement('div');
            artistDiv.className = 'truncate text-xs text-[#B3B3B3]';
            artistDiv.textContent = artist || '';
            meta.appendChild(titleDiv);
            meta.appendChild(artistDiv);
            row.appendChild(meta);
        };

        const playingTracks = (hub.playingTracks && hub.playingTracks.length) ? hub.playingTracks : hub.tracks;
        const currentSourcePid = String(hub.playingPlaylistId || hub.playlistId || '');

        if (hub.currentTrackId) {
            const tloc = playingTracks.find(function (x) { return x.id === hub.currentTrackId; });
            if (tloc && tloc.play_src) {
                any = true;
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'queue-row w-full text-left';
                append_thumb_meta(row, currentSourcePid, hub.currentTrackId, tloc.title, tloc.artist, true);
                row.addEventListener('click', () => {
                    if (this.transport) this.transport.playTrackById(hub.currentTrackId);
                });
                hub.queueList.appendChild(row);
            } else {
                const snap = hub.lastPlayedTrackSnapshot;
                const cpid = String((snap && snap.source_playlist_id) || hub.playingPlaylistId || hub.playlistId || '');
                if (snap && snap.id === hub.currentTrackId && cpid) {
                    any = true;
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'queue-row w-full text-left';
                    append_thumb_meta(row, cpid, hub.currentTrackId, snap.title, snap.artist, true);
                    row.addEventListener('click', () => {
                        if (hub.audio.paused) {
                            hub.audio.play().catch(err => { if (this.transport) this.transport.handlePlayError(err); });
                        } else {
                            hub.audio.pause();
                        }
                    });
                    hub.queueList.appendChild(row);
                }
            }
        }

        hub.manual_up_next_queue.forEach((entry) => {
            any = true;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'queue-row w-full text-left';
            append_thumb_meta(row, entry.source_playlist_id, entry.track_id, entry.title, entry.artist, false);
            row.addEventListener('click', () => {
                const before = hub.manual_up_next_queue.length;
                while (hub.manual_up_next_queue.length && hub.manual_up_next_queue[0] !== entry) {
                    hub.manual_up_next_queue.shift();
                }
                if (hub.manual_up_next_queue.length < before) {
                    this.persist_manual_queue_state();
                }
                if (hub.manual_up_next_queue.length && hub.manual_up_next_queue[0] === entry) {
                    const ent = hub.manual_up_next_queue.shift();
                    this.persist_manual_queue_state();
                    this.play_track_from_queue_entry(ent);
                }
            });
            hub.queueList.appendChild(row);
        });

        const tailIds = this.get_queue_track_ids();
        let skipFirstIfCurrent = true;
        tailIds.forEach((tid) => {
            if (skipFirstIfCurrent && tid === hub.currentTrackId) {
                skipFirstIfCurrent = false;
                return;
            }
            const t = playingTracks.find(function (x) { return x.id === tid; });
            if (!t) return;
            any = true;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'queue-row w-full text-left';
            append_thumb_meta(row, currentSourcePid, tid, t.title, t.artist, false);
            row.addEventListener('click', () => {
                if (this.transport) this.transport.playTrackById(tid);
            });
            hub.queueList.appendChild(row);
        });

        if (!any) {
            const p = document.createElement('p');
            p.className = 'text-sm text-[#727272] text-center py-8 px-2';
            p.textContent = 'No playable tracks in this playlist.';
            hub.queueList.appendChild(p);
        }
    }

}

