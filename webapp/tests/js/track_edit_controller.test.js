import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrackEditController } from '../../static/js/ui/track_edit_controller.js';

function mount_track_edit_dom() {
    document.body.innerHTML = `
        <div id="track-edit-modal" class="hidden">
            <div id="track-edit-modal-backdrop"></div>
            <button id="track-edit-close-x"></button>
            <button id="track-edit-cancel"></button>
            <button id="track-edit-save"></button>
            <input id="track-edit-title-input">
            <input id="track-edit-artist-input">
            <input id="track-edit-album-input">
            <p id="track-edit-error" class="hidden"></p>
        </div>
    `;
}

function json_response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function make_controller(hub = {}) {
    return new TrackEditController({ hub });
}

function make_transport() {
    return {
        quality: { patchTrackInHub: vi.fn() },
        mediaSession: { updateMediaSessionMetadata: vi.fn() },
    };
}

function make_queue() {
    return {
        persist_manual_queue_state: vi.fn(),
        render_queue_list: vi.fn(),
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    mount_track_edit_dom();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('constructor and cross refs', () => {
    it('starts without cross refs or ids', () => {
        const controller = make_controller();
        expect(controller.transport).toBe(null);
        expect(controller.queue).toBe(null);
        expect(controller.contextMenu).toBe(null);
        expect(controller._playlist_id).toBe('');
        expect(controller._track_id).toBe('');
    });

    it('setCrossRefs stores the collaborators', () => {
        const controller = make_controller();
        const transport = make_transport();
        const queue = make_queue();
        const context_menu = { closeContextMenu: vi.fn() };
        controller.setCrossRefs(transport, queue, context_menu);
        expect(controller.transport).toBe(transport);
        expect(controller.queue).toBe(queue);
        expect(controller.contextMenu).toBe(context_menu);
    });
});

describe('init', () => {
    it('caches the modal elements on the hub', () => {
        const controller = make_controller();
        const hub = controller.state.hub;
        controller.init();
        expect(hub.trackEditModal).toBe(document.getElementById('track-edit-modal'));
        expect(hub.trackEditBackdrop).toBe(document.getElementById('track-edit-modal-backdrop'));
        expect(hub.trackEditCloseX).toBe(document.getElementById('track-edit-close-x'));
        expect(hub.trackEditCancel).toBe(document.getElementById('track-edit-cancel'));
        expect(hub.trackEditSave).toBe(document.getElementById('track-edit-save'));
        expect(hub.trackEditTitleInput).toBe(document.getElementById('track-edit-title-input'));
        expect(hub.trackEditArtistInput).toBe(document.getElementById('track-edit-artist-input'));
        expect(hub.trackEditAlbumInput).toBe(document.getElementById('track-edit-album-input'));
        expect(hub.trackEditError).toBe(document.getElementById('track-edit-error'));
    });

    it('closes from the backdrop, the X and the cancel button', () => {
        const controller = make_controller();
        controller.init();
        const modal = document.getElementById('track-edit-modal');
        controller.open('p1', 't1', 'T', 'A', 'B');
        document.getElementById('track-edit-modal-backdrop').click();
        expect(modal.classList.contains('hidden')).toBe(true);
        controller.open('p1', 't1', 'T', 'A', 'B');
        document.getElementById('track-edit-close-x').click();
        expect(modal.classList.contains('hidden')).toBe(true);
        controller.open('p1', 't1', 'T', 'A', 'B');
        document.getElementById('track-edit-cancel').click();
        expect(modal.classList.contains('hidden')).toBe(true);
    });

    it('closes on Escape only while the modal is open', () => {
        const controller = make_controller();
        controller.init();
        const modal = document.getElementById('track-edit-modal');
        controller.open('p1', 't1', 'T', 'A', 'B');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(modal.classList.contains('hidden')).toBe(true);

        controller.open('p1', 't1', 'T', 'A', 'B');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(modal.classList.contains('hidden')).toBe(false);
    });

    it('ignores Escape when the modal is hidden', () => {
        const controller = make_controller();
        controller.init();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(true);
    });

    it('saves from the save button', () => {
        const controller = make_controller();
        const spy = vi.spyOn(controller, 'save').mockResolvedValue();
        controller.init();
        document.getElementById('track-edit-save').click();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe('open', () => {
    it('fills the inputs and shows the modal', () => {
        const controller = make_controller();
        const context_menu = { closeContextMenu: vi.fn() };
        controller.setCrossRefs(null, null, context_menu);
        controller.init();
        controller.open('p1', 't1', 'Title', 'Artist', 'Album');
        expect(document.getElementById('track-edit-title-input').value).toBe('Title');
        expect(document.getElementById('track-edit-artist-input').value).toBe('Artist');
        expect(document.getElementById('track-edit-album-input').value).toBe('Album');
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(false);
        expect(document.body.classList.contains('overflow-hidden')).toBe(true);
        expect(document.activeElement).toBe(document.getElementById('track-edit-title-input'));
        expect(context_menu.closeContextMenu).toHaveBeenCalledTimes(1);
        expect(controller._playlist_id).toBe('p1');
        expect(controller._track_id).toBe('t1');
    });

    it('turns missing values into empty strings', () => {
        const controller = make_controller();
        controller.init();
        controller.open('p1', 't1', null, undefined, null);
        expect(document.getElementById('track-edit-title-input').value).toBe('');
        expect(document.getElementById('track-edit-artist-input').value).toBe('');
        expect(document.getElementById('track-edit-album-input').value).toBe('');
    });

    it('clears a previous error', () => {
        const controller = make_controller();
        controller.init();
        const error = document.getElementById('track-edit-error');
        error.textContent = 'old';
        error.classList.remove('hidden');
        controller.open('p1', 't1', 'T', 'A', 'B');
        expect(error.textContent).toBe('');
        expect(error.classList.contains('hidden')).toBe(true);
    });

    it('does nothing without a playlist or track id', () => {
        const controller = make_controller();
        controller.init();
        controller.open('', 't1', 'T', 'A', 'B');
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(true);
        controller.open('p1', '', 'T', 'A', 'B');
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(true);
        expect(controller._track_id).toBe('');
        expect(controller._playlist_id).toBe('');
    });

    it('does nothing without the modal', () => {
        const controller = make_controller({});
        expect(() => controller.open('p1', 't1', 'T', 'A', 'B')).not.toThrow();
    });
});

describe('close', () => {
    it('hides the modal, clears the error and the ids', () => {
        const controller = make_controller();
        controller.init();
        controller.open('p1', 't1', 'T', 'A', 'B');
        const error = document.getElementById('track-edit-error');
        error.textContent = 'boom';
        error.classList.remove('hidden');
        controller.close();
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(true);
        expect(error.textContent).toBe('');
        expect(error.classList.contains('hidden')).toBe(true);
        expect(document.body.classList.contains('overflow-hidden')).toBe(false);
        expect(controller._playlist_id).toBe('');
        expect(controller._track_id).toBe('');
    });

    it('does nothing without the modal', () => {
        const controller = make_controller({});
        expect(() => controller.close()).not.toThrow();
    });
});

describe('save', () => {
    it('does nothing without ids', async () => {
        const fetch_mock = vi.fn(async () => json_response({}));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller();
        controller.init();
        await controller.save();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('rejects an empty title', async () => {
        const fetch_mock = vi.fn(async () => json_response({}));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller();
        controller.init();
        controller.open('p1', 't1', '   ', 'A', 'B');
        await controller.save();
        expect(fetch_mock).not.toHaveBeenCalled();
        expect(document.getElementById('track-edit-error').textContent).toBe('Title cannot be empty.');
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(false);
    });

    it('posts the trimmed values and applies them locally', async () => {
        const fetch_mock = vi.fn(async () => json_response({
            title: 'New title',
            artist: 'New artist',
            album: 'New album',
        }));
        vi.stubGlobal('fetch', fetch_mock);
        const controller = make_controller();
        const transport = make_transport();
        controller.setCrossRefs(transport, null, null);
        controller.init();
        controller.open('p 1', 't/1', ' Old ', ' Old artist ', ' Old album ');
        await controller.save();
        const [url, options] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/playlists/p%201/tracks/t%2F1/details');
        expect(options.method).toBe('POST');
        expect(options.body).toBe(
            '{"title":"Old","artist":"Old artist","album":"Old album"}',
        );
        expect(transport.quality.patchTrackInHub).toHaveBeenCalledWith({
            id: 't/1',
            title: 'New title',
            artist: 'New artist',
            album: 'New album',
        });
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(true);
    });

    it('falls back to the input values when the response omits fields', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json_response({})));
        const controller = make_controller();
        const transport = make_transport();
        controller.setCrossRefs(transport, null, null);
        controller.init();
        controller.open('p1', 't1', 'Title', 'Artist', 'Album');
        await controller.save();
        expect(transport.quality.patchTrackInHub).toHaveBeenCalledWith({
            id: 't1',
            title: 'Title',
            artist: 'Artist',
            album: 'Album',
        });
    });

    it('keeps the modal open when the server refuses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json_response({}, false, 400)));
        const controller = make_controller();
        controller.init();
        controller.open('p1', 't1', 'Title', 'Artist', 'Album');
        await controller.save();
        expect(document.getElementById('track-edit-error').textContent).toBe('Could not save.');
        expect(document.getElementById('track-edit-modal').classList.contains('hidden')).toBe(false);
    });

    it('reports a network error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const controller = make_controller();
        controller.init();
        controller.open('p1', 't1', 'Title', 'Artist', 'Album');
        await controller.save();
        expect(document.getElementById('track-edit-error').textContent).toBe(
            'Network error while saving.',
        );
    });
});

describe('apply_locally', () => {
    function mount_rows() {
        const row = document.createElement('div');
        row.className = 'track-row';
        row.setAttribute('data-track-id', 't1');
        row.innerHTML = '<span class="track-row-title"></span><span class="track-row-artist"></span>';
        document.body.appendChild(row);

        const other = document.createElement('div');
        other.className = 'track-row';
        other.setAttribute('data-track-id', 't2');
        other.innerHTML = '<span class="track-row-title">Old</span><span class="track-row-artist">Old</span>';
        document.body.appendChild(other);

        const not_a_row = document.createElement('div');
        not_a_row.setAttribute('data-track-id', 't1');
        document.body.appendChild(not_a_row);

        return { row, other, not_a_row };
    }

    it('patches the hub, the rows and the now playing labels', () => {
        const { row, other, not_a_row } = mount_rows();
        const hub = {
            currentTrackId: 't1',
            titleEl: document.createElement('span'),
            subEl: document.createElement('span'),
            lastPlayedTrackSnapshot: { id: 't1', title: 'Old', artist: 'Old', album: 'Old' },
            manual_up_next_queue: [
                { track_id: 't1', title: 'Old', artist: 'Old', album: 'Old' },
                { track_id: 't2', title: 'Keep', artist: 'Keep', album: 'Keep' },
            ],
            queueVisible: true,
        };
        const controller = make_controller(hub);
        const transport = make_transport();
        const queue = make_queue();
        controller.setCrossRefs(transport, queue, null);

        controller.apply_locally('t1', 'New title', 'New artist', 'New album');

        expect(transport.quality.patchTrackInHub).toHaveBeenCalledWith({
            id: 't1',
            title: 'New title',
            artist: 'New artist',
            album: 'New album',
        });
        expect(row.getAttribute('data-title')).toBe('New title');
        expect(row.getAttribute('data-artist')).toBe('New artist');
        expect(row.getAttribute('data-album')).toBe('New album');
        expect(row.querySelector('.track-row-title').textContent).toBe('New title');
        expect(row.querySelector('.track-row-title').getAttribute('title')).toBe('New title');
        expect(row.querySelector('.track-row-artist').textContent).toBe('New artist');
        expect(row.querySelector('.track-row-artist').getAttribute('title')).toBe('New artist');
        expect(other.getAttribute('data-title')).toBe(null);
        expect(other.querySelector('.track-row-title').textContent).toBe('Old');
        expect(not_a_row.getAttribute('data-title')).toBe(null);
        expect(hub.titleEl.textContent).toBe('New title');
        expect(hub.subEl.textContent).toBe('New artist');
        expect(hub.lastPlayedTrackSnapshot).toEqual({
            id: 't1',
            title: 'New title',
            artist: 'New artist',
            album: 'New album',
        });
        expect(transport.mediaSession.updateMediaSessionMetadata).toHaveBeenCalledWith({
            id: 't1',
            title: 'New title',
            artist: 'New artist',
        });
        expect(hub.manual_up_next_queue[0]).toEqual({
            track_id: 't1',
            title: 'New title',
            artist: 'New artist',
            album: 'New album',
        });
        expect(hub.manual_up_next_queue[1].title).toBe('Keep');
        expect(queue.persist_manual_queue_state).toHaveBeenCalledTimes(1);
        expect(queue.render_queue_list).toHaveBeenCalledTimes(1);
    });

    it('leaves the now playing labels alone for another track', () => {
        mount_rows();
        const hub = {
            currentTrackId: 't2',
            titleEl: document.createElement('span'),
            subEl: document.createElement('span'),
            lastPlayedTrackSnapshot: { id: 't1', title: 'Old' },
        };
        hub.titleEl.textContent = 'Playing';
        hub.subEl.textContent = 'Someone';
        const controller = make_controller(hub);
        const transport = make_transport();
        controller.setCrossRefs(transport, null, null);

        controller.apply_locally('t1', 'New title', 'New artist', 'New album');

        expect(hub.titleEl.textContent).toBe('Playing');
        expect(hub.subEl.textContent).toBe('Someone');
        expect(hub.lastPlayedTrackSnapshot.title).toBe('Old');
        expect(transport.mediaSession.updateMediaSessionMetadata).not.toHaveBeenCalled();
    });

    it('uses dashes for empty now playing values', () => {
        const hub = {
            currentTrackId: 't1',
            titleEl: document.createElement('span'),
            subEl: document.createElement('span'),
        };
        const controller = make_controller(hub);
        controller.apply_locally('t1', '', '', '');
        expect(hub.titleEl.textContent).toBe(String.fromCharCode(8212));
        expect(hub.subEl.textContent).toBe(String.fromCharCode(8212));
    });

    it('skips the queue work when the queue is hidden', () => {
        const hub = {
            manual_up_next_queue: [{ track_id: 't1', title: 'Old' }],
            queueVisible: false,
        };
        const controller = make_controller(hub);
        const queue = make_queue();
        controller.setCrossRefs(null, queue, null);
        controller.apply_locally('t1', 'New', 'New', 'New');
        expect(queue.persist_manual_queue_state).toHaveBeenCalledTimes(1);
        expect(queue.render_queue_list).not.toHaveBeenCalled();
    });

    it('works without a transport, queue or matching rows', () => {
        const controller = make_controller({});
        expect(() => controller.apply_locally('missing', 'T', 'A', 'B')).not.toThrow();
    });
});

describe('_show_error', () => {
    it('shows and hides the message', () => {
        const controller = make_controller();
        controller.init();
        const error = document.getElementById('track-edit-error');
        controller._show_error('boom');
        expect(error.textContent).toBe('boom');
        expect(error.classList.contains('hidden')).toBe(false);
        controller._show_error('');
        expect(error.textContent).toBe('');
        expect(error.classList.contains('hidden')).toBe(true);
    });

    it('does nothing without the element', () => {
        document.getElementById('track-edit-error').remove();
        const controller = make_controller();
        expect(() => controller._show_error('boom')).not.toThrow();
    });
});
