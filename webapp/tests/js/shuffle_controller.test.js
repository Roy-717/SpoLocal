import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistShuffleController } from '../../static/js/player/shuffle_controller.js';

function make_hub(overrides = {}) {
    return {
        LS_SHUFFLE: 'spolocal_shuffle',
        LS_REPEAT: 'spolocal_repeat',
        LS_SHUFFLE_ORDER: 'spolocal_shuffle_order',
        shuffleOn: false,
        shuffleMode: 'off',
        repeatMode: 'off',
        playable: [],
        playlistId: 'p1',
        shuffledOrder: [],
        btnShuffle: null,
        btnRepeat: null,
        repeatOneBadge: null,
        shuffleMixBadge: null,
        queueVisible: false,
        ...overrides,
    };
}

function make_controller(overrides = {}) {
    const hub = make_hub(overrides);
    const ctrl = new PlaylistShuffleController({ hub });
    return { ctrl, hub };
}

function sorted(values) {
    return values.slice().sort();
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
});

describe('setQueueRef', () => {
    it('stores the queue controller reference', () => {
        const { ctrl } = make_controller();
        const queue = { render_queue_list: vi.fn() };
        ctrl.setQueueRef(queue);
        expect(ctrl.queue).toBe(queue);
    });
});

describe('shuffle_mode', () => {
    it('falls back to the shuffle flag for older hubs', () => {
        const on = make_controller({ shuffleOn: true, shuffleMode: undefined });
        expect(on.ctrl.shuffle_mode()).toBe('shuffle');
        const off = make_controller({ shuffleOn: false, shuffleMode: undefined });
        expect(off.ctrl.shuffle_mode()).toBe('off');
    });

    it('returns the stored mode', () => {
        const mix = make_controller({ shuffleMode: 'mix' });
        expect(mix.ctrl.shuffle_mode()).toBe('mix');
    });
});

describe('persistShuffle', () => {
    it('writes the current shuffle mode', () => {
        const { ctrl, hub } = make_controller({ shuffleMode: 'shuffle' });
        ctrl.persistShuffle();
        expect(localStorage.getItem(hub.LS_SHUFFLE)).toBe('shuffle');
        hub.shuffleMode = 'mix';
        ctrl.persistShuffle();
        expect(localStorage.getItem(hub.LS_SHUFFLE)).toBe('mix');
        hub.shuffleMode = 'off';
        ctrl.persistShuffle();
        expect(localStorage.getItem(hub.LS_SHUFFLE)).toBe('off');
    });
});

describe('persistRepeat', () => {
    it('writes the current repeat mode', () => {
        const { ctrl, hub } = make_controller({ repeatMode: 'all' });
        ctrl.persistRepeat();
        expect(localStorage.getItem(hub.LS_REPEAT)).toBe('all');
        hub.repeatMode = 'one';
        ctrl.persistRepeat();
        expect(localStorage.getItem(hub.LS_REPEAT)).toBe('one');
    });
});

describe('shuffleArrayInPlace', () => {
    it('returns the same array with the same elements', () => {
        const { ctrl } = make_controller();
        const arr = ['a', 'b', 'c', 'd', 'e'];
        const result = ctrl.shuffleArrayInPlace(arr);
        expect(result).toBe(arr);
        expect(sorted(result)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('handles empty and single element arrays', () => {
        const { ctrl } = make_controller();
        expect(ctrl.shuffleArrayInPlace([])).toEqual([]);
        expect(ctrl.shuffleArrayInPlace(['only'])).toEqual(['only']);
    });
});

describe('persist_shuffle_order_state', () => {
    it('removes the saved order when shuffle is off', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: false, playable: [{ id: 'a' }] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, 'old');
        ctrl.persist_shuffle_order_state();
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });

    it('removes the saved order when there is nothing playable', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: true, playable: [] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, 'old');
        ctrl.persist_shuffle_order_state();
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });

    it('writes playlist id and stringified order', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffledOrder: ['b', 'a'],
        });
        ctrl.persist_shuffle_order_state();
        expect(JSON.parse(localStorage.getItem(hub.LS_SHUFFLE_ORDER))).toEqual({
            playlist_id: 'p1',
            order: ['b', 'a'],
        });
    });

    it('does nothing without a playlist id', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playlistId: '',
            playable: [{ id: 'a' }],
            shuffledOrder: ['a'],
        });
        ctrl.persist_shuffle_order_state();
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });

    it('does nothing with an empty shuffled order', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playable: [{ id: 'a' }],
            shuffledOrder: [],
        });
        ctrl.persist_shuffle_order_state();
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });
});

