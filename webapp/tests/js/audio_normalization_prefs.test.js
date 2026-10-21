import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../../static/js/audio_normalization_prefs.js';

const prefs = window.SpolocalNormalizationPrefs;

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('SpolocalNormalizationPrefs', () => {
    it('is exposed on the window', () => {
        expect(typeof prefs.enabled).toBe('function');
        expect(typeof prefs.setEnabled).toBe('function');
    });

    it('defaults to enabled without a stored value', () => {
        expect(prefs.enabled()).toBe(true);
    });

    it('reads the stored false value', () => {
        localStorage.setItem('spolocal_normalize_loudness', 'false');
        expect(prefs.enabled()).toBe(false);
    });

    it('reads the legacy 0 value as disabled', () => {
        localStorage.setItem('spolocal_normalize_loudness', '0');
        expect(prefs.enabled()).toBe(false);
    });

    it('treats any other stored value as enabled', () => {
        localStorage.setItem('spolocal_normalize_loudness', 'true');
        expect(prefs.enabled()).toBe(true);
        localStorage.setItem('spolocal_normalize_loudness', 'yes');
        expect(prefs.enabled()).toBe(true);
    });

    it('persists the disabled state', () => {
        prefs.setEnabled(false);
        expect(localStorage.getItem('spolocal_normalize_loudness')).toBe('false');
        expect(prefs.enabled()).toBe(false);
    });

    it('persists the enabled state', () => {
        prefs.setEnabled(false);
        prefs.setEnabled(true);
        expect(localStorage.getItem('spolocal_normalize_loudness')).toBe('true');
        expect(prefs.enabled()).toBe(true);
    });

    it('treats a falsy argument as disabled', () => {
        prefs.setEnabled(0);
        expect(localStorage.getItem('spolocal_normalize_loudness')).toBe('false');
    });

    it('stays enabled when reading storage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        expect(prefs.enabled()).toBe(true);
    });

    it('does not throw when writing storage fails', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(() => prefs.setEnabled(false)).not.toThrow();
    });
});
