import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlaylistDownloadController } from '../../static/js/services/download_controller.js';

function make_hub(overrides = {}) {
    document.body.innerHTML = [
        '<div id="dl-count"></div>',
        '<div id="dl-list"></div>',
        '<p id="dl-idle"></p>',
        '<span id="dl-error-count"></span>',
        '<button id="dl-retry-all"></button>',
        '<div id="dl-error-list"></div>',
        '<p id="dl-idle-msg"></p>',
    ].join('');
    return {
        dlCount: document.getElementById('dl-count'),
        dlList: document.getElementById('dl-list'),
        dlIdle: document.getElementById('dl-idle'),
        dlErrorCount: document.getElementById('dl-error-count'),
        dlRetryAllErrors: document.getElementById('dl-retry-all'),
        dlErrorList: document.getElementById('dl-error-list'),
        playlistId: 'p1',
        isHomeView: false,
        libraryPool: [],
        currentTrackId: null,
        lastLyricsPayload: {},
        ...overrides,
    };
}

function make_controller(overrides = {}) {
    const hub = make_hub(overrides);
    return { controller: new PlaylistDownloadController({ hub }), hub };
}

function progress_response(data) {
    return {
        ok: true,
        json: async () => data,
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.SpolocalQualityPrefs;
    delete window.applySpaPlaylist;
    delete window.refreshSidebarPlaylistList;
    vi.unstubAllGlobals();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('constructor and cross references', () => {
    it('starts with idle defaults', () => {
        const { controller } = make_controller();
        expect(controller.progressInFlight).toBe(false);
        expect(controller.progressTimer).toBeNull();
        expect(controller._watching).toBe(false);
        expect(controller._idle_hits).toBe(0);
        expect(controller.session).toBeNull();
        expect(controller.PROGRESS_MS_VISIBLE).toBe(3000);
        expect(controller.PROGRESS_MS_HIDDEN).toBe(12000);
    });

    it('stores the session reference', () => {
        const { controller } = make_controller();
        const session = { name: 'session' };
        controller.setCrossRefs(session);
        expect(controller.session).toBe(session);
    });
});

describe('formatting', () => {
    it('formats speeds', () => {
        const { controller } = make_controller();
        expect(controller.fmtSpeed(null)).toBe('');
        expect(controller.fmtSpeed(512)).toBe('512 KB/s');
        expect(controller.fmtSpeed(2048)).toBe('2.0 MB/s');
    });

    it('formats ETAs', () => {
        const { controller } = make_controller();
        expect(controller.fmtEta(null)).toBe('');
        expect(controller.fmtEta(30)).toBe('30s');
        expect(controller.fmtEta(90)).toBe('1m 30s');
    });
});

describe('progress timer', () => {
    it('does not arm when not watching', () => {
        const { controller } = make_controller();
        controller.armProgressTimer();
        expect(controller.progressTimer).toBeNull();
    });

    it('arms with the visible interval', () => {
        const { controller } = make_controller();
        const interval = vi.spyOn(globalThis, 'setInterval');
        controller._watching = true;

        controller.armProgressTimer();

        expect(controller.progressTimer).not.toBeNull();
        expect(interval).toHaveBeenCalledWith(expect.any(Function), 3000);
    });

    it('arms with the hidden interval', () => {
        const { controller } = make_controller();
        const interval = vi.spyOn(globalThis, 'setInterval');
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        controller._watching = true;

        controller.armProgressTimer();

        expect(interval).toHaveBeenCalledWith(expect.any(Function), 12000);
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    it('stops the timer and clears watching state', () => {
        const { controller } = make_controller();
        controller._watching = true;
        controller._idle_hits = 3;
        controller.armProgressTimer();

        controller.stop_progress_timer();

        expect(controller.progressTimer).toBeNull();
        expect(controller._watching).toBe(false);
        expect(controller._idle_hits).toBe(0);
    });

    it('watch_downloads arms the timer and refreshes', () => {
        const { controller } = make_controller();
        const refresh = vi.spyOn(controller, 'refreshProgress').mockResolvedValue();
        const arm = vi.spyOn(controller, 'armProgressTimer').mockImplementation(() => {});

        controller.watch_downloads();

        expect(controller._watching).toBe(true);
        expect(controller._idle_hits).toBe(0);
        expect(arm).toHaveBeenCalled();
        expect(refresh).toHaveBeenCalled();
    });
});

describe('refreshProgress', () => {
    it('renders active jobs, counts, and the empty error list', async () => {
        const { controller, hub } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            jobs: {
                t1: { phase: 'downloading', percent: 50, speed: 2048, eta: 90, title: 'Song', artist: 'Art' },
            },
            remaining: 1,
            queue_depth: 0,
            errors: [],
            errors_total: 0,
        })));

        await controller.refreshProgress();

        expect(hub.dlCount.textContent).toContain('1 left');
        expect(hub.dlCount.textContent).toContain('1 active');
        expect(hub.dlList.children.length).toBe(1);
        expect(hub.dlList.textContent).toContain('Song');
        expect(hub.dlList.textContent).toContain('Art');
        expect(hub.dlList.textContent).toContain('50%');
        expect(hub.dlList.textContent).toContain('2.0 MB/s');
        expect(hub.dlList.textContent).toContain('ETA 1m 30s');
        expect(hub.dlList.querySelector('div[style]').style.width).toBe('50%');
        expect(hub.dlErrorCount.textContent).toBe('0');
        expect(hub.dlRetryAllErrors.disabled).toBe(true);
        expect(hub.dlErrorList.textContent).toBe('No failed downloads.');
    });

    it('renders the idle state', async () => {
        const { controller, hub } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({})));

        await controller.refreshProgress();

        expect(hub.dlCount.textContent).toBe('Idle');
        expect(hub.dlList.contains(hub.dlIdle)).toBe(true);
        expect(hub.dlIdle.classList.contains('hidden')).toBe(false);
    });

    it('renders a queued placeholder while jobs are pending', async () => {
        const { controller, hub } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            jobs: {},
            remaining: 3,
            queue_depth: 2,
            errors: [],
        })));

        await controller.refreshProgress();

        expect(hub.dlList.textContent).toContain('2 downloads queued');
        expect(hub.dlIdle.classList.contains('hidden')).toBe(true);
    });

    it('counts searching jobs', async () => {
        const { controller, hub } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            jobs: {
                t1: { phase: 'searching' },
                t2: { phase: 'downloading', percent: 10 },
            },
            remaining: 2,
            queue_depth: 0,
            errors: [],
        })));

        await controller.refreshProgress();

        expect(hub.dlCount.textContent).toContain('2 active');
        expect(hub.dlCount.textContent).toContain('1 searching');
    });

    it('renders failed downloads and the truncation notice', async () => {
        const { controller, hub } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            jobs: {},
            remaining: 0,
            queue_depth: 0,
            errors: [{
                playlist_id: 'p1',
                track_id: 't1',
                error: 'boom',
                title: 'Bad',
                artist: 'Art',
                playlist_name: 'List',
            }],
            errors_total: 5,
        })));

        await controller.refreshProgress();

        expect(hub.dlErrorCount.textContent).toBe('5');
        expect(hub.dlRetryAllErrors.disabled).toBe(false);
        expect(hub.dlErrorList.textContent).toContain('Bad');
        expect(hub.dlErrorList.textContent).toContain('List');
        expect(hub.dlErrorList.textContent).toContain('Failed');
        expect(hub.dlErrorList.textContent).toContain('boom');
        expect(hub.dlErrorList.textContent).toContain('Showing 1 of 5');
        expect(hub.dlErrorList.querySelectorAll('button').length).toBe(2);
    });

    it('retries a failed download from its button', async () => {
        const { controller, hub } = make_controller();
        const fetch_mock = vi.fn(async () => progress_response({
            jobs: {},
            remaining: 0,
            queue_depth: 0,
            errors: [{ playlist_id: 'p1', track_id: 't1', error: 'boom', title: 'Bad' }],
            errors_total: 1,
        }));
        vi.stubGlobal('fetch', fetch_mock);
        await controller.refreshProgress();
        fetch_mock.mockClear();
        const watch = vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});

        const retry = Array.from(hub.dlErrorList.querySelectorAll('button'))
            .find((btn) => btn.textContent === 'Retry');
        retry.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(fetch_mock).toHaveBeenCalledWith(
            '/playlists/p1/tracks/t1/download',
            expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'manual' }),
        );
        expect(watch).toHaveBeenCalled();
    });

    it('opens the playlist from its button', async () => {
        const { controller, hub } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            jobs: {},
            remaining: 0,
            queue_depth: 0,
            errors: [{ playlist_id: 'p1', track_id: 't1', error: 'boom', title: 'Bad' }],
            errors_total: 1,
        })));
        const navigate = vi.fn();
        controller.setCrossRefs({ navigatePlaylist: navigate });

        await controller.refreshProgress();
        const open = Array.from(hub.dlErrorList.querySelectorAll('button'))
            .find((btn) => btn.textContent === 'Open playlist');
        open.click();

        expect(navigate).toHaveBeenCalledWith('p1', true);
    });

    it('refreshes the playlist view when a job completes', async () => {
        const { controller, hub } = make_controller();
        controller._prevJobKeys = new Set(['old']);
        const apply = vi.fn();
        const quality = vi.fn();
        const lyrics = vi.fn();
        controller.setCrossRefs({
            applySpaPlaylist: apply,
            transport: { quality: { onPlaybackQualityChanged: quality } },
            lyrics: { fetchLyrics: lyrics },
        });
        hub.currentTrackId = 't1';
        hub.lastLyricsPayload = { has_audio: false };
        const fetch_mock = vi.fn(async (url) => {
            if (url === '/api/progress') {
                return progress_response({
                    jobs: { t2: { phase: 'downloading', percent: 5 } },
                    remaining: 1,
                    queue_depth: 0,
                    errors: [],
                });
            }
            if (url.indexOf('/api/playlist/view') === 0) {
                return progress_response({ tracks: [] });
            }
            return progress_response({});
        });
        vi.stubGlobal('fetch', fetch_mock);

        await controller.refreshProgress();

        expect(fetch_mock).toHaveBeenCalledWith('/api/playlist/view?playlist_id=p1');
        expect(apply).toHaveBeenCalledWith({ tracks: [] });
        expect(quality).toHaveBeenCalledWith(false);
        expect(lyrics).toHaveBeenCalledWith(true);
    });

    it('refreshes the home view when a job completes there', async () => {
        const { controller, hub } = make_controller({ isHomeView: true });
        controller._prevJobKeys = new Set(['old']);
        const render = vi.fn();
        controller.setCrossRefs({ home: { render } });
        const fetch_mock = vi.fn(async (url) => {
            if (url === '/api/progress') {
                return progress_response({
                    jobs: { t2: { phase: 'downloading', percent: 5 } },
                    remaining: 1,
                    queue_depth: 0,
                    errors: [],
                });
            }
            if (url === '/api/home/view') {
                return progress_response({ library_pool: [{ id: 'x' }] });
            }
            return progress_response({});
        });
        vi.stubGlobal('fetch', fetch_mock);

        await controller.refreshProgress();

        expect(fetch_mock).toHaveBeenCalledWith('/api/home/view');
        expect(hub.libraryPool).toEqual([{ id: 'x' }]);
        expect(render).toHaveBeenCalled();
    });

    it('ignores a concurrent refresh', async () => {
        const { controller } = make_controller();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        controller.progressInFlight = true;

        await controller.refreshProgress();

        expect(fetch_mock).not.toHaveBeenCalled();
        expect(controller.progressInFlight).toBe(true);
    });

    it('clears the in-flight flag when fetch throws', async () => {
        const { controller } = make_controller();
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('offline');
        }));

        await controller.refreshProgress();

        expect(controller.progressInFlight).toBe(false);
    });

    it('starts watching when work is pending', async () => {
        const { controller } = make_controller();
        const arm = vi.spyOn(controller, 'armProgressTimer').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            jobs: { t1: { phase: 'downloading', percent: 1 } },
            remaining: 1,
            queue_depth: 0,
            errors: [],
        })));

        await controller.refreshProgress();

        expect(controller._watching).toBe(true);
        expect(arm).toHaveBeenCalled();
    });

    it('stops the timer after two idle polls', async () => {
        const { controller } = make_controller();
        const stop = vi.spyOn(controller, 'stop_progress_timer');
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({})));

        await controller.refreshProgress();
        await controller.refreshProgress();

        expect(stop).toHaveBeenCalled();
    });
});

