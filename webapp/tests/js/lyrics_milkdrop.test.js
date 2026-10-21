import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LyricsMilkdrop } from '../../static/js/player/lyrics_milkdrop.js';

function make_canvas(width, height) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    parent.getBoundingClientRect = vi.fn(() => ({ width, height }));
    return { canvas, parent };
}

function fake_visualizer() {
    return {
        connectAudio: vi.fn(),
        setRendererSize: vi.fn(),
        render: vi.fn(),
        loadPreset: vi.fn(),
    };
}

function fake_norm() {
    return {
        ensure_wired: vi.fn(),
        ctx: {},
        gain_node: {},
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        disconnect() {}
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('static packs', () => {
    it('exposes four preset packs', () => {
        expect(Object.keys(LyricsMilkdrop.PACKS)).toEqual(['electronic', 'rock', 'ambient', 'pop']);
        expect(LyricsMilkdrop.PACKS.rock).toHaveLength(3);
    });
});

describe('constructor', () => {
    it('stores the canvas and observes the parent', () => {
        const { canvas } = make_canvas(100, 100);
        const get_norm = vi.fn(() => null);
        const milk = new LyricsMilkdrop(canvas, get_norm);
        expect(milk.canvas).toBe(canvas);
        expect(milk.get_norm).toBe(get_norm);
        expect(milk.running).toBe(false);
        expect(milk.pack).toBe('auto');
        expect(milk.ro).toBeDefined();
    });

    it('works without a canvas', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(milk.canvas).toBeNull();
        expect(milk.ro).toBeUndefined();
    });
});

describe('guess_pack', () => {
    it('maps keywords to packs', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(milk.guess_pack('Techno Track', '')).toBe('electronic');
        expect(milk.guess_pack('Nirvana', '')).toBe('rock');
        expect(milk.guess_pack('Ambient Piano', '')).toBe('ambient');
        expect(milk.guess_pack('Unknown', 'Nobody')).toBe('pop');
    });
});

describe('set_pack and set_track', () => {
    it('accepts known packs and falls back to auto', () => {
        const milk = new LyricsMilkdrop(null, null);
        const load = vi.spyOn(milk, 'load_preset_for_track').mockImplementation(() => {});
        milk.set_pack('rock');
        expect(milk.pack).toBe('rock');
        milk.set_pack('nope');
        expect(milk.pack).toBe('auto');
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('stores the track seed and reloads the preset', () => {
        const milk = new LyricsMilkdrop(null, null);
        const load = vi.spyOn(milk, 'load_preset_for_track').mockImplementation(() => {});
        milk.set_track('Title', 'Artist');
        expect(milk.track_seed).toBe('Title\nArtist');
        expect(milk.track_title).toBe('Title');
        expect(milk.track_artist).toBe('Artist');
        expect(load).toHaveBeenCalled();
    });
});

describe('hash_seed', () => {
    it('is deterministic and non-negative', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(milk.hash_seed('abc')).toBe(milk.hash_seed('abc'));
        expect(milk.hash_seed('abc')).toBeGreaterThanOrEqual(0);
        expect(milk.hash_seed('abc')).not.toBe(milk.hash_seed('abd'));
        expect(milk.hash_seed(null)).toBe(0);
    });
});

describe('load_preset_for_track', () => {
    it('does nothing without a visualizer', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(() => milk.load_preset_for_track()).not.toThrow();
    });

    it('loads a preset from the selected pack', () => {
        const milk = new LyricsMilkdrop(null, null);
        const name = LyricsMilkdrop.PACKS.rock[0];
        milk.visualizer = fake_visualizer();
        milk.presets = { [name]: { id: 'rock-preset' } };
        milk.pack = 'rock';
        milk.load_preset_for_track();
        expect(milk.visualizer.loadPreset).toHaveBeenCalledWith({ id: 'rock-preset' }, 2.0);
    });

    it('guesses the pack when set to auto', () => {
        const milk = new LyricsMilkdrop(null, null);
        const name = LyricsMilkdrop.PACKS.electronic[0];
        milk.visualizer = fake_visualizer();
        milk.presets = { [name]: { id: 'electronic-preset' } };
        milk.track_title = 'Techno';
        milk.track_artist = '';
        milk.load_preset_for_track();
        expect(milk.visualizer.loadPreset).toHaveBeenCalledWith({ id: 'electronic-preset' }, 2.0);
    });

    it('falls back to a keyword match when pack names are missing', () => {
        const milk = new LyricsMilkdrop(null, null);
        milk.visualizer = fake_visualizer();
        milk.presets = { 'Fire Storm': { id: 'fire' } };
        milk.pack = 'rock';
        milk.load_preset_for_track();
        expect(milk.visualizer.loadPreset).toHaveBeenCalledWith({ id: 'fire' }, 2.0);
    });

    it('falls back to the first presets when nothing matches', () => {
        const milk = new LyricsMilkdrop(null, null);
        milk.visualizer = fake_visualizer();
        milk.presets = { alpha: { id: 'a' }, beta: { id: 'b' } };
        milk.pack = 'rock';
        milk.load_preset_for_track();
        expect(milk.visualizer.loadPreset).toHaveBeenCalled();
    });
});

