/**
 * Cover-tinted silk field. Layout is unique per track; audio energy reshapes it.
 */
export class LyricsWaveField {
    constructor(canvas, get_norm) {
        this.canvas = canvas;
        this.get_norm = get_norm || (() => null);
        this.ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
        this.palette = LyricsWaveField.default_palette();
        this.t = 0;
        this.last_ms = 0;
        this.raf = 0;
        this.running = false;
        this.held = false;
        this.w = 1;
        this.h = 1;
        this.mood = 'pop';
        this.track_key = '';
        this.energy = { bass: 0, mid: 0, treble: 0 };
        this.prev_bass = 0;
        this.hit = 0;
        this.layout = null;
        if (canvas && canvas.parentElement) {
            this.ro = new ResizeObserver(() => this.sync_size());
            this.ro.observe(canvas.parentElement);
        }
        document.addEventListener('visibilitychange', () => this.on_visibility());
    }

    static default_palette() {
        return {
            bg: '#0a1a16',
            fills: ['#0d2a24', '#16382e', '#0f2420', '#1a4034'],
            strokes: ['#e8c56b', '#f0d78a', '#c9a227'],
        };
    }

    hash_str(s) {
        let h = 2166136261;
        const t = String(s || '');
        for (let i = 0; i < t.length; i += 1) {
            h ^= t.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    unit(h, i) {
        return ((h >>> (i * 5)) & 1023) / 1023;
    }

    set_palette(palette) {
        if (!palette) return;
        this.palette = palette;
        this.paint();
    }

    set_mood(mood) {
        this.mood = mood || 'pop';
        this.layout = null;
    }

    set_track_key(title, artist) {
        this.track_key = `${title || ''}|${artist || ''}`;
        this.layout = null;
    }

    mood_params() {
        const m = this.mood;
        if (m === 'electronic') return { speed: 0.00048, amp: 1.1, glow: 1.25, hit: 1.4 };
        if (m === 'rock') return { speed: 0.00034, amp: 1.25, glow: 1.05, hit: 1.7 };
        if (m === 'ambient') return { speed: 0.00012, amp: 0.65, glow: 0.8, hit: 0.45 };
        return { speed: 0.00024, amp: 1, glow: 1, hit: 1 };
    }

    pick_scene(h) {
        const m = this.mood;
        const bag = m === 'electronic' ? ['vortex', 'diagonal', 'cross']
            : m === 'rock' ? ['horizon', 'cross', 'ribbon']
            : m === 'ambient' ? ['ribbon', 'lens', 'horizon']
            : ['ribbon', 'horizon', 'diagonal', 'lens'];
        return bag[h % bag.length];
    }

    rebuild_layout() {
        const h = this.hash_str(this.track_key + ':' + this.mood);
        const u = (i) => this.unit(h, i);
        const scene = this.pick_scene(h);
        const k1 = 1.6 + u(1) * 2.4;
        const k2 = 0.8 + u(2) * 1.8;
        const k3 = 3.2 + u(3) * 3.0;
        this.layout = {
            scene,
            rotate: scene === 'diagonal' ? (-0.28 + u(4) * 0.56) : 0,
            cx: 0.35 + u(5) * 0.3,
            cy: 0.38 + u(6) * 0.28,
            turns: 1.2 + u(7) * 1.6,
            spec: {
                y0: 0.32 + u(8) * 0.28,
                k1, k2, k3,
                w1: 0.28 + u(9) * 0.45,
                w2: 0.18 + u(10) * 0.4,
                w3: 0.1 + u(11) * 0.22,
                ph: u(12) * Math.PI * 2,
                a1: 0.06 + u(13) * 0.07,
                a2: 0.025 + u(14) * 0.04,
                a3: 0.008 + u(15) * 0.018,
                thick: 0.22 + u(16) * 0.16,
            },
            spec_b: {
                y0: 0.58 + u(17) * 0.22,
                k1: k1 * 0.85, k2: k2 * 1.1, k3: k3 * 0.9,
                w1: 0.22 + u(18) * 0.4,
                w2: 0.2 + u(19) * 0.35,
                w3: 0.12 + u(20) * 0.2,
                ph: u(12) * Math.PI * 2 + 1.7,
                a1: 0.05 + u(21) * 0.06,
                a2: 0.02 + u(22) * 0.035,
                a3: 0.008 + u(23) * 0.014,
                thick: 0.2 + u(24) * 0.14,
            },
        };
    }

    start() {
        if (!this.ctx) return false;
        this.held = false;
        this.canvas.classList.remove('hidden');
        this.sync_size();
        if (this.running) return true;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.paint();
            return true;
        }
        this.running = true;
        this.last_ms = 0;
        this.raf = requestAnimationFrame((ms) => this.tick(ms));
        return true;
    }

    stop() {
        this.held = false;
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        if (this.canvas) this.canvas.classList.add('hidden');
    }

    on_visibility() {
        if (document.hidden) {
            this.held = this.running;
            this.running = false;
            if (this.raf) cancelAnimationFrame(this.raf);
            this.raf = 0;
            return;
        }
        if (this.held) this.start();
    }

    sync_size() {
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!canvas || !ctx || !canvas.parentElement) return;
        const box = canvas.parentElement.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.floor(box.width));
        const h = Math.max(1, Math.floor(box.height));
        if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
            canvas.width = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.w = w;
        this.h = h;
        this.paint();
    }

    tick(ms) {
        if (!this.running) return;
        const mood = this.mood_params();
        const norm = this.get_norm();
        if (norm && typeof norm.ensure_wired === 'function') norm.ensure_wired();
        if (norm && typeof norm.bands_energy === 'function') this.energy = norm.bands_energy();
        const bass = this.energy.bass || 0;
        if (bass > this.prev_bass + 0.11) this.hit = Math.min(1.2, this.hit + (bass - this.prev_bass) * 4 * mood.hit);
        this.hit *= 0.9;
        this.prev_bass = bass;
        if (this.last_ms) this.t += (ms - this.last_ms) * mood.speed * (0.7 + this.energy.mid * 0.9 + this.hit * 0.35);
        this.last_ms = ms;
        this._amp = mood.amp * (1 + bass * 0.55 + this.hit * 0.7);
        this._glow = mood.glow * (0.55 + this.energy.treble * 1.1 + this.hit * 0.6);
        this.paint();
        this.raf = requestAnimationFrame((next) => this.tick(next));
    }

    field_y(x, spec) {
        const nx = x / this.w;
        const amp = this._amp == null ? 1 : this._amp;
        return spec.y0 * this.h
            + Math.sin(nx * spec.k1 + this.t * spec.w1 + spec.ph) * spec.a1 * this.h * amp
            + Math.sin(nx * spec.k2 - this.t * spec.w2) * spec.a2 * this.h * amp
            + Math.sin(nx * spec.k3 + this.t * spec.w3) * spec.a3 * this.h * amp;
    }

    sample_scene(spec, which) {
        const w = this.w;
        const h = this.h;
        const scene = this.layout.scene;
        const step = Math.max(4, Math.floor(w / 150));
        const pts = [];
        const amp = this._amp == null ? 1 : this._amp;
        const n = Math.ceil(w / step);
        for (let i = 0; i <= n; i += 1) {
            const u = i / n;
            let p;
            if (scene === 'vortex') {
                const ang = u * Math.PI * 2 * this.layout.turns + this.t * spec.w1 + spec.ph;
                const r = h * (0.12 + 0.34 * u) + Math.sin(ang * 2 + this.t) * spec.a1 * h * amp;
                p = {
                    x: this.layout.cx * w + Math.cos(ang) * r,
                    y: this.layout.cy * h + Math.sin(ang) * r * 0.58,
                };
            } else if (scene === 'lens') {
                const ang = -0.2 + u * (Math.PI + 0.4) + Math.sin(this.t * spec.w2) * 0.12;
                const r = h * (0.22 + 0.18 * which) + Math.sin(u * spec.k1 + this.t * spec.w1) * spec.a1 * h * amp;
                p = {
                    x: this.layout.cx * w + Math.cos(ang) * r * 1.55,
                    y: this.layout.cy * h + Math.sin(ang) * r,
                };
            } else if (scene === 'ribbon') {
                const x = u * w;
                const base = h * (0.28 + which * 0.32);
                const s = Math.sin(u * Math.PI + spec.ph + this.t * spec.w1 * 0.6);
                p = { x, y: base + s * h * 0.28 + (this.field_y(x, spec) - spec.y0 * h) * 0.45 };
            } else if (scene === 'cross' && which) {
                const x = u * w;
                p = { x, y: h - this.field_y(x, spec) };
            } else {
                const x = u * w;
                p = { x, y: this.field_y(x, spec) };
            }
            pts.push(p);
        }
        return pts;
    }

    trace_smooth(points) {
        const ctx = this.ctx;
        if (!points.length) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i += 1) {
            ctx.quadraticCurveTo(
                points[i].x,
                points[i].y,
                (points[i].x + points[i + 1].x) / 2,
                (points[i].y + points[i + 1].y) / 2,
            );
        }
        const last = points[points.length - 1];
        ctx.lineTo(last.x, last.y);
    }

    paint_curve(points, color, width, alpha) {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = Math.max(18, width * 1.8);
        ctx.globalAlpha = alpha * 0.42;
        ctx.lineWidth = width * 1.7;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        this.trace_smooth(points);
        ctx.stroke();
        ctx.shadowBlur = Math.max(8, width * 0.55);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        this.trace_smooth(points);
        ctx.stroke();
        ctx.restore();
    }

    paint_scene_forms(scene, colors, phase) {
        const [color_a, color_b, color_c] = colors;
        const width = Math.min(this.w, this.h) * (this.mood === 'ambient' ? 0.045 : 0.065);
        const third_spec = { ...this.layout.spec, ph: this.layout.spec.ph + phase * 0.35 + 1.4 };
        const first = this.sample_scene(this.layout.spec, 0);
        const second = this.sample_scene(this.layout.spec_b, 1);
        const third = this.sample_scene(third_spec, 0);

        if (scene === 'vortex') {
            this.paint_curve(first, color_a, width * 1.1, 0.24);
            this.paint_curve(second, color_b, width * 0.72, 0.17);
            this.paint_curve(third, color_c, width * 0.45, 0.11);
            return;
        }
        if (scene === 'diagonal') {
            this.paint_curve(first, color_a, width * 1.15, 0.2);
            this.paint_curve(second, color_b, width * 0.8, 0.15);
            return;
        }
        if (scene === 'cross') {
            this.paint_curve(first, color_a, width * 1.25, 0.21);
            this.paint_curve(second, color_b, width * 1.05, 0.17);
            this.paint_curve(third, color_c, width * 0.52, 0.1);
            return;
        }
        if (scene === 'horizon') {
            this.paint_curve(first, color_a, width * 1.3, 0.19);
            this.paint_curve(second, color_b, width * 0.92, 0.15);
            this.paint_curve(third, color_c, width * 0.58, 0.1);
            return;
        }
        if (scene === 'lens') {
            this.paint_curve(first, color_a, width * 1.08, 0.22);
            this.paint_curve(second, color_b, width * 0.86, 0.17);
            this.paint_curve(third, color_c, width * 0.5, 0.1);
            return;
        }
        this.paint_curve(first, color_a, width * 1.18, 0.2);
        this.paint_curve(second, color_b, width * 0.9, 0.15);
        this.paint_curve(third, color_c, width * 0.5, 0.1);
    }

    paint() {
        const ctx = this.ctx;
        if (!ctx) return;
        if (!this.layout) this.rebuild_layout();
        const pal = this.palette;
        const fills = pal.fills || [];
        const strokes = pal.strokes || [];
        const background = ctx.createLinearGradient(0, 0, this.w, this.h);
        const base = pal.bg || '#0a1a16';
        const first_fill = fills[0] || base;
        const last_fill = fills[2] || first_fill;
        background.addColorStop(0, base);
        background.addColorStop(0.55, first_fill);
        background.addColorStop(1, last_fill);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, this.w, this.h);

        ctx.save();
        if (this.layout.rotate) {
            ctx.translate(this.w / 2, this.h / 2);
            ctx.rotate(this.layout.rotate);
            ctx.translate(-this.w / 2, -this.h / 2);
        }

        const color_a = strokes[0] || fills[0] || '#e8c56b';
        const color_b = strokes[1] || fills[1] || color_a;
        const color_c = strokes[2] || fills[2] || color_a;
        const scene = this.layout.scene;
        const e = this.energy;
        const bass = e.bass || 0;
        const beat = this.hit || 0;
        const phase = this.t + this.layout.spec.ph;
        this.paint_scene_forms(scene, [color_a, color_b, color_c], phase + bass * 0.6 + beat * 0.3);
        ctx.restore();
    }
}