describe('init', () => {
    it('wires the global watcher and refreshes', () => {
        const { controller, hub } = make_controller();
        const refresh = vi.spyOn(controller, 'refreshProgress').mockResolvedValue();
        const watch = vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});

        controller.init();

        expect(refresh).toHaveBeenCalled();
        expect(typeof window.watchSpolocalDownloads).toBe('function');
        window.watchSpolocalDownloads();
        expect(watch).toHaveBeenCalled();
        expect(hub.dlRetryAllErrors).not.toBeNull();
    });

    it('re-arms the timer on visibility changes while watching', () => {
        const { controller } = make_controller();
        vi.spyOn(controller, 'refreshProgress').mockResolvedValue();
        const arm = vi.spyOn(controller, 'armProgressTimer').mockImplementation(() => {});
        controller.init();
        controller._watching = true;

        document.dispatchEvent(new Event('visibilitychange'));

        expect(arm).toHaveBeenCalled();
    });

    it('does nothing without a hub', () => {
        const controller = new PlaylistDownloadController({ hub: null });
        const refresh = vi.spyOn(controller, 'refreshProgress');
        expect(() => controller.init()).not.toThrow();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('retries all errors from the button', async () => {
        const { controller, hub } = make_controller();
        vi.spyOn(controller, 'refreshProgress').mockResolvedValue();
        const watch = vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        const fetch_mock = vi.fn(async () => ({ ok: true }));
        vi.stubGlobal('fetch', fetch_mock);
        controller.init();

        hub.dlRetryAllErrors.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(hub.dlRetryAllErrors.disabled).toBe(true);
        expect(fetch_mock).toHaveBeenCalledWith(
            '/api/downloads/retry-all-errors',
            expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
        );
        expect(watch).toHaveBeenCalled();
    });

    it('ignores the retry-all button while disabled', () => {
        const { controller, hub } = make_controller();
        vi.spyOn(controller, 'refreshProgress').mockResolvedValue();
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        controller.init();
        hub.dlRetryAllErrors.disabled = true;

        hub.dlRetryAllErrors.click();

        expect(fetch_mock).not.toHaveBeenCalled();
    });
});

