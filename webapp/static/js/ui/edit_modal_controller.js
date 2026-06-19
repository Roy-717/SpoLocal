/**
 * Controller that encapsulates the playlist edit modal behaviour.
 * Responsibilities:
 * - Open/close modal, validate inputs, handle save/delete calls
 * - Surface errors into the small inline error slot managed by the modal
 */
export class PlaylistEditModalController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./context_menu_controller.js').PlaylistContextMenuController|null} */
        this.contextMenu = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(contextMenu) {
        this.contextMenu = contextMenu;
    }

    /** Wire up modal open/save/delete handlers. */
    init() {
        const hub = this.state.hub;
        if (hub.playlistEditBackdrop) {
            hub.playlistEditBackdrop.addEventListener('click', () => this.closePlaylistEditModal());
        }
        if (hub.playlistEditCloseX) {
            hub.playlistEditCloseX.addEventListener('click', () => this.closePlaylistEditModal());
        }
        if (hub.playlistEditCancel) {
            hub.playlistEditCancel.addEventListener('click', () => this.closePlaylistEditModal());
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!hub.playlistEditModal || hub.playlistEditModal.classList.contains('hidden')) return;
            e.preventDefault();
            this.closePlaylistEditModal();
        });

        if (hub.playlistEditSave && hub.playlistEditId && hub.playlistEditNameInput && hub.playlistEditBioInput) {
            hub.playlistEditSave.addEventListener('click', async () => {
                const pid = hub.playlistEditId.value.trim();
                const name = hub.playlistEditNameInput.value.trim();
                const bio = hub.playlistEditBioInput.value;
                if (!pid) return;
                if (!name) {
                    this.showPlaylistEditError('Playlist name cannot be empty.');
                    return;
                }
                this.showPlaylistEditError('');
                try {
                    const fd = new FormData();
                    fd.append('name', name);
                    fd.append('bio', bio);
                    const r = await fetch('/playlists/' + encodeURIComponent(pid) + '/edit', {
                        method: 'POST',
                        body: fd,
                        credentials: 'same-origin',
                    });
                    if (!r.ok) {
                        let msg = 'Could not save.';
                        try {
                            const err = await r.json();
                            if (typeof err.detail === 'string') msg = err.detail;
                        } catch (x) {}
                        this.showPlaylistEditError(msg);
                        return;
                    }
                    const j = await r.json();
                    if (!j || !j.ok) {
                        this.showPlaylistEditError('Could not save.');
                        return;
                    }
                    const spaPlaylistTitleEl = document.getElementById('spa-playlist-title');
                    if (spaPlaylistTitleEl) spaPlaylistTitleEl.textContent = j.name || '';
                    const bioEl = document.getElementById('spa-playlist-bio');
                    if (bioEl) {
                        const t = (j.bio || '').trim();
                        bioEl.textContent = t;
                        bioEl.classList.toggle('hidden', !t);
                    }
                    const jsonEl = document.getElementById('spa-playlist-edit-json');
                    if (jsonEl) {
                        jsonEl.textContent = JSON.stringify({
                            id: j.id || pid,
                            name: j.name || name,
                            bio: j.bio != null ? j.bio : bio,
                        });
                    }
                    this.syncPlaylistEditModalFromFragment();
                    document.querySelectorAll('.playlist-card a.playlist-spa-nav').forEach(function (a) {
                        let u;
                        try {
                            u = new URL(a.getAttribute('href'), location.origin);
                        } catch (x) {
                            return;
                        }
                        if ((u.searchParams.get('playlist_id') || '') !== (j.id || pid)) return;
                        const span = a.querySelector('span.truncate');
                        if (span) span.textContent = j.name || '';
                    });
                    this.closePlaylistEditModal();
                } catch (e) {
                    this.showPlaylistEditError('Network error while saving.');
                }
            });
        }

        if (hub.playlistEditDelete && hub.playlistEditId) {
            hub.playlistEditDelete.addEventListener('click', async () => {
                const pid = hub.playlistEditId.value.trim();
                if (!pid) return;
                if (!confirm('Delete this playlist? Files on disk are not removed.')) return;
                try {
                    const r = await fetch('/playlists/' + encodeURIComponent(pid) + '/delete', {
                        method: 'POST',
                        redirect: 'manual',
                        credentials: 'same-origin',
                    });
                    const dest = r.headers.get('Location') || '/';
                    if (r.status === 303 || r.status === 302 || r.status === 301) {
                        window.location.assign(dest.startsWith('http') ? dest : new URL(dest, location.origin).href);
                        return;
                    }
                } catch (e) {}
                window.location.href = '/';
            });
        }
    }

    showPlaylistEditError(msg) {
        const hub = this.state.hub;
        if (!hub.playlistEditError) return;
        if (!msg) {
            hub.playlistEditError.textContent = '';
            hub.playlistEditError.classList.add('hidden');
            return;
        }
        hub.playlistEditError.textContent = msg;
        hub.playlistEditError.classList.remove('hidden');
    }

    closePlaylistEditModal() {
        const hub = this.state.hub;
        if (!hub.playlistEditModal) return;
        hub.playlistEditModal.classList.add('hidden');
        this.showPlaylistEditError('');
        if (hub.playlistEditSave) {
            hub.playlistEditSave.classList.remove('hidden');
            hub.playlistEditSave.disabled = false;
        }
        if (hub.playlistEditDelete) {
            hub.playlistEditDelete.classList.remove('hidden');
            hub.playlistEditDelete.disabled = false;
        }
        if (hub.playlistEditNameInput) hub.playlistEditNameInput.readOnly = false;
        if (hub.playlistEditBioInput) hub.playlistEditBioInput.readOnly = false;
        document.body.classList.remove('overflow-hidden');
    }

    syncPlaylistEditModalFromFragment() {
        const el = document.getElementById('spa-playlist-edit-json');
        if (!el) return;
        try {
            window.__playlistEditMeta = JSON.parse(el.textContent || '{}');
        } catch (e) {
            window.__playlistEditMeta = {};
        }
    }

    openPlaylistEditModal(data) {
        const hub = this.state.hub;
        if (!hub.playlistEditModal || !hub.playlistEditId || !hub.playlistEditNameInput || !hub.playlistEditBioInput) return;
        const d = data || window.__playlistEditMeta || {};
        const id = d.id;
        if (!id) return;
        hub.playlistEditId.value = id;
        hub.playlistEditNameInput.value = (d.name != null) ? String(d.name) : '';
        hub.playlistEditBioInput.value = (d.bio != null) ? String(d.bio) : '';
        const lip = String(typeof window !== 'undefined' && window.__likedPlaylistId ? window.__likedPlaylistId : '').trim();
        const locked = !!(lip && String(id) === lip);
        if (hub.playlistEditDelete) {
            hub.playlistEditDelete.classList.toggle('hidden', locked);
            hub.playlistEditDelete.disabled = locked;
        }
        if (hub.playlistEditNameInput) {
            hub.playlistEditNameInput.readOnly = locked;
        }
        if (hub.playlistEditBioInput) {
            hub.playlistEditBioInput.readOnly = locked;
        }
        if (hub.playlistEditSave) {
            hub.playlistEditSave.classList.toggle('hidden', locked);
            hub.playlistEditSave.disabled = locked;
        }
        this.showPlaylistEditError('');
        if (this.contextMenu) this.contextMenu.closeContextMenu();
        hub.playlistEditModal.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        hub.playlistEditNameInput.focus();
    }
}
