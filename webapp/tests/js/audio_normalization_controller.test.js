import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_normalization_prefs.js';
import { AudioNormalizationController } from '../../static/js/player/audio_normalization_controller.js';

function fakeAudio() {
    return {
        paused: true,
        volume: 1,
        addEventListener: vi.fn(),
    };
}

beforeEach(() => {
    localStorage.clear();
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
