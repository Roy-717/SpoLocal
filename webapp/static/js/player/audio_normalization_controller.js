/**
 * Web Audio gain chain for per-track loudness normalization.
 */
export class AudioNormalizationController {
    /** @param {HTMLMediaElement} audio_el */
    constructor(audio_el) {
        this.audio_el = audio_el;
        /** @type {AudioContext|null} */
        this.ctx = null;
        /** @type {GainNode|null} */
        this.gain_node = null;
        this.user_volume = 1;
        this.track_gain_db = 0;
        this.enabled = true;
        this._wired = false;
    }

    ensure_wired() {
        this.wire();
        if (!this._wired && this.audio_el && !this.audio_el.paused) {
            this._connect_graph();
        }
    }

    _connect_graph() {
        if (this._wired) return;
        try {
            this.ctx = new AudioContext();
            const src = this.ctx.createMediaElementSource(this.audio_el);
            this.gain_node = this.ctx.createGain();
            src.connect(this.gain_node);
            this.gain_node.connect(this.ctx.destination);
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.82;
            this.gain_node.connect(this.analyser);
            this._freq = new Uint8Array(this.analyser.frequencyBinCount);
            this.audio_el.volume = 1;
            this._wired = true;
            if (this.ctx.state === 'suspended') {
                this.ctx.resume().catch(() => {});
            }
        } catch (e) {
            this._wired = false;
        }
        this._sync_gain();
    }

    wire() {
        if (this._wired) return;
        const prefs = window.SpolocalNormalizationPrefs;
        if (prefs) this.enabled = prefs.enabled();
        this.audio_el.addEventListener('play', () => this._connect_graph(), { once: true });
        if (!this.audio_el.paused) this._connect_graph();
        this._sync_gain();
    }

    bands_energy() {
        if (!this.analyser || !this._freq) return { bass: 0, mid: 0, treble: 0 };
        this.analyser.getByteFrequencyData(this._freq);
        const n = this._freq.length;
        const avg = (a, b) => {
            let s = 0;
            const lo = Math.max(0, a);
            const hi = Math.min(n, b);
            const c = Math.max(1, hi - lo);
            for (let i = lo; i < hi; i += 1) s += this._freq[i];
            return s / c / 255;
        };
        return { bass: avg(0, 6), mid: avg(6, 24), treble: avg(24, 64) };
    }

    set_user_volume(v) {
        this.user_volume = Math.max(0, Math.min(1, v));
        this._sync_gain();
    }

    get_user_volume() {
        return this.user_volume;
    }

    set_track_gain_db(db) {
        const n = Number(db);
        this.track_gain_db = Number.isFinite(n) ? n : 0;
        this._sync_gain();
    }

    set_enabled(on) {
        this.enabled = !!on;
        this._sync_gain();
    }

    _sync_gain() {
        if (!this.gain_node) {
            if (this.audio_el) this.audio_el.volume = this.user_volume;
            return;
        }
        const prefs = window.SpolocalNormalizationPrefs;
        const use_norm = this.enabled && prefs && prefs.enabled();
        const norm_lin = use_norm ? Math.pow(10, this.track_gain_db / 20) : 1;
        const v = this.user_volume * norm_lin;
        this.gain_node.gain.value = Math.max(0, Math.min(4, v));
    }
}