describe('shuffle_order_matches_playable', () => {
    it('rejects non arrays and empty playable lists', () => {
        const { ctrl } = make_controller({ playable: [{ id: 'a' }] });
        expect(ctrl.shuffle_order_matches_playable(null)).toBe(false);
        expect(ctrl.shuffle_order_matches_playable('a')).toBe(false);
        const empty = make_controller({ playable: [] });
        expect(empty.ctrl.shuffle_order_matches_playable(['a'])).toBe(false);
    });

    it('accepts the same ids in a different order', () => {
        const { ctrl } = make_controller({ playable: [{ id: 'a' }, { id: 'b' }] });
        expect(ctrl.shuffle_order_matches_playable(['b', 'a'])).toBe(true);
    });

    it('compares ids as strings', () => {
        const { ctrl } = make_controller({ playable: [{ id: 1 }, { id: 2 }] });
        expect(ctrl.shuffle_order_matches_playable(['2', '1'])).toBe(true);
    });

    it('rejects different lengths and different ids', () => {
        const { ctrl } = make_controller({ playable: [{ id: 'a' }, { id: 'b' }] });
        expect(ctrl.shuffle_order_matches_playable(['a'])).toBe(false);
        expect(ctrl.shuffle_order_matches_playable(['a', 'c'])).toBe(false);
    });
});

describe('restore_shuffle_order_from_storage', () => {
    it('returns false when shuffle is off', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: false, playable: [{ id: 'a' }] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, JSON.stringify({ playlist_id: 'p1', order: ['a'] }));
        expect(ctrl.restore_shuffle_order_from_storage()).toBe(false);
    });

    it('returns false when nothing is stored', () => {
        const { ctrl } = make_controller({ shuffleOn: true, playable: [{ id: 'a' }] });
        expect(ctrl.restore_shuffle_order_from_storage()).toBe(false);
    });

    it('drops a stored order for another playlist', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: true, playable: [{ id: 'a' }] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, JSON.stringify({ playlist_id: 'p2', order: ['a'] }));
        expect(ctrl.restore_shuffle_order_from_storage()).toBe(false);
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });

    it('drops a stored order that does not match the playable tracks', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: true, playable: [{ id: 'a' }, { id: 'b' }] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, JSON.stringify({ playlist_id: 'p1', order: ['a'] }));
        expect(ctrl.restore_shuffle_order_from_storage()).toBe(false);
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });

    it('restores the saved order using the original track ids', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: true, playable: [{ id: 1 }, { id: 2 }] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, JSON.stringify({ playlist_id: 'p1', order: ['2', '1'] }));
        expect(ctrl.restore_shuffle_order_from_storage()).toBe(true);
        expect(hub.shuffledOrder).toEqual([2, 1]);
    });

    it('drops invalid json and returns false', () => {
        const { ctrl, hub } = make_controller({ shuffleOn: true, playable: [{ id: 'a' }] });
        localStorage.setItem(hub.LS_SHUFFLE_ORDER, '{not json');
        expect(ctrl.restore_shuffle_order_from_storage()).toBe(false);
        expect(localStorage.getItem(hub.LS_SHUFFLE_ORDER)).toBeNull();
    });
});

describe('rebuildShuffledOrder', () => {
    it('builds a permutation of the playable ids and persists it', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        });
        ctrl.rebuildShuffledOrder();
        expect(sorted(hub.shuffledOrder)).toEqual(['a', 'b', 'c']);
        const saved = JSON.parse(localStorage.getItem(hub.LS_SHUFFLE_ORDER));
        expect(saved.playlist_id).toBe('p1');
        expect(sorted(saved.order)).toEqual(['a', 'b', 'c']);
    });
});

describe('syncShuffleOrderWithPlaylist', () => {
    it('does nothing when shuffle is off or nothing is playable', () => {
        const off = make_controller({ shuffleOn: false, playable: [{ id: 'a' }], shuffledOrder: [] });
        off.ctrl.syncShuffleOrderWithPlaylist();
        expect(off.hub.shuffledOrder).toEqual([]);

        const empty = make_controller({ shuffleOn: true, playable: [], shuffledOrder: ['x'] });
        empty.ctrl.syncShuffleOrderWithPlaylist();
        expect(empty.hub.shuffledOrder).toEqual(['x']);
    });

    it('keeps a matching order untouched', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffledOrder: ['b', 'a'],
        });
        const before = hub.shuffledOrder;
        ctrl.syncShuffleOrderWithPlaylist();
        expect(hub.shuffledOrder).toBe(before);
    });

    it('rebuilds when the length differs', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffledOrder: ['a'],
        });
        ctrl.syncShuffleOrderWithPlaylist();
        expect(sorted(hub.shuffledOrder)).toEqual(['a', 'b']);
    });

    it('rebuilds when the order contains an unknown id', () => {
        const { ctrl, hub } = make_controller({
            shuffleOn: true,
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffledOrder: ['a', 'zzz'],
        });
        ctrl.syncShuffleOrderWithPlaylist();
        expect(sorted(hub.shuffledOrder)).toEqual(['a', 'b']);
    });
});

