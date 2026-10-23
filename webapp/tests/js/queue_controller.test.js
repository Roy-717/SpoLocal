import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistQueueController } from '../../static/js/player/queue_controller.js';

function make_audio() {
    return {
        src: '',
        paused: true,
        currentTime: 0,
        duration: 0,
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

function make_hub(overrides = {}) {
    return {
        LS_MANUAL_QUEUE: 'spolocal_manual_queue',
        playlistId: 'p1',
        playingPlaylistId: 'p1',
        currentTrackId: null,
        tracks: [],
        playable: [],
        playingTracks: [],
        playingPlayable: [],
        manual_up_next_queue: [],
        resume_anchor_track_id: null,
        shuffleOn: false,
        repeatMode: 'off',
        shuffledOrder: [],
        queueVisible: false,
        queueList: null,
        queuePanel: null,
        queueClose: null,
        btnQueueMobile: null,
        btnQueueDesktop: null,
        lyricsVisible: false,
        lastPlayedTrackSnapshot: null,
        pendingRestoreOnMeta: null,
        audio: make_audio(),
        titleEl: document.createElement('div'),
        subEl: document.createElement('div'),
        ...overrides,
    };
}

function make_transport() {
    return {
        quality: { apply_track_loudness: vi.fn() },
        updatePlayingRow: vi.fn(),
        handlePlayError: vi.fn(),
        mediaSession: { updateMediaSessionMetadata: vi.fn() },
        likes: { update_like_button_ui: vi.fn() },
        shuffle: {
            syncShuffleOrderWithPlaylist: vi.fn(),
            rebuildShuffledOrder: vi.fn(),
        },
        playTrackById: vi.fn(),
    };
}

function make_controller(overrides = {}) {
    const hub = make_hub(overrides);
    const transport = make_transport();
    const ctrl = new PlaylistQueueController({ hub }, transport);
    return { ctrl, hub, transport };
}

function make_entry(track_id, overrides = {}) {
    return {
        source_playlist_id: 'p1',
        track_id: track_id,
        play_src: '/media/' + track_id + '.webm',
        title: 'Title ' + track_id,
        artist: 'Artist ' + track_id,
        album: 'Album ' + track_id,
        youtube_video_id: 'yt' + track_id,
        url: '/track/' + track_id,
        ...overrides,
    };
}

function make_queue_list() {
    const list = document.createElement('div');
    document.body.appendChild(list);
    return list;
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
    delete window.SpolocalMse;
    delete window.SpolocalCoverUrls;
});

describe('setCrossRefs', () => {
    it('stores the lyrics controller', () => {
        const { ctrl } = make_controller();
        const lyrics = { loadCover: vi.fn() };
        ctrl.setCrossRefs(lyrics);
        expect(ctrl.lyrics).toBe(lyrics);
    });
});

describe('normalize_queue_entry', () => {
    it('rejects non objects and entries missing required fields', () => {
        const { ctrl } = make_controller();
        expect(ctrl.normalize_queue_entry(null)).toBeNull();
        expect(ctrl.normalize_queue_entry('x')).toBeNull();
        expect(ctrl.normalize_queue_entry({ track_id: 't1', source_playlist_id: 'p1' })).toBeNull();
        expect(ctrl.normalize_queue_entry({ play_src: '/a', source_playlist_id: 'p1' })).toBeNull();
        expect(ctrl.normalize_queue_entry({ play_src: '/a', track_id: 't1' })).toBeNull();
    });

    it('trims ids and fills missing text fields', () => {
        const { ctrl } = make_controller();
        const entry = ctrl.normalize_queue_entry({
            play_src: '  /a.webm  ',
            track_id: '  t1  ',
            source_playlist_id: '  p1  ',
        });
        expect(entry).toEqual({
            source_playlist_id: 'p1',
            track_id: 't1',
            play_src: '/a.webm',
            title: '',
            artist: '',
            album: '',
            youtube_video_id: '',
            url: '',
        });
    });

    it('keeps the provided metadata', () => {
        const { ctrl } = make_controller();
        const entry = ctrl.normalize_queue_entry(make_entry('t1'));
        expect(entry.title).toBe('Title t1');
        expect(entry.artist).toBe('Artist t1');
        expect(entry.album).toBe('Album t1');
        expect(entry.youtube_video_id).toBe('ytt1');
        expect(entry.url).toBe('/track/t1');
    });
});

describe('persist_manual_queue_state', () => {
    it('does nothing without a playlist id', () => {
        const { ctrl, hub } = make_controller({ playlistId: '' });
        ctrl.persist_manual_queue_state();
        expect(localStorage.getItem(hub.LS_MANUAL_QUEUE)).toBeNull();
    });

    it('writes context, items and the resume anchor', () => {
        const { ctrl, hub } = make_controller({ resume_anchor_track_id: 't0' });
        hub.manual_up_next_queue.push(ctrl.normalize_queue_entry(make_entry('t1')));
        ctrl.persist_manual_queue_state();
        const saved = JSON.parse(localStorage.getItem(hub.LS_MANUAL_QUEUE));
        expect(saved.context_playlist_id).toBe('p1');
        expect(saved.resume_anchor_track_id).toBe('t0');
        expect(saved.items.length).toBe(1);
        expect(saved.items[0].track_id).toBe('t1');
        expect(saved.items[0].play_src).toBe('/media/t1.webm');
    });
});

describe('restore_manual_queue_from_storage', () => {
    it('does nothing when nothing is stored', () => {
        const { ctrl, hub } = make_controller();
        ctrl.restore_manual_queue_from_storage();
        expect(hub.manual_up_next_queue).toEqual([]);
    });

    it('drops state for another playlist', () => {
        const { ctrl, hub } = make_controller();
        localStorage.setItem(hub.LS_MANUAL_QUEUE, JSON.stringify({
            context_playlist_id: 'p2',
            items: [make_entry('t1')],
        }));
        ctrl.restore_manual_queue_from_storage();
        expect(hub.manual_up_next_queue).toEqual([]);
        expect(localStorage.getItem(hub.LS_MANUAL_QUEUE)).toBeNull();
    });

    it('restores valid items and the resume anchor', () => {
        const { ctrl, hub } = make_controller();
        localStorage.setItem(hub.LS_MANUAL_QUEUE, JSON.stringify({
            context_playlist_id: 'p1',
            items: [make_entry('t1'), { track_id: 'broken' }, make_entry('t2')],
            resume_anchor_track_id: '  t0  ',
        }));
        ctrl.restore_manual_queue_from_storage();
        expect(hub.manual_up_next_queue.map((e) => e.track_id)).toEqual(['t1', 't2']);
        expect(hub.resume_anchor_track_id).toBe('t0');
    });

    it('clears the anchor when it is empty', () => {
        const { ctrl, hub } = make_controller({ resume_anchor_track_id: 'old' });
        localStorage.setItem(hub.LS_MANUAL_QUEUE, JSON.stringify({
            context_playlist_id: 'p1',
            items: [],
            resume_anchor_track_id: '   ',
        }));
        ctrl.restore_manual_queue_from_storage();
        expect(hub.resume_anchor_track_id).toBeNull();
    });

    it('drops invalid json', () => {
        const { ctrl, hub } = make_controller();
        localStorage.setItem(hub.LS_MANUAL_QUEUE, '{not json');
        ctrl.restore_manual_queue_from_storage();
        expect(hub.manual_up_next_queue).toEqual([]);
        expect(localStorage.getItem(hub.LS_MANUAL_QUEUE)).toBeNull();
    });
});

describe('clear_manual_play_next_queue', () => {
    it('empties the queue, clears the anchor and persists', () => {
        const { ctrl, hub } = make_controller({ resume_anchor_track_id: 't0' });
        hub.manual_up_next_queue.push(ctrl.normalize_queue_entry(make_entry('t1')));
        ctrl.clear_manual_play_next_queue();
        expect(hub.manual_up_next_queue).toEqual([]);
        expect(hub.resume_anchor_track_id).toBeNull();
        const saved = JSON.parse(localStorage.getItem(hub.LS_MANUAL_QUEUE));
        expect(saved.items).toEqual([]);
        expect(saved.resume_anchor_track_id).toBeNull();
    });
});

describe('enqueue_manual_play_next', () => {
    it('rejects invalid entries', () => {
        const { ctrl, hub } = make_controller();
        expect(ctrl.enqueue_manual_play_next(null)).toBe(false);
        expect(hub.manual_up_next_queue).toEqual([]);
    });

    it('sets the resume anchor from the current track when the queue is empty', () => {
        const { ctrl, hub } = make_controller({
            currentTrackId: 't5',
            playable: [{ id: 't5' }],
        });
        expect(ctrl.enqueue_manual_play_next(make_entry('t1'))).toBe(true);
        expect(hub.resume_anchor_track_id).toBe('t5');
        expect(hub.manual_up_next_queue.length).toBe(1);
    });

    it('does not set an anchor when the current track is not playable', () => {
        const { ctrl, hub } = make_controller({
            currentTrackId: 't9',
            playable: [{ id: 't5' }],
        });
        ctrl.enqueue_manual_play_next(make_entry('t1'));
        expect(hub.resume_anchor_track_id).toBeNull();
    });

    it('keeps an existing anchor when the queue is not empty', () => {
        const { ctrl, hub } = make_controller({
            currentTrackId: 't5',
            playable: [{ id: 't5' }],
            resume_anchor_track_id: 't0',
        });
        hub.manual_up_next_queue.push(ctrl.normalize_queue_entry(make_entry('t1')));
        ctrl.enqueue_manual_play_next(make_entry('t2'));
        expect(hub.resume_anchor_track_id).toBe('t0');
        expect(hub.manual_up_next_queue.length).toBe(2);
    });

    it('persists and re-renders when the queue is visible', () => {
        const queueList = make_queue_list();
        const { ctrl, hub } = make_controller({ queueList, queueVisible: true });
        ctrl.enqueue_manual_play_next(make_entry('t1'));
        expect(localStorage.getItem(hub.LS_MANUAL_QUEUE)).not.toBeNull();
        expect(queueList.querySelectorAll('.queue-row').length).toBe(1);
    });
});

describe('play_track_from_queue_entry', () => {
    it('ignores invalid entries', () => {
        const { ctrl, hub, transport } = make_controller();
        ctrl.play_track_from_queue_entry(null);
        expect(hub.audio.src).toBe('');
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('loads the entry into the audio element and updates the UI', () => {
        const { ctrl, hub, transport } = make_controller({
            tracks: [{ id: 't1' }],
            playable: [{ id: 't1' }],
        });
        const lyrics = { loadCover: vi.fn(), fetchLyrics: vi.fn() };
        ctrl.setCrossRefs(lyrics);
        window.SpolocalMse = { stop: vi.fn() };

        ctrl.play_track_from_queue_entry(make_entry('t1'));

        expect(hub.playingPlaylistId).toBe('p1');
        expect(hub.currentTrackId).toBe('t1');
        expect(hub.audio.src).toBe('/media/t1.webm');
        expect(hub.titleEl.textContent).toBe('Title t1');
        expect(hub.subEl.textContent).toBe('Artist t1');
        expect(hub.lastPlayedTrackSnapshot.id).toBe('t1');
        expect(hub.lastPlayedTrackSnapshot.source_playlist_id).toBe('p1');
        expect(hub.playingTracks.length).toBe(1);
        expect(hub.playingPlayable.length).toBe(1);
        expect(window.SpolocalMse.stop).toHaveBeenCalled();
        expect(transport.quality.apply_track_loudness).toHaveBeenCalledWith(
            { id: 't1', loudness_gain_db: undefined },
            'p1',
        );
        expect(lyrics.loadCover).toHaveBeenCalledWith('t1', 'p1');
        expect(transport.updatePlayingRow).toHaveBeenCalled();
        expect(hub.audio.play).toHaveBeenCalled();
        expect(transport.mediaSession.updateMediaSessionMetadata).toHaveBeenCalled();
        expect(transport.likes.update_like_button_ui).toHaveBeenCalled();
    });

    it('keeps the current playlist tracks when the entry comes from another playlist', () => {
        const { ctrl, hub } = make_controller({
            tracks: [{ id: 'local' }],
            playable: [{ id: 'local' }],
        });
        ctrl.play_track_from_queue_entry(make_entry('t1', { source_playlist_id: 'p2' }));
        expect(hub.playingPlaylistId).toBe('p2');
        expect(hub.playingTracks).toEqual([]);
        expect(hub.playingPlayable).toEqual([]);
    });

    it('removes a pending metadata restore listener', () => {
        const { ctrl, hub } = make_controller();
        const pending = vi.fn();
        hub.pendingRestoreOnMeta = pending;
        ctrl.play_track_from_queue_entry(make_entry('t1'));
        expect(hub.audio.removeEventListener).toHaveBeenCalledWith('loadedmetadata', pending);
        expect(hub.pendingRestoreOnMeta).toBeNull();
    });

    it('fetches lyrics when the lyrics panel is visible', () => {
        const { ctrl, hub } = make_controller({ lyricsVisible: true });
        const lyrics = { loadCover: vi.fn(), fetchLyrics: vi.fn() };
        ctrl.setCrossRefs(lyrics);
        ctrl.play_track_from_queue_entry(make_entry('t1'));
        expect(lyrics.fetchLyrics).toHaveBeenCalledWith(true);
    });

    it('re-renders the queue when it is visible', () => {
        const queueList = make_queue_list();
        const { ctrl, hub } = make_controller({ queueList, queueVisible: true });
        ctrl.play_track_from_queue_entry(make_entry('t1'));
        expect(queueList.querySelectorAll('.queue-row').length).toBeGreaterThan(0);
    });
});

describe('play_next_from_resume_anchor', () => {
    it('pauses when there is nothing playable', () => {
        const { ctrl, hub } = make_controller({ playable: [] });
        ctrl.play_next_from_resume_anchor();
        expect(hub.audio.pause).toHaveBeenCalled();
    });

    it('plays the track after the current one', () => {
        const { ctrl, hub, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            currentTrackId: 'a',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.playTrackById).toHaveBeenCalledWith('b');
    });

    it('uses the resume anchor when it is playable', () => {
        const { ctrl, hub, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            resume_anchor_track_id: 'b',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.playTrackById).toHaveBeenCalledWith('c');
        expect(hub.resume_anchor_track_id).toBeNull();
    });

    it('falls back to the first playable track as anchor', () => {
        const { ctrl, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            resume_anchor_track_id: 'missing',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.playTrackById).toHaveBeenCalledWith('b');
    });

    it('pauses at the end when repeat is off', () => {
        const { ctrl, hub, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            resume_anchor_track_id: 'b',
            repeatMode: 'off',
        });
        ctrl.play_next_from_resume_anchor();
        expect(hub.audio.pause).toHaveBeenCalled();
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('wraps around when repeat is all', () => {
        const { ctrl, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            resume_anchor_track_id: 'b',
            repeatMode: 'all',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.playTrackById).toHaveBeenCalledWith('a');
    });

    it('clamps to the last track when repeat is one', () => {
        const { ctrl, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            resume_anchor_track_id: 'b',
            repeatMode: 'one',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.playTrackById).toHaveBeenCalledWith('b');
    });

    it('follows the shuffled order when shuffle is on', () => {
        const { ctrl, hub, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            shuffleOn: true,
            shuffledOrder: ['c', 'a', 'b'],
            resume_anchor_track_id: 'a',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.shuffle.syncShuffleOrderWithPlaylist).toHaveBeenCalled();
        expect(transport.playTrackById).toHaveBeenCalledWith('b');
    });

    it('rebuilds an empty shuffled order and stops when it stays empty', () => {
        const { ctrl, transport } = make_controller({
            playable: [{ id: 'a' }],
            shuffleOn: true,
            shuffledOrder: [],
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.shuffle.rebuildShuffledOrder).toHaveBeenCalled();
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('pauses at the end of the shuffled order when repeat is off', () => {
        const { ctrl, hub, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffleOn: true,
            shuffledOrder: ['a', 'b'],
            resume_anchor_track_id: 'b',
            repeatMode: 'off',
        });
        ctrl.play_next_from_resume_anchor();
        expect(hub.audio.pause).toHaveBeenCalled();
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('wraps the shuffled order when repeat is all', () => {
        const { ctrl, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffleOn: true,
            shuffledOrder: ['a', 'b'],
            resume_anchor_track_id: 'b',
            repeatMode: 'all',
        });
        ctrl.play_next_from_resume_anchor();
        expect(transport.playTrackById).toHaveBeenCalledWith('a');
    });
});

describe('get_queue_track_ids', () => {
    it('returns an empty list without playable tracks', () => {
        const { ctrl } = make_controller({ playable: [] });
        expect(ctrl.get_queue_track_ids()).toEqual([]);
    });

    it('returns the full order without a current track', () => {
        const { ctrl } = make_controller({ playable: [{ id: 'a' }, { id: 'b' }] });
        expect(ctrl.get_queue_track_ids()).toEqual(['a', 'b']);
    });

    it('starts at the current track when repeat is off', () => {
        const { ctrl } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            currentTrackId: 'b',
        });
        expect(ctrl.get_queue_track_ids()).toEqual(['b', 'c']);
    });

    it('rotates the order when repeat is all', () => {
        const { ctrl } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            currentTrackId: 'b',
            repeatMode: 'all',
        });
        expect(ctrl.get_queue_track_ids()).toEqual(['b', 'c', 'a']);
    });

    it('returns the full order when the current track is unknown', () => {
        const { ctrl } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            currentTrackId: 'zzz',
        });
        expect(ctrl.get_queue_track_ids()).toEqual(['a', 'b']);
    });

    it('uses the shuffled order when it matches', () => {
        const { ctrl } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            shuffleOn: true,
            shuffledOrder: ['c', 'a', 'b'],
            currentTrackId: 'a',
        });
        expect(ctrl.get_queue_track_ids()).toEqual(['a', 'b']);
    });

    it('uses the playing playlist when viewing another playlist', () => {
        const { ctrl } = make_controller({
            playlistId: 'p1',
            playingPlaylistId: 'p2',
            playable: [{ id: 'a' }],
            playingPlayable: [{ id: 'x' }, { id: 'y' }],
            shuffleOn: true,
            shuffledOrder: ['a'],
        });
        expect(ctrl.get_queue_track_ids()).toEqual(['x', 'y']);
    });

    it('syncs and rebuilds a mismatched shuffled order while viewing the playing playlist', () => {
        const { ctrl, hub, transport } = make_controller({
            playable: [{ id: 'a' }, { id: 'b' }],
            shuffleOn: true,
            shuffledOrder: [],
        });
        expect(ctrl.get_queue_track_ids()).toEqual([]);
        expect(transport.shuffle.syncShuffleOrderWithPlaylist).toHaveBeenCalled();
        expect(transport.shuffle.rebuildShuffledOrder).toHaveBeenCalled();
        expect(hub.shuffledOrder).toEqual([]);
    });
});

