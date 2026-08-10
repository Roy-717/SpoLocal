/**
 * Loudness normalization preference (enabled by default).
 */
(function () {
    const LS_NORMALIZE = 'spolocal_normalize_loudness';

    function enabled() {
        try {
            const v = localStorage.getItem(LS_NORMALIZE);
            if (v === 'false') return false;
            if (v === '0') return false;
        } catch (e) {}
        return true;
    }

    function setEnabled(on) {
        try { localStorage.setItem(LS_NORMALIZE, on ? 'true' : 'false'); } catch (e) {}
    }

    window.SpolocalNormalizationPrefs = {
        enabled,
        setEnabled,
    };
})();
