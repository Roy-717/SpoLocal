/**
 * Playback / download quality: Low (64), Medium (120), High (192) kbps.
 */
(function () {
    const QUALITY_TIERS = [64, 120, 192];
    const DEFAULT_KBPS = 192;
    const LS_PLAYBACK_KBPS = 'spolocal_playback_kbps';
    const LS_DOWNLOAD_KBPS = 'spolocal_download_kbps';
    const LEGACY = { low: 64, mid: 120, medium: 120, high: 192 };

    function snapKbps(n) {
        const v = parseInt(n, 10);
        if (!isFinite(v)) return DEFAULT_KBPS;
        let best = QUALITY_TIERS[0];
        let best_dist = Math.abs(v - best);
        for (let i = 1; i < QUALITY_TIERS.length; i++) {
            const t = QUALITY_TIERS[i];
            const d = Math.abs(v - t);
            if (d < best_dist) {
                best = t;
                best_dist = d;
            }
        }
        return best;
    }

    function parseStored(raw, fallback) {
        if (raw == null || raw === '') return snapKbps(fallback);
        const s = String(raw).trim().toLowerCase();
        if (s in LEGACY) return LEGACY[s];
        if (s.endsWith('k')) return snapKbps(s.slice(0, -1));
        return snapKbps(s);
    }

    function migrateLegacy(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            if (v != null && v !== '') return parseStored(v, fallback);
            const oldKey = key === LS_PLAYBACK_KBPS ? 'spolocal_playback_quality' : 'spolocal_download_quality';
            const legacy = localStorage.getItem(oldKey);
            if (legacy) return parseStored(legacy, fallback);
        } catch (e) {}
        return snapKbps(fallback);
    }

    function playbackKbps() {
        return migrateLegacy(LS_PLAYBACK_KBPS, DEFAULT_KBPS);
    }

    function downloadKbps() {
        try {
            const v = localStorage.getItem(LS_DOWNLOAD_KBPS);
            if (v != null && v !== '') return parseStored(v, playbackKbps());
            const legacy = localStorage.getItem('spolocal_download_quality');
            if (legacy) return parseStored(legacy, playbackKbps());
        } catch (e) {}
        return playbackKbps();
    }

    function setPlaybackKbps(kbps) {
        try { localStorage.setItem(LS_PLAYBACK_KBPS, String(snapKbps(kbps))); } catch (e) {}
    }

    function setDownloadKbps(kbps) {
        try { localStorage.setItem(LS_DOWNLOAD_KBPS, String(snapKbps(kbps))); } catch (e) {}
    }

    function variantKeys(track) {
        const variants = track && track.play_variants ? track.play_variants : {};
        return Object.keys(variants).filter(function (k) { return !!variants[k]; });
    }

    function streamPlaySrc(track) {
        if (!track) return '';
        const vid = String(track.youtube_video_id || '').trim();
        if (!vid) return '';
        return '/api/stream?vid=' + encodeURIComponent(vid);
    }

    function resolveExactPlaySrc(track, kbps) {
        if (!track) return '';
        const want = String(kbps != null ? snapKbps(kbps) : playbackKbps());
        const variants = track.play_variants || {};
        return variants[want] || '';
    }

    function normalizeMediaPath(src) {
        if (!src) return '';
        try {
            const u = new URL(src, window.location.href);
            let path = decodeURIComponent(u.pathname);
            if (path.startsWith('/media/')) path = path.slice('/media/'.length);
            return path;
        } catch (e) {
            return '';
        }
    }

    function resolvePlaybackPlaySrc(track, kbps) {
        const exact = resolveExactPlaySrc(track, kbps);
        if (exact) return exact;
        return streamPlaySrc(track);
    }

    function resolvePlaySrc(track) {
        const exact = resolveExactPlaySrc(track);
        if (exact) return exact;
        if (!track) return '';
        const variants = track.play_variants || {};
        const order = ['192', '120', '64', 'high', 'mid', 'medium', 'low'];
        for (let i = 0; i < order.length; i++) {
            const k = order[i];
            if (variants[k]) return variants[k];
        }
        const keys = variantKeys(track).sort(function (a, b) {
            return parseInt(b, 10) - parseInt(a, 10);
        });
        if (keys.length) return variants[keys[0]];
        if (track.play_src) return track.play_src;
        if (track.stream_src) return track.stream_src;
        return streamPlaySrc(track);
    }

    function hasVariant(track, kbps) {
        if (!track || !track.play_variants) return false;
        const key = String(snapKbps(kbps));
        return !!track.play_variants[key];
    }

    function formatLabel(kbps) {
        const k = snapKbps(kbps);
        if (k <= 64) return 'Low (64 kbps)';
        if (k <= 120) return 'Medium (120 kbps)';
        return 'High (192 kbps)';
    }

    function syncTierGroup(container, kbps) {
        if (!container) return;
        const active = String(snapKbps(kbps));
        container.querySelectorAll('.quality-tier-btn').forEach(function (btn) {
            const on = btn.getAttribute('data-kbps') === active;
            btn.classList.toggle('quality-tier-btn--active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function bindTierGroup(container, getValue, setValue, onChange) {
        if (!container) return;
        syncTierGroup(container, getValue());
        container.querySelectorAll('.quality-tier-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const kbps = snapKbps(btn.getAttribute('data-kbps'));
                setValue(kbps);
                syncTierGroup(container, kbps);
                if (typeof onChange === 'function') onChange(kbps);
            });
        });
    }

    window.SpolocalQualityPrefs = {
        QUALITY_TIERS,
        MIN_KBPS: 64,
        MAX_KBPS: 192,
        DEFAULT_KBPS,
        snapKbps,
        clampKbps: snapKbps,
        playbackKbps,
        downloadKbps,
        setPlaybackKbps,
        setDownloadKbps,
        resolvePlaySrc,
        resolveExactPlaySrc,
        resolvePlaybackPlaySrc,
        streamPlaySrc,
        normalizeMediaPath,
        hasVariant,
        formatLabel,
        syncTierGroup,
        bindTierGroup,
        playbackQuality: playbackKbps,
        downloadQuality: downloadKbps,
        setPlaybackQuality: setPlaybackKbps,
        setDownloadQuality: setDownloadKbps,
    };
})();

