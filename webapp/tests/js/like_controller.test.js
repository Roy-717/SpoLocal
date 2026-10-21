import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistLikeController } from '../../static/js/player/like_controller.js';

function make_hub(overrides = {}) {
    return {
        likedKeysSet: new Set(),
        LIKED_PLAYLIST_ID: 'liked',
        playingPlaylistId: 'p1',
        playlistId: 'p1',
        currentTrackId: 't1',
        btnLike: null,
        likeIconEl: null,
        btnLikeMobile: null,
        likeIconMobileEl: null,
        ...overrides,
    };
}

function make_controller(overrides = {}) {
    const hub = make_hub(overrides);
    const ctrl = new PlaylistLikeController({ hub });
    return { ctrl, hub };
}

function stub_fetch_routes(routes) {
    const fn = vi.fn((url) => {
        const handler = routes[url];
        if (!handler) return Promise.resolve({ ok: false, json: async () => ({}) });
        return Promise.resolve(handler());
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

function flush_async() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function make_like_button(playlist_id, track_id) {
    const btn = document.createElement('button');
    btn.className = 'track-row-like';
    btn.setAttribute('data-playlist-id', playlist_id);
    btn.setAttribute('data-track-id', track_id);
    const icon = document.createElement('i');
    btn.appendChild(icon);
    document.body.appendChild(btn);
    return btn;
}

function make_player_like_button() {
    const btn = document.createElement('button');
    const icon = document.createElement('i');
    btn.appendChild(icon);
    return { btn, icon };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('liked_entry_key', () => {
    it('joins trimmed ids with a pipe', () => {
        const { ctrl } = make_controller();
        expect(ctrl.liked_entry_key(' p1 ', ' t1 ')).toBe('p1|t1');
    });

    it('treats missing ids as empty strings', () => {
        const { ctrl } = make_controller();
        expect(ctrl.liked_entry_key(null, undefined)).toBe('|');
    });
});

describe('refresh_liked_keys_from_server', () => {
    it('replaces the set with the server keys', async () => {
        const { ctrl, hub } = make_controller();
        hub.likedKeysSet.add('old|key');
        stub_fetch_routes({
            '/api/liked-keys': () => ({ ok: true, json: async () => ({ keys: ['p1|t1', 'p2|t2'] }) }),
        });
        await ctrl.refresh_liked_keys_from_server();
        expect(Array.from(hub.likedKeysSet)).toEqual(['p1|t1', 'p2|t2']);
    });

    it('ignores empty and non string keys', async () => {
        const { ctrl, hub } = make_controller();
        stub_fetch_routes({
            '/api/liked-keys': () => ({ ok: true, json: async () => ({ keys: ['p1|t1', '', 5, null] }) }),
        });
        await ctrl.refresh_liked_keys_from_server();
        expect(Array.from(hub.likedKeysSet)).toEqual(['p1|t1']);
    });

    it('keeps the set when the response is not ok', async () => {
        const { ctrl, hub } = make_controller();
        hub.likedKeysSet.add('old|key');
        stub_fetch_routes({
            '/api/liked-keys': () => ({ ok: false, json: async () => ({}) }),
        });
        await ctrl.refresh_liked_keys_from_server();
        expect(Array.from(hub.likedKeysSet)).toEqual(['old|key']);
    });

    it('swallows fetch errors', async () => {
        const { ctrl } = make_controller();
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
        await expect(ctrl.refresh_liked_keys_from_server()).resolves.toBeUndefined();
    });
});

describe('is_current_track_liked', () => {
    it('returns false without a track or playlist', () => {
        const no_track = make_controller({ currentTrackId: null });
        expect(no_track.ctrl.is_current_track_liked()).toBe(false);
        const no_playlist = make_controller({ playingPlaylistId: '', playlistId: '' });
        expect(no_playlist.ctrl.is_current_track_liked()).toBe(false);
    });

    it('prefers the playing playlist id', () => {
        const { ctrl, hub } = make_controller({ playingPlaylistId: 'p2', playlistId: 'p1' });
        hub.likedKeysSet.add('p2|t1');
        expect(ctrl.is_current_track_liked()).toBe(true);
        const other = make_controller({ playingPlaylistId: 'p3', playlistId: 'p1' });
        other.hub.likedKeysSet.add('p1|t1');
        expect(other.ctrl.is_current_track_liked()).toBe(false);
    });

    it('falls back to the viewed playlist id', () => {
        const { ctrl, hub } = make_controller({ playingPlaylistId: '', playlistId: 'p1' });
        hub.likedKeysSet.add('p1|t1');
        expect(ctrl.is_current_track_liked()).toBe(true);
    });

    it('always reports liked tracks inside the liked playlist', () => {
        const { ctrl } = make_controller({ playingPlaylistId: 'liked' });
        expect(ctrl.is_current_track_liked()).toBe(true);
    });
});

describe('is_track_liked', () => {
    it('returns false for empty ids', () => {
        const { ctrl } = make_controller();
        expect(ctrl.is_track_liked('', 't1')).toBe(false);
        expect(ctrl.is_track_liked('p1', '')).toBe(false);
    });

    it('checks the liked key set', () => {
        const { ctrl, hub } = make_controller();
        hub.likedKeysSet.add('p1|t1');
        expect(ctrl.is_track_liked('p1', 't1')).toBe(true);
        expect(ctrl.is_track_liked('p1', 't2')).toBe(false);
    });

    it('always reports liked tracks inside the liked playlist', () => {
        const { ctrl } = make_controller();
        expect(ctrl.is_track_liked('liked', 'anything')).toBe(true);
    });
});

describe('update_track_row_like_buttons', () => {
    it('marks liked rows and unliked rows', () => {
        const liked = make_like_button('p1', 't1');
        const unliked = make_like_button('p1', 't2');
        const { ctrl, hub } = make_controller();
        hub.likedKeysSet.add('p1|t1');
        ctrl.update_track_row_like_buttons();

        expect(liked.getAttribute('aria-pressed')).toBe('true');
        expect(liked.classList.contains('track-row-like--on')).toBe(true);
        expect(liked.querySelector('i').classList.contains('fa-solid')).toBe(true);
        expect(liked.querySelector('i').classList.contains('fa-regular')).toBe(false);

        expect(unliked.getAttribute('aria-pressed')).toBe('false');
        expect(unliked.classList.contains('track-row-like--on')).toBe(false);
        expect(unliked.querySelector('i').classList.contains('fa-regular')).toBe(true);
    });

    it('works for rows without an icon', () => {
        const btn = document.createElement('button');
        btn.className = 'track-row-like';
        btn.setAttribute('data-playlist-id', 'p1');
        btn.setAttribute('data-track-id', 't1');
        document.body.appendChild(btn);
        const { ctrl } = make_controller();
        expect(() => ctrl.update_track_row_like_buttons()).not.toThrow();
        expect(btn.getAttribute('aria-pressed')).toBe('false');
    });
});

describe('bind_track_row_like_buttons', () => {
    it('posts the new like state and refreshes the ui', async () => {
        const btn = make_like_button('p1', 't1');
        const { ctrl } = make_controller();
        const fetch_fn = stub_fetch_routes({
            '/api/track/like': () => ({ ok: true, json: async () => ({}) }),
            '/api/liked-keys': () => ({ ok: true, json: async () => ({ keys: ['p1|t1'] }) }),
        });
        ctrl.bind_track_row_like_buttons();
        expect(btn.dataset.likeBound).toBe('1');

        btn.click();
        await flush_async();

        expect(fetch_fn).toHaveBeenCalledWith('/api/track/like', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_playlist_id: 'p1',
                source_track_id: 't1',
                liked: true,
            }),
        });
        expect(btn.getAttribute('aria-pressed')).toBe('true');
    });

    it('binds each button only once', () => {
        const btn = make_like_button('p1', 't1');
        const { ctrl } = make_controller();
        ctrl.bind_track_row_like_buttons();
        ctrl.bind_track_row_like_buttons();
        expect(btn.dataset.likeBound).toBe('1');
    });

    it('ignores clicks on buttons without ids', async () => {
        const btn = document.createElement('button');
        btn.className = 'track-row-like';
        document.body.appendChild(btn);
        const { ctrl } = make_controller();
        const fetch_fn = stub_fetch_routes({});
        ctrl.bind_track_row_like_buttons();
        btn.click();
        await flush_async();
        expect(fetch_fn).not.toHaveBeenCalled();
    });

    it('does not refresh when the like request fails', async () => {
        const btn = make_like_button('p1', 't1');
        const { ctrl } = make_controller();
        const fetch_fn = stub_fetch_routes({
            '/api/track/like': () => ({ ok: false, json: async () => ({}) }),
        });
        ctrl.bind_track_row_like_buttons();
        btn.click();
        await flush_async();
        expect(fetch_fn).toHaveBeenCalledTimes(1);
    });
});

describe('update_like_button_ui', () => {
    it('disables both buttons when there is no track', () => {
        const desktop = make_player_like_button();
        const mobile = make_player_like_button();
        const { ctrl } = make_controller({
            currentTrackId: null,
            btnLike: desktop.btn,
            likeIconEl: desktop.icon,
            btnLikeMobile: mobile.btn,
            likeIconMobileEl: mobile.icon,
        });
        ctrl.update_like_button_ui();

        expect(desktop.btn.disabled).toBe(true);
        expect(desktop.btn.classList.contains('player-control-btn--muted')).toBe(true);
        expect(desktop.btn.getAttribute('title')).toBe('Like');
        expect(desktop.btn.getAttribute('aria-pressed')).toBe('false');
        expect(desktop.icon.classList.contains('fa-regular')).toBe(true);
        expect(mobile.btn.disabled).toBe(true);
        expect(mobile.icon.classList.contains('fa-regular')).toBe(true);
    });

    it('marks the buttons active for a liked track', () => {
        const desktop = make_player_like_button();
        const mobile = make_player_like_button();
        const { ctrl, hub } = make_controller({
            btnLike: desktop.btn,
            likeIconEl: desktop.icon,
            btnLikeMobile: mobile.btn,
            likeIconMobileEl: mobile.icon,
        });
        hub.likedKeysSet.add('p1|t1');
        ctrl.update_like_button_ui();

        expect(desktop.btn.disabled).toBe(false);
        expect(desktop.btn.classList.contains('player-control-btn--active')).toBe(true);
        expect(desktop.btn.getAttribute('title')).toBe('Unlike');
        expect(desktop.btn.getAttribute('aria-label')).toBe('Unlike');
        expect(desktop.btn.getAttribute('aria-pressed')).toBe('true');
        expect(desktop.icon.classList.contains('fa-solid')).toBe(true);
        expect(mobile.btn.getAttribute('aria-pressed')).toBe('true');
    });

    it('marks the buttons muted for an unliked track', () => {
        const desktop = make_player_like_button();
        const { ctrl } = make_controller({
            btnLike: desktop.btn,
            likeIconEl: desktop.icon,
        });
        ctrl.update_like_button_ui();
        expect(desktop.btn.classList.contains('player-control-btn--muted')).toBe(true);
        expect(desktop.btn.getAttribute('title')).toBe('Like');
        expect(desktop.icon.classList.contains('fa-regular')).toBe(true);
    });

    it('skips missing buttons and icons', () => {
        const { ctrl } = make_controller();
        expect(() => ctrl.update_like_button_ui()).not.toThrow();
    });
});

describe('attach_like_click_handler', () => {
    it('does nothing without a button', () => {
        const { ctrl } = make_controller();
        expect(() => ctrl.attach_like_click_handler(null)).not.toThrow();
    });

    it('ignores clicks while the button is disabled', async () => {
        const { btn } = make_player_like_button();
        btn.disabled = true;
        const { ctrl } = make_controller();
        const fetch_fn = stub_fetch_routes({});
        ctrl.attach_like_click_handler(btn);
        btn.click();
        await flush_async();
        expect(fetch_fn).not.toHaveBeenCalled();
    });

    it('ignores clicks without a current track', async () => {
        const { btn } = make_player_like_button();
        const { ctrl } = make_controller({ currentTrackId: null });
        const fetch_fn = stub_fetch_routes({});
        ctrl.attach_like_click_handler(btn);
        btn.click();
        await flush_async();
        expect(fetch_fn).not.toHaveBeenCalled();
    });

    it('posts the like, refreshes keys and reloads the catalog', async () => {
        const { btn, icon } = make_player_like_button();
        const { ctrl } = make_controller({
            btnLike: btn,
            likeIconEl: icon,
        });
        const catalog = [{ id: 'p1' }];
        const fetch_fn = stub_fetch_routes({
            '/api/track/like': () => ({ ok: true, json: async () => ({}) }),
            '/api/liked-keys': () => ({ ok: true, json: async () => ({ keys: ['p1|t1'] }) }),
            '/api/playlists/catalog': () => ({ ok: true, json: async () => catalog }),
        });
        ctrl.attach_like_click_handler(btn);
        btn.click();
        await flush_async();

        expect(fetch_fn).toHaveBeenCalledWith('/api/track/like', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_playlist_id: 'p1',
                source_track_id: 't1',
                liked: true,
            }),
        });
        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(window.__playlistsCatalog).toEqual(catalog);
    });

    it('does not refresh when the like request fails', async () => {
        const { btn } = make_player_like_button();
        const { ctrl } = make_controller();
        const fetch_fn = stub_fetch_routes({
            '/api/track/like': () => ({ ok: false, json: async () => ({}) }),
        });
        ctrl.attach_like_click_handler(btn);
        btn.click();
        await flush_async();
        expect(fetch_fn).toHaveBeenCalledTimes(1);
        expect(window.__playlistsCatalog).toBeUndefined();
    });
});

