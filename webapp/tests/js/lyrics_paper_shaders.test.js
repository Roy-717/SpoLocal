import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LyricsPaperShaders } from '../../static/js/player/lyrics_paper_shaders.js';

function make_host() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return host;
}

function fake_mount() {
    return {
        setUniforms: vi.fn(),
        setSpeed: vi.fn(),
        dispose: vi.fn(),
    };
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('static mood table', () => {
    it('defines four moods', () => {
        expect(Object.keys(LyricsPaperShaders.MOOD)).toEqual(['pop', 'electronic', 'rock', 'ambient']);
        expect(LyricsPaperShaders.MOOD.pop.distortion).toBe(0.82);
    });
});

describe('constructor', () => {
    it('starts idle with the default palette', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.host).toBeNull();
        expect(shader.mount).toBeNull();
        expect(shader.running).toBe(false);
        expect(shader.mood).toBe('pop');
        expect(shader.track_key).toBe('');
        expect(shader.ok).toBe(false);
        expect(shader.palette).toEqual(LyricsPaperShaders.default_palette());
    });

    it('uses a no-op normalizer by default', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.get_norm()).toBeNull();
    });
});

describe('default_palette', () => {
    it('returns the green and gold palette', () => {
        const pal = LyricsPaperShaders.default_palette();
        expect(pal.bg).toBe('#0a1a16');
        expect(pal.fills).toHaveLength(4);
        expect(pal.strokes).toHaveLength(3);
    });
});

describe('blend_toward', () => {
    it('returns the endpoints and clamps t', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.blend_toward([0, 0, 0], [1, 1, 1], 0)).toEqual([0, 0, 0, 1]);
        expect(shader.blend_toward([0, 0, 0], [1, 1, 1], 1)).toEqual([1, 1, 1, 1]);
        expect(shader.blend_toward([0, 0, 0], [1, 1, 1], 2)).toEqual([1, 1, 1, 1]);
        expect(shader.blend_toward([0, 0, 0], [1, 1, 1], -1)).toEqual([0, 0, 0, 1]);
    });

    it('interpolates halfway', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.blend_toward([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5, 1]);
    });
});

describe('hex_or_rgb', () => {
    it('parses hex and rgb strings', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.hex_or_rgb('#ff0000')).toEqual([1, 0, 0, 1]);
        expect(shader.hex_or_rgb('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    });

    it('falls back for empty input', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.hex_or_rgb('')).toEqual([0.05, 0.1, 0.09, 1]);
        expect(shader.hex_or_rgb(null)).toEqual([0.05, 0.1, 0.09, 1]);
    });

    it('falls back for unsupported input', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.hex_or_rgb('nope')).toEqual([0, 0, 0, 1]);
        expect(error).toHaveBeenCalled();
    });
});

describe('color_list', () => {
    it('builds five blended colors padded to ten', () => {
        const shader = new LyricsPaperShaders(null, null);
        const colors = shader.color_list();
        expect(colors).toHaveLength(10);
        expect(shader._color_count).toBe(5);
        expect(colors[5]).toEqual([0, 0, 0, 0]);
        expect(colors[0]).toHaveLength(4);
    });
});

describe('hash_str', () => {
    it('is deterministic and unsigned', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.hash_str('abc')).toBe(shader.hash_str('abc'));
        expect(shader.hash_str('abc')).toBeGreaterThanOrEqual(0);
        expect(shader.hash_str('abc')).not.toBe(shader.hash_str('abd'));
        expect(shader.hash_str(null)).toBe(shader.hash_str(''));
    });
});

describe('track_variation', () => {
    it('stays inside the documented ranges', () => {
        const shader = new LyricsPaperShaders(null, null);
        shader.track_key = 'Title|Artist';
        const variation = shader.track_variation();
        expect(variation.scale).toBeGreaterThanOrEqual(0.96);
        expect(variation.scale).toBeLessThanOrEqual(1.08);
        expect(Math.abs(variation.rotation)).toBeLessThanOrEqual(0.09);
        expect(Math.abs(variation.offset_x)).toBeLessThanOrEqual(0.04);
        expect(Math.abs(variation.offset_y)).toBeLessThanOrEqual(0.04);
    });
});

describe('sizing_uniforms', () => {
    it('returns cover fit and centered origin', () => {
        const shader = new LyricsPaperShaders(null, null);
        const uniforms = shader.sizing_uniforms();
        expect(uniforms.u_fit).toBe(2);
        expect(uniforms.u_originX).toBe(0.5);
        expect(uniforms.u_originY).toBe(0.5);
        expect(uniforms.u_worldWidth).toBe(0);
        expect(uniforms.u_worldHeight).toBe(0);
    });
});

describe('mesh_uniforms', () => {
    it('adds energy to the mood values', () => {
        const shader = new LyricsPaperShaders(null, null);
        const uniforms = shader.mesh_uniforms({ bass: 0.5, mid: 0.2, treble: 0 });
        expect(uniforms.u_colors).toHaveLength(10);
        expect(uniforms.u_colorsCount).toBe(5);
        expect(uniforms.u_distortion).toBeCloseTo(0.82 + 0.5 * 0.55);
        expect(uniforms.u_swirl).toBeCloseTo(0.12 + 0.2 * 0.28);
        expect(uniforms.u_grainMixer).toBe(0.04);
        expect(uniforms.u_grainOverlay).toBe(0.05);
    });

    it('treats missing energy as zero', () => {
        const shader = new LyricsPaperShaders(null, null);
        const uniforms = shader.mesh_uniforms(null);
        expect(uniforms.u_distortion).toBe(0.82);
        expect(uniforms.u_swirl).toBe(0.12);
    });
});

