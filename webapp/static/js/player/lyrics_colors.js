/**
 * Pure color math for the lyrics panel theme.
 * Extracts a small palette from cover art (via canvas) and converts between
 * RGB and HSL. No DOM state or playback logic - safe to unit test.
 */
export class LyricsColorExtractor {
    isColorDark(hexColor) {
        if (!hexColor || typeof hexColor !== 'string') return true;
        let r, g, b;
        if (hexColor.startsWith('#')) {
            const hex = hexColor.replace('#', '');
            r = parseInt(hex.substring(0, 2), 16);
            g = parseInt(hex.substring(2, 4), 16);
            b = parseInt(hex.substring(4, 6), 16);
        } else if (hexColor.startsWith('rgb')) {
            const match = hexColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
                r = parseInt(match[1], 10);
                g = parseInt(match[2], 10);
                b = parseInt(match[3], 10);
            }
        }
        if (isNaN(r) || isNaN(g) || isNaN(b)) return true;
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance < 0.5;
    }

    rgb_to_hsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        const l = (max + min) / 2;
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return { h, s, l };
    }

    hsl_to_rgb(h, s, l) {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        let r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255),
        };
    }

    pixel_chroma(r, g, b) {
        return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    }

    hue_distance(a, b) {
        const d = Math.abs(a - b) % 360;
        return Math.min(d, 360 - d);
    }

    hex_from_rgb(r, g, b) {
        return '#' + [r, g, b].map(x => Math.min(255, Math.max(0, Math.round(x))).toString(16).padStart(2, '0')).join('');
    }

    lyrics_tone(hsl, lightness, sat_mul) {
        const s = Math.min(0.95, Math.max(0.45, hsl.s * (sat_mul == null ? 1.35 : sat_mul)));
        const rgb = this.hsl_to_rgb(hsl.h, s, lightness);
        return this.hex_from_rgb(rgb.r, rgb.g, rgb.b);
    }

    ranked_cover_hues(data) {
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            if (data[i + 3] < 128) continue;
            const mx = Math.max(r, g, b);
            const mn = Math.min(r, g, b);
            if (mx < 20 || mn > 240) continue;
            const chroma = this.pixel_chroma(r, g, b);
            if (chroma < 0.08) continue;
            const hsl = this.rgb_to_hsl(r, g, b);
            const hue_key = Math.round(hsl.h / 12) * 12;
            const prev = buckets.get(hue_key) || { n: 0, chroma: 0, h: hsl.h, s: hsl.s };
            prev.n += 1;
            prev.chroma += chroma;
            prev.s = Math.max(prev.s, hsl.s);
            buckets.set(hue_key, prev);
        }
        return [...buckets.values()]
            .map(v => ({ h: v.h, s: v.s, score: v.n * (0.2 + v.chroma / Math.max(1, v.n)) }))
            .sort((a, b) => b.score - a.score);
    }

    pick_cover_hues(ranked) {
        const picked = [];
        for (const c of ranked) {
            if (picked.every(p => this.hue_distance(p.h, c.h) >= 28)) {
                picked.push(c);
                if (picked.length === 3) break;
            }
        }
        if (!picked.length) {
            picked.push({ h: 270, s: 0.65 }, { h: 200, s: 0.55 }, { h: 320, s: 0.5 });
        }
        while (picked.length < 3) {
            const base = picked[0];
            picked.push({ h: (base.h + picked.length * 40) % 360, s: Math.max(0.5, base.s) });
        }
        return picked;
    }

    calculateLyricsColors(img) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const size = 64;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);

        try {
            ctx.getImageData(0, 0, 1, 1);
        } catch (e) {
            throw new Error('Canvas tainted');
        }

        const data = ctx.getImageData(0, 0, size, size).data;
        const hues = this.pick_cover_hues(this.ranked_cover_hues(data));
        const fills = [
            this.lyrics_tone(hues[0], 0.14, 1.1),
            this.lyrics_tone(hues[1], 0.20, 1.15),
            this.lyrics_tone(hues[2], 0.26, 1.2),
            this.lyrics_tone(hues[0], 0.32, 1.05),
        ];
        const strokes = [
            this.lyrics_tone(hues[0], 0.68, 1.4),
            this.lyrics_tone(hues[1], 0.62, 1.35),
            this.lyrics_tone(hues[2], 0.58, 1.3),
        ];
        return {
            background: fills[0],
            fills,
            strokes,
            text: '#ffffff',
            isDark: true
        };
    }
}