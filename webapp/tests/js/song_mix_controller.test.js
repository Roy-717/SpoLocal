import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SongMixController } from '../../static/js/player/song_mix_controller.js';

function make_state(overrides = {}) {
    const hub = {
        songMixView: false,
        lyricsVisible: false,
        lyricsPanel: null,
        ...overrides,
    };
    return { hub, state: { hub } };
}

function make_shell() {
    document.body.innerHTML = '<div id="spa-main"></div>';
    return document.getElementById('spa-main');
}

function ok_mix(data) {
    return {
        ok: true,
        json: async () => data,
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.closeGlobalSearch;
    delete window.renderSpolocalMixRows;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('constructor', () => {
    it('stores the state and starts at generation zero', () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        expect(controller.state).toBe(state);
        expect(controller.fetch_gen).toBe(0);
    });
});

describe('open_from_payload', () => {
    it('alerts when there is no usable id', () => {
        const alert_mock = vi.fn();
        vi.stubGlobal('alert', alert_mock);
        const { state } = make_state();
        const controller = new SongMixController(state);
        const open = vi.spyOn(controller, 'open').mockResolvedValue();

        controller.open_from_payload({ ytid: 'short' });

        expect(alert_mock).toHaveBeenCalledWith('No YouTube id for this song.');
        expect(open).not.toHaveBeenCalled();
    });

    it('opens with a valid video id and pushes history', () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        const open = vi.spyOn(controller, 'open').mockResolvedValue();

        controller.open_from_payload({
            ytid: 'abcdefghijk',
            title: 'Song',
            artist: 'Artist',
        });

        expect(open).toHaveBeenCalledWith({
            playlist_id: '',
            track_id: '',
            video_id: 'abcdefghijk',
            title: 'Song',
            artist: 'Artist',
            push: true,
        });
    });

    it('opens with playlist and track ids when the video id is missing', () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        const open = vi.spyOn(controller, 'open').mockResolvedValue();

        controller.open_from_payload({ playlistId: 'p1', trackId: 't1' });

        expect(open).toHaveBeenCalledWith({
            playlist_id: 'p1',
            track_id: 't1',
            video_id: '',
            title: '',
            artist: '',
            push: true,
        });
    });
});

describe('render_shell', () => {
    it('renders the mix header, message, and grid', () => {
        const shell = make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);

        controller.render_shell('Song', 'Artist');

        expect(shell.children.length).toBe(1);
        expect(shell.querySelector('h1').textContent).toBe('Song');
        expect(shell.textContent).toContain('MIX');
        expect(shell.textContent).toContain('Radio from Artist');
        expect(document.getElementById('song-mix-msg').textContent).toContain('Loading mix');
        expect(document.getElementById('song-mix-grid')).not.toBeNull();
    });

    it('uses fallback labels without a title or artist', () => {
        const shell = make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);

        controller.render_shell('', '');

        expect(shell.querySelector('h1').textContent).toBe('Song mix');
        expect(shell.textContent).toContain('Streamed YouTube Mix');
    });

    it('does nothing without the main shell', () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        expect(() => controller.render_shell('Song', 'Artist')).not.toThrow();
    });
});

describe('set_msg', () => {
    it('shows and hides the message element', () => {
        document.body.innerHTML = '<p id="song-mix-msg" class="hidden"></p>';
        const { state } = make_state();
        const controller = new SongMixController(state);
        const msg = document.getElementById('song-mix-msg');

        controller.set_msg('Hello');
        expect(msg.textContent).toBe('Hello');
        expect(msg.classList.contains('hidden')).toBe(false);

        controller.set_msg('');
        expect(msg.textContent).toBe('');
        expect(msg.classList.contains('hidden')).toBe(true);
    });

    it('does nothing without the message element', () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        expect(() => controller.set_msg('Hello')).not.toThrow();
    });
});

