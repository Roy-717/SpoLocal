/**
 * Playback / download quality as MP3 kbps (32–192).
 */
(function () {
    const MIN_KBPS = 32;
    const MAX_KBPS = 192;
    const DEFAULT_KBPS = 192;
    const LS_PLAYBACK_KBPS = 'spolocal_playback_kbps';
    const LS_DOWNLOAD_KBPS = 'spolocal_download_kbps';
    const LEGACY = { low: 64, high: 192 };

    function clampKbps(n) {
        const v = parseInt(n, 10);
        if (!isFinite(v)) return DEFAULT_KBPS;
        return Math.max(MIN_KBPS, Math.min(MAX_KBPS, v));
    }

    function parseStored(raw, fallback) {
        if (raw == null || raw === '') return clampKbps(fallback);
        const s = String(raw).trim().toLowerCase();
        if (s === 'low' || s === 'high') return LEGACY[s];
        if (s.endsWith('k')) return clampKbps(s.slice(0, -1));
        return clampKbps(s);
    }

    function migrateLegacy(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            if (v != null && v !== '') return parseStored(v, fallback);
            const oldKey = key === LS_PLAYBACK_KBPS ? 'spolocal_playback_quality' : 'spolocal_download_quality';
            const legacy = localStorage.getItem(oldKey);
            if (legacy) return parseStored(legacy, fallback);
        } catch (e) {}
        return clampKbps(fallback);
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
        try { localStorage.setItem(LS_PLAYBACK_KBPS, String(clampKbps(kbps))); } catch (e) {}
    }

    function setDownloadKbps(kbps) {
        try { localStorage.setItem(LS_DOWNLOAD_KBPS, String(clampKbps(kbps))); } catch (e) {}
    }

    function variantKeys(track) {
        const variants = track && track.play_variants ? track.play_variants : {};
        return Object.keys(variants).filter(function (k) { return !!variants[k]; });
    }

    function resolveExactPlaySrc(track, kbps) {
        if (!track) return '';
        const want = String(kbps != null ? clampKbps(kbps) : playbackKbps());
        const variants = track.play_variants || {};
        return variants[want] || '';
    }

    function resolvePlaySrc(track) {
        const exact = resolveExactPlaySrc(track);
        if (exact) return exact;
        if (!track) return '';
        const variants = track.play_variants || {};
        if (variants['192']) return variants['192'];
        if (variants.high) return variants.high;
        if (variants['64']) return variants['64'];
        if (variants.low) return variants.low;
        const keys = variantKeys(track).sort(function (a, b) {
            return parseInt(b, 10) - parseInt(a, 10);
        });
        if (keys.length) return variants[keys[0]];
        return track.play_src || '';
    }

    function hasVariant(track, kbps) {
        if (!track || !track.play_variants) return false;
        const key = String(clampKbps(kbps));
        return !!track.play_variants[key];
    }

    function formatLabel(kbps) {
        const k = clampKbps(kbps);
        return k >= MAX_KBPS ? k + ' kbps (high)' : k + ' kbps';
    }

    window.SpolocalQualityPrefs = {
        MIN_KBPS,
        MAX_KBPS,
        DEFAULT_KBPS,
        clampKbps,
        playbackKbps,
        downloadKbps,
        setPlaybackKbps,
        setDownloadKbps,
        resolvePlaySrc,
        resolveExactPlaySrc,
        hasVariant,
        formatLabel,
        playbackQuality: playbackKbps,
        downloadQuality: downloadKbps,
        setPlaybackQuality: setPlaybackKbps,
        setDownloadQuality: setDownloadKbps,
    };
})();