describe('render_queue_list', () => {
    it('does nothing without a queue list element', () => {
        const { ctrl } = make_controller();
        expect(() => ctrl.render_queue_list()).not.toThrow();
    });

    it('shows the empty message when nothing can be played', () => {
        const queueList = make_queue_list();
        const { ctrl } = make_controller({ queueList });
        ctrl.render_queue_list();
        expect(queueList.children.length).toBe(1);
        expect(queueList.textContent).toBe('No playable tracks in this playlist.');
    });

    it('renders the current track and plays it on click', () => {
        const queueList = make_queue_list();
        const { ctrl, hub, transport } = make_controller({
            queueList,
            currentTrackId: 'a',
            tracks: [{ id: 'a', play_src: '/a', title: 'A', artist: 'Ar' }],
            playingTracks: [{ id: 'a', play_src: '/a', title: 'A', artist: 'Ar' }],
            playable: [{ id: 'a' }],
        });
        ctrl.render_queue_list();
        const rows = queueList.querySelectorAll('.queue-row');
        expect(rows.length).toBe(1);
        expect(rows[0].classList.contains('queue-row--current')).toBe(true);
        rows[0].click();
        expect(transport.playTrackById).toHaveBeenCalledWith('a');
    });

    it('renders the last played snapshot and toggles playback on click', () => {
        const queueList = make_queue_list();
        const { ctrl, hub } = make_controller({
            queueList,
            currentTrackId: 'x',
            playingTracks: [],
            lastPlayedTrackSnapshot: {
                id: 'x',
                source_playlist_id: 'p1',
                title: 'X',
                artist: 'Y',
                youtube_video_id: 'ytx',
            },
        });
        ctrl.render_queue_list();
        const rows = queueList.querySelectorAll('.queue-row');
        expect(rows.length).toBe(1);
        rows[0].click();
        expect(hub.audio.play).toHaveBeenCalled();
        hub.audio.paused = false;
        rows[0].click();
        expect(hub.audio.pause).toHaveBeenCalled();
    });

    it('renders manual queue entries and plays the clicked one', () => {
        const queueList = make_queue_list();
        const { ctrl, hub, transport } = make_controller({ queueList });
        hub.manual_up_next_queue.push(ctrl.normalize_queue_entry(make_entry('t1')));
        hub.manual_up_next_queue.push(ctrl.normalize_queue_entry(make_entry('t2')));
        ctrl.render_queue_list();
        const rows = queueList.querySelectorAll('.queue-row');
        expect(rows.length).toBe(2);
        rows[1].click();
        expect(hub.manual_up_next_queue).toEqual([]);
        expect(hub.currentTrackId).toBe('t2');
        expect(transport.quality.apply_track_loudness).toHaveBeenCalled();
    });

    it('renders the upcoming tracks after the current one', () => {
        const queueList = make_queue_list();
        const { ctrl, transport } = make_controller({
            queueList,
            currentTrackId: 'b',
            tracks: [
                { id: 'a', play_src: '/a', title: 'A', artist: 'Ar' },
                { id: 'b', play_src: '/b', title: 'B', artist: 'Br' },
                { id: 'c', play_src: '/c', title: 'C', artist: 'Cr' },
            ],
            playingTracks: [
                { id: 'a', play_src: '/a', title: 'A', artist: 'Ar' },
                { id: 'b', play_src: '/b', title: 'B', artist: 'Br' },
                { id: 'c', play_src: '/c', title: 'C', artist: 'Cr' },
            ],
            playable: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        });
        ctrl.render_queue_list();
        const rows = queueList.querySelectorAll('.queue-row');
        expect(rows.length).toBe(2);
        rows[1].click();
        expect(transport.playTrackById).toHaveBeenCalledWith('c');
    });

    it('uses the cover helper when available and the fallback path otherwise', () => {
        const queueList = make_queue_list();
        const { ctrl } = make_controller({
            queueList,
            currentTrackId: 'a',
            playingTracks: [{ id: 'a', play_src: '/a', title: 'A', artist: 'Ar' }],
            playable: [{ id: 'a' }],
        });
        ctrl.render_queue_list();
        const first_img = queueList.querySelector('img');
        expect(first_img.getAttribute('src')).toBe('/playlists/p1/tracks/a/cover');

        window.SpolocalCoverUrls = { trackCoverUrl: vi.fn(() => '/cover/custom.jpg') };
        ctrl.render_queue_list();
        const second_img = queueList.querySelector('img');
        expect(second_img.getAttribute('src')).toBe('/cover/custom.jpg');
        expect(window.SpolocalCoverUrls.trackCoverUrl).toHaveBeenCalledWith('p1', 'a', undefined);
    });

    it('hides a cover image that fails to load', () => {
        const queueList = make_queue_list();
        const { ctrl } = make_controller({
            queueList,
            currentTrackId: 'a',
            playingTracks: [{ id: 'a', play_src: '/a', title: 'A', artist: 'Ar' }],
            playable: [{ id: 'a' }],
        });
        ctrl.render_queue_list();
        const img = queueList.querySelector('img');
        img.dispatchEvent(new Event('error'));
        expect(img.style.opacity).toBe('0');
    });
});

