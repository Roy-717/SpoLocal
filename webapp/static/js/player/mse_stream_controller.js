/**
 * MSE stream controller: keep ~10s ahead of the playhead.
 * Seek uses the slider time, fetches from an estimated WebM cluster, and only
 * moves the playhead once that time is actually buffered.
 */
export class MseStreamController {
    constructor() {
        this._ms = null;
        this._sb = null;
        this._vid = '';
        this._total = 0;
        this._pos = 0;
        this._fetching = false;
        this._file_complete = false;
        this._completed = false;
        this._aborted = true;
        this._audio = null;
        this._gen = 0;
        this._seeking = false;
        this._seek_target = 0;
        this._seek_slices = 0;
        this._duration = 0;
        this._need_init = true;
        this._jump_seek = false;
        this._resume_pos = 0;
        this._ignore_native_seek = false;
        this._on_seek_bound = null;
        this._on_time_bound = null;
        this._on_complete = null;
        this._on_seek_done = null;
        this._started = false;
        this._op = 0;
        this.SLICE = 512 * 1024;
        this.INIT_BYTES = 32 * 1024;
        this.BUFFER_AHEAD_SEC = 10;
        this.MAX_SEEK_SLICES = 4;
        this.EXTEND_SEC = 45;
        this._codec_map = {
            webm: 'audio/webm; codecs="opus"',
            opus: 'audio/ogg; codecs="opus"',
            m4a: 'audio/mp4; codecs="mp4a.40.2"',
            mp4: 'audio/mp4; codecs="mp4a.40.2"',
        };
    }

    is_active() {
        return !!(this._audio && this._ms && !this._aborted);
    }

    should_advance_on_ended() {
        return false;
    }

    is_supported() {
        return typeof window.MediaSource !== 'undefined' && MediaSource.isTypeSupported;
    }

    seek_to(seconds, on_done) {
        const t = Number(seconds);
        if (!isFinite(t) || t < 0) return;
        if (!this.is_active() || !this._sb) return;
        this._seek_target = t;
        if (typeof on_done === 'function') this._on_seek_done = on_done;
        if (this._is_buffered(t)) {
            this._finish_seek();
            return;
        }
        this._seeking = true;
        this._seek_slices = 0;
        this._completed = false;
        if (this._is_just_after_buffer(t)) {
            this._jump_seek = false;
            this._file_complete = false;
            this._maybe_fetch_next(this._gen);
            return;
        }
        this._jump_seek = true;
        this._file_complete = false;
        this._op += 1;
        this._remove_all(this._gen);
    }

    async play(vid, audio_el, on_fallback, duration_sec, on_complete) {
        this.stop();
        this._gen++;
        const gen = this._gen;
        this._vid = vid;
        this._audio = audio_el;
        this._aborted = false;
        this._completed = false;
        this._file_complete = false;
        this._started = false;
        this._on_complete = on_complete || null;
        this._duration = Number(duration_sec) > 0 ? Number(duration_sec) : 0;

        if (!this.is_supported()) {
            if (on_fallback) on_fallback();
            return;
        }

        let ext = 'webm';
        let filesize = 0;
        try {
            const r = await fetch('/api/stream/prepare?vid=' + encodeURIComponent(vid));
            if (gen !== this._gen) return;
            if (r.ok) {
                const data = await r.json();
                ext = data.ext || 'webm';
                filesize = data.filesize || 0;
                const d = Number(data.duration_sec);
                if (d > 0) this._duration = d;
            }
        } catch (e) {}

        if (gen !== this._gen) return;

        const codec = this._codec_map[ext] || this._codec_map.webm;
        if (!MediaSource.isTypeSupported(codec)) {
            if (on_fallback) on_fallback();
            return;
        }

        this._total = filesize;
        this._pos = 0;
        this._fetching = false;
        this._seeking = false;
        this._need_init = true;
        this._jump_seek = false;

        const ms = new MediaSource();
        this._ms = ms;
        audio_el.src = URL.createObjectURL(ms);

        ms.addEventListener('sourceopen', () => {
            if (gen !== this._gen) return;
            let sb;
            try {
                sb = ms.addSourceBuffer(codec);
            } catch (e) {
                this._fallback(on_fallback);
                return;
            }
            this._sb = sb;
            sb.mode = 'segments';
            this._lock_duration();
            sb.addEventListener('updateend', () => this._on_updateend(gen));
            this._maybe_fetch_next(gen);
        });

        this._on_time_bound = () => {
            this._maybe_fetch_next(gen);
            this._check_natural_end();
        };
        audio_el.addEventListener('timeupdate', this._on_time_bound);
    }

