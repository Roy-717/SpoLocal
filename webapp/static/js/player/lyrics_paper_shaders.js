import {
    ShaderMount,
    ShaderFitOptions,
    meshGradientFragmentShader,
    getShaderColorFromString,
} from '../vendor/paper-shaders/index.js';

/**
 * Lyrics background via Paper Shaders Mesh Gradient (npm @paper-design/shaders).
 * Cover colors + analyser energy drive uniforms. Not a custom silk renderer.
 */
export class LyricsPaperShaders {
    static MOOD = {
        pop: { distortion: 0.82, swirl: 0.12, speed: 0.38 },
        electronic: { distortion: 1.15, swirl: 0.42, speed: 0.72 },
        rock: { distortion: 1.02, swirl: 0.26, speed: 0.58 },
        ambient: { distortion: 0.42, swirl: 0.07, speed: 0.16 },
    };

    constructor(host, get_norm) {
        this.host = host;
        this.get_norm = get_norm || (() => null);
        this.mount = null;
        this.running = false;
        this.mood = 'pop';
        this.track_key = '';
        this.palette = LyricsPaperShaders.default_palette();
        this.raf = 0;
        this.ok = false;
    }

    static default_palette() {
        return {
            bg: '#0a1a16',
            fills: ['#0d2a24', '#16382e', '#0f2420', '#1a4034'],
            strokes: ['#e8c56b', '#f0d78a', '#c9a227'],
        };
    }

    blend_toward(from, toward, t) {
        const k = Math.max(0, Math.min(1, t));
        return [
            from[0] + (toward[0] - from[0]) * k,
            from[1] + (toward[1] - from[1]) * k,
            from[2] + (toward[2] - from[2]) * k,
            1,
        ];
    }

    hex_or_rgb(c) {
        const s = String(c || '').trim();
        if (!s) return [0.05, 0.1, 0.09, 1];
        try {
            const v = getShaderColorFromString(s);
            if (Array.isArray(v) && v.length >= 3) {
                return [v[0], v[1], v[2], v[3] == null ? 1 : v[3]];
            }
        } catch (e) {}
        const rgb = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, 1];
        return [0.05, 0.1, 0.09, 1];
    }

    color_list() {
        const fills = (this.palette.fills || []).map((c) => this.hex_or_rgb(c));
        const base = fills[0] || this.hex_or_rgb(this.palette.bg);
        const accent = fills[1] || base;
        const third = fills[2] || accent;
        const fourth = fills[3] || base;
        const unique = [
            this.blend_toward(base, [0, 0, 0, 1], 0.24),
            this.blend_toward(base, accent, 0.38),
            this.blend_toward(accent, third, 0.52),
            this.blend_toward(third, fourth, 0.42),
            this.blend_toward(fourth, base, 0.36),
        ];
        this._color_count = unique.length;
        const out = unique.slice();
        while (out.length < 10) out.push([0, 0, 0, 0]);
        return out;
    }

    hash_str(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    track_variation() {
        const hash = this.hash_str(this.track_key);
        const unit = (shift) => ((hash >>> shift) & 1023) / 1023;
        return {
            scale: 0.96 + unit(0) * 0.12,
            rotation: (unit(10) - 0.5) * 0.18,
            offset_x: (unit(20) - 0.5) * 0.08,
            offset_y: (unit(30) - 0.5) * 0.08,
        };
    }

    sizing_uniforms() {
        const variation = this.track_variation();
        return {
            u_fit: ShaderFitOptions.cover,
            u_scale: variation.scale,
            u_rotation: variation.rotation,
            u_offsetX: variation.offset_x,
            u_offsetY: variation.offset_y,
            u_originX: 0.5,
            u_originY: 0.5,
            u_worldWidth: 0,
            u_worldHeight: 0,
        };
    }

    mesh_uniforms(energy) {
        const mood = LyricsPaperShaders.MOOD[this.mood] || LyricsPaperShaders.MOOD.pop;
        const bass = energy && energy.bass ? energy.bass : 0;
        const mid = energy && energy.mid ? energy.mid : 0;
        const colors = this.color_list();
        return {
            ...this.sizing_uniforms(),
            u_colors: colors,
            u_colorsCount: this._color_count || colors.length,
            u_distortion: mood.distortion + bass * 0.55,
            u_swirl: mood.swirl + mid * 0.28,
            u_grainMixer: 0.04,
            u_grainOverlay: 0.05,
        };
    }

    mood_speed(energy) {
        const mood = LyricsPaperShaders.MOOD[this.mood] || LyricsPaperShaders.MOOD.pop;
        const bass = energy && energy.bass ? energy.bass : 0;
        const treble = energy && energy.treble ? energy.treble : 0;
        return mood.speed + bass * 1.15 + treble * 0.25;
    }

    set_mood(mood) {
        this.mood = LyricsPaperShaders.MOOD[mood] ? mood : 'pop';
        this.push_uniforms();
    }

    set_track_key(title, artist) {
        this.track_key = `${title || ''}|${artist || ''}`;
        this.push_uniforms();
    }

    set_palette(palette) {
        if (!palette) return;
        this.palette = {
            bg: palette.bg || this.palette.bg,
            fills: palette.fills || this.palette.fills,
            strokes: palette.strokes || this.palette.strokes,
        };
        this.push_uniforms();
    }

    push_uniforms() {
        if (!this.mount) return;
        const energy = this.get_norm() ? this.get_norm().bands_energy() : { bass: 0, mid: 0, treble: 0 };
        this.mount.setUniforms(this.mesh_uniforms(energy));
        this.mount.setSpeed(this.mood_speed(energy));
    }

    mount_shader() {
        if (this.mount || !this.host) return false;
        try {
            this.mount = new ShaderMount(
                this.host,
                meshGradientFragmentShader,
                this.mesh_uniforms({ bass: 0, mid: 0, treble: 0 }),
                { alpha: false, antialias: true },
                0.4,
                0,
                1.25,
            );
            this.ok = true;
            return true;
        } catch (e) {
            this.mount = null;
            this.ok = false;
            return false;
        }
    }

    start() {
        if (!this.host) return false;
        this.host.classList.remove('hidden');
        if (!this.mount && !this.mount_shader()) return false;
        this.running = true;
        this.push_uniforms();
        this.loop();
        return true;
    }

    loop() {
        if (!this.running) return;
        cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(() => {
            if (!this.running) return;
            const now = performance.now();
            if (!this._last_push || now - this._last_push > 50) {
                this._last_push = now;
                this.push_uniforms();
            }
            this.loop();
        });
    }

    stop() {
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        if (this.mount) this.mount.setSpeed(0);
        if (this.host) this.host.classList.add('hidden');
    }

    dispose() {
        this.stop();
        if (this.mount) {
            this.mount.dispose();
            this.mount = null;
        }
    }
}
