import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MseStreamController } from '../../static/js/player/mse_stream_controller.js';

function make_fake_sb() {
    const listeners = new Map();
    return {
        mode: '',
        updating: false,
        appended: [],
        removed: [],
        aborted: false,
        appendBuffer: vi.fn(function (buf) {
            this.appended.push(buf);
        }),
        remove: vi.fn(function (start, end) {
            this.removed.push([start, end]);
        }),
        abort: vi.fn(function () {
            this.aborted = true;
        }),
        addEventListener: vi.fn((name, fn) => {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        }),
        fire(name) {
            (listeners.get(name) || []).forEach((fn) => fn());
        },
    };
}

function make_fake_ms() {
    return {
        readyState: 'open',
        duration: NaN,
        ended: false,
        addSourceBuffer: vi.fn(() => make_fake_sb()),
        endOfStream: vi.fn(function () {
            this.ended = true;
        }),
        addEventListener: vi.fn(),
    };
}

class FakeMediaSource {
    constructor() {
        const listeners = new Map();
        this.readyState = 'closed';
        this.duration = NaN;
        this.ended = false;
        this.addSourceBuffer = vi.fn(() => make_fake_sb());
        this.endOfStream = vi.fn(() => {
            this.ended = true;
        });
        this.addEventListener = vi.fn((name, fn) => {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        });
        this.fire = (name) => {
            if (name === 'sourceopen') this.readyState = 'open';
            (listeners.get(name) || []).forEach((fn) => fn());
        };
        FakeMediaSource.instances.push(this);
    }
}

FakeMediaSource.instances = [];
FakeMediaSource.isTypeSupported = vi.fn(() => true);

function fake_buffered(ranges) {
    return {
        length: ranges.length,
        start: (i) => ranges[i][0],
        end: (i) => ranges[i][1],
    };
}

function make_audio(ranges = []) {
    const listeners = new Map();
    return {
        src: '',
        currentTime: 0,
        duration: NaN,
        paused: true,
        buffered: fake_buffered(ranges),
        pause: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        load: vi.fn(),
        removeAttribute: vi.fn(),
        addEventListener: vi.fn((name, fn) => {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        }),
        removeEventListener: vi.fn((name, fn) => {
            const list = listeners.get(name) || [];
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        }),
        fire(name) {
            (listeners.get(name) || []).forEach((fn) => fn());
        },
    };
}

function make_active_controller(ranges = []) {
    const controller = new MseStreamController();
    const audio = make_audio(ranges);
    const sb = make_fake_sb();
    controller._audio = audio;
    controller._ms = make_fake_ms();
    controller._sb = sb;
    controller._aborted = false;
    controller._blob_url = '';
    controller._gen = 1;
    return { controller, audio, sb };
}

function ok_response(body, range) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => range || '' },
        arrayBuffer: async () => body,
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeMediaSource.instances = [];
    FakeMediaSource.isTypeSupported = vi.fn(() => true);
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
});

describe('constructor and capability flags', () => {
    it('starts inactive and unsupported', () => {
        const controller = new MseStreamController();
        expect(controller.is_active()).toBe(false);
        expect(controller.is_local_media()).toBe(false);
        expect(controller.should_advance_on_ended()).toBe(false);
        expect(controller.is_supported()).toBe(false);
    });

    it('reports support when MediaSource can check types', () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        const controller = new MseStreamController();
        expect(controller.is_supported()).toBeTruthy();
    });

    it('reports local media mode', () => {
        const controller = new MseStreamController();
        controller._mode = 'media';
        expect(controller.is_local_media()).toBe(true);
    });

    it('is active only with an audio element, media source, and matching blob url', () => {
        const { controller, audio } = make_active_controller();
        expect(controller.is_active()).toBe(true);

        controller._aborted = true;
        expect(controller.is_active()).toBe(false);

        controller._aborted = false;
        controller._blob_url = 'blob:one';
        audio.src = 'blob:two';
        expect(controller.is_active()).toBe(false);

        audio.src = 'blob:one';
        expect(controller.is_active()).toBe(true);
    });
});