describe('butterchurn_api', () => {
    it('returns null without a module', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(milk.butterchurn_api()).toBeNull();
    });

    it('accepts a direct createVisualizer', () => {
        const milk = new LyricsMilkdrop(null, null);
        const mod = { createVisualizer: vi.fn() };
        window.butterchurn = mod;
        expect(milk.butterchurn_api()).toBe(mod);
        delete window.butterchurn;
    });

    it('accepts a default export wrapper', () => {
        const milk = new LyricsMilkdrop(null, null);
        const mod = { default: { createVisualizer: vi.fn() } };
        window.butterchurn = mod;
        expect(milk.butterchurn_api()).toBe(mod.default);
        delete window.butterchurn;
    });

    it('rejects a module without createVisualizer', () => {
        const milk = new LyricsMilkdrop(null, null);
        window.butterchurn = { other: true };
        expect(milk.butterchurn_api()).toBeNull();
        delete window.butterchurn;
    });
});

describe('preset_map', () => {
    it('merges getPresets sources', () => {
        const milk = new LyricsMilkdrop(null, null);
        window.butterchurnPresets = { getPresets: () => ({ a: { id: 'a' } }) };
        window.base = { getPresets: () => ({ b: { id: 'b' } }) };
        expect(milk.preset_map()).toEqual({ a: { id: 'a' }, b: { id: 'b' } });
        delete window.butterchurnPresets;
        delete window.base;
    });

    it('accepts plain objects and default wrappers', () => {
        const milk = new LyricsMilkdrop(null, null);
        window.butterchurnPresets = { default: { a: { id: 'a' } } };
        window.extra = { b: { id: 'b' }, bad: 'nope' };
        expect(milk.preset_map()).toEqual({ a: { id: 'a' }, b: { id: 'b' } });
        delete window.butterchurnPresets;
        delete window.extra;
    });

    it('returns null when nothing is available', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(milk.preset_map()).toBeNull();
    });
});

