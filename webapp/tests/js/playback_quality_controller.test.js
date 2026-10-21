import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_quality_prefs.js';
import { PlaybackQualityController } from '../../static/js/player/playback_quality_controller.js';

function fakeAudio() {
    const listeners = new Map();
    return {
        paused: true,
        currentTime: 0,
        duration: 100,
        currentSrc: '',
        src: '',
        pause: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        load: vi.fn(),
        removeAttribute: vi.fn(),
        addEventListener: vi.fn((name, fn) => {
            listeners.set(name, fn);
        }),
        fire(name) {
            const fn = listeners.get(name);
            if (fn) fn();
        },
    };
}

function makeController(overrides = {}) {
    const hub = {
        tracks: [],
        playingTracks: [],
        libraryPool: [],
        audio: fakeAudio(),
        subEl: { textContent: '' },
        currentTrackId: null,
        playingPlaylistId: null,
        playlistId: 'p1',
        ...overrides.hub,
    };
    const state = { hub };
    const transport = {
        _playGeneration: 1,
        setPlayUi: vi.fn(),
        mediaSession: { updateMediaSessionPlaybackState: vi.fn() },
        ...overrides.transport,
    };
    return { controller: new PlaybackQualityController(state, transport), hub, transport };
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('spolocal_playback_kbps', '64');
});

describe('findTrackInHub', () => {
    it('finds a track in hub.tracks', () => {
        const { controller, hub } = makeController();
        hub.tracks = [{ id: 't1', title: 'A' }];
        expect(controller.findTrackInHub('t1')).toBe(hub.tracks[0]);
    });

    it('falls back to playingTracks', () => {
        const { controller, hub } = makeController();
        hub.playingTracks = [{ id: 't2', title: 'B' }];
        expect(controller.findTrackInHub('t2')).toBe(hub.playingTracks[0]);
    });

    it('returns null when missing', () => {
        const { controller } = makeController();
        expect(controller.findTrackInHub('nope')).toBeNull();
    });
});

describe('patchTrackInHub', () => {
    it('patches tracks, playingTracks, and libraryPool', () => {
        const { controller, hub } = makeController();
        hub.tracks = [{ id: 't1', title: 'Old' }];
        hub.playingTracks = [{ id: 't1', title: 'Old' }];
        hub.libraryPool = [{ track_id: 't1', title: 'Old' }];

        controller.patchTrackInHub({ id: 't1', title: 'New', play_src: '/media/x' });

        expect(hub.tracks[0].title).toBe('New');
        expect(hub.playingTracks[0].title).toBe('New');
        expect(hub.libraryPool[0].title).toBe('New');
        expect(hub.libraryPool[0].play_src).toBe('/media/x');
    });

    it('ignores payloads without an id', () => {
        const { controller, hub } = makeController();
        hub.tracks = [{ id: 't1', title: 'Old' }];
        controller.patchTrackInHub({ title: 'New' });
        expect(hub.tracks[0].title).toBe('Old');
    });
});

describe('ensurePlaybackVariantReady', () => {
    it('returns true when the variant already exists', async () => {
        const { controller } = makeController();
        const track = { play_variants: { '64': '/media/a__64k.webm' } };
        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, false)).toBe(true);
    });

    it('starts a background download and returns true when streaming is allowed', async () => {
        const { controller } = makeController();
        const download = vi.spyOn(controller, 'request_quality_download').mockResolvedValue(true);
        const track = { youtube_video_id: 'abc' };

        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, true)).toBe(true);
        expect(download).toHaveBeenCalledWith('p1', 't1', 64);
    });

    it('waits for the file when streaming is not allowed', async () => {
        const { controller, hub } = makeController();
        const download = vi.spyOn(controller, 'request_quality_download').mockResolvedValue(true);
        const wait = vi.spyOn(controller, 'waitForPlaybackVariant').mockResolvedValue(true);
        const track = { artist: 'Artist' };

        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, false)).toBe(true);
        expect(download).toHaveBeenCalledWith('p1', 't1', 64);
        expect(wait).toHaveBeenCalledWith('p1', 't1', 64, 1);
        expect(hub.subEl.textContent).toBe('Downloading Data Saver…');
    });

    it('restores the artist label when the wait fails', async () => {
        const { controller, hub } = makeController();
        vi.spyOn(controller, 'request_quality_download').mockResolvedValue(true);
        vi.spyOn(controller, 'waitForPlaybackVariant').mockResolvedValue(false);
        const track = { artist: 'Artist' };

        expect(await controller.ensurePlaybackVariantReady(track, 'p1', 't1', 64, 1, false)).toBe(false);
        expect(hub.subEl.textContent).toBe('Artist');
    });

    it('bails out when the play generation changed', async () => {
        const { controller, transport } = makeController();
        vi.spyOn(controller, 'request_quality_download').mockImplementation(async () => {
            transport._playGeneration = 2;
            return true;
        });
        const wait = vi.spyOn(controller, 'waitForPlaybackVariant');

        expect(await controller.ensurePlaybackVariantReady({}, 'p1', 't1', 64, 1, false)).toBe(false);
        expect(wait).not.toHaveBeenCalled();
    });
});

describe('onPlaybackQualityChanged', () => {
    it('does not start a download when called after a finished job', async () => {
        const { controller, hub } = makeController();
        hub.currentTrackId = 't1';
        const track = { id: 't1', play_variants: {} };
        vi.spyOn(controller, 'fetchTrackPayload').mockResolvedValue(track);
        const ensure = vi.spyOn(controller, 'ensurePlaybackVariantReady');
        const replace = vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(false);

        expect(ensure).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it('starts a download when the user changes quality', async () => {
        const { controller, hub } = makeController();
        hub.currentTrackId = 't1';
        const track = { id: 't1', play_variants: {} };
        vi.spyOn(controller, 'fetchTrackPayload').mockResolvedValue(track);
        const ensure = vi.spyOn(controller, 'ensurePlaybackVariantReady').mockResolvedValue(true);
        vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(true);

        expect(ensure).toHaveBeenCalled();
    });

    it('replaces the source when the variant is present', async () => {
        const { controller, hub } = makeController();
        hub.currentTrackId = 't1';
        const track = { id: 't1', play_variants: { '64': '/media/a__64k.webm' } };
        vi.spyOn(controller, 'fetchTrackPayload').mockResolvedValue(track);
        const replace = vi.spyOn(controller, 'replace_audio_src');

        await controller.onPlaybackQualityChanged(false);

        expect(replace).toHaveBeenCalledWith('/media/a__64k.webm?kbps=64', 0);
    });

    it('does nothing without a current track', async () => {
        const { controller } = makeController();
        const fetchPayload = vi.spyOn(controller, 'fetchTrackPayload');
        await controller.onPlaybackQualityChanged(false);
        expect(fetchPayload).not.toHaveBeenCalled();
    });
});

describe('replace_audio_src', () => {
    it('sets the source and resumes on canplay', () => {
        const { controller, hub } = makeController();
        hub.audio.currentTime = 10;
        hub.audio.duration = 100;

        controller.replace_audio_src('/media/a__64k.webm', 10);

        expect(hub.audio.src).toBe('/media/a__64k.webm');
        expect(hub.audio.pause).toHaveBeenCalled();
        hub.audio.currentSrc = '/media/a__64k.webm';
        hub.audio.fire('canplay');
        expect(hub.audio.currentTime).toBe(10);
        expect(hub.audio.play).toHaveBeenCalled();
    });

    it('ignores empty sources', () => {
        const { controller, hub } = makeController();
        controller.replace_audio_src('', 0);
        expect(hub.audio.src).toBe('');
    });
});