describe('seek_to', () => {
    it('ignores invalid and inactive seeks', () => {
        const controller = new MseStreamController();
        controller.seek_to(-1);
        controller.seek_to('nope');
        controller.seek_to(5);
        expect(controller._seeking).toBe(false);
    });

    it('finishes immediately when the target is buffered', () => {
        const { controller, audio } = make_active_controller([[0, 50]]);
        const done = vi.fn();

        controller.seek_to(10, done);

        expect(audio.currentTime).toBe(10);
        expect(audio.play).toHaveBeenCalled();
        expect(done).toHaveBeenCalled();
        expect(controller._seeking).toBe(false);
    });

    it('extends the buffer when the target is just after it', () => {
        const { controller } = make_active_controller([[0, 10]]);
        const fetch_next = vi.spyOn(controller, '_maybe_fetch_next').mockImplementation(() => {});

        controller.seek_to(20);

        expect(controller._seeking).toBe(true);
        expect(controller._jump_seek).toBe(false);
        expect(fetch_next).toHaveBeenCalledWith(controller._gen);
    });

    it('jumps and clears the buffer for a far seek', () => {
        const { controller } = make_active_controller([[0, 10]]);
        const remove_all = vi.spyOn(controller, '_remove_all').mockImplementation(() => {});
        const op_before = controller._op;

        controller.seek_to(100);

        expect(controller._jump_seek).toBe(true);
        expect(controller._op).toBe(op_before + 1);
        expect(remove_all).toHaveBeenCalledWith(controller._gen);
    });
});

describe('play', () => {
    it('falls back when MediaSource is unavailable', async () => {
        const controller = new MseStreamController();
        const audio = make_audio();
        const fallback = vi.fn();

        await controller.play('vid1', audio, fallback);

        expect(fallback).toHaveBeenCalled();
    });

    it('prepares the stream and begins playback', async () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        const controller = new MseStreamController();
        const audio = make_audio();
        const fallback = vi.fn();
        const begin = vi.spyOn(controller, '_begin').mockImplementation(() => {});
        const fetch_mock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ ext: 'webm', filesize: 4096, duration_sec: 120 }),
        }));
        vi.stubGlobal('fetch', fetch_mock);

        await controller.play('vid1', audio, fallback);

        expect(fetch_mock).toHaveBeenCalledWith('/api/stream/prepare?vid=vid1');
        expect(controller._duration).toBe(120);
        expect(begin).toHaveBeenCalledWith(expect.any(Number), 'webm', 4096);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('begins with defaults when prepare fails', async () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        const controller = new MseStreamController();
        const audio = make_audio();
        const begin = vi.spyOn(controller, '_begin').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('offline');
        }));

        await controller.play('vid1', audio, vi.fn());

        expect(begin).toHaveBeenCalledWith(expect.any(Number), 'webm', 0);
    });

    it('drops the result when the generation changed during prepare', async () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        const controller = new MseStreamController();
        const audio = make_audio();
        const begin = vi.spyOn(controller, '_begin').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => {
            controller.stop();
            return { ok: true, json: async () => ({ ext: 'webm', filesize: 10, duration_sec: 5 }) };
        }));

        await controller.play('vid1', audio, vi.fn());

        expect(begin).not.toHaveBeenCalled();
    });

    it('wires the source buffer on sourceopen', async () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        const controller = new MseStreamController();
        const audio = make_audio();
        const fetch_next = vi.spyOn(controller, '_maybe_fetch_next').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ ext: 'webm', filesize: 4096, duration_sec: 120 }),
        })));

        await controller.play('vid1', audio, vi.fn());
        const ms = FakeMediaSource.instances[0];
        ms.fire('sourceopen');

        expect(ms.addSourceBuffer).toHaveBeenCalledWith('audio/webm; codecs="opus"');
        const sb = ms.addSourceBuffer.mock.results[0].value;
        expect(sb.mode).toBe('segments');
        expect(ms.duration).toBe(120);
        expect(audio.src).toBe('blob:fake');
        expect(fetch_next).toHaveBeenCalled();
    });
});