describe('mood_speed', () => {
    it('combines mood speed with bass and treble', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.mood_speed({ bass: 0.5, treble: 0.4 })).toBeCloseTo(0.38 + 0.5 * 1.15 + 0.4 * 0.25);
        expect(shader.mood_speed(null)).toBe(0.38);
    });
});

describe('set_mood and set_track_key', () => {
    it('accepts known moods and falls back to pop', () => {
        const shader = new LyricsPaperShaders(null, null);
        shader.set_mood('rock');
        expect(shader.mood).toBe('rock');
        shader.set_mood('nope');
        expect(shader.mood).toBe('pop');
    });

    it('stores the track key', () => {
        const shader = new LyricsPaperShaders(null, null);
        shader.set_track_key('Title', 'Artist');
        expect(shader.track_key).toBe('Title|Artist');
        shader.set_track_key(null, null);
        expect(shader.track_key).toBe('|');
    });
});

describe('set_palette', () => {
    it('merges partial palettes', () => {
        const shader = new LyricsPaperShaders(null, null);
        shader.set_palette({ bg: '#000000' });
        expect(shader.palette.bg).toBe('#000000');
        expect(shader.palette.fills).toEqual(LyricsPaperShaders.default_palette().fills);
    });

    it('ignores a missing palette', () => {
        const shader = new LyricsPaperShaders(null, null);
        const before = shader.palette;
        shader.set_palette(null);
        expect(shader.palette).toBe(before);
    });
});

describe('push_uniforms', () => {
    it('does nothing without a mount', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(() => shader.push_uniforms()).not.toThrow();
    });

    it('pushes uniforms and speed to the mount', () => {
        const shader = new LyricsPaperShaders(null, () => ({
            bands_energy: () => ({ bass: 0.5, mid: 0.2, treble: 0.1 }),
        }));
        shader.mount = fake_mount();
        shader.push_uniforms();
        expect(shader.mount.setUniforms).toHaveBeenCalled();
        expect(shader.mount.setSpeed).toHaveBeenCalledWith(shader.mood_speed({ bass: 0.5, mid: 0.2, treble: 0.1 }));
    });
});

describe('mount_shader', () => {
    it('returns false without a host', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.mount_shader()).toBe(false);
    });

    it('returns false when WebGL is unavailable', () => {
        const shader = new LyricsPaperShaders(make_host(), null);
        expect(shader.mount_shader()).toBe(false);
        expect(shader.mount).toBeNull();
        expect(shader.ok).toBe(false);
    });

    it('does not remount when a mount exists', () => {
        const shader = new LyricsPaperShaders(make_host(), null);
        shader.mount = fake_mount();
        expect(shader.mount_shader()).toBe(false);
    });
});

describe('start', () => {
    it('returns false without a host', () => {
        const shader = new LyricsPaperShaders(null, null);
        expect(shader.start()).toBe(false);
    });

    it('returns false when the shader cannot mount', () => {
        const shader = new LyricsPaperShaders(make_host(), null);
        expect(shader.start()).toBe(false);
        expect(shader.running).toBe(false);
    });

    it('starts the loop with an existing mount', () => {
        const host = make_host();
        const shader = new LyricsPaperShaders(host, null);
        shader.mount = fake_mount();
        host.classList.add('hidden');
        expect(shader.start()).toBe(true);
        expect(shader.running).toBe(true);
        expect(host.classList.contains('hidden')).toBe(false);
        expect(shader.mount.setUniforms).toHaveBeenCalled();
        expect(requestAnimationFrame).toHaveBeenCalled();
    });
});

describe('loop', () => {
    it('does nothing when stopped', () => {
        const shader = new LyricsPaperShaders(null, null);
        shader.loop();
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('schedules the next frame while running', () => {
        const shader = new LyricsPaperShaders(null, null);
        shader.running = true;
        shader.loop();
        expect(requestAnimationFrame).toHaveBeenCalled();
    });
});

describe('stop and dispose', () => {
    it('stops the loop, zeroes speed and hides the host', () => {
        const host = make_host();
        const shader = new LyricsPaperShaders(host, null);
        shader.mount = fake_mount();
        shader.running = true;
        shader.raf = 9;
        shader.stop();
        expect(shader.running).toBe(false);
        expect(shader.raf).toBe(0);
        expect(cancelAnimationFrame).toHaveBeenCalledWith(9);
        expect(shader.mount.setSpeed).toHaveBeenCalledWith(0);
        expect(host.classList.contains('hidden')).toBe(true);
    });

    it('disposes the mount', () => {
        const shader = new LyricsPaperShaders(make_host(), null);
        const mount = fake_mount();
        shader.mount = mount;
        shader.dispose();
        expect(mount.dispose).toHaveBeenCalled();
        expect(shader.mount).toBeNull();
        expect(shader.running).toBe(false);
    });
});
