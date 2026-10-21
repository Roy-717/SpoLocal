import { beforeEach, describe, expect, it } from 'vitest';

import '../../static/js/audio_quality_prefs.js';

const prefs = window.SpolocalQualityPrefs;
const covers = window.SpolocalCoverUrls;

beforeEach(() => {
    localStorage.clear();
});

describe('snapKbps', () => {
    it.each([
        [0, 64],
        [32, 64],
        [64, 64],
        [96, 64],
        [112, 64],
        [120, 192],
        [130, 192],
        [192, 192],
        [320, 192],
    ])('snaps %i to %i', (value, expected) => {
        expect(prefs.snapKbps(value)).toBe(expected);
    });

    it('ties at the midpoint to Data Saver', () => {
        // 128 is equidistant from 64 and 192; the first tier wins.
        expect(prefs.snapKbps(128)).toBe(64);
    });

    it('falls back to the default for non-numbers', () => {
        expect(prefs.snapKbps('nope')).toBe(192);
    });
});

describe('stored preferences', () => {
    it('defaults playback to Highest', () => {
        expect(prefs.playbackKbps()).toBe(192);
    });

    it('reads the current key', () => {
        localStorage.setItem('spolocal_playback_kbps', '64');
        expect(prefs.playbackKbps()).toBe(64);
    });

    it('migrates the legacy quality key', () => {
        localStorage.setItem('spolocal_playback_quality', 'low');
        expect(prefs.playbackKbps()).toBe(64);
    });

    it('maps legacy names', () => {
        localStorage.setItem('spolocal_playback_kbps', 'high');
        expect(prefs.playbackKbps()).toBe(192);
        localStorage.setItem('spolocal_playback_kbps', 'medium');
        expect(prefs.playbackKbps()).toBe(192);
    });

    it('download quality falls back to playback', () => {
        localStorage.setItem('spolocal_playback_kbps', '64');
        expect(prefs.downloadKbps()).toBe(64);
        localStorage.setItem('spolocal_download_kbps', '192');
        expect(prefs.downloadKbps()).toBe(192);
    });

    it('setPlaybackKbps persists and dispatches an event', () => {
        let fired = 0;
        const handler = () => { fired += 1; };
        window.addEventListener('spolocal:playback-quality-changed', handler);
        prefs.setPlaybackKbps(64);
        expect(localStorage.getItem('spolocal_playback_kbps')).toBe('64');
        expect(fired).toBe(1);
        window.removeEventListener('spolocal:playback-quality-changed', handler);
    });
});

describe('variant resolution', () => {
    const track = {
        play_variants: {
            '64': '/media/a__64k.webm',
            '192': '/media/a__192k.opus',
        },
        youtube_video_id: 'dQw4w9WgXcQ',
    };

    it('resolveExactPlaySrc returns only the exact tier', () => {
        expect(prefs.resolveExactPlaySrc(track, 64)).toBe('/media/a__64k.webm');
        expect(prefs.resolveExactPlaySrc(track, 192)).toBe('/media/a__192k.opus');
        expect(prefs.resolveExactPlaySrc({ play_variants: {} }, 64)).toBe('');
    });

    it('resolvePlaySrc prefers the exact tier', () => {
        expect(prefs.resolvePlaySrc(track)).toBe('/media/a__192k.opus');
        localStorage.setItem('spolocal_playback_kbps', '64');
        expect(prefs.resolvePlaySrc(track)).toBe('/media/a__64k.webm');
    });

    it('resolvePlaySrc falls back through the legacy order', () => {
        const legacy = { play_variants: { high: '/media/a__192k.opus' } };
        expect(prefs.resolvePlaySrc(legacy)).toBe('/media/a__192k.opus');
    });

    it('resolvePlaySrc falls back to play_src and stream', () => {
        expect(prefs.resolvePlaySrc({ play_src: '/media/x.mp3' })).toBe('/media/x.mp3');
        expect(prefs.resolvePlaySrc({ youtube_video_id: 'dQw4w9WgXcQ' })).toBe(
            '/api/stream?vid=dQw4w9WgXcQ',
        );
    });

    it('resolvePlaybackPlaySrc uses the exact tier or the stream', () => {
        expect(prefs.resolvePlaybackPlaySrc(track, 64)).toBe('/media/a__64k.webm');
        expect(prefs.resolvePlaybackPlaySrc({ youtube_video_id: 'dQw4w9WgXcQ' }, 64)).toBe(
            '/api/stream?vid=dQw4w9WgXcQ',
        );
    });

    it('streamPlaySrc requires a video id', () => {
        expect(prefs.streamPlaySrc({})).toBe('');
        expect(prefs.streamPlaySrc({ youtube_video_id: 'abc' })).toBe('/api/stream?vid=abc');
    });

    it('hasVariant checks the exact key', () => {
        expect(prefs.hasVariant(track, 64)).toBe(true);
        expect(prefs.hasVariant(track, 192)).toBe(true);
        expect(prefs.hasVariant({ play_variants: { '64': '/x' } }, 192)).toBe(false);
        expect(prefs.hasVariant(null, 64)).toBe(false);
    });
});

describe('normalizeMediaPath', () => {
    it('strips the /media prefix', () => {
        expect(prefs.normalizeMediaPath('/media/youtube/a.webm')).toBe('youtube/a.webm');
    });

    it('handles absolute URLs', () => {
        expect(prefs.normalizeMediaPath('https://localhost:8000/media/youtube/a.webm')).toBe(
            'youtube/a.webm',
        );
    });

    it('returns empty for invalid input', () => {
        expect(prefs.normalizeMediaPath('')).toBe('');
        expect(prefs.normalizeMediaPath(null)).toBe('');
    });
});

describe('labels', () => {
    it('formatLabel', () => {
        expect(prefs.formatLabel(64)).toBe('Data Saver');
        expect(prefs.formatLabel(192)).toBe('Highest');
    });

    it('streamFitsTier only for Highest', () => {
        expect(prefs.streamFitsTier(64)).toBe(false);
        expect(prefs.streamFitsTier(192)).toBe(true);
    });
});

describe('SpolocalCoverUrls', () => {
    it('uses the low thumbnail for Data Saver', () => {
        localStorage.setItem('spolocal_playback_kbps', '64');
        expect(covers.qualityKey()).toBe('low');
        expect(covers.youtubeThumbName()).toBe('default.jpg');
        expect(covers.youtubeThumbUrl('abc')).toBe('https://i.ytimg.com/vi/abc/default.jpg');
    });

    it('uses the high thumbnail for Highest', () => {
        localStorage.setItem('spolocal_playback_kbps', '192');
        expect(covers.qualityKey()).toBe('high');
        expect(covers.youtubeThumbName()).toBe('hqdefault.jpg');
    });

    it('builds local cover URLs', () => {
        expect(covers.localCoverUrl('p 1', 't/1')).toBe(
            '/playlists/p%201/tracks/t%2F1/cover?q=high',
        );
    });

    it('prefers the YouTube thumbnail in Data Saver', () => {
        localStorage.setItem('spolocal_playback_kbps', '64');
        expect(covers.trackCoverUrl('p', 't', 'abc')).toBe('/api/thumb?vid=abc&q=low');
    });

    it('prefers the local cover in Highest', () => {
        localStorage.setItem('spolocal_playback_kbps', '192');
        expect(covers.trackCoverUrl('p', 't', 'abc')).toBe('/playlists/p/tracks/t/cover?q=high');
    });
});