describe('play_media', () => {
    it('falls back when MediaSource is unavailable', async () => {
        const controller = new MseStreamController();
        const fallback = vi.fn();

        await controller.play_media('/media/a.webm', make_audio(), fallback);

        expect(fallback).toHaveBeenCalled();
    });

    it('normalizes the path and begins local media playback', async () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        vi.stubGlobal('SpolocalQualityPrefs', { normalizeMediaPath: () => 'norm' });
        const controller = new MseStreamController();
        const audio = make_audio();
        const begin = vi.spyOn(controller, '_begin').mockImplementation(() => {});
        const fetch_mock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ ext: 'webm', filesize: 100, duration_sec: 10 }),
        }));
        vi.stubGlobal('fetch', fetch_mock);

        await controller.play_media('/media/a.webm', audio, vi.fn());

        expect(fetch_mock).toHaveBeenCalledWith('/api/media/prepare?path=norm');
        expect(begin).toHaveBeenCalledWith(expect.any(Number), 'webm', 100);
        expect(controller.is_local_media()).toBe(true);
    });

    it('falls back when size or duration is missing', async () => {
        vi.stubGlobal('MediaSource', FakeMediaSource);
        const controller = new MseStreamController();
        const fallback = vi.fn();
        const begin = vi.spyOn(controller, '_begin').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ ext: 'webm', filesize: 100, duration_sec: 0 }),
        })));

        await controller.play_media('/media/a.webm', make_audio(), fallback);

        expect(fallback).toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
    });
});

describe('webm helpers', () => {
    it('finds the first cluster signature', () => {
        const controller = new MseStreamController();
        const buf = new Uint8Array([0, 0, 0, 0, 0x1f, 0x43, 0xb6, 0x75, 9]).buffer;
        expect(controller._cluster_index(buf)).toBe(4);
    });

    it('returns -1 when no cluster signature exists', () => {
        const controller = new MseStreamController();
        const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        expect(controller._cluster_index(buf)).toBe(-1);
    });

    it('trims init and cluster data around the signature', () => {
        const controller = new MseStreamController();
        const buf = new Uint8Array([0, 0, 0, 0, 0x1f, 0x43, 0xb6, 0x75, 9]).buffer;

        expect(controller._trim_init(buf).byteLength).toBe(4);
        expect(controller._trim_cluster(buf).byteLength).toBe(5);
    });

    it('returns the buffer unchanged without a signature', () => {
        const controller = new MseStreamController();
        const buf = new Uint8Array([1, 2, 3]).buffer;

        expect(controller._trim_init(buf)).toBe(buf);
        expect(controller._trim_cluster(buf)).toBe(buf);
    });
});

describe('buffer queries', () => {
    it('computes buffered time ahead of the playhead', () => {
        const { controller, audio } = make_active_controller([[0, 10]]);
        audio.currentTime = 5;
        expect(controller._buffered_ahead()).toBe(5);

        audio.currentTime = 15;
        expect(controller._buffered_ahead()).toBe(0);
    });

    it('checks whether a time is buffered', () => {
        const { controller } = make_active_controller([[0, 10]]);
        expect(controller._is_buffered(5)).toBe(true);
        expect(controller._is_buffered(10.1)).toBe(true);
        expect(controller._is_buffered(10.2)).toBe(false);
    });

    it('checks whether a time is just after the buffer', () => {
        const { controller } = make_active_controller([[0, 10]]);
        expect(controller._is_just_after_buffer(20)).toBe(true);
        expect(controller._is_just_after_buffer(60)).toBe(false);
    });

    it('returns the full buffer span', () => {
        const { controller } = make_active_controller([[0, 10], [20, 30]]);
        expect(controller._buffer_span()).toEqual({ start: 0, end: 30 });
    });

    it('returns null without buffered ranges', () => {
        const { controller } = make_active_controller([]);
        expect(controller._buffer_span()).toBeNull();
        expect(controller._buffered_ahead()).toBe(0);
        expect(controller._is_buffered(1)).toBe(false);
        expect(controller._is_just_after_buffer(1)).toBe(false);
    });

    it('finds the nearest buffered edge', () => {
        const { controller } = make_active_controller([[0, 10], [20, 30]]);
        expect(controller._nearest_in_buffer(25)).toBe(25);
        expect(controller._nearest_in_buffer(15)).toBe(10);
        expect(controller._nearest_in_buffer(100)).toBe(30);
    });

    it('prefers the controller duration and falls back to the element', () => {
        const { controller, audio } = make_active_controller();
        controller._duration = 120;
        expect(controller._song_duration()).toBe(120);

        controller._duration = 0;
        audio.duration = 100;
        expect(controller._song_duration()).toBe(100);

        audio.duration = 5;
        expect(controller._song_duration()).toBe(0);
    });

    it('maps a time to a byte position', () => {
        const { controller } = make_active_controller();
        controller._total = 1000000;
        controller._duration = 100;

        expect(controller._byte_pos_for_time(0)).toBe(controller.INIT_BYTES);
        expect(controller._byte_pos_for_time(50)).toBe(499712);
        expect(controller._byte_pos_for_time(200)).toBe(969728);
    });

    it('uses the init size when total or duration is unknown', () => {
        const { controller } = make_active_controller();
        expect(controller._byte_pos_for_time(50)).toBe(controller.INIT_BYTES);
    });
});