describe('_resetLikeButtons', () => {
    it('re-enables the buttons and resets the icons', () => {
        const desktop = make_player_like_button();
        const mobile = make_player_like_button();
        desktop.btn.disabled = true;
        desktop.btn.classList.add('player-control-btn--active');
        desktop.icon.classList.add('fa-solid');
        mobile.btn.disabled = true;
        mobile.icon.classList.add('fa-solid');

        const lyrics_mobile = document.createElement('button');
        lyrics_mobile.id = 'btn-lyrics-mobile';
        lyrics_mobile.classList.add('opacity-50', 'pointer-events-none');
        document.body.appendChild(lyrics_mobile);
        const lyrics_desktop = document.createElement('button');
        lyrics_desktop.id = 'btn-lyrics-desktop';
        lyrics_desktop.classList.add('opacity-50', 'pointer-events-none');
        document.body.appendChild(lyrics_desktop);

        const { ctrl, hub } = make_controller({
            btnLike: desktop.btn,
            likeIconEl: desktop.icon,
            btnLikeMobile: mobile.btn,
            likeIconMobileEl: mobile.icon,
        });
        ctrl._resetLikeButtons(hub);

        expect(desktop.btn.disabled).toBe(false);
        expect(desktop.btn.classList.contains('player-control-btn--muted')).toBe(true);
        expect(desktop.btn.classList.contains('player-control-btn--active')).toBe(false);
        expect(desktop.icon.classList.contains('fa-regular')).toBe(true);
        expect(mobile.btn.disabled).toBe(false);
        expect(mobile.icon.classList.contains('fa-regular')).toBe(true);
        expect(lyrics_mobile.classList.contains('opacity-50')).toBe(false);
        expect(lyrics_mobile.classList.contains('pointer-events-none')).toBe(false);
        expect(lyrics_desktop.classList.contains('opacity-50')).toBe(false);
    });

    it('tolerates a hub without buttons', () => {
        const { ctrl, hub } = make_controller();
        expect(() => ctrl._resetLikeButtons(hub)).not.toThrow();
    });
});
