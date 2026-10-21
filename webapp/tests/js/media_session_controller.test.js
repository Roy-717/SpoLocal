import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistMediaSessionController } from '../../static/js/player/media_session_controller.js';

function make_audio(overrides = {}) {
    return {
        paused: true,
        currentTime: 0,
        duration: 0,
        playbackRate: 1,
        pause: vi.fn(),
        ...overrides,
    };
}

function make_hub(overrides = {}) {
    return {
        LS_LAST_PL: 'spolocal_last_playlist',
        LS_LAST_TR: 'spolocal_last_track',
        LS_LAST_POS: 'spolocal_last_position',
        playingPlaylistId: 'p1',
        playlistId: 'p1',
        currentTrackId: 't1',
        playable: [],
        audio: make_audio(),
        ...overrides,
    };
}

function make_transport() {
    return {
        playTrackById: vi.fn(),
        playAtDelta: vi.fn(),
        seek_audio_to: vi.fn(),
    };
}

function make_controller(overrides = {}) {
    const hub = make_hub(overrides);
    const transport = make_transport();
    const ctrl = new PlaylistMediaSessionController({ hub }, transport);
    return { ctrl, hub, transport };
}

function install_media_session(overrides = {}) {
    const session = {
        metadata: null,
        playbackState: 'none',
        setActionHandler: vi.fn(),
        setPositionState: vi.fn(),
        ...overrides,
    };
    Object.defineProperty(navigator, 'mediaSession', {
        configurable: true,
        value: session,
    });
    return session;
}

function remove_media_session() {
    try {
        delete navigator.mediaSession;
    } catch (e) {}
}

function install_media_metadata() {
    class FakeMediaMetadata {
        constructor(init) {
            Object.assign(this, init);
        }
    }
    vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
}

function handlers_by_action(session) {
    const map = {};
    session.setActionHandler.mock.calls.forEach((call) => {
        map[call[0]] = call[1];
    });
    return map;
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
    delete window.SpolocalCoverUrls;
    remove_media_session();
});

afterEach(() => {
    vi.unstubAllGlobals();
    remove_media_session();
});

describe('updateMediaSessionMetadata', () => {
    it('does nothing without the media session api', () => {
        const { ctrl } = make_controller();
        expect(() => ctrl.updateMediaSessionMetadata({ id: 't1', title: 'T' })).not.toThrow();
    });

    it('sets title, artist, album and artwork from the cover helper', () => {
        const session = install_media_session();
        install_media_metadata();
        window.SpolocalCoverUrls = { trackCoverUrl: vi.fn(() => '/covers/p1/t1.jpg') };
        const { ctrl } = make_controller();

        ctrl.updateMediaSessionMetadata({
            id: 't1',
            title: 'Title',
            artist: 'Artist',
            album: 'Album',
            youtube_video_id: 'yt1',
        });

        expect(window.SpolocalCoverUrls.trackCoverUrl).toHaveBeenCalledWith('p1', 't1', 'yt1');
        expect(session.metadata.title).toBe('Title');
        expect(session.metadata.artist).toBe('Artist');
        expect(session.metadata.album).toBe('Album');
        expect(session.metadata.artwork.length).toBe(3);
        expect(session.metadata.artwork[0].src).toBe(location.origin + '/covers/p1/t1.jpg');
        expect(session.metadata.artwork[0].sizes).toBe('96x96');
    });

    it('uses the explicit artwork playlist id', () => {
        install_media_session();
        install_media_metadata();
        window.SpolocalCoverUrls = { trackCoverUrl: vi.fn(() => '/covers/p2/t1.jpg') };
        const { ctrl } = make_controller();

        ctrl.updateMediaSessionMetadata({ id: 't1', title: 'T' }, 'p2');

        expect(window.SpolocalCoverUrls.trackCoverUrl).toHaveBeenCalledWith('p2', 't1', undefined);
    });

    it('falls back to the track cover endpoint without the helper', () => {
        const session = install_media_session();
        install_media_metadata();
        const { ctrl } = make_controller();

        ctrl.updateMediaSessionMetadata({ id: 't1', title: 'T' });

        expect(session.metadata.artwork[0].src).toBe(location.origin + '/playlists/p1/tracks/t1/cover');
    });

    it('keeps absolute artwork urls untouched', () => {
        const session = install_media_session();
        install_media_metadata();
        window.SpolocalCoverUrls = { trackCoverUrl: vi.fn(() => 'https://cdn.example/x.jpg') };
        const { ctrl } = make_controller();

        ctrl.updateMediaSessionMetadata({ id: 't1', title: 'T' });

        expect(session.metadata.artwork[0].src).toBe('https://cdn.example/x.jpg');
    });

    it('uses an empty artwork list without a cover path', () => {
        const session = install_media_session();
        install_media_metadata();
        const { ctrl } = make_controller({ playingPlaylistId: '', playlistId: '' });

        ctrl.updateMediaSessionMetadata({ id: '', title: 'T' });

        expect(session.metadata.artwork).toEqual([]);
    });

    it('updates the playback state after setting metadata', () => {
        const session = install_media_session();
        install_media_metadata();
        const { ctrl, hub } = make_controller();
        hub.audio.paused = false;
        ctrl.updateMediaSessionMetadata({ id: 't1', title: 'T' });
        expect(session.playbackState).toBe('playing');
    });
});

