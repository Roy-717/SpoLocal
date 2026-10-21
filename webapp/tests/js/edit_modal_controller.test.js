import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistEditModalController } from '../../static/js/ui/edit_modal_controller.js';

function mount_edit_dom() {
    document.body.innerHTML = `
        <div id="playlist-edit-modal" class="hidden">
            <div id="playlist-edit-backdrop"></div>
            <button id="playlist-edit-close-x"></button>
            <button id="playlist-edit-cancel"></button>
            <input id="playlist-edit-id" />
            <input id="playlist-edit-name" />
            <textarea id="playlist-edit-bio"></textarea>
            <button id="playlist-edit-save"></button>
            <button id="playlist-edit-delete"></button>
            <p id="playlist-edit-error" class="hidden"></p>
        </div>
        <h1 id="spa-playlist-title"></h1>
        <p id="spa-playlist-bio" class="hidden"></p>
        <pre id="spa-playlist-edit-json"></pre>
        <div class="playlist-card">
            <a class="playlist-spa-nav" href="/?playlist_id=p1"><span class="truncate">Old</span></a>
        </div>
    `;
}

function make_hub() {
    mount_edit_dom();
    return {
        playlistEditModal: document.getElementById('playlist-edit-modal'),
        playlistEditBackdrop: document.getElementById('playlist-edit-backdrop'),
        playlistEditCloseX: document.getElementById('playlist-edit-close-x'),
        playlistEditCancel: document.getElementById('playlist-edit-cancel'),
        playlistEditId: document.getElementById('playlist-edit-id'),
        playlistEditNameInput: document.getElementById('playlist-edit-name'),
        playlistEditBioInput: document.getElementById('playlist-edit-bio'),
        playlistEditSave: document.getElementById('playlist-edit-save'),
        playlistEditDelete: document.getElementById('playlist-edit-delete'),
        playlistEditError: document.getElementById('playlist-edit-error'),
    };
}

function make_controller(hub) {
    return new PlaylistEditModalController({ hub: hub });
}

function flush() {
    return new Promise(function (resolve) {
        setTimeout(resolve, 0);
    });
}

function fill_form(hub, id, name, bio) {
    hub.playlistEditId.value = id;
    hub.playlistEditNameInput.value = name;
    hub.playlistEditBioInput.value = bio;
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
    delete window.__playlistEditMeta;
    delete window.__likedPlaylistId;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('constructor and cross refs', () => {
    it('stores the state and starts without a context menu', () => {
        const state = { hub: {} };
        const controller = new PlaylistEditModalController(state);
        expect(controller.state).toBe(state);
        expect(controller.contextMenu).toBeNull();
    });

    it('stores the context menu reference', () => {
        const controller = new PlaylistEditModalController({ hub: {} });
        const contextMenu = { closeContextMenu: vi.fn() };
        controller.setCrossRefs(contextMenu);
        expect(controller.contextMenu).toBe(contextMenu);
    });
});

describe('init wiring', () => {
    it('closes on backdrop click', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        hub.playlistEditBackdrop.click();
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
    });

    it('closes on the close X', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        hub.playlistEditCloseX.click();
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
    });

    it('closes on cancel', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        hub.playlistEditCancel.click();
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
    });

    it('closes on Escape while the modal is visible', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
    });

    it('keeps a hidden modal hidden on Escape', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.init();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
    });

    it('ignores other keys', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(false);
    });
});

