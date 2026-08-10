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

    wire() {
        if (this._wired) return;
        try {
            this.ctx = new AudioContext();
            const src = this.ctx.createMediaElementSource(this.audio_el);
            this.gain_node = this.ctx.createGain();
            src.connect(this.gain_node);
            this.gain_node.connect(this.ctx.destination);
            this.audio_el.volume = 1;
            this._wired = true;
            this.audio_el.addEventListener('play', () => {
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume().catch(() => {});
                }
            });
        } catch (e) {
            this._wired = false;
        }
        const prefs = window.SpolocalNormalizationPrefs;
        if (prefs) this.enabled = prefs.enabled();
        this._sync_gain();
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