describe('render_queue_list in mix mode', () => {
    const order = [
        { kind: 'track', id: 'a' },
        { kind: 'rec', video_id: 'r1', title: 'R1', artist: 'AR1' },
        { kind: 'track', id: 'b' },
        { kind: 'rec', video_id: 'r2', title: 'R2', artist: 'AR2' },
    ];
    const playingTracks = [
        { id: 'a', play_src: '/a', title: 'A', artist: 'Ar' },
        { id: 'b', play_src: '/b', title: 'B', artist: 'Br' },
    ];

    function make_mix_controller(overrides = {}) {
        const out = make_controller({
            queueList: make_queue_list(),
            shuffleMode: 'mix',
            playbackContext: 'playlist',
            playingTracks: playingTracks,
            playable: [{ id: 'a' }, { id: 'b' }],
            ...overrides,
        });
        const { ctrl, hub, transport } = out;
        transport.mix_order = vi.fn(() => order);
        transport.current_stream_vid = vi.fn(() => String(hub.searchStreamHit && hub.searchStreamHit.video_id || ''));
        transport.mix_current_index = vi.fn((o) => {
            const vid = transport.current_stream_vid();
            if (hub.playbackContext === 'recs' && vid) {
                const ri = o.findIndex((e) => e.kind === 'rec' && e.video_id === vid);
                if (ri >= 0) return ri;
            }
            return o.findIndex((e) => e.kind === 'track' && e.id === hub.currentTrackId);
        });
        transport.play_mix_entry = vi.fn();
        return out;
    }

    it('lists the recommendations between the playlist tracks', () => {
        const { ctrl, hub } = make_mix_controller({ currentTrackId: 'a' });
        ctrl.render_queue_list();
        const rows = hub.queueList.querySelectorAll('.queue-row');
        expect(rows.length).toBe(4);
        expect(rows[0].classList.contains('queue-row--current')).toBe(true);
        expect(rows[1].querySelector('.queue-row-title').textContent).toBe('R1');
        expect(rows[2].querySelector('.queue-row-title').textContent).toBe('B');
        expect(rows[3].querySelector('.queue-row-title').textContent).toBe('R2');
    });

    it('asks the transport to load recommendations when the mix has none', () => {
        const { ctrl, transport } = make_mix_controller({ currentTrackId: 'a' });
        transport.mix_order = vi.fn(() => [{ kind: 'track', id: 'a' }, { kind: 'track', id: 'b' }]);
        transport.ensure_mix_recommendations = vi.fn();
        ctrl.render_queue_list();
        expect(transport.ensure_mix_recommendations).toHaveBeenCalled();
    });

    it('does not reload recommendations when the mix already has them', () => {
        const { ctrl, transport } = make_mix_controller({ currentTrackId: 'a' });
        transport.ensure_mix_recommendations = vi.fn();
        ctrl.render_queue_list();
        expect(transport.ensure_mix_recommendations).not.toHaveBeenCalled();
    });

    it('plays a recommendation when its row is clicked', () => {
        const { ctrl, hub, transport } = make_mix_controller({ currentTrackId: 'a' });
        ctrl.render_queue_list();
        hub.queueList.querySelectorAll('.queue-row')[1].click();
        expect(transport.play_mix_entry).toHaveBeenCalledWith(order[1]);
    });

    it('shows the streaming recommendation as the current row', () => {
        const { ctrl, hub } = make_mix_controller({
            currentTrackId: 'a',
            playbackContext: 'recs',
            searchStreamHit: { video_id: 'r2' },
        });
        ctrl.render_queue_list();
        const rows = hub.queueList.querySelectorAll('.queue-row');
        expect(rows.length).toBe(1);
        expect(rows[0].classList.contains('queue-row--current')).toBe(true);
        expect(rows[0].querySelector('.queue-row-title').textContent).toBe('R2');
    });

    it('falls back to the normal track queue outside mix mode', () => {
        const { ctrl, hub, transport } = make_mix_controller({
            currentTrackId: 'a',
            shuffleMode: 'shuffle',
        });
        ctrl.render_queue_list();
        expect(transport.mix_order).not.toHaveBeenCalled();
        expect(hub.queueList.querySelectorAll('.queue-row').length).toBe(2);
    });

    it('ignores mix mode in the library context', () => {
        const { ctrl, hub, transport } = make_mix_controller({
            currentTrackId: 'a',
            playbackContext: 'library',
        });
        ctrl.render_queue_list();
        expect(transport.mix_order).not.toHaveBeenCalled();
        expect(hub.queueList.querySelectorAll('.queue-row').length).toBe(2);
    });
});

