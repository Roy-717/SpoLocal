import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import { PlaylistTransportController } from '../../static/js/player/transport_controller.js';

function entry(trackId, playlistId = 'p1') {
    return {
        playlist_id: playlistId,
        track_id: trackId,
        play_src: '/media/' + trackId + '.webm',
        title: trackId,
        artist: 'A',
    };
}

function makeTransport(hubOverrides = {}) {
    const hub = {
        audio: {
            pause: vi.fn(),
            play: vi.fn(() => Promise.resolve()),
            currentTime: 12,
        },
        repeatMode: 'off',
        shuffleOn: false,
        randomMode: false,
        currentTrackId: 't2',
        playingPlaylistId: 'p1',
        libraryPool: [],
        playable: [],
        manual_up_next_queue: [],
        ...hubOverrides,
    };
    const transport = new PlaylistTransportController({ hub });
    transport.playLibraryEntry = vi.fn();
    transport.skip_rec_or_mix_row = vi.fn();
    transport.playAtDeltaPlaylistBody = vi.fn();
    transport.playAtDeltaMix = vi.fn();
    transport.playAtDeltaRandomMode = vi.fn(() => true);
    transport.pick_random_library_entry = vi.fn(() => entry('t9'));
    return { transport, hub };
}

beforeEach(() => {
    localStorage.clear();
});

describe('playAtDelta routing', () => {
    it('sends recommendations playback to the rec/mix rows', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'recs' });
        transport.playAtDelta(1);
        expect(transport.skip_rec_or_mix_row).toHaveBeenCalledWith(1);
        expect(transport.playAtDeltaPlaylistBody).not.toHaveBeenCalled();
        expect(hub.audio.pause).not.toHaveBeenCalled();
    });

    it('sends library playback to the library pool', () => {
        const { transport } = makeTransport({ playbackContext: 'library' });
        transport.playAtDelta(1);
        expect(transport.playAtDeltaPlaylistBody).not.toHaveBeenCalled();
        expect(transport.skip_rec_or_mix_row).not.toHaveBeenCalled();
    });

    it('keeps playlist playback in the playlist even when a rec row matches', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'playlist' });
        hub.playable = [{ id: 't2' }, { id: 't3' }];
        transport.playAtDelta(1);
        expect(transport.playAtDeltaPlaylistBody).toHaveBeenCalledWith(1);
        expect(transport.skip_rec_or_mix_row).not.toHaveBeenCalled();
    });

    it('routes playlist playback through the mix in mix mode', () => {
        const { transport } = makeTransport({ playbackContext: 'playlist', repeatMode: 'mix' });
        transport.playAtDelta(1);
        expect(transport.playAtDeltaMix).toHaveBeenCalledWith(1);
        expect(transport.playAtDeltaPlaylistBody).not.toHaveBeenCalled();
        expect(transport.skip_rec_or_mix_row).not.toHaveBeenCalled();
    });

    it('keeps library playback out of the mix', () => {
        const { transport } = makeTransport({ playbackContext: 'library', repeatMode: 'mix' });
        transport.playAtDelta(1);
        expect(transport.playAtDeltaMix).not.toHaveBeenCalled();
    });

    it('keeps random mode out of the mix', () => {
        const { transport } = makeTransport({ playbackContext: 'playlist', repeatMode: 'mix', randomMode: true });
        transport.playAtDelta(1);
        expect(transport.playAtDeltaMix).not.toHaveBeenCalled();
    });
});

describe('playAtDeltaLibrary', () => {
    it('advances to the next track in the visible ranking', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library' });
        hub.libraryOrder = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(1);
        expect(transport.playLibraryEntry).toHaveBeenCalledWith(entry('t3'), 'library');
    });

    it('goes back to the previous track', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library' });
        hub.libraryOrder = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(-1);
        expect(transport.playLibraryEntry).toHaveBeenCalledWith(entry('t1'), 'library');
    });

    it('stops at the end when repeat is off', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library' });
        hub.currentTrackId = 't3';
        hub.libraryOrder = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(1);
        expect(transport.playLibraryEntry).not.toHaveBeenCalled();
        expect(hub.audio.pause).toHaveBeenCalled();
    });

    it('wraps around when repeat is all', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library', repeatMode: 'all' });
        hub.currentTrackId = 't3';
        hub.libraryOrder = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(1);
        expect(transport.playLibraryEntry).toHaveBeenCalledWith(entry('t1'), 'library');
    });

    it('restarts the track when repeat is one', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library', repeatMode: 'one' });
        hub.libraryOrder = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(1);
        expect(hub.audio.currentTime).toBe(0);
        expect(hub.audio.play).toHaveBeenCalled();
        expect(transport.playLibraryEntry).not.toHaveBeenCalled();
    });

    it('picks a random track when shuffle is on', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library', shuffleOn: true });
        hub.libraryOrder = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(1);
        expect(transport.pick_random_library_entry).toHaveBeenCalled();
        expect(transport.playLibraryEntry).toHaveBeenCalledWith(entry('t9'), 'library');
    });

    it('falls back to the whole library pool without a ranking', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library' });
        hub.libraryPool = [entry('t1'), entry('t2'), entry('t3')];
        transport.playAtDelta(1);
        expect(transport.playLibraryEntry).toHaveBeenCalledWith(entry('t3'), 'library');
    });

    it('pauses when the library is empty', () => {
        const { transport, hub } = makeTransport({ playbackContext: 'library' });
        transport.playAtDelta(1);
        expect(hub.audio.pause).toHaveBeenCalled();
        expect(transport.playLibraryEntry).not.toHaveBeenCalled();
    });
});

describe('library_playback_entries', () => {
    it('drops ranking rows that cannot be played', () => {
        const { transport, hub } = makeTransport();
        hub.libraryOrder = [entry('t1'), { playlist_id: 'p1', track_id: 't2', play_src: '' }];
        const rows = transport.library_playback_entries();
        expect(rows.map((r) => r.track_id)).toEqual(['t1']);
    });

    it('uses the library pool when the ranking is empty', () => {
        const { transport, hub } = makeTransport();
        hub.libraryPool = [entry('t1')];
        expect(transport.library_playback_entries()).toEqual([entry('t1')]);
    });
});

describe('library_entry_index', () => {
    it('prefers the entry from the playing playlist', () => {
        const { transport, hub } = makeTransport();
        hub.currentTrackId = 't1';
        hub.playingPlaylistId = 'p2';
        const pool = [entry('t1', 'p1'), entry('t1', 'p2')];
        expect(transport.library_entry_index(pool)).toBe(1);
    });

    it('falls back to the track id alone', () => {
        const { transport, hub } = makeTransport();
        hub.currentTrackId = 't1';
        hub.playingPlaylistId = 'p9';
        const pool = [entry('t1', 'p1')];
        expect(transport.library_entry_index(pool)).toBe(0);
    });

    it('returns -1 for an unknown track', () => {
        const { transport, hub } = makeTransport();
        hub.currentTrackId = 'nope';
        expect(transport.library_entry_index([entry('t1')])).toBe(-1);
    });
});
