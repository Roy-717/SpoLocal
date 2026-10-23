import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistTransportController } from '../../static/js/player/transport_controller.js';

function makeTransport(hubOverrides = {}) {
    const hub = {
        audio: { pause: vi.fn(), play: vi.fn(() => Promise.resolve()), currentTime: 0, src: '' },
        repeatMode: 'off',
        shuffleMode: 'mix',
        shuffleOn: false,
        randomMode: false,
        currentTrackId: 't1',
        playbackContext: 'playlist',
        playlistId: 'p1',
        playable: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
        ...hubOverrides,
    };
    const transport = new PlaylistTransportController({ hub });
    transport.playTrackById = vi.fn();
    transport.play_rec_or_mix_row = vi.fn(() => true);
    transport.stop_playback = vi.fn();
    return { transport, hub };
}

function mount_recs(vids) {
    document.body.innerHTML = '<div id="playlist-recommendations-grid"></div>';
    const grid = document.getElementById('playlist-recommendations-grid');
    const table = document.createElement('table');
    table.id = 'playlist-recommendations-table';
    const tbody = document.createElement('tbody');
    vids.forEach((vid) => {
        const tr = document.createElement('tr');
        tr.className = 'track-row';
        tr.setAttribute('data-youtube-video-id', vid);
        tr.setAttribute('data-title', 'Title ' + vid);
        tr.setAttribute('data-artist', 'Artist ' + vid);
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    grid.appendChild(table);
    return grid;
}

function kinds(order) {
    return order.map((e) => e.kind + ':' + (e.kind === 'track' ? e.id : e.video_id));
}

beforeEach(() => {
    document.body.innerHTML = '';
    delete window.playPreview;
    delete window.ensurePlaylistRecommendations;
});

describe('mix_rec_entries', () => {
    it('reads the rendered recommendation rows', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport();
        expect(transport.mix_rec_entries()).toEqual([
            { kind: 'rec', video_id: 'r1', title: 'Title r1', artist: 'Artist r1' },
            { kind: 'rec', video_id: 'r2', title: 'Title r2', artist: 'Artist r2' },
        ]);
    });

    it('returns an empty list without a recommendations table', () => {
        const { transport } = makeTransport();
        expect(transport.mix_rec_entries()).toEqual([]);
    });
});

describe('mix_order', () => {
    it('includes every track and every recommendation', () => {
        mount_recs(['r1', 'r2', 'r3']);
        const { transport } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order()).sort()).toEqual([
            'rec:r1', 'rec:r2', 'rec:r3', 'track:t1', 'track:t2', 'track:t3', 'track:t4',
        ]);
    });

    it('includes every track for a one track playlist', () => {
        mount_recs(['r1', 'r2', 'r3', 'r4']);
        const { transport } = makeTransport({ playable: [{ id: 't1' }] });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order()).sort()).toEqual([
            'rec:r1', 'rec:r2', 'rec:r3', 'rec:r4', 'track:t1',
        ]);
    });

    it('keeps the tracks when there are no recommendations', () => {
        const { transport } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        expect(kinds(transport.mix_order())).toEqual(['track:t1', 'track:t2', 'track:t3', 'track:t4']);
    });

    it('caches the order until the tracks or recommendations change', () => {
        mount_recs(['r1', 'r2']);
        const { transport, hub } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        const first = transport.mix_order();
        expect(transport.mix_order()).toBe(first);
        expect(hub.mixOrder).toBe(first);

        mount_recs(['r1', 'r2', 'r3', 'r4']);
        expect(transport.mix_order()).not.toBe(first);
    });

    it('shuffles the whole order', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport();
        transport.shuffle = { shuffleArrayInPlace: vi.fn((arr) => arr.reverse()) };
        const order = transport.mix_order();
        expect(transport.shuffle.shuffleArrayInPlace).toHaveBeenCalledWith(order);
        expect(kinds(order)).toEqual([
            'rec:r2', 'rec:r1', 'track:t4', 'track:t3', 'track:t2', 'track:t1',
        ]);
    });
});

describe('mix_current_index', () => {
    it('finds the current playlist track', () => {
        const { transport } = makeTransport({ currentTrackId: 't3' });
        const order = transport.mix_order();
        expect(transport.mix_current_index(order)).toBe(2);
    });

    it('finds the current recommendation by video id', () => {
        mount_recs(['r1', 'r2']);
        const { transport, hub } = makeTransport({ playbackContext: 'recs' });
        hub.searchStreamHit = { video_id: 'r1' };
        const order = transport.mix_order();
        expect(transport.mix_current_index(order)).toBe(4);
    });

    it('returns -1 for an unknown current item', () => {
        const { transport } = makeTransport({ currentTrackId: 'nope' });
        expect(transport.mix_current_index(transport.mix_order())).toBe(-1);
    });
});