describe('open', () => {
    it('loads the mix, renders rows, and pushes history', async () => {
        make_shell();
        const { hub, state } = make_state();
        const controller = new SongMixController(state);
        const hits = [{ video_id: 'abcdefghijk', title: 'Hit' }];
        const fetch_mock = vi.fn(async () => ok_mix({ seed: { title: 'Seed', artist: 'Seed Artist' }, hits }));
        vi.stubGlobal('fetch', fetch_mock);
        const render = vi.fn();
        vi.stubGlobal('renderSpolocalMixRows', render);
        const close = vi.fn();
        vi.stubGlobal('closeGlobalSearch', close);
        const push = vi.spyOn(history, 'pushState');

        await controller.open({
            playlist_id: 'p1',
            track_id: 't1',
            video_id: 'abcdefghijk',
            title: 'Title',
            artist: 'Artist',
            push: true,
        });

        expect(fetch_mock).toHaveBeenCalledWith(
            '/api/track/mix?playlist_id=p1&track_id=t1&vid=abcdefghijk&limit=24',
        );
        expect(hub.songMixView).toBe(true);
        expect(close).toHaveBeenCalled();
        expect(render).toHaveBeenCalledWith(
            document.getElementById('song-mix-grid'),
            hits,
            { plus_menu: true, table_id: 'song-mix-table' },
        );
        expect(push).toHaveBeenCalled();
        expect(push.mock.calls[0][2].searchParams.get('view')).toBe('mix');
        expect(push.mock.calls[0][2].searchParams.get('playlist_id')).toBe('p1');
        expect(push.mock.calls[0][2].searchParams.get('track_id')).toBe('t1');
    });

    it('uses the seed title and artist from the response', async () => {
        const shell = make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ok_mix({
            seed: { title: 'Seed', artist: 'Seed Artist' },
            hits: [{ video_id: 'abcdefghijk' }],
        })));
        vi.stubGlobal('renderSpolocalMixRows', vi.fn());

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: false });

        expect(shell.querySelector('h1').textContent).toBe('Seed');
        expect(shell.textContent).toContain('Radio from Seed Artist');
    });

    it('hides the lyrics panel when it is visible', async () => {
        make_shell();
        const panel = document.createElement('div');
        panel.style.bottom = '10px';
        const { hub, state } = make_state({ lyricsVisible: true, lyricsPanel: panel });
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ok_mix({ seed: {}, hits: [{ video_id: 'abcdefghijk' }] })));
        vi.stubGlobal('renderSpolocalMixRows', vi.fn());

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: false });

        expect(hub.lyricsVisible).toBe(false);
        expect(panel.classList.contains('hidden')).toBe(true);
        expect(panel.style.bottom).toBe('');
    });

    it('shows a message when the mix has no hits', async () => {
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ok_mix({ seed: {}, hits: [] })));
        const render = vi.fn();
        vi.stubGlobal('renderSpolocalMixRows', render);

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: false });

        const msg = document.getElementById('song-mix-msg');
        expect(msg.textContent).toBe('No mix for this song.');
        expect(msg.classList.contains('hidden')).toBe(false);
        expect(render).not.toHaveBeenCalled();
    });

    it('shows a message when the response is not ok', async () => {
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: false });

        expect(document.getElementById('song-mix-msg').textContent).toBe('Could not load mix.');
    });

    it('shows a network message when fetch throws', async () => {
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('offline');
        }));

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: false });

        expect(document.getElementById('song-mix-msg').textContent).toBe('Could not load mix (network).');
    });

    it('drops a stale response', async () => {
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        const render = vi.fn();
        vi.stubGlobal('renderSpolocalMixRows', render);
        vi.stubGlobal('fetch', vi.fn(async () => {
            controller.fetch_gen += 1;
            return ok_mix({ seed: {}, hits: [{ video_id: 'abcdefghijk' }] });
        }));
        const push = vi.spyOn(history, 'pushState');

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: true });

        expect(render).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it('does not push history when push is false', async () => {
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ok_mix({ seed: {}, hits: [{ video_id: 'abcdefghijk' }] })));
        vi.stubGlobal('renderSpolocalMixRows', vi.fn());
        const push = vi.spyOn(history, 'pushState');

        await controller.open({ playlist_id: 'p1', track_id: 't1', push: false });

        expect(push).not.toHaveBeenCalled();
    });

    it('waits for the mix row renderer before pushing history', async () => {
        vi.useFakeTimers();
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ok_mix({ seed: {}, hits: [{ video_id: 'abcdefghijk' }] })));
        const push = vi.spyOn(history, 'pushState');

        const pending = controller.open({ playlist_id: 'p1', track_id: 't1', push: true });
        await vi.advanceTimersByTimeAsync(2100);
        await pending;

        expect(push).toHaveBeenCalled();
    });

    it('renders once the helper appears during the wait', async () => {
        vi.useFakeTimers();
        make_shell();
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => ok_mix({ seed: {}, hits: [{ video_id: 'abcdefghijk' }] })));
        const render = vi.fn();
        setTimeout(() => {
            window.renderSpolocalMixRows = render;
        }, 100);

        const pending = controller.open({ playlist_id: 'p1', track_id: 't1', push: false });
        await vi.advanceTimersByTimeAsync(200);
        await pending;

        expect(render).toHaveBeenCalled();
    });
});

describe('warm_hit_streams', () => {
    it('prepares each unique valid video id once', async () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        const fetch_mock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetch_mock);

        controller.warm_hit_streams([
            { video_id: 'abcdefghijk' },
            { video_id: 'abcdefghijk' },
            { video_id: 'short' },
            { video_id: '12345678901' },
        ]);

        await vi.waitFor(() => expect(fetch_mock).toHaveBeenCalledTimes(2));
        const urls = fetch_mock.mock.calls.map((call) => call[0]);
        expect(urls).toContain('/api/stream/prepare?vid=abcdefghijk');
        expect(urls).toContain('/api/stream/prepare?vid=12345678901');
    });

    it('does nothing for an empty list', async () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        const fetch_mock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetch_mock);

        controller.warm_hit_streams([]);
        await Promise.resolve();

        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('swallows prepare failures', async () => {
        const { state } = make_state();
        const controller = new SongMixController(state);
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('offline');
        }));

        expect(() => controller.warm_hit_streams([{ video_id: 'abcdefghijk' }])).not.toThrow();
        await Promise.resolve();
    });
});
