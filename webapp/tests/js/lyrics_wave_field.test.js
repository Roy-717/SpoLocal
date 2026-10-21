import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LyricsWaveField } from '../../static/js/player/lyrics_wave_field.js';

function fake_ctx() {
    return {
        setTransform: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        fillRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        stroke: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
    };
}

function make_canvas(width, height) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const canvas = document.createElement('canvas');
    parent.appendChild(canvas);
    parent.getBoundingClientRect = vi.fn(() => ({ width, height }));
    const ctx = fake_ctx();
    canvas.getContext = vi.fn(() => ctx);
    return { canvas, parent, ctx };
}

function make_wave(overrides) {
    const { canvas, parent, ctx } = make_canvas(200, 100);
    const wave = new LyricsWaveField(canvas, () => null);
    wave.w = 200;
    wave.h = 100;
    return Object.assign({ wave, canvas, parent, ctx }, overrides || {});
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

describe('default_palette', () => {
    it('returns the green and gold palette', () => {
        const pal = LyricsWaveField.default_palette();
        expect(pal.bg).toBe('#0a1a16');
        expect(pal.fills).toHaveLength(4);
        expect(pal.strokes).toHaveLength(3);
    });
});

describe('constructor', () => {
    it('gets a 2d context and observes the parent', () => {
        const { canvas, ctx } = make_canvas(100, 100);
        const wave = new LyricsWaveField(canvas, null);
        expect(wave.canvas).toBe(canvas);
        expect(wave.ctx).toBe(ctx);
        expect(wave.mood).toBe('pop');
        expect(wave.running).toBe(false);
        expect(wave.ro).toBeDefined();
        expect(wave.palette).toEqual(LyricsWaveField.default_palette());
    });

    it('works without a canvas', () => {
        const wave = new LyricsWaveField(null, null);
        expect(wave.canvas).toBeNull();
        expect(wave.ctx).toBeNull();
        expect(wave.ro).toBeUndefined();
    });
});

describe('hash_str and unit', () => {
    it('hashes deterministically and unsigned', () => {
        const { wave } = make_wave();
        expect(wave.hash_str('abc')).toBe(wave.hash_str('abc'));
        expect(wave.hash_str('abc')).toBeGreaterThanOrEqual(0);
        expect(wave.hash_str('abc')).not.toBe(wave.hash_str('abd'));
        expect(wave.hash_str(null)).toBe(wave.hash_str(''));
    });

    it('maps hash bits into the unit range', () => {
        const { wave } = make_wave();
        const h = wave.hash_str('seed');
        for (let i = 0; i < 6; i += 1) {
            const value = wave.unit(h, i);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
        }
    });
});

describe('set_palette', () => {
    it('stores the palette and repaints', () => {
        const { wave } = make_wave();
        const paint = vi.spyOn(wave, 'paint').mockImplementation(() => {});
        const pal = { bg: '#000000', fills: ['#111111'], strokes: ['#222222'] };
        wave.set_palette(pal);
        expect(wave.palette).toBe(pal);
        expect(paint).toHaveBeenCalled();
    });

    it('ignores a missing palette', () => {
        const { wave } = make_wave();
        const before = wave.palette;
        wave.set_palette(null);
        expect(wave.palette).toBe(before);
    });
});

describe('set_mood and set_track_key', () => {
    it('stores the mood and clears the layout', () => {
        const { wave } = make_wave();
        wave.layout = { scene: 'ribbon' };
        wave.set_mood('rock');
        expect(wave.mood).toBe('rock');
        expect(wave.layout).toBeNull();
        wave.set_mood('');
        expect(wave.mood).toBe('pop');
    });

    it('stores the track key and clears the layout', () => {
        const { wave } = make_wave();
        wave.layout = { scene: 'ribbon' };
        wave.set_track_key('Title', 'Artist');
        expect(wave.track_key).toBe('Title|Artist');
        expect(wave.layout).toBeNull();
    });
});

describe('mood_params', () => {
    it('returns distinct parameters per mood', () => {
        const { wave } = make_wave();
        wave.mood = 'electronic';
        expect(wave.mood_params().speed).toBe(0.00048);
        wave.mood = 'rock';
        expect(wave.mood_params().hit).toBe(1.7);
        wave.mood = 'ambient';
        expect(wave.mood_params().amp).toBe(0.65);
        wave.mood = 'pop';
        expect(wave.mood_params()).toEqual({ speed: 0.00024, amp: 1, glow: 1, hit: 1 });
    });
});

describe('pick_scene', () => {
    it('picks from the mood bag', () => {
        const { wave } = make_wave();
        wave.mood = 'electronic';
        expect(['vortex', 'diagonal', 'cross']).toContain(wave.pick_scene(0));
        wave.mood = 'rock';
        expect(['horizon', 'cross', 'ribbon']).toContain(wave.pick_scene(1));
        wave.mood = 'ambient';
        expect(['ribbon', 'lens', 'horizon']).toContain(wave.pick_scene(2));
        wave.mood = 'pop';
        expect(['ribbon', 'horizon', 'diagonal', 'lens']).toContain(wave.pick_scene(3));
    });
});

describe('rebuild_layout', () => {
    it('builds a deterministic layout from the track key', () => {
        const { wave } = make_wave();
        wave.set_track_key('Title', 'Artist');
        wave.rebuild_layout();
        const first = wave.layout;
        expect(first.scene).toBeTruthy();
        expect(first.spec.k1).toBeGreaterThanOrEqual(1.6);
        expect(first.spec_b.k1).toBeCloseTo(first.spec.k1 * 0.85);
        wave.rebuild_layout();
        expect(wave.layout).toEqual(first);
    });
});

describe('start and stop', () => {
    it('returns false without a context', () => {
        const wave = new LyricsWaveField(null, null);
        expect(wave.start()).toBe(false);
    });

    it('starts the animation loop', () => {
        const { wave, canvas } = make_wave();
        canvas.classList.add('hidden');
        expect(wave.start()).toBe(true);
        expect(wave.running).toBe(true);
        expect(canvas.classList.contains('hidden')).toBe(false);
        expect(requestAnimationFrame).toHaveBeenCalled();
    });

    it('paints once with reduced motion', () => {
        window.matchMedia = vi.fn(() => ({ matches: true }));
        const { wave } = make_wave();
        const paint = vi.spyOn(wave, 'paint').mockImplementation(() => {});
        expect(wave.start()).toBe(true);
        expect(wave.running).toBe(false);
        expect(paint).toHaveBeenCalled();
    });

    it('stops the loop and hides the canvas', () => {
        const { wave, canvas } = make_wave();
        wave.running = true;
        wave.raf = 6;
        wave.stop();
        expect(wave.running).toBe(false);
        expect(wave.raf).toBe(0);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(6);
        expect(canvas.classList.contains('hidden')).toBe(true);
    });
});

describe('on_visibility', () => {
    it('pauses while hidden and resumes when visible', () => {
        const { wave } = make_wave();
        wave.running = true;
        wave.raf = 8;
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        wave.on_visibility();
        expect(wave.held).toBe(true);
        expect(wave.running).toBe(false);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(8);
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        const start = vi.spyOn(wave, 'start').mockReturnValue(true);
        wave.on_visibility();
        expect(start).toHaveBeenCalled();
    });
});

describe('sync_size', () => {
    it('sizes the canvas for the device pixel ratio', () => {
        const { wave, canvas, ctx } = make_wave();
        Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
        const paint = vi.spyOn(wave, 'paint').mockImplementation(() => {});
        wave.sync_size();
        expect(canvas.width).toBe(400);
        expect(canvas.height).toBe(200);
        expect(canvas.style.width).toBe('200px');
        expect(canvas.style.height).toBe('100px');
        expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
        expect(wave.w).toBe(200);
        expect(wave.h).toBe(100);
        expect(paint).toHaveBeenCalled();
    });

    it('does nothing without a context', () => {
        const wave = new LyricsWaveField(null, null);
        expect(() => wave.sync_size()).not.toThrow();
    });
});

describe('tick', () => {
    it('does nothing when stopped', () => {
        const { wave } = make_wave();
        const paint = vi.spyOn(wave, 'paint').mockImplementation(() => {});
        wave.tick(100);
        expect(paint).not.toHaveBeenCalled();
    });

    it('advances time and energy and schedules the next frame', () => {
        const { wave } = make_wave();
        wave.get_norm = () => ({
            ensure_wired: vi.fn(),
            bands_energy: () => ({ bass: 0.5, mid: 0.2, treble: 0.1 }),
        });
        const paint = vi.spyOn(wave, 'paint').mockImplementation(() => {});
        wave.running = true;
        wave.tick(100);
        wave.tick(200);
        expect(wave.energy.bass).toBe(0.5);
        expect(wave.t).toBeGreaterThan(0);
        expect(wave.hit).toBeGreaterThan(0);
        expect(paint).toHaveBeenCalled();
        expect(requestAnimationFrame).toHaveBeenCalled();
    });
});

describe('field_y', () => {
    it('returns a numeric y for a spec', () => {
        const { wave } = make_wave();
        wave.rebuild_layout();
        const y = wave.field_y(50, wave.layout.spec);
        expect(typeof y).toBe('number');
        expect(Number.isFinite(y)).toBe(true);
    });
});

describe('sample_scene', () => {
    it('samples points for every scene', () => {
        const { wave } = make_wave();
        wave.rebuild_layout();
        ['vortex', 'lens', 'ribbon', 'cross', 'horizon'].forEach((scene) => {
            wave.layout.scene = scene;
            const points = wave.sample_scene(wave.layout.spec, 1);
            expect(points.length).toBeGreaterThan(1);
            expect(typeof points[0].x).toBe('number');
            expect(typeof points[0].y).toBe('number');
        });
    });
});

describe('trace_smooth', () => {
    it('does nothing for an empty point list', () => {
        const { wave, ctx } = make_wave();
        wave.trace_smooth([]);
        expect(ctx.beginPath).not.toHaveBeenCalled();
    });

    it('traces a smooth path through the points', () => {
        const { wave, ctx } = make_wave();
        wave.trace_smooth([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
        expect(ctx.beginPath).toHaveBeenCalled();
        expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
        expect(ctx.quadraticCurveTo).toHaveBeenCalled();
        expect(ctx.lineTo).toHaveBeenCalledWith(20, 0);
    });
});

describe('paint_curve', () => {
    it('strokes the curve twice and restores the context', () => {
        const { wave, ctx } = make_wave();
        wave.paint_curve([{ x: 0, y: 0 }, { x: 10, y: 10 }], '#ffffff', 2, 0.5);
        expect(ctx.save).toHaveBeenCalled();
        expect(ctx.stroke).toHaveBeenCalledTimes(2);
        expect(ctx.restore).toHaveBeenCalled();
    });
});

describe('paint_scene_forms', () => {
    it('draws three curves for vortex', () => {
        const { wave } = make_wave();
        wave.rebuild_layout();
        const curve = vi.spyOn(wave, 'paint_curve').mockImplementation(() => {});
        wave.paint_scene_forms('vortex', ['#a', '#b', '#c'], 0);
        expect(curve).toHaveBeenCalledTimes(3);
    });

    it('draws two curves for diagonal', () => {
        const { wave } = make_wave();
        wave.rebuild_layout();
        const curve = vi.spyOn(wave, 'paint_curve').mockImplementation(() => {});
        wave.paint_scene_forms('diagonal', ['#a', '#b', '#c'], 0);
        expect(curve).toHaveBeenCalledTimes(2);
    });
});

describe('paint', () => {
    it('does nothing without a context', () => {
        const wave = new LyricsWaveField(null, null);
        expect(() => wave.paint()).not.toThrow();
    });

    it('builds the layout, paints the background and restores', () => {
        const { wave, ctx } = make_wave();
        wave.paint();
        expect(wave.layout).not.toBeNull();
        expect(ctx.createLinearGradient).toHaveBeenCalled();
        expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
        expect(ctx.save).toHaveBeenCalled();
        expect(ctx.restore).toHaveBeenCalled();
    });
});