describe('ensure_visualizer', () => {
    it('returns false without the butterchurn api', () => {
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => fake_norm());
        expect(milk.ensure_visualizer()).toBe(false);
    });

    it('creates and connects the visualizer', () => {
        const { canvas } = make_canvas(100, 100);
        const visualizer = fake_visualizer();
        window.butterchurn = { createVisualizer: vi.fn(() => visualizer) };
        window.butterchurnPresets = { getPresets: () => ({ p: { id: 'p' } }) };
        const norm = fake_norm();
        const milk = new LyricsMilkdrop(canvas, () => norm);
        expect(milk.ensure_visualizer()).toBe(true);
        expect(norm.ensure_wired).toHaveBeenCalled();
        expect(visualizer.connectAudio).toHaveBeenCalledWith(norm.gain_node);
        expect(milk.visualizer).toBe(visualizer);
        expect(milk.ready).toBe(true);
        expect(milk.audio_connected).toBe(true);
        delete window.butterchurn;
        delete window.butterchurnPresets;
    });

    it('returns false when the audio context is not ready', () => {
        const { canvas } = make_canvas(100, 100);
        window.butterchurn = { createVisualizer: vi.fn() };
        window.butterchurnPresets = { getPresets: () => ({ p: {} }) };
        const milk = new LyricsMilkdrop(canvas, () => ({ ensure_wired: vi.fn(), ctx: null, gain_node: null }));
        expect(milk.ensure_visualizer()).toBe(false);
        delete window.butterchurn;
        delete window.butterchurnPresets;
    });

    it('returns false when createVisualizer throws', () => {
        const { canvas } = make_canvas(100, 100);
        window.butterchurn = { createVisualizer: vi.fn(() => { throw new Error('boom'); }) };
        window.butterchurnPresets = { getPresets: () => ({ p: {} }) };
        const milk = new LyricsMilkdrop(canvas, () => fake_norm());
        expect(milk.ensure_visualizer()).toBe(false);
        expect(milk.visualizer).toBeNull();
        expect(milk.ready).toBe(false);
        delete window.butterchurn;
        delete window.butterchurnPresets;
    });
});

describe('start and stop', () => {
    it('refuses to start with reduced motion', () => {
        window.matchMedia = vi.fn(() => ({ matches: true }));
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => null);
        expect(milk.start()).toBe(false);
    });

    it('returns false when the visualizer cannot be created', () => {
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => null);
        expect(milk.start()).toBe(false);
    });

    it('starts the render loop', () => {
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => null);
        vi.spyOn(milk, 'ensure_visualizer').mockReturnValue(true);
        milk.visualizer = fake_visualizer();
        canvas.classList.add('hidden');
        expect(milk.start()).toBe(true);
        expect(milk.running).toBe(true);
        expect(canvas.classList.contains('hidden')).toBe(false);
        expect(requestAnimationFrame).toHaveBeenCalled();
    });

    it('returns true when already running', () => {
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => null);
        vi.spyOn(milk, 'ensure_visualizer').mockReturnValue(true);
        milk.running = true;
        expect(milk.start()).toBe(true);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('stops the loop and hides the canvas', () => {
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => null);
        milk.running = true;
        milk.raf = 3;
        milk.stop();
        expect(milk.running).toBe(false);
        expect(milk.raf).toBe(0);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(3);
        expect(canvas.classList.contains('hidden')).toBe(true);
    });
});

describe('on_visibility', () => {
    it('pauses while hidden and resumes when visible', () => {
        const { canvas } = make_canvas(100, 100);
        const milk = new LyricsMilkdrop(canvas, () => null);
        milk.running = true;
        milk.raf = 4;
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        milk.on_visibility();
        expect(milk.held).toBe(true);
        expect(milk.running).toBe(false);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(4);
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        const start = vi.spyOn(milk, 'start').mockReturnValue(true);
        milk.on_visibility();
        expect(start).toHaveBeenCalled();
    });
});

describe('sync_size', () => {
    it('sizes the canvas and the renderer from the parent box', () => {
        const { canvas } = make_canvas(320.7, 200.2);
        const milk = new LyricsMilkdrop(canvas, () => null);
        milk.visualizer = fake_visualizer();
        milk.sync_size();
        expect(canvas.style.width).toBe('320px');
        expect(canvas.style.height).toBe('200px');
        expect(milk.visualizer.setRendererSize).toHaveBeenCalledWith(320, 200);
    });

    it('does nothing without a parent', () => {
        const milk = new LyricsMilkdrop(null, null);
        expect(() => milk.sync_size()).not.toThrow();
    });
});