describe('play_mix_entry', () => {
    it('plays a playlist track by id', () => {
        const { transport } = makeTransport();
        expect(transport.play_mix_entry({ kind: 'track', id: 't2' })).toBe(true);
        expect(transport.playTrackById).toHaveBeenCalledWith('t2');
    });

    it('plays a recommendation through its rendered row', () => {
        mount_recs(['r1']);
        const { transport } = makeTransport();
        const row = document.querySelector('tr[data-youtube-video-id="r1"]');
        expect(transport.play_mix_entry({ kind: 'rec', video_id: 'r1' })).toBe(true);
        expect(transport.play_rec_or_mix_row).toHaveBeenCalledWith(row);
    });

    it('falls back to playPreview when the row is gone', () => {
        const playPreview = vi.fn();
        window.playPreview = playPreview;
        const { transport } = makeTransport();
        expect(transport.play_mix_entry({ kind: 'rec', video_id: 'r9', title: 'T', artist: 'A' })).toBe(true);
        expect(playPreview).toHaveBeenCalledWith({
            video_id: 'r9',
            title: 'T',
            artist: 'A',
            channel: 'A',
        }, null);
    });

    it('returns false for an empty entry', () => {
        const { transport } = makeTransport();
        expect(transport.play_mix_entry(null)).toBe(false);
    });
});

describe('playAtDeltaMix', () => {
    it('advances to the next entry in the mix', () => {
        mount_recs(['r1', 'r2']);
        const { transport } = makeTransport({ currentTrackId: 't2' });
        transport.playAtDeltaMix(1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t3');
    });

    it('wraps from the last entry to the first', () => {
        const { transport } = makeTransport({ currentTrackId: 't4' });
        transport.playAtDeltaMix(1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t1');
    });

    it('wraps backwards from the first entry to the last', () => {
        const { transport } = makeTransport({ currentTrackId: 't1' });
        transport.playAtDeltaMix(-1);
        expect(transport.playTrackById).toHaveBeenCalledWith('t4');
    });

    it('reshuffles a fresh cycle instead of repeating the same order', () => {
        const { transport } = makeTransport({ currentTrackId: 't4' });
        transport.mix_order();
        transport.shuffle = { shuffleArrayInPlace: vi.fn((arr) => arr.reverse()) };
        transport.playAtDeltaMix(1);
        expect(kinds(transport.mix_order())).toEqual(['track:t4', 'track:t3', 'track:t2', 'track:t1']);
        expect(transport.playTrackById).toHaveBeenCalledWith('t3');
    });

    it('keeps the current entry first when the cycle restarts', () => {
        const { transport } = makeTransport({ currentTrackId: 't2' });
        transport.shuffle = { shuffleArrayInPlace: vi.fn() };
        const current = transport.mix_order().find((e) => e.id === 't2');
        const order = transport.reshuffle_mix_order(current);
        expect(order[0]).toBe(current);
        expect(order.length).toBe(4);
    });

    it('asks for recommendations when the mix has none', () => {
        const { transport } = makeTransport();
        transport.ensure_mix_recommendations = vi.fn();
        transport.playAtDeltaMix(1);
        expect(transport.ensure_mix_recommendations).toHaveBeenCalled();
    });

    it('stops when there is nothing to play', () => {
        const { transport } = makeTransport({ playable: [] });
        transport.playAtDeltaMix(1);
        expect(transport.stop_playback).toHaveBeenCalled();
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });
});

describe('ensure_mix_recommendations', () => {
    it('requests recommendations once per playlist', () => {
        const ensure = vi.fn();
        window.ensurePlaylistRecommendations = ensure;
        const { transport, hub } = makeTransport();
        transport.ensure_mix_recommendations();
        transport.ensure_mix_recommendations();
        expect(ensure).toHaveBeenCalledTimes(1);
        expect(ensure).toHaveBeenCalledWith('p1');
        expect(hub.mixOrder).toBeNull();

        hub.playlistId = 'p2';
        transport.ensure_mix_recommendations();
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(ensure).toHaveBeenLastCalledWith('p2');
    });

    it('does nothing without a playlist id or the shell hook', () => {
        const ensure = vi.fn();
        window.ensurePlaylistRecommendations = ensure;
        const no_pid = makeTransport({ playlistId: '' });
        no_pid.transport.ensure_mix_recommendations();
        expect(ensure).not.toHaveBeenCalled();

        delete window.ensurePlaylistRecommendations;
        const no_hook = makeTransport();
        expect(() => no_hook.transport.ensure_mix_recommendations()).not.toThrow();
    });
});