describe('updateMediaSessionPlaybackState', () => {
    it('does nothing without the media session api', () => {
        const { ctrl } = make_controller();
        expect(() => ctrl.updateMediaSessionPlaybackState()).not.toThrow();
    });

    it('reports paused and does not set a position', () => {
        const session = install_media_session();
        const { ctrl, hub } = make_controller();
        hub.audio = make_audio({ paused: true, duration: 100, currentTime: 10 });
        ctrl.updateMediaSessionPlaybackState();
        expect(session.playbackState).toBe('paused');
        expect(session.setPositionState).not.toHaveBeenCalled();
    });

    it('reports playing and sets the position state', () => {
        const session = install_media_session();
        const { ctrl, hub } = make_controller();
        hub.audio = make_audio({ paused: false, duration: 100, currentTime: 10, playbackRate: 1.5 });
        ctrl.updateMediaSessionPlaybackState();
        expect(session.playbackState).toBe('playing');
        expect(session.setPositionState).toHaveBeenCalledWith({
            duration: 100,
            playbackRate: 1.5,
            position: 10,
        });
    });

    it('defaults the playback rate to one', () => {
        const session = install_media_session();
        const { ctrl, hub } = make_controller();
        hub.audio = make_audio({ paused: false, duration: 100, currentTime: 5, playbackRate: 0 });
        ctrl.updateMediaSessionPlaybackState();
        expect(session.setPositionState).toHaveBeenCalledWith({
            duration: 100,
            playbackRate: 1,
            position: 5,
        });
    });

    it('skips the position state without a duration', () => {
        const session = install_media_session();
        const { ctrl, hub } = make_controller();
        hub.audio = make_audio({ paused: false, duration: 0, currentTime: 5 });
        ctrl.updateMediaSessionPlaybackState();
        expect(session.playbackState).toBe('playing');
        expect(session.setPositionState).not.toHaveBeenCalled();
    });
});