describe('save handler', () => {
    it('does nothing without a playlist id', async () => {
        const hub = make_hub();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller(hub);
        controller.init();
        fill_form(hub, '   ', 'Name', 'Bio');
        hub.playlistEditSave.click();
        await flush();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('rejects an empty name', async () => {
        const hub = make_hub();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller(hub);
        controller.init();
        fill_form(hub, 'p1', '   ', 'Bio');
        hub.playlistEditSave.click();
        await flush();
        expect(fetch_mock).not.toHaveBeenCalled();
        expect(hub.playlistEditError.textContent).toBe('Playlist name cannot be empty.');
        expect(hub.playlistEditError.classList.contains('hidden')).toBe(false);
    });

    it('saves and updates the page', async () => {
        const hub = make_hub();
        const fetch_mock = vi.fn(() => Promise.resolve({
            ok: true,
            json: async () => ({ ok: true, id: 'p1', name: 'New Name', bio: 'New Bio' }),
        }));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller(hub);
        controller.init();
        fill_form(hub, 'p1', 'New Name', 'New Bio');
        hub.playlistEditSave.click();
        await flush();

        expect(fetch_mock).toHaveBeenCalledTimes(1);
        const url = fetch_mock.mock.calls[0][0];
        const options = fetch_mock.mock.calls[0][1];
        expect(url).toBe('/playlists/p1/edit');
        expect(options.method).toBe('POST');
        expect(options.credentials).toBe('same-origin');
        expect(options.body instanceof FormData).toBe(true);
        expect(options.body.get('name')).toBe('New Name');
        expect(options.body.get('bio')).toBe('New Bio');

        expect(document.getElementById('spa-playlist-title').textContent).toBe('New Name');
        const bio_el = document.getElementById('spa-playlist-bio');
        expect(bio_el.textContent).toBe('New Bio');
        expect(bio_el.classList.contains('hidden')).toBe(false);
        expect(JSON.parse(document.getElementById('spa-playlist-edit-json').textContent)).toEqual({
            id: 'p1',
            name: 'New Name',
            bio: 'New Bio',
        });
        expect(window.__playlistEditMeta).toEqual({ id: 'p1', name: 'New Name', bio: 'New Bio' });
        expect(document.querySelector('.playlist-card span.truncate').textContent).toBe('New Name');
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
        expect(document.body.classList.contains('overflow-hidden')).toBe(false);
    });

    it('hides the bio when the saved bio is empty', async () => {
        const hub = make_hub();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: async () => ({ ok: true, id: 'p1', name: 'Name', bio: '   ' }),
        })));
        const controller = make_controller(hub);
        controller.init();
        fill_form(hub, 'p1', 'Name', '');
        hub.playlistEditSave.click();
        await flush();
        expect(document.getElementById('spa-playlist-bio').classList.contains('hidden')).toBe(true);
    });

    it('shows the server detail on a failed response', async () => {
        const hub = make_hub();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false,
            json: async () => ({ detail: 'Name already taken' }),
        })));
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        fill_form(hub, 'p1', 'Name', '');
        hub.playlistEditSave.click();
        await flush();
        expect(hub.playlistEditError.textContent).toBe('Name already taken');
        expect(hub.playlistEditError.classList.contains('hidden')).toBe(false);
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(false);
    });

    it('falls back to a generic message when the error body is unreadable', async () => {
        const hub = make_hub();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false,
            json: async () => {
                throw new Error('bad json');
            },
        })));
        const controller = make_controller(hub);
        controller.init();
        fill_form(hub, 'p1', 'Name', '');
        hub.playlistEditSave.click();
        await flush();
        expect(hub.playlistEditError.textContent).toBe('Could not save.');
    });

    it('rejects a response without ok', async () => {
        const hub = make_hub();
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true,
            json: async () => ({ ok: false }),
        })));
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditModal.classList.remove('hidden');
        fill_form(hub, 'p1', 'Name', '');
        hub.playlistEditSave.click();
        await flush();
        expect(hub.playlistEditError.textContent).toBe('Could not save.');
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(false);
    });

    it('reports a network error', async () => {
        const hub = make_hub();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
        const controller = make_controller(hub);
        controller.init();
        fill_form(hub, 'p1', 'Name', '');
        hub.playlistEditSave.click();
        await flush();
        expect(hub.playlistEditError.textContent).toBe('Network error while saving.');
    });
});