describe('updateShuffleRepeatUi', () => {
    it('marks the shuffle button active when shuffle is on', () => {
        const btnShuffle = document.createElement('button');
        const { ctrl } = make_controller({ shuffleMode: 'shuffle', btnShuffle });
        ctrl.updateShuffleRepeatUi();
        expect(btnShuffle.classList.contains('player-control-btn--active')).toBe(true);
        expect(btnShuffle.classList.contains('player-control-btn--muted')).toBe(false);
        expect(btnShuffle.getAttribute('aria-pressed')).toBe('true');
    });

    it('marks the shuffle button muted when shuffle is off', () => {
        const btnShuffle = document.createElement('button');
        const { ctrl } = make_controller({ shuffleMode: 'off', btnShuffle });
        ctrl.updateShuffleRepeatUi();
        expect(btnShuffle.classList.contains('player-control-btn--active')).toBe(false);
        expect(btnShuffle.classList.contains('player-control-btn--muted')).toBe(true);
        expect(btnShuffle.getAttribute('aria-pressed')).toBe('false');
    });

    it('sets the shuffle title for each mode', () => {
        const btnShuffle = document.createElement('button');
        const { ctrl, hub } = make_controller({ shuffleMode: 'off', btnShuffle });

        ctrl.updateShuffleRepeatUi();
        expect(btnShuffle.getAttribute('title')).toBe('Shuffle: off');

        hub.shuffleMode = 'shuffle';
        ctrl.updateShuffleRepeatUi();
        expect(btnShuffle.getAttribute('title')).toBe('Shuffle: on');

        hub.shuffleMode = 'mix';
        ctrl.updateShuffleRepeatUi();
        expect(btnShuffle.getAttribute('title')).toBe('Mix: playlist + recommendations');
    });

    it('sets the repeat title for each mode', () => {
        const btnRepeat = document.createElement('button');
        const { ctrl, hub } = make_controller({ repeatMode: 'off', btnRepeat });

        ctrl.updateShuffleRepeatUi();
        expect(btnRepeat.getAttribute('title')).toBe('Repeat: off');
        expect(btnRepeat.getAttribute('aria-pressed')).toBe('false');

        hub.repeatMode = 'all';
        ctrl.updateShuffleRepeatUi();
        expect(btnRepeat.getAttribute('title')).toBe('Repeat: all');
        expect(btnRepeat.getAttribute('aria-pressed')).toBe('true');

        hub.repeatMode = 'one';
        ctrl.updateShuffleRepeatUi();
        expect(btnRepeat.getAttribute('title')).toBe('Repeat one');
        expect(btnRepeat.getAttribute('aria-pressed')).toBe('true');

        hub.repeatMode = 'off';
        ctrl.updateShuffleRepeatUi();
        expect(btnRepeat.getAttribute('title')).toBe('Repeat: off');
        expect(btnRepeat.getAttribute('aria-pressed')).toBe('false');
    });

    it('shows the mix badge only in mix mode', () => {
        const shuffleMixBadge = document.createElement('span');
        const { ctrl, hub } = make_controller({ shuffleMode: 'mix', shuffleMixBadge });
        ctrl.updateShuffleRepeatUi();
        expect(shuffleMixBadge.classList.contains('hidden')).toBe(false);
        hub.shuffleMode = 'shuffle';
        ctrl.updateShuffleRepeatUi();
        expect(shuffleMixBadge.classList.contains('hidden')).toBe(true);
    });

    it('shows the repeat-one badge only in repeat one mode', () => {
        const repeatOneBadge = document.createElement('span');
        const { ctrl, hub } = make_controller({ repeatMode: 'one', repeatOneBadge });
        ctrl.updateShuffleRepeatUi();
        expect(repeatOneBadge.classList.contains('hidden')).toBe(false);
        hub.repeatMode = 'all';
        ctrl.updateShuffleRepeatUi();
        expect(repeatOneBadge.classList.contains('hidden')).toBe(true);
    });

    it('re-renders the queue only when it is visible and a queue is set', () => {
        const queue = { render_queue_list: vi.fn() };
        const hidden = make_controller({ queueVisible: false });
        hidden.ctrl.setQueueRef(queue);
        hidden.ctrl.updateShuffleRepeatUi();
        expect(queue.render_queue_list).not.toHaveBeenCalled();

        const visible = make_controller({ queueVisible: true });
        visible.ctrl.setQueueRef(queue);
        visible.ctrl.updateShuffleRepeatUi();
        expect(queue.render_queue_list).toHaveBeenCalledTimes(1);

        const no_queue = make_controller({ queueVisible: true });
        expect(() => no_queue.ctrl.updateShuffleRepeatUi()).not.toThrow();
    });
});
