/**
 * Modal to edit track title, artist, and album.
 */
export class TrackEditController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
        this.transport = null;
        this.queue = null;
        this.contextMenu = null;
        this._playlist_id = '';
        this._track_id = '';
    }

    setCrossRefs(transport, queue, contextMenu) {
        this.transport = transport;
        this.queue = queue;
        this.contextMenu = contextMenu;
    }

    init() {
        const hub = this.state.hub;
        hub.trackEditModal = document.getElementById('track-edit-modal');
        hub.trackEditBackdrop = document.getElementById('track-edit-modal-backdrop');
        hub.trackEditCloseX = document.getElementById('track-edit-close-x');
        hub.trackEditCancel = document.getElementById('track-edit-cancel');
        hub.trackEditSave = document.getElementById('track-edit-save');
        hub.trackEditTitleInput = document.getElementById('track-edit-title-input');
        hub.trackEditArtistInput = document.getElementById('track-edit-artist-input');
        hub.trackEditAlbumInput = document.getElementById('track-edit-album-input');
        hub.trackEditError = document.getElementById('track-edit-error');

        if (hub.trackEditBackdrop) {
            hub.trackEditBackdrop.addEventListener('click', () => this.close());
        }
        if (hub.trackEditCloseX) {
            hub.trackEditCloseX.addEventListener('click', () => this.close());
        }
        if (hub.trackEditCancel) {
            hub.trackEditCancel.addEventListener('click', () => this.close());
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!hub.trackEditModal || hub.trackEditModal.classList.contains('hidden')) return;
            e.preventDefault();
            this.close();
        });
        if (hub.trackEditSave) {
            hub.trackEditSave.addEventListener('click', () => { void this.save(); });
        }
    }

    open(playlist_id, track_id, title, artist, album) {
        const hub = this.state.hub;
        if (!hub.trackEditModal) return;
        this._playlist_id = String(playlist_id || '').trim();
        this._track_id = String(track_id || '').trim();
        if (!this._playlist_id || !this._track_id) return;
        hub.trackEditTitleInput.value = title != null ? String(title) : '';
        hub.trackEditArtistInput.value = artist != null ? String(artist) : '';
        hub.trackEditAlbumInput.value = album != null ? String(album) : '';
        this._show_error('');
        if (this.contextMenu) this.contextMenu.closeContextMenu();
        hub.trackEditModal.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        hub.trackEditTitleInput.focus();
        hub.trackEditTitleInput.select();
    }

    close() {
        const hub = this.state.hub;
        if (!hub.trackEditModal) return;
        hub.trackEditModal.classList.add('hidden');
        this._show_error('');
        document.body.classList.remove('overflow-hidden');
        this._playlist_id = '';
        this._track_id = '';
    }

    async save() {
        const hub = this.state.hub;
        const pid = this._playlist_id;
        const tid = this._track_id;
        const title = (hub.trackEditTitleInput.value || '').trim();
        const artist = (hub.trackEditArtistInput.value || '').trim();
        const album = (hub.trackEditAlbumInput.value || '').trim();
        if (!pid || !tid) return;
        if (!title) {
            this._show_error('Title cannot be empty.');
            return;
        }
        this._show_error('');
        try {
            const r = await fetch(
                '/api/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(tid) + '/details',
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: title, artist: artist, album: album }),
                },
            );
            if (!r.ok) {
                this._show_error('Could not save.');
                return;
            }
            const j = await r.json();
            this.apply_locally(tid, j.title || title, j.artist != null ? j.artist : artist, j.album != null ? j.album : album);
            this.close();
        } catch (e) {
            this._show_error('Network error while saving.');
        }
    }

    apply_locally(track_id, title, artist, album) {
        const hub = this.state.hub;
        const tid = String(track_id);
        if (this.transport) {
            this.transport.patchTrackInHub({ id: tid, title: title, artist: artist, album: album });
        }
        document.querySelectorAll('[data-track-id="' + CSS.escape(tid) + '"]').forEach((el) => {
            if (!el.classList || !el.classList.contains('track-row')) return;
            el.setAttribute('data-title', title);
            el.setAttribute('data-artist', artist);
            el.setAttribute('data-album', album);
            const title_el = el.querySelector('.track-row-title');
            const artist_el = el.querySelector('.track-row-artist');
            if (title_el) {
                title_el.textContent = title;
                title_el.setAttribute('title', title);
            }
            if (artist_el) {
                artist_el.textContent = artist;
                artist_el.setAttribute('title', artist);
            }
        });
        if (String(hub.currentTrackId || '') === tid) {
            if (hub.titleEl) hub.titleEl.textContent = title || '—';
            if (hub.subEl) hub.subEl.textContent = artist || '—';
            if (hub.lastPlayedTrackSnapshot && hub.lastPlayedTrackSnapshot.id === tid) {
                hub.lastPlayedTrackSnapshot.title = title;
                hub.lastPlayedTrackSnapshot.artist = artist;
                hub.lastPlayedTrackSnapshot.album = album;
            }
            if (this.transport) {
                this.transport.updateMediaSessionMetadata({ id: tid, title: title, artist: artist });
            }
        }
        if (Array.isArray(hub.manual_up_next_queue)) {
            hub.manual_up_next_queue.forEach((e) => {
                if (String(e.track_id) !== tid) return;
                e.title = title;
                e.artist = artist;
                e.album = album;
            });
            if (this.queue) this.queue.persist_manual_queue_state();
        }
        if (hub.queueVisible && this.queue) this.queue.render_queue_list();
    }

    _show_error(msg) {
        const hub = this.state.hub;
        if (!hub.trackEditError) return;
        if (!msg) {
            hub.trackEditError.textContent = '';
            hub.trackEditError.classList.add('hidden');
            return;
        }
        hub.trackEditError.textContent = msg;
        hub.trackEditError.classList.remove('hidden');
    }
}