describe('playhead handling', () => {
    it('sets the playhead and clears the native seek guard', () => {
        const { controller, audio } = make_active_controller();

        controller._set_playhead(7);

        expect(audio.currentTime).toBe(7);
        expect(controller._ignore_native_seek).toBe(false);
    });

    it('plays only when paused', () => {
        const { controller, audio } = make_active_controller();

        controller._play_if_needed();
        expect(audio.play).toHaveBeenCalled();
        expect(controller._started).toBe(true);

        audio.paused = false;
        audio.play.mockClear();
        controller._play_if_needed();
        expect(audio.play).not.toHaveBeenCalled();
    });

    it('snaps the playhead forward to a nearby buffered start', () => {
        const { controller, audio } = make_active_controller([[6, 20]]);
        audio.currentTime = 5;

        controller._snap_playhead_into_buffer();

        expect(audio.currentTime).toBe(6);
        expect(audio.play).toHaveBeenCalled();
    });

    it('does not snap when the gap is larger than two seconds', () => {
        const { controller, audio } = make_active_controller([[10, 20]]);
        audio.currentTime = 5;

        controller._snap_playhead_into_buffer();

        expect(audio.currentTime).toBe(5);
    });

    it('routes native seeks through seek_to', () => {
        const { controller, audio } = make_active_controller([[0, 10]]);
        const seek = vi.spyOn(controller, 'seek_to').mockImplementation(() => {});

        controller._ignore_native_seek = true;
        controller._on_seek(controller._gen);
        expect(seek).not.toHaveBeenCalled();

        controller._ignore_native_seek = false;
        audio.currentTime = 30;
        controller._on_seek(controller._gen);
        expect(seek).toHaveBeenCalledWith(30);
    });

    it('nudges only when active', () => {
        const controller = new MseStreamController();
        const snap = vi.spyOn(controller, '_snap_playhead_into_buffer').mockImplementation(() => {});
        controller.nudge();
        expect(snap).not.toHaveBeenCalled();

        const active = make_active_controller();
        const snap_active = vi.spyOn(active.controller, '_snap_playhead_into_buffer').mockImplementation(() => {});
        const fetch_next = vi.spyOn(active.controller, '_maybe_fetch_next').mockImplementation(() => {});
        active.controller.nudge();
        expect(snap_active).toHaveBeenCalled();
        expect(fetch_next).toHaveBeenCalledWith(active.controller._gen);
    });
});