describe('initMediaSessionHandlers', () => {
    it('does nothing without the media session api', () => {
        const { ctrl } = make_controller();
        expect(() => ctrl.initMediaSessionHandlers()).not.toThrow();
    });

    it('registers all supported actions', () => {
        const session = install_media_session();
        const { ctrl } = make_controller();
        ctrl.initMediaSessionHandlers();
        const actions = session.setActionHandler.mock.calls.map((call) => call[0]);
        expect(actions).toEqual([
            'play',
            'pause',
            'previoustrack',
            'nexttrack',
            'seekbackward',
            'seekforward',
            'seekto',
        ]);
    });

    it('plays the current track on play', () => {
        const session = install_media_session();
        const { ctrl, transport } = make_controller();
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).play();
        expect(transport.playTrackById).toHaveBeenCalledWith('t1');
    });

    it('plays the first playable track when there is no current track', () => {
        const session = install_media_session();
        const { ctrl, transport } = make_controller({
            currentTrackId: null,
            playable: [{ id: 'a' }, { id: 'b' }],
        });
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).play();
        expect(transport.playTrackById).toHaveBeenCalledWith('a');
    });

    it('does nothing on play without a current or playable track', () => {
        const session = install_media_session();
        const { ctrl, transport } = make_controller({ currentTrackId: null, playable: [] });
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).play();
        expect(transport.playTrackById).not.toHaveBeenCalled();
    });

    it('pauses the audio element', () => {
        const session = install_media_session();
        const { ctrl, hub } = make_controller();
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).pause();
        expect(hub.audio.pause).toHaveBeenCalled();
    });

    it('routes previous and next track', () => {
        const session = install_media_session();
        const { ctrl, transport } = make_controller();
        ctrl.initMediaSessionHandlers();
        const handlers = handlers_by_action(session);
        handlers.previoustrack();
        handlers.nexttrack();
        expect(transport.playAtDelta).toHaveBeenNthCalledWith(1, -1);
        expect(transport.playAtDelta).toHaveBeenNthCalledWith(2, 1);
    });

    it('seeks backward with the default offset and clamps at zero', () => {
        const session = install_media_session();
        const { ctrl, hub, transport } = make_controller();
        hub.audio = make_audio({ currentTime: 3 });
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).seekbackward({});
        expect(transport.seek_audio_to).toHaveBeenCalledWith(0);
    });

    it('seeks backward with a custom offset', () => {
        const session = install_media_session();
        const { ctrl, hub, transport } = make_controller();
        hub.audio = make_audio({ currentTime: 30 });
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).seekbackward({ seekOffset: 5 });
        expect(transport.seek_audio_to).toHaveBeenCalledWith(25);
    });

    it('seeks forward with the default offset and clamps at the duration', () => {
        const session = install_media_session();
        const { ctrl, hub, transport } = make_controller();
        hub.audio = make_audio({ currentTime: 95, duration: 100 });
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).seekforward({});
        expect(transport.seek_audio_to).toHaveBeenCalledWith(100);
    });

    it('seeks forward with a custom offset', () => {
        const session = install_media_session();
        const { ctrl, hub, transport } = make_controller();
        hub.audio = make_audio({ currentTime: 10, duration: 100 });
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).seekforward({ seekOffset: 15 });
        expect(transport.seek_audio_to).toHaveBeenCalledWith(25);
    });

    it('seeks to an absolute position', () => {
        const session = install_media_session();
        const { ctrl, transport } = make_controller();
        ctrl.initMediaSessionHandlers();
        handlers_by_action(session).seekto({ seekTime: 42 });
        expect(transport.seek_audio_to).toHaveBeenCalledWith(42);
    });

    it('refreshes the playback state after seeking', () => {
        const session = install_media_session();
        const { ctrl } = make_controller();
        const spy = vi.spyOn(ctrl, 'updateMediaSessionPlaybackState');
        ctrl.initMediaSessionHandlers();
        const handlers = handlers_by_action(session);
        handlers.seekbackward({});
        handlers.seekforward({});
        handlers.seekto({ seekTime: 1 });
        expect(spy).toHaveBeenCalledTimes(3);
    });

    it('keeps registering when one action handler throws', () => {
        const session = install_media_session({
            setActionHandler: vi.fn((action) => {
                if (action === 'play') throw new Error('unsupported');
            }),
        });
        const { ctrl } = make_controller();
        ctrl.initMediaSessionHandlers();
        expect(session.setActionHandler).toHaveBeenCalledTimes(7);
    });
});

describe('persistPlaybackProgress', () => {
    it('does nothing without a track or playlist', () => {
        const no_track = make_controller({ currentTrackId: null });
        no_track.ctrl.persistPlaybackProgress();
        expect(localStorage.getItem(no_track.hub.LS_LAST_PL)).toBeNull();

        const no_playlist = make_controller({ playingPlaylistId: '' });
        no_playlist.ctrl.persistPlaybackProgress();
        expect(localStorage.getItem(no_playlist.hub.LS_LAST_TR)).toBeNull();
    });

    it('writes playlist, track and position', () => {
        const { ctrl, hub } = make_controller();
        hub.audio = make_audio({ currentTime: 42.5 });
        ctrl.persistPlaybackProgress();
        expect(localStorage.getItem(hub.LS_LAST_PL)).toBe('p1');
        expect(localStorage.getItem(hub.LS_LAST_TR)).toBe('t1');
        expect(localStorage.getItem(hub.LS_LAST_POS)).toBe('42.5');
    });

    it('clamps a negative position to zero', () => {
        const { ctrl, hub } = make_controller();
        hub.audio = make_audio({ currentTime: -5 });
        ctrl.persistPlaybackProgress();
        expect(localStorage.getItem(hub.LS_LAST_POS)).toBe('0');
    });
});