describe('toggleQueue and visibility', () => {
    it('toggles the flag, the panel and the body class', () => {
        const panel = document.createElement('div');
        const { ctrl, hub } = make_controller({ queuePanel: panel });
        ctrl.toggleQueue();
        expect(hub.queueVisible).toBe(true);
        expect(panel.classList.contains('hidden')).toBe(false);
        expect(panel.getAttribute('aria-hidden')).toBe('false');
        expect(document.body.classList.contains('mobile-queue-open')).toBe(true);

        ctrl.toggleQueue();
        expect(hub.queueVisible).toBe(false);
        expect(panel.classList.contains('hidden')).toBe(true);
        expect(panel.getAttribute('aria-hidden')).toBe('true');
        expect(document.body.classList.contains('mobile-queue-open')).toBe(false);
    });

    it('renders the list when opening', () => {
        const queueList = make_queue_list();
        const { ctrl } = make_controller({ queueList });
        ctrl.toggleQueue();
        expect(queueList.textContent).toBe('No playable tracks in this playlist.');
    });

    it('syncs both queue buttons', () => {
        const btnQueueMobile = document.createElement('button');
        const btnQueueDesktop = document.createElement('button');
        const { ctrl, hub } = make_controller({ btnQueueMobile, btnQueueDesktop });
        hub.queueVisible = true;
        ctrl.sync_queue_button_ui();
        expect(btnQueueMobile.getAttribute('aria-pressed')).toBe('true');
        expect(btnQueueDesktop.getAttribute('aria-pressed')).toBe('true');
        expect(btnQueueMobile.classList.contains('player-control-btn--active')).toBe(true);
        expect(btnQueueDesktop.classList.contains('player-control-btn--active')).toBe(true);

        hub.queueVisible = false;
        ctrl.sync_queue_button_ui();
        expect(btnQueueMobile.getAttribute('aria-pressed')).toBe('false');
        expect(btnQueueDesktop.classList.contains('player-control-btn--active')).toBe(false);
    });
});