describe('buffer maintenance', () => {
    it('removes the whole buffered range', () => {
        const { controller, sb } = make_active_controller([[0, 10]]);

        controller._remove_all(controller._gen);

        expect(sb.remove).toHaveBeenCalledWith(0, 10);
    });

    it('evicts old audio behind the playhead', () => {
        const { controller, audio, sb } = make_active_controller([[0, 20]]);
        audio.currentTime = 10;

        controller._evict_old();

        expect(sb.remove).toHaveBeenCalledWith(0, 9);
    });

    it('does not evict when the gap is small', () => {
        const { controller, audio, sb } = make_active_controller([[0, 20]]);
        audio.currentTime = 2;

        controller._evict_old();

        expect(sb.remove).not.toHaveBeenCalled();
    });

    it('resumes fetching after a buffer removal', () => {
        const { controller } = make_active_controller();
        controller._seek_target = 50;
        controller._total = 1000;
        controller._duration = 100;
        const set_playhead = vi.spyOn(controller, '_set_playhead').mockImplementation(() => {});
        const fetch_next = vi.spyOn(controller, '_maybe_fetch_next').mockImplementation(() => {});

        controller._after_remove(controller._gen);

        expect(controller._need_init).toBe(true);
        expect(controller._pos).toBe(0);
        expect(controller._file_complete).toBe(false);
        expect(controller._resume_pos).toBe(controller.INIT_BYTES);
        expect(set_playhead).toHaveBeenCalledWith(50);
        expect(fetch_next).toHaveBeenCalledWith(controller._gen);
    });

    it('finishes a seek once the target is buffered', () => {
        const { controller } = make_active_controller([[0, 50]]);
        controller._seeking = true;
        controller._seek_target = 10;
        const finish = vi.spyOn(controller, '_finish_seek').mockImplementation(() => {});

        controller._on_seek_data(controller._gen);

        expect(finish).toHaveBeenCalled();
    });

    it('finishes a seek after the maximum number of slices', () => {
        const { controller } = make_active_controller([[0, 10]]);
        controller._seeking = true;
        controller._seek_target = 100;
        controller._seek_slices = controller.MAX_SEEK_SLICES;
        const finish = vi.spyOn(controller, '_finish_seek').mockImplementation(() => {});

        controller._on_seek_data(controller._gen);

        expect(finish).toHaveBeenCalled();
    });

    it('starts playback and keeps fetching on updateend', () => {
        const { controller, audio } = make_active_controller([[0, 10]]);
        const snap = vi.spyOn(controller, '_snap_playhead_into_buffer').mockImplementation(() => {});
        const play = vi.spyOn(controller, '_play_if_needed').mockImplementation(() => {});
        const evict = vi.spyOn(controller, '_evict_old').mockImplementation(() => {});
        const fetch_next = vi.spyOn(controller, '_maybe_fetch_next').mockImplementation(() => {});
        const check_end = vi.spyOn(controller, '_check_natural_end').mockImplementation(() => {});

        controller._on_updateend(controller._gen);

        expect(snap).toHaveBeenCalled();
        expect(play).toHaveBeenCalled();
        expect(evict).toHaveBeenCalled();
        expect(fetch_next).toHaveBeenCalledWith(controller._gen);
        expect(check_end).toHaveBeenCalled();
        expect(audio.buffered.length).toBe(1);
    });
});

describe('natural end', () => {
    it('ends the stream and reports completion at the song end', () => {
        const { controller, audio } = make_active_controller();
        controller._duration = 100;
        controller._total = 0;
        audio.currentTime = 100;
        const complete = vi.fn();
        controller._on_complete = complete;

        controller._check_natural_end();

        expect(controller._completed).toBe(true);
        expect(controller._ms.endOfStream).toHaveBeenCalled();
        expect(complete).toHaveBeenCalled();
    });

    it('does nothing before the song end', () => {
        const { controller, audio } = make_active_controller();
        controller._duration = 100;
        audio.currentTime = 50;
        const complete = vi.fn();
        controller._on_complete = complete;

        controller._check_natural_end();

        expect(controller._completed).toBe(false);
        expect(complete).not.toHaveBeenCalled();
    });
});

