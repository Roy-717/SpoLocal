import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_normalization_prefs.js';
import { AudioNormalizationController } from '../../static/js/player/audio_normalization_controller.js';

function fakeAudio() {
    return {
        paused: true,
        volume: 1,
        addEventListener: vi.fn(),
    };
}

function fakeAudioWithEvents() {
    const listeners = {};
    return {
        paused: true,
        volume: 1,
        addEventListener: (name, fn) => {
            (listeners[name] = listeners[name] || []).push(fn);
        },
        emit: (name) => (listeners[name] || []).forEach((fn) => fn()),
    };
}

class FakeAudioContext {
    constructor() {
        this.state = 'suspended';
        this.destination = {};
        this.source_el = null;
    }
    createMediaElementSource(el) {
        this.source_el = el;
        return { connect: vi.fn() };
    }
    createGain() {
        return { gain: { value: 1 }, connect: vi.fn() };
    }
    createAnalyser() {
        return {
            fftSize: 0,
            smoothingTimeConstant: 0,
            frequencyBinCount: 8,
            connect: vi.fn(),
            getByteFrequencyData: vi.fn(),
        };
    }
    resume() {
        this.state = 'running';
        return Promise.resolve();
    }
}

class StuckAudioContext extends FakeAudioContext {
    resume() {
        return new Promise(() => {});
    }
}

class RunningAudioContext extends FakeAudioContext {
    constructor() {
        super();
        this.state = 'running';
        this.currentTime = 10;
    }
    createGain() {
        return {
            gain: {
                value: 1,
                cancelAndHoldAtTime: vi.fn(),
                cancelScheduledValues: vi.fn(),
                setValueAtTime: vi.fn(),
                linearRampToValueAtTime: vi.fn(),
            },
            connect: vi.fn(),
        };
    }
}

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    delete globalThis.AudioContext;
});

describe('volume and gain', () => {
    it('clamps user volume to 0..1', () => {
        const audio = fakeAudio();
        const ctrl = new AudioNormalizationController(audio);
        ctrl.set_user_volume(2);
        expect(ctrl.get_user_volume()).toBe(1);
        expect(audio.volume).toBe(1);
        ctrl.set_user_volume(-1);
        expect(ctrl.get_user_volume()).toBe(0);
        expect(audio.volume).toBe(0);
    });

    it('accepts finite track gain and ignores NaN', () => {
        const ctrl = new AudioNormalizationController(fakeAudio());
        ctrl.set_track_gain_db(-6);
        expect(ctrl.track_gain_db).toBe(-6);
        ctrl.set_track_gain_db('nope');
        expect(ctrl.track_gain_db).toBe(0);
    });

    it('applies the user volume when there is no gain node', () => {
        const audio = fakeAudio();
        const ctrl = new AudioNormalizationController(audio);
        ctrl.set_user_volume(0.4);
        expect(audio.volume).toBe(0.4);
    });

    it('set_enabled toggles the flag', () => {
        const ctrl = new AudioNormalizationController(fakeAudio());
        ctrl.set_enabled(false);
        expect(ctrl.enabled).toBe(false);
        ctrl.set_enabled(true);
        expect(ctrl.enabled).toBe(true);
    });
});

describe('gain fade', () => {
    it('ramps a measured gain in instead of jumping', () => {
        globalThis.AudioContext = RunningAudioContext;
        const audio = fakeAudio();
        audio.paused = false;
        const ctrl = new AudioNormalizationController(audio);
        ctrl.wire();
        expect(ctrl._wired).toBe(true);

        ctrl.set_track_gain_db(-6);

        const param = ctrl.gain_node.gain;
        expect(param.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
        const [value, when] = param.linearRampToValueAtTime.mock.calls[0];
        expect(value).toBeCloseTo(Math.pow(10, -6 / 20), 5);
        expect(when).toBeCloseTo(10.4, 5);
    });

    it('sets the gain instantly when the context is not running', () => {
        const audio = fakeAudio();
        const ctrl = new AudioNormalizationController(audio);
        ctrl.gain_node = { gain: { value: 1 } };
        ctrl.ctx = { state: 'suspended', currentTime: 0 };

        ctrl.set_track_gain_db(-6);

        expect(ctrl.gain_node.gain.value).toBeCloseTo(Math.pow(10, -6 / 20), 5);
    });
});

describe('suspended audio context', () => {
    it('keeps native audio until the context is running', () => {
        globalThis.AudioContext = StuckAudioContext;
        const audio = fakeAudio();
        audio.paused = false;
        const ctrl = new AudioNormalizationController(audio);
        ctrl.wire();
        expect(ctrl.ctx).toBeTruthy();
        expect(ctrl.ctx.state).toBe('suspended');
        expect(ctrl._wired).toBe(false);
        expect(ctrl.gain_node).toBeNull();
        expect(audio.volume).toBe(1);
    });

    it('connects the graph once resume succeeds', async () => {
        globalThis.AudioContext = FakeAudioContext;
        const audio = fakeAudio();
        audio.paused = false;
        const ctrl = new AudioNormalizationController(audio);
        ctrl.wire();
        await Promise.resolve();
        await Promise.resolve();
        expect(ctrl.ctx.state).toBe('running');
        expect(ctrl._wired).toBe(true);
        expect(ctrl.gain_node).toBeTruthy();
    });

    it('resumes a suspended context on the next play event', async () => {
        globalThis.AudioContext = FakeAudioContext;
        const audio = fakeAudioWithEvents();
        const ctrl = new AudioNormalizationController(audio);
        ctrl.wire();
        expect(ctrl._wired).toBe(false);
        audio.paused = false;
        audio.emit('play');
        await Promise.resolve();
        await Promise.resolve();
        expect(ctrl._wired).toBe(true);
    });

    it('resumes a wired context when playback restarts', async () => {
        globalThis.AudioContext = FakeAudioContext;
        const audio = fakeAudioWithEvents();
        audio.paused = false;
        const ctrl = new AudioNormalizationController(audio);
        ctrl.wire();
        await Promise.resolve();
        await Promise.resolve();
        expect(ctrl._wired).toBe(true);
        ctrl.ctx.state = 'suspended';
        const resume = vi.spyOn(ctrl.ctx, 'resume');
        audio.emit('play');
        expect(resume).toHaveBeenCalled();
    });
});

describe('bands_energy', () => {
    it('returns zeros without an analyser', () => {
        const ctrl = new AudioNormalizationController(fakeAudio());
        expect(ctrl.bands_energy()).toEqual({ bass: 0, mid: 0, treble: 0 });
    });
});

describe('normalization preference', () => {
    it('defaults to enabled', () => {
        expect(window.SpolocalNormalizationPrefs.enabled()).toBe(true);
    });

    it('can be disabled', () => {
        window.SpolocalNormalizationPrefs.setEnabled(false);
        expect(window.SpolocalNormalizationPrefs.enabled()).toBe(false);
        window.SpolocalNormalizationPrefs.setEnabled(true);
        expect(window.SpolocalNormalizationPrefs.enabled()).toBe(true);
    });
});