describe('init', () => {
    it('restores the queue and renders it when visible', () => {
        const queueList = make_queue_list();
        const { ctrl, hub } = make_controller({ queueList, queueVisible: true });
        localStorage.setItem(hub.LS_MANUAL_QUEUE, JSON.stringify({
            context_playlist_id: 'p1',
            items: [make_entry('t1')],
        }));
        ctrl.init();
        expect(hub.manual_up_next_queue.length).toBe(1);
        expect(queueList.querySelectorAll('.queue-row').length).toBe(1);
    });

    it('wires the toggle buttons only once', () => {
        const btnQueueMobile = document.createElement('button');
        const btnQueueDesktop = document.createElement('button');
        const { ctrl, hub } = make_controller({ btnQueueMobile, btnQueueDesktop });
        ctrl.init();
        ctrl.init();
        btnQueueMobile.click();
        expect(hub.queueVisible).toBe(true);
        btnQueueDesktop.click();
        expect(hub.queueVisible).toBe(false);
    });

    it('closes the queue with the close button', () => {
        const panel = document.createElement('div');
        const queueClose = document.createElement('button');
        panel.appendChild(queueClose);
        const { ctrl, hub } = make_controller({ queuePanel: panel, queueClose, queueVisible: true });
        ctrl.init();
        queueClose.click();
        expect(hub.queueVisible).toBe(false);
        expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('closes the queue on the force-close event', () => {
        const panel = document.createElement('div');
        const { ctrl, hub } = make_controller({ queuePanel: panel, queueVisible: true });
        ctrl.init();
        window.dispatchEvent(new Event('spolocal:force-close-queue'));
        expect(hub.queueVisible).toBe(false);
        expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('closes the queue when clicking outside the panel', () => {
        const panel = document.createElement('div');
        const { ctrl, hub } = make_controller({ queuePanel: panel, queueVisible: true });
        ctrl.init();
        document.body.click();
        expect(hub.queueVisible).toBe(false);
    });

    it('keeps the queue open when clicking inside the panel', () => {
        const panel = document.createElement('div');
        const inner = document.createElement('span');
        panel.appendChild(inner);
        document.body.appendChild(panel);
        const { ctrl, hub } = make_controller({ queuePanel: panel, queueVisible: true });
        ctrl.init();
        inner.click();
        expect(hub.queueVisible).toBe(true);
    });

    it('re-renders the mix queue when the recommendations finish loading', () => {
        const queueList = make_queue_list();
        const { ctrl, hub, transport } = make_controller({
            queueList,
            queueVisible: true,
            shuffleMode: 'mix',
        });
        transport.mix_order = vi.fn(() => []);
        transport.mix_current_index = vi.fn(() => -1);
        ctrl.init();
        const spy = vi.spyOn(ctrl, 'render_queue_list');
        window.dispatchEvent(new CustomEvent('spolocal:mix-recommendations-rendered'));
        expect(spy).toHaveBeenCalled();
    });

    it('keeps the queue untouched for other modes when recommendations load', () => {
        const queueList = make_queue_list();
        const { ctrl, transport } = make_controller({ queueList, queueVisible: true });
        transport.mix_order = vi.fn(() => []);
        ctrl.init();
        const spy = vi.spyOn(ctrl, 'render_queue_list');
        window.dispatchEvent(new CustomEvent('spolocal:mix-recommendations-rendered'));
        expect(spy).not.toHaveBeenCalled();
    });
});
