/**
 * Butterchurn (Milkdrop) visuals behind lyrics, driven by the player AudioContext.
 */
export class LyricsMilkdrop {
    static PACKS = {
        electronic: [
            'fiShbRaiN + Flexi - witchcraft 2.0',
            'flexi + amandio c - organic [random mashup]',
            'Eo.S. - glowsticks v2 05 and proton lights (+Krash′s beat code) _Phat_remix02b',
        ],
        rock: [
            'Cope - The Neverending Explosion of Red Liquid Fire',
            '_Rovastar + Geiss - Hurricane Nightmare (Posterize Mix)',
            'Aderrasi - Storm of the Eye (Thunder) - mash0000 - quasi pseudo meta concentrics',
        ],
        ambient: [
            '_Geiss - Desert Rose 2',
            'Aderrasi - Potion of Spirits',
            'cope + martin - mother-of-pearl',
        ],
        pop: [
            'Eo.S. + Zylot - skylight (Stained Glass Majesty mix)',
            'Aderrasi - Songflower (Moss Posy)',
            '$$$ Royal - Mashup (220)',
        ],
    };

    constructor(canvas, get_norm) {
        this.canvas = canvas;
        this.get_norm = get_norm;
        this.visualizer = null;
        this.presets = null;
        this.running = false;
        this.held = false;
        this.raf = 0;
        this.pack = 'auto';
        this.track_seed = '';
        this.audio_connected = false;
        this.ready = false;
        if (canvas && canvas.parentElement) {
            this.ro = new ResizeObserver(() => this.sync_size());
            this.ro.observe(canvas.parentElement);
        }
        document.addEventListener('visibilitychange', () => this.on_visibility());
    }

    guess_pack(title, artist) {
        const s = `${title || ''} ${artist || ''}`.toLowerCase();
        if (/(edm|electro|house|techno|trance|dubstep|dnb|synth|daft|kraftwerk|aphex|skrillex)/.test(s)) {
            return 'electronic';
        }
        if (/(rock|metal|punk|grunge|nirvana|radiohead|arctic|foo fighter|killers)/.test(s)) {
            return 'rock';
        }
        if (/(ambient|classical|piano|score|lofi|lo-fi|chill)/.test(s)) {
            return 'ambient';
        }
        return 'pop';
    }

    set_pack(pack) {
        const next = pack === 'auto' || LyricsMilkdrop.PACKS[pack] ? pack : 'auto';
        this.pack = next;
        this.load_preset_for_track();
    }

    set_track(title, artist) {
        this.track_seed = `${title || ''}\n${artist || ''}`;
        this.track_title = title || '';
        this.track_artist = artist || '';
        this.load_preset_for_track();
    }

    hash_seed(s) {
        let h = 0;
        const t = String(s || '');
        for (let i = 0; i < t.length; i += 1) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    load_preset_for_track() {
        if (!this.visualizer || !this.presets) return;
        const pack = this.pack === 'auto' ? this.guess_pack(this.track_title, this.track_artist) : this.pack;
        const wanted = LyricsMilkdrop.PACKS[pack] || LyricsMilkdrop.PACKS.pop;
        const keys = Object.keys(this.presets);
        let names = wanted.filter((n) => this.presets[n]);
        if (!names.length) {
            const needle = pack === 'rock' ? /fire|hurricane|storm/i : pack === 'electronic' ? /flexi|witch|organic|glow/i : pack === 'ambient' ? /desert|pearl|potion|geiss/i : /sky|flower|royal|mash/i;
            names = keys.filter((k) => needle.test(k));
        }
        if (!names.length) names = keys.slice(0, 8);
        const name = names[this.hash_seed(this.track_seed) % names.length];
        try {
            this.visualizer.loadPreset(this.presets[name], 2.0);
        } catch (e) {}
    }

    butterchurn_api() {
        const mod = window.butterchurn;
        if (!mod) return null;
        if (typeof mod.createVisualizer === 'function') return mod;
        if (mod.default && typeof mod.default.createVisualizer === 'function') return mod.default;
        return null;
    }

    preset_map() {
        const sources = [
            window.butterchurnPresets,
            window.base,
            window.extra,
        ];
        const presets = {};
        sources.forEach((source) => {
            const pack = source && source.default ? source.default : source;
            if (!pack) return;
            if (typeof pack.getPresets === 'function') {
                Object.assign(presets, pack.getPresets() || {});
                return;
            }
            if (typeof pack !== 'object' || Array.isArray(pack)) return;
            Object.entries(pack).forEach(([name, preset]) => {
                if (preset && typeof preset === 'object') presets[name] = preset;
            });
        });
        return Object.keys(presets).length ? presets : null;
    }

    ensure_visualizer() {
        if (this.visualizer) return true;
        const api = this.butterchurn_api();
        const presets = this.preset_map();
        const norm = this.get_norm && this.get_norm();
        if (!api || !presets || !this.canvas || !norm) return false;
        norm.ensure_wired();
        if (!norm.ctx || !norm.gain_node) return false;
        try {
            this.presets = presets;
            this.visualizer = api.createVisualizer(norm.ctx, this.canvas, {
                width: Math.max(2, this.canvas.clientWidth || 2),
                height: Math.max(2, this.canvas.clientHeight || 2),
                pixelRatio: 1,
            });
            this.visualizer.connectAudio(norm.gain_node);
            this.audio_connected = true;
            this.sync_size();
            this.load_preset_for_track();
            this.ready = true;
            return true;
        } catch (e) {
            this.visualizer = null;
            this.ready = false;
            return false;
        }
    }

    start() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        this.held = false;
        if (!this.ensure_visualizer()) return false;
        if (this.running) return true;
        this.running = true;
        this.canvas.classList.remove('hidden');
        const loop = () => {
            if (!this.running) return;
            try { this.visualizer.render(); } catch (e) {}
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
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
        if (!this.canvas || !this.canvas.parentElement) return;
        const box = this.canvas.parentElement.getBoundingClientRect();
        const w = Math.max(2, Math.floor(box.width));
        const h = Math.max(2, Math.floor(box.height));
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        if (this.visualizer && typeof this.visualizer.setRendererSize === 'function') {
            this.visualizer.setRendererSize(w, h);
        }
    }
}