describe('_maybe_fetch_next', () => {
    it('fetches the init slice and appends it', async () => {
        const { controller, sb } = make_active_controller();
        controller._vid = 'abc';
        controller._total = 1000;
        controller._pos = 0;
        controller._need_init = true;
        const fetch_mock = vi.fn(async () => ok_response(new Uint8Array([1, 2, 3]).buffer, 'bytes 0-999/1000'));
        vi.stubGlobal('fetch', fetch_mock);

        await controller._maybe_fetch_next(controller._gen);

        const [url, opts] = fetch_mock.mock.calls[0];
        expect(url).toBe('/api/stream?vid=abc');
        expect(opts.headers.Range).toBe('bytes=0-999');
        expect(sb.appendBuffer).toHaveBeenCalled();
        expect(controller._need_init).toBe(false);
        expect(controller._pos).toBe(3);
        expect(controller._fetching).toBe(false);
    });

    it('uses the media url in media mode', async () => {
        const { controller } = make_active_controller();
        controller._mode = 'media';
        controller._src_url = '/media/x.webm';
        controller._total = 100;
        controller._need_init = true;
        const fetch_mock = vi.fn(async () => ok_response(new Uint8Array([1, 2]).buffer, 'bytes 0-99/100'));
        vi.stubGlobal('fetch', fetch_mock);

        await controller._maybe_fetch_next(controller._gen);

        expect(fetch_mock.mock.calls[0][0]).toBe('/media/x.webm');
        expect(fetch_mock.mock.calls[0][1].headers.Range).toBe('bytes=0-99');
    });

    it('marks the file complete when the position reaches the total', async () => {
        const { controller } = make_active_controller();
        controller._total = 1000;
        controller._pos = 1000;
        controller._need_init = false;
        const check_end = vi.spyOn(controller, '_check_natural_end').mockImplementation(() => {});
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);

        await controller._maybe_fetch_next(controller._gen);

        expect(controller._file_complete).toBe(true);
        expect(check_end).toHaveBeenCalled();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('marks the file complete on an empty response', async () => {
        const { controller } = make_active_controller();
        controller._total = 1000;
        controller._need_init = true;
        const check_end = vi.spyOn(controller, '_check_natural_end').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => ok_response(new ArrayBuffer(0), 'bytes 0-0/1000')));

        await controller._maybe_fetch_next(controller._gen);

        expect(controller._file_complete).toBe(true);
        expect(check_end).toHaveBeenCalled();
    });

    it('retries with fresh=1 and falls back on a failed stream fetch', async () => {
        const { controller } = make_active_controller();
        controller._vid = 'abc';
        controller._total = 1000;
        controller._need_init = true;
        const fallback = vi.spyOn(controller, '_fallback').mockImplementation(() => {});
        const fetch_mock = vi.fn(async () => ({ ok: false, status: 500 }));
        vi.stubGlobal('fetch', fetch_mock);

        await controller._maybe_fetch_next(controller._gen);

        expect(fetch_mock).toHaveBeenCalledTimes(2);
        expect(fetch_mock.mock.calls[1][0]).toBe('/api/stream?vid=abc&fresh=1');
        expect(fallback).toHaveBeenCalled();
    });

    it('ignores aborted fetches', async () => {
        const { controller } = make_active_controller();
        controller._total = 1000;
        controller._need_init = true;
        const fallback = vi.spyOn(controller, '_fallback').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        }));

        await controller._maybe_fetch_next(controller._gen);

        expect(fallback).not.toHaveBeenCalled();
    });

    it('drops the response when the generation changed', async () => {
        const { controller, sb } = make_active_controller();
        controller._total = 1000;
        controller._need_init = true;
        vi.stubGlobal('fetch', vi.fn(async () => {
            controller._gen += 1;
            return ok_response(new Uint8Array([1, 2, 3]).buffer, 'bytes 0-999/1000');
        }));

        await controller._maybe_fetch_next(1);

        expect(sb.appendBuffer).not.toHaveBeenCalled();
    });
});

describe('stop', () => {
    it('tears down the source, listeners, and pending work', () => {
        const { controller, audio, sb } = make_active_controller();
        const done = vi.fn();
        const abort = vi.fn();
        controller._on_seek_done = done;
        controller._fetch_ac = { abort };
        controller._blob_url = 'blob:fake';
        controller._total = 1000;
        controller._pos = 500;
        controller._on_seek_bound = vi.fn();
        controller._on_time_bound = vi.fn();
        controller._on_waiting_bound = vi.fn();

        controller.stop();

        expect(controller._aborted).toBe(true);
        expect(controller._completed).toBe(true);
        expect(controller._fetching).toBe(false);
        expect(controller._seeking).toBe(false);
        expect(abort).toHaveBeenCalled();
        expect(done).toHaveBeenCalled();
        expect(sb.abort).toHaveBeenCalled();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
        expect(audio.removeEventListener).toHaveBeenCalledTimes(4);
        expect(controller._sb).toBeNull();
        expect(controller._ms).toBeNull();
        expect(controller._blob_url).toBe('');
        expect(controller._total).toBe(0);
        expect(controller._pos).toBe(0);
    });
});