describe('queueQualityDownloads', () => {
    it('queues a playlist at a quality tier and reports the result', async () => {
        const { controller } = make_controller();
        const watch = vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        vi.stubGlobal('SpolocalQualityPrefs', { formatLabel: (kbps) => kbps + ' kbps' });
        const fetch_mock = vi.fn(async () => progress_response({
            quality: 320,
            queued: 2,
            already_have: 1,
            ineligible: 0,
            duplicates: 1,
        }));
        vi.stubGlobal('fetch', fetch_mock);

        await controller.queueQualityDownloads('p1', 320);

        expect(fetch_mock).toHaveBeenCalledWith(
            '/api/playlists/p1/downloads/quality',
            expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
        );
        const body = JSON.parse(fetch_mock.mock.calls[0][1].body);
        expect(body).toEqual({ quality: '320' });
        const idle = document.getElementById('dl-idle-msg');
        expect(idle.textContent).toBe(
            'Queued 2 at 320 kbps. 1 already at 320 kbps. 1 duplicate list entries ignored.',
        );
        expect(idle.classList.contains('hidden')).toBe(false);
        expect(watch).toHaveBeenCalled();
    });

    it('queues the whole library without a playlist id', async () => {
        const { controller } = make_controller();
        vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        vi.stubGlobal('SpolocalQualityPrefs', { formatLabel: (kbps) => kbps + ' kbps' });
        const fetch_mock = vi.fn(async () => progress_response({ quality: 320, queued: 1 }));
        vi.stubGlobal('fetch', fetch_mock);

        await controller.queueQualityDownloads(null, 320);

        expect(fetch_mock.mock.calls[0][0]).toBe('/api/downloads/quality-all');
    });

    it('reports when there is nothing to queue', async () => {
        const { controller } = make_controller();
        vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        vi.stubGlobal('SpolocalQualityPrefs', { formatLabel: (kbps) => kbps + ' kbps' });
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({
            quality: 320,
            queued: 0,
            already_have: 0,
            ineligible: 0,
            duplicates: 0,
        })));

        await controller.queueQualityDownloads('p1', 320);

        expect(document.getElementById('dl-idle-msg').textContent).toBe('Nothing to queue at 320 kbps.');
    });

    it('alerts when the request is rejected', async () => {
        const { controller } = make_controller();
        const watch = vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        const alert_mock = vi.fn();
        vi.stubGlobal('alert', alert_mock);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

        await controller.queueQualityDownloads('p1', 320);

        expect(alert_mock).toHaveBeenCalledWith('Could not queue downloads. Try again in a moment.');
        expect(watch).not.toHaveBeenCalled();
    });

    it('alerts when the request throws', async () => {
        const { controller } = make_controller();
        const watch = vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        const alert_mock = vi.fn();
        vi.stubGlobal('alert', alert_mock);
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('offline');
        }));

        await controller.queueQualityDownloads('p1', 320);

        expect(alert_mock).toHaveBeenCalledWith('Could not queue downloads.');
        expect(watch).toHaveBeenCalled();
    });

    it('alerts when the idle message element is missing', async () => {
        const { controller } = make_controller();
        vi.spyOn(controller, 'watch_downloads').mockImplementation(() => {});
        const alert_mock = vi.fn();
        vi.stubGlobal('alert', alert_mock);
        vi.stubGlobal('SpolocalQualityPrefs', { formatLabel: (kbps) => kbps + ' kbps' });
        vi.stubGlobal('fetch', vi.fn(async () => progress_response({ quality: 320, queued: 1 })));
        document.body.innerHTML = '';

        await controller.queueQualityDownloads('p1', 320);

        expect(alert_mock).toHaveBeenCalledWith('Queued 1 at 320 kbps.');
    });
});
