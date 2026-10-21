import { describe, expect, it } from 'vitest';

import { LyricsColorExtractor } from '../../static/js/player/lyrics_colors.js';

const colors = new LyricsColorExtractor();

describe('isColorDark', () => {
    it('treats black as dark and white as light', () => {
        expect(colors.isColorDark('#000000')).toBe(true);
        expect(colors.isColorDark('#ffffff')).toBe(false);
    });

    it('accepts rgb strings', () => {
        expect(colors.isColorDark('rgb(10, 10, 10)')).toBe(true);
        expect(colors.isColorDark('rgb(240, 240, 240)')).toBe(false);
    });

    it('defaults to dark for invalid input', () => {
        expect(colors.isColorDark(null)).toBe(true);
        expect(colors.isColorDark('nope')).toBe(true);
    });
});

describe('rgb_to_hsl', () => {
    it('converts red', () => {
        expect(colors.rgb_to_hsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 });
    });

    it('converts green', () => {
        expect(colors.rgb_to_hsl(0, 255, 0)).toEqual({ h: 120, s: 1, l: 0.5 });
    });

    it('converts blue', () => {
        expect(colors.rgb_to_hsl(0, 0, 255)).toEqual({ h: 240, s: 1, l: 0.5 });
    });

    it('converts gray', () => {
        expect(colors.rgb_to_hsl(128, 128, 128)).toEqual({ h: 0, s: 0, l: 128 / 255 });
    });
});

describe('hsl_to_rgb', () => {
    it('converts red', () => {
        expect(colors.hsl_to_rgb(0, 1, 0.5)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('converts green', () => {
        expect(colors.hsl_to_rgb(120, 1, 0.5)).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('converts blue', () => {
        expect(colors.hsl_to_rgb(240, 1, 0.5)).toEqual({ r: 0, g: 0, b: 255 });
    });
});

describe('pixel_chroma', () => {
    it('is zero for gray', () => {
        expect(colors.pixel_chroma(100, 100, 100)).toBe(0);
    });

    it('is one for a pure primary', () => {
        expect(colors.pixel_chroma(255, 0, 0)).toBe(1);
    });
});

describe('hue_distance', () => {
    it('measures the short way around the wheel', () => {
        expect(colors.hue_distance(0, 0)).toBe(0);
        expect(colors.hue_distance(0, 180)).toBe(180);
        expect(colors.hue_distance(350, 10)).toBe(20);
        expect(colors.hue_distance(10, 350)).toBe(20);
    });
});

describe('hex_from_rgb', () => {
    it('formats and clamps', () => {
        expect(colors.hex_from_rgb(255, 0, 0)).toBe('#ff0000');
        expect(colors.hex_from_rgb(300, -20, 128)).toBe('#ff0080');
    });
});

describe('lyrics_tone', () => {
    it('returns a hex color', () => {
        const tone = colors.lyrics_tone({ h: 200, s: 0.5 }, 0.2, 1.2);
        expect(tone).toMatch(/^#[0-9a-f]{6}$/);
    });
});

describe('ranked_cover_hues', () => {
    it('ignores transparent and gray pixels', () => {
        const data = new Uint8ClampedArray([
            255, 0, 0, 255,
            100, 100, 100, 255,
            0, 0, 0, 0,
        ]);
        const ranked = colors.ranked_cover_hues(data);
        expect(ranked).toHaveLength(1);
        expect(ranked[0].h).toBe(0);
    });

    it('sorts by score', () => {
        const data = new Uint8ClampedArray([
            255, 0, 0, 255,
            255, 0, 0, 255,
            0, 0, 255, 255,
        ]);
        const ranked = colors.ranked_cover_hues(data);
        expect(ranked[0].h).toBe(0);
    });
});

describe('pick_cover_hues', () => {
    it('picks up to three well-separated hues', () => {
        const picked = colors.pick_cover_hues([
            { h: 0, s: 0.8 },
            { h: 10, s: 0.7 },
            { h: 120, s: 0.6 },
            { h: 240, s: 0.9 },
        ]);
        expect(picked).toHaveLength(3);
        expect(picked[0].h).toBe(0);
        expect(picked[1].h).toBe(120);
        expect(picked[2].h).toBe(240);
    });

    it('falls back to defaults when nothing is ranked', () => {
        const picked = colors.pick_cover_hues([]);
        expect(picked).toHaveLength(3);
        expect(picked[0].h).toBe(270);
    });
});
