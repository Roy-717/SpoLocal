/**
 * Settings modal: playback and download MP3 kbps sliders (32–192).
 */
export class SettingsController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
        /** @type {import('../player/transport_controller.js').PlaylistTransportController|null} */
        this.transport = null;
    }

    setCrossRefs(transport) {
        this.transport = transport;
    }

    init() {
        const hub = this.state.hub;
        hub.settingsModal = document.getElementById('settings-modal');
        hub.settingsBackdrop = document.getElementById('settings-modal-backdrop');
        hub.settingsClose = document.getElementById('settings-close');
        hub.settingsOpenBtn = document.getElementById('open-settings');
        hub.settingsPlaybackSlider = document.getElementById('settings-playback-kbps');
        hub.settingsPlaybackValue = document.getElementById('settings-playback-kbps-value');
        hub.settingsDownloadSlider = document.getElementById('settings-download-kbps');
        hub.settingsDownloadValue = document.getElementById('settings-download-kbps-value');

        if (hub.settingsOpenBtn) {
            hub.settingsOpenBtn.addEventListener('click', () => this.open());
        }
        if (hub.settingsBackdrop) {
            hub.settingsBackdrop.addEventListener('click', () => this.close());
        }
        if (hub.settingsClose) {
            hub.settingsClose.addEventListener('click', () => this.close());
        }

        const self = this;
        if (hub.settingsPlaybackSlider) {
            hub.settingsPlaybackSlider.addEventListener('input', function () {
                const prefs = window.SpolocalQualityPrefs;
                if (!prefs) return;
                const v = prefs.clampKbps(hub.settingsPlaybackSlider.value);
                prefs.setPlaybackKbps(v);
                self._update_slider_labels();
                if (self.transport) self.transport.onPlaybackQualityChanged();
            });
        }
        if (hub.settingsDownloadSlider) {
            hub.settingsDownloadSlider.addEventListener('input', function () {
                const prefs = window.SpolocalQualityPrefs;
                if (!prefs) return;
                const v = prefs.clampKbps(hub.settingsDownloadSlider.value);
                prefs.setDownloadKbps(v);
                self._update_slider_labels();
            });
        }

        this.sync_ui();
    }

    open() {
        const hub = this.state.hub;
        if (!hub.settingsModal) return;
        this.sync_ui();
        hub.settingsModal.classList.remove('hidden');
    }

    close() {
        const hub = this.state.hub;
        if (!hub.settingsModal) return;
        hub.settingsModal.classList.add('hidden');
    }

    sync_ui() {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs) return;
        const hub = this.state.hub;
        if (hub.settingsPlaybackSlider) {
            hub.settingsPlaybackSlider.value = String(prefs.playbackKbps());
        }
        if (hub.settingsDownloadSlider) {
            hub.settingsDownloadSlider.value = String(prefs.downloadKbps());
        }
        this._update_slider_labels();
    }

    _update_slider_labels() {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs) return;
        const hub = this.state.hub;
        if (hub.settingsPlaybackValue) {
            hub.settingsPlaybackValue.textContent = prefs.formatLabel(prefs.playbackKbps());
        }
        if (hub.settingsDownloadValue) {
            hub.settingsDownloadValue.textContent = prefs.formatLabel(prefs.downloadKbps());
        }
    }
}