describe('delete handler', () => {
    it('does nothing without a playlist id', async () => {
        const hub = make_hub();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditId.value = '';
        hub.playlistEditDelete.click();
        await flush();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('does nothing when confirmation is cancelled', async () => {
        const hub = make_hub();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        vi.stubGlobal('confirm', vi.fn(() => false));
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditId.value = 'p1';
        hub.playlistEditDelete.click();
        await flush();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('posts to the delete endpoint after confirmation', async () => {
        const hub = make_hub();
        const fetch_mock = vi.fn(() => new Promise(function () {}));
        vi.stubGlobal('fetch', fetch_mock);
        vi.stubGlobal('confirm', vi.fn(() => true));
        const controller = make_controller(hub);
        controller.init();
        hub.playlistEditId.value = 'p1';
        hub.playlistEditDelete.click();
        await flush();
        expect(fetch_mock).toHaveBeenCalledWith('/playlists/p1/delete', {
            method: 'POST',
            redirect: 'manual',
            credentials: 'same-origin',
        });
    });
});

describe('showPlaylistEditError', () => {
    it('shows a message', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.showPlaylistEditError('Broken');
        expect(hub.playlistEditError.textContent).toBe('Broken');
        expect(hub.playlistEditError.classList.contains('hidden')).toBe(false);
    });

    it('clears the message', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        hub.playlistEditError.textContent = 'Broken';
        hub.playlistEditError.classList.remove('hidden');
        controller.showPlaylistEditError('');
        expect(hub.playlistEditError.textContent).toBe('');
        expect(hub.playlistEditError.classList.contains('hidden')).toBe(true);
    });

    it('tolerates a missing error element', () => {
        const controller = make_controller({});
        expect(function () {
            controller.showPlaylistEditError('Broken');
        }).not.toThrow();
    });
});

describe('closePlaylistEditModal', () => {
    it('hides the modal and restores the controls', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        hub.playlistEditModal.classList.remove('hidden');
        hub.playlistEditError.textContent = 'Broken';
        hub.playlistEditError.classList.remove('hidden');
        hub.playlistEditSave.classList.add('hidden');
        hub.playlistEditSave.disabled = true;
        hub.playlistEditDelete.classList.add('hidden');
        hub.playlistEditDelete.disabled = true;
        hub.playlistEditNameInput.readOnly = true;
        hub.playlistEditBioInput.readOnly = true;
        document.body.classList.add('overflow-hidden');

        controller.closePlaylistEditModal();

        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
        expect(hub.playlistEditError.textContent).toBe('');
        expect(hub.playlistEditError.classList.contains('hidden')).toBe(true);
        expect(hub.playlistEditSave.classList.contains('hidden')).toBe(false);
        expect(hub.playlistEditSave.disabled).toBe(false);
        expect(hub.playlistEditDelete.classList.contains('hidden')).toBe(false);
        expect(hub.playlistEditDelete.disabled).toBe(false);
        expect(hub.playlistEditNameInput.readOnly).toBe(false);
        expect(hub.playlistEditBioInput.readOnly).toBe(false);
        expect(document.body.classList.contains('overflow-hidden')).toBe(false);
    });

    it('tolerates a missing modal', () => {
        const controller = make_controller({});
        expect(function () {
            controller.closePlaylistEditModal();
        }).not.toThrow();
    });
});

describe('syncPlaylistEditModalFromFragment', () => {
    it('parses the json fragment into window state', () => {
        const hub = make_hub();
        document.getElementById('spa-playlist-edit-json').textContent = '{"id":"p1","name":"N"}';
        const controller = make_controller(hub);
        controller.syncPlaylistEditModalFromFragment();
        expect(window.__playlistEditMeta).toEqual({ id: 'p1', name: 'N' });
    });

    it('falls back to an empty object for invalid json', () => {
        const hub = make_hub();
        document.getElementById('spa-playlist-edit-json').textContent = 'not json';
        const controller = make_controller(hub);
        controller.syncPlaylistEditModalFromFragment();
        expect(window.__playlistEditMeta).toEqual({});
    });

    it('leaves the state alone without a fragment element', () => {
        const hub = make_hub();
        document.getElementById('spa-playlist-edit-json').remove();
        window.__playlistEditMeta = { keep: true };
        const controller = make_controller(hub);
        controller.syncPlaylistEditModalFromFragment();
        expect(window.__playlistEditMeta).toEqual({ keep: true });
    });
});

describe('openPlaylistEditModal', () => {
    it('does nothing without the required elements', () => {
        const controller = make_controller({});
        expect(function () {
            controller.openPlaylistEditModal({ id: 'p1', name: 'N', bio: 'B' });
        }).not.toThrow();
    });

    it('does nothing without an id', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.openPlaylistEditModal({ name: 'N' });
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(true);
        expect(hub.playlistEditId.value).toBe('');
    });

    it('fills the form and shows the modal', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.openPlaylistEditModal({ id: 'p1', name: 'N', bio: 'B' });
        expect(hub.playlistEditId.value).toBe('p1');
        expect(hub.playlistEditNameInput.value).toBe('N');
        expect(hub.playlistEditBioInput.value).toBe('B');
        expect(hub.playlistEditModal.classList.contains('hidden')).toBe(false);
        expect(document.body.classList.contains('overflow-hidden')).toBe(true);
        expect(document.activeElement).toBe(hub.playlistEditNameInput);
        expect(hub.playlistEditSave.disabled).toBe(false);
        expect(hub.playlistEditDelete.disabled).toBe(false);
    });

    it('uses empty strings for missing name and bio', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.openPlaylistEditModal({ id: 'p1' });
        expect(hub.playlistEditNameInput.value).toBe('');
        expect(hub.playlistEditBioInput.value).toBe('');
    });

    it('falls back to window.__playlistEditMeta', () => {
        const hub = make_hub();
        window.__playlistEditMeta = { id: 'p7', name: 'Meta', bio: 'Meta Bio' };
        const controller = make_controller(hub);
        controller.openPlaylistEditModal();
        expect(hub.playlistEditId.value).toBe('p7');
        expect(hub.playlistEditNameInput.value).toBe('Meta');
        expect(hub.playlistEditBioInput.value).toBe('Meta Bio');
    });

    it('locks the liked playlist', () => {
        const hub = make_hub();
        window.__likedPlaylistId = 'p1';
        const controller = make_controller(hub);
        controller.openPlaylistEditModal({ id: 'p1', name: 'Liked', bio: '' });
        expect(hub.playlistEditDelete.classList.contains('hidden')).toBe(true);
        expect(hub.playlistEditDelete.disabled).toBe(true);
        expect(hub.playlistEditSave.classList.contains('hidden')).toBe(true);
        expect(hub.playlistEditSave.disabled).toBe(true);
        expect(hub.playlistEditNameInput.readOnly).toBe(true);
        expect(hub.playlistEditBioInput.readOnly).toBe(true);
    });

    it('does not lock other playlists', () => {
        const hub = make_hub();
        window.__likedPlaylistId = 'p2';
        const controller = make_controller(hub);
        controller.openPlaylistEditModal({ id: 'p1', name: 'Other', bio: '' });
        expect(hub.playlistEditDelete.classList.contains('hidden')).toBe(false);
        expect(hub.playlistEditSave.classList.contains('hidden')).toBe(false);
        expect(hub.playlistEditNameInput.readOnly).toBe(false);
    });

    it('closes the context menu', () => {
        const hub = make_hub();
        const controller = make_controller(hub);
        controller.setCrossRefs({ closeContextMenu: vi.fn() });
        controller.openPlaylistEditModal({ id: 'p1', name: 'N', bio: '' });
        expect(controller.contextMenu.closeContextMenu).toHaveBeenCalled();
    });
});
