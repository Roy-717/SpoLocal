/**
 * Like/track-liking state and UI (Liked Songs integration).
 * Reads/writes ``hub.likedKeysSet`` and the like buttons in the player bar
 * and track rows. No playback logic lives here.
 */
export class PlaylistLikeController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
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

    is_track_liked(playlist_id, track_id) {
        const hub = this.state.hub;
        const pid = String(playlist_id || '').trim();
        const tid = String(track_id || '').trim();
        if (!tid || !pid) return false;
        if (hub.LIKED_PLAYLIST_ID && pid === hub.LIKED_PLAYLIST_ID) return true;
        return hub.likedKeysSet.has(this.liked_entry_key(pid, tid));
    }

    update_track_row_like_buttons() {
        document.querySelectorAll('.track-row-like').forEach((btn) => {
            const pid = btn.getAttribute('data-playlist-id') || btn.dataset.playlistId || '';
            const tid = btn.getAttribute('data-track-id') || btn.dataset.trackId || '';
            const on = this.is_track_liked(pid, tid);
            const icon = btn.querySelector('i');
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.classList.toggle('track-row-like--on', on);
            if (icon) {
                icon.classList.toggle('fa-solid', on);
                icon.classList.toggle('fa-regular', !on);
            }
        });
    }

    bind_track_row_like_buttons() {
        document.querySelectorAll('.track-row-like').forEach((btn) => {
            if (btn.dataset.likeBound) return;
            btn.dataset.likeBound = '1';
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const pid = btn.getAttribute('data-playlist-id') || btn.dataset.playlistId || '';
                const tid = btn.getAttribute('data-track-id') || btn.dataset.trackId || '';
                if (!pid || !tid) return;
                const want = !this.is_track_liked(pid, tid);
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
                    this.update_track_row_like_buttons();
                } catch (err) {}
            });
        });
        this.update_track_row_like_buttons();
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
}