    _cluster_index(buf) {
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < u8.length - 3; i++) {
            if (u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) {
                return i;
            }
        }
        return -1;
    }

    _trim_init(buf) {
        const i = this._cluster_index(buf);
        if (i > 0) return buf.slice(0, i);
        return buf;
    }

    _trim_cluster(buf) {
        const i = this._cluster_index(buf);
        if (i > 0) return buf.slice(i);
        return buf;
    }

    _lock_duration() {
        if (!this._ms || this._ms.readyState !== 'open') return;
        if (!(this._duration > 0)) return;
        try { this._ms.duration = this._duration; } catch (e) {}
    }

    _song_duration() {
        if (this._duration > 0 && isFinite(this._duration)) return this._duration;
        const d = this._audio && this._audio.duration;
        if (d && isFinite(d) && d > this.BUFFER_AHEAD_SEC + 1) return d;
        return 0;
    }

    _buffered_ahead() {
        const audio = this._audio;
        if (!audio || !audio.buffered.length) return 0;
        const t = audio.currentTime;
        for (let i = 0; i < audio.buffered.length; i++) {
            const s = audio.buffered.start(i);
            const e = audio.buffered.end(i);
            if (t >= s && t <= e + 0.15) return e - t;
        }
        return 0;
    }

    _is_just_after_buffer(time) {
        const audio = this._audio;
        if (!audio || !audio.buffered.length) return false;
        for (let i = 0; i < audio.buffered.length; i++) {
            const end = audio.buffered.end(i);
            if (time > end && time <= end + this.EXTEND_SEC) return true;
        }
        return false;
    }

    _is_buffered(time) {
        const audio = this._audio;
        if (!audio || !audio.buffered.length) return false;
        for (let i = 0; i < audio.buffered.length; i++) {
            if (time >= audio.buffered.start(i) && time <= audio.buffered.end(i) + 0.15) return true;
        }
        return false;
    }

    _buffer_span() {
        const audio = this._audio;
        if (!audio || !audio.buffered.length) return null;
        return {
            start: audio.buffered.start(0),
            end: audio.buffered.end(audio.buffered.length - 1),
        };
    }

    _set_playhead(t) {
        if (!this._audio) return;
        this._ignore_native_seek = true;
        try { this._audio.currentTime = t; } catch (e) {}
        this._ignore_native_seek = false;
    }

    _on_seek(gen) {
        if (this._ignore_native_seek) return;
        if (gen !== this._gen || !this._audio || !this._sb) return;
        if (this._seeking) return;
        const target = this._audio.currentTime;
        if (this._is_buffered(target)) return;
        this.seek_to(target);
    }

    _remove_all(gen) {
        const go = () => {
            if (gen !== this._gen || !this._sb) return;
            if (this._sb.updating) {
                this._sb.addEventListener('updateend', go, { once: true });
                return;
            }
            if (!this._audio || !this._audio.buffered.length) {
                this._after_remove(gen);
                return;
            }
            try {
                const start = this._audio.buffered.start(0);
                const end = this._audio.buffered.end(this._audio.buffered.length - 1);
                this._sb.addEventListener('updateend', () => this._after_remove(gen), { once: true });
                this._sb.remove(start, end);
            } catch (e) {
                this._after_remove(gen);
            }
        };
        go();
    }

    _byte_pos_for_time(t) {
        const dur = this._song_duration();
        if (!this._total || !dur) return this.INIT_BYTES;
        const ratio = Math.min(0.97, Math.max(0, t / dur));
        return Math.max(this.INIT_BYTES, Math.floor(ratio * this._total / 1024) * 1024);
    }

    _after_remove(gen) {
        if (gen !== this._gen) return;
        this._lock_duration();
        this._resume_pos = this._byte_pos_for_time(this._seek_target);
        this._need_init = true;
        this._pos = 0;
        this._file_complete = false;
        this._set_playhead(this._seek_target);
        this._maybe_fetch_next(gen);
    }

    _nearest_in_buffer(target) {
        const audio = this._audio;
        if (!audio || !audio.buffered.length) return null;
        if (this._is_buffered(target)) return target;
        let best = audio.buffered.start(0);
        let best_d = Infinity;
        for (let i = 0; i < audio.buffered.length; i++) {
            const s = audio.buffered.start(i);
            const e = audio.buffered.end(i);
            const edge = target < s ? s : e;
            const d = Math.abs(edge - target);
            if (d < best_d) {
                best_d = d;
                best = edge;
            }
        }
        return best;
    }

    _finish_seek() {
        let t = this._seek_target;
        if (!this._is_buffered(t)) {
            const n = this._nearest_in_buffer(t);
            if (n != null) t = n;
        }
        this._set_playhead(t);
        this._seeking = false;
        this._jump_seek = false;
        this._play_if_needed();
        if (typeof this._on_seek_done === 'function') {
            const done = this._on_seek_done;
            this._on_seek_done = null;
            done();
        }
    }

    _on_seek_data(gen) {
        if (!this._seeking) return;
        if (this._is_buffered(this._seek_target)) {
            this._finish_seek();
            return;
        }
        if (this._seek_slices >= this.MAX_SEEK_SLICES || this._file_complete) {
            this._finish_seek();
            return;
        }
        const span = this._buffer_span();
        if (this._jump_seek && span && span.start > this._seek_target + 0.5 && this._seek_slices > 0) {
            this._resume_pos = Math.max(this.INIT_BYTES, Math.floor((this._resume_pos || this._pos) * 0.7 / 1024) * 1024);
            this._need_init = true;
            this._pos = 0;
            this._remove_all(gen);
            return;
        }
        this._maybe_fetch_next(gen);
    }

    _evict_old() {
        if (this._seeking || !this._sb || this._sb.updating) return;
        const audio = this._audio;
        if (!audio || !audio.buffered.length) return;
        const keep_from = Math.max(0, audio.currentTime - 1);
        const start = audio.buffered.start(0);
        if (keep_from - start < 2) return;
        try { this._sb.remove(start, keep_from); } catch (e) {}
    }

    _on_updateend(gen) {
        if (gen !== this._gen) return;
        this._lock_duration();
        if (this._seeking) {
            this._on_seek_data(gen);
            if (this._seeking) return;
        } else if (!this._started && this._audio && this._audio.buffered.length) {
            this._play_if_needed();
        }
        this._evict_old();
        this._maybe_fetch_next(gen);
        this._check_natural_end();
    }

    _play_if_needed() {
        const audio = this._audio;
        if (!audio) return;
        this._started = true;
        if (audio.paused) audio.play().catch(() => {});
    }

    _check_natural_end() {
        if (this._completed || this._aborted || this._seeking) return;
        const audio = this._audio;
        const dur = this._song_duration();
        if (!audio || !dur) return;
        if (audio.currentTime < dur - 0.35) return;
        if (this._total && !this._file_complete && this._pos < this._total) return;
        this._completed = true;
        try {
            if (this._ms && this._ms.readyState === 'open') this._ms.endOfStream();
        } catch (e) {}
        if (typeof this._on_complete === 'function') this._on_complete();
    }

    async _maybe_fetch_next(gen) {
        if (gen !== this._gen || this._aborted) return;
        if (this._fetching || this._file_complete || !this._sb) return;
        if (this._sb.updating) return;
        if (this._seeking && this._is_buffered(this._seek_target)) return;
        if (this._seeking && this._seek_slices >= this.MAX_SEEK_SLICES) return;

        if (!this._seeking && this._buffered_ahead() > this.BUFFER_AHEAD_SEC) return;
        if (!this._seeking && this._audio && this._audio.buffered.length && !this._is_buffered(this._audio.currentTime)) {
            return;
        }

        if (this._total && this._pos >= this._total && !this._need_init) {
            this._file_complete = true;
            if (this._seeking) this._finish_seek();
            else this._check_natural_end();
            return;
        }

        this._fetching = true;
        const op = this._op;
        const init = this._need_init;
        const start = init ? 0 : this._pos;
        const span = init ? this.INIT_BYTES : this.SLICE;
        const end = this._total ? Math.min(start + span - 1, this._total - 1) : start + span - 1;
        try {
            const r = await fetch('/api/stream?vid=' + encodeURIComponent(this._vid), {
                headers: { Range: 'bytes=' + start + '-' + end },
            });
            if (gen !== this._gen || op !== this._op) return;
            if (!r.ok) {
                if (this._seeking) this._finish_seek();
                else this._fallback(null);
                return;
            }
            let buf = await r.arrayBuffer();
            if (gen !== this._gen || op !== this._op) return;
            if (!buf.byteLength) {
                this._file_complete = true;
                if (this._seeking) this._finish_seek();
                else this._check_natural_end();
                return;
            }
            const cr = r.headers.get('content-range') || '';
            const m = /\/(\d+)\s*$/.exec(cr);
            if (m) this._total = parseInt(m[1], 10);
            if (init) {
                if (this._jump_seek) buf = this._trim_init(buf);
                this._need_init = false;
                this._pos = this._jump_seek ? this._resume_pos : buf.byteLength;
            } else {
                if (this._jump_seek) buf = this._trim_cluster(buf);
                if (this._seeking) this._seek_slices += 1;
                this._pos = start + this.SLICE;
            }
            if (this._sb && !this._sb.updating && buf.byteLength) {
                try {
                    this._sb.appendBuffer(buf);
                } catch (e) {
                    this._evict_old();
                    if (this._seeking) this._finish_seek();
                }
            }
        } catch (e) {
            if (gen !== this._gen) return;
            if (this._seeking) this._finish_seek();
            else this._fallback(null);
        } finally {
            this._fetching = false;
        }
    }

    _fallback(on_fallback) {
        this.stop();
        if (on_fallback) on_fallback();
    }

    stop() {
        this._gen++;
        this._aborted = true;
        this._fetching = false;
        this._seeking = false;
        this._completed = true;
        if (typeof this._on_seek_done === 'function') {
            const done = this._on_seek_done;
            this._on_seek_done = null;
            try { done(); } catch (e) {}
        }
        this._on_complete = null;
        this._need_init = true;
        this._jump_seek = false;
        this._started = false;
        if (this._audio) {
            if (this._on_seek_bound) this._audio.removeEventListener('seeking', this._on_seek_bound);
            if (this._on_time_bound) this._audio.removeEventListener('timeupdate', this._on_time_bound);
        }
        this._on_seek_bound = null;
        this._on_time_bound = null;
        if (this._sb) {
            try { this._sb.abort(); } catch (e) {}
            this._sb = null;
        }
        if (this._ms) {
            if (this._audio && this._audio.src) {
                try { URL.revokeObjectURL(this._audio.src); } catch (e) {}
            }
            this._ms = null;
        }
        this._pos = 0;
        this._total = 0;
    }
}
