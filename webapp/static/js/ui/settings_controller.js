/**
 * Settings modal: playback and download quality tiers (64 / 120 / 192 kbps).
 */
export class SettingsController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        this.state = state;
        /** @type {import('../player/transport_controller.js').PlaylistTransportController|null} */
        this.transport = null;
        /** @type {import('../services/download_controller.js').PlaylistDownloadController|null} */
        this.download = null;
    }

    setCrossRefs(transport, download) {
        this.transport = transport;
        this.download = download;
    }

    init() {
        const hub = this.state.hub;
        hub.settingsModal = document.getElementById('settings-modal');
        hub.settingsBackdrop = document.getElementById('settings-modal-backdrop');
        hub.settingsClose = document.getElementById('settings-close');
        hub.settingsOpenBtn = document.getElementById('open-settings');
        hub.settingsPlaybackTiers = document.getElementById('settings-playback-tiers');
        hub.settingsPlaybackValue = document.getElementById('settings-playback-kbps-value');
        hub.settingsDownloadTiers = document.getElementById('settings-download-tiers');
        hub.settingsDownloadValue = document.getElementById('settings-download-kbps-value');
        hub.settingsLibraryDownloadTiers = document.getElementById('settings-library-download-tiers');

        if (hub.settingsOpenBtn) {
            hub.settingsOpenBtn.addEventListener('click', () => this.open());
        }
        if (hub.settingsBackdrop) {
            hub.settingsBackdrop.addEventListener('click', () => this.close());
        }
        if (hub.settingsClose) {
            hub.settingsClose.addEventListener('click', () => this.close());
        }

        const prefs = window.SpolocalQualityPrefs;
        const self = this;
        if (prefs && hub.settingsPlaybackTiers) {
            prefs.bindTierGroup(
                hub.settingsPlaybackTiers,
                () => prefs.playbackKbps(),
                (v) => prefs.setPlaybackKbps(v),
                () => {
                    self._update_labels();
                    if (self.transport) self.transport.onPlaybackQualityChanged();
                },
            );
        }
        if (prefs && hub.settingsDownloadTiers) {
            prefs.bindTierGroup(
                hub.settingsDownloadTiers,
                () => prefs.downloadKbps(),
                (v) => prefs.setDownloadKbps(v),
                () => self._update_labels(),
            );
        }
        if (prefs && hub.settingsLibraryDownloadTiers) {
            const quality_labels = { 64: 'Low (64 kbps)', 120: 'Medium (120 kbps)', 192: 'High (192 kbps)' };
            hub.settingsLibraryDownloadTiers.querySelectorAll('.quality-tier-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const kbps = prefs.clampKbps(btn.getAttribute('data-kbps'));
                    const label = quality_labels[kbps] || prefs.formatLabel(kbps);
                    if (!confirm('Queue download of all tracks in every playlist at ' + label + '?')) return;
                    if (self.download) {
                        self.download.queueQualityDownloads(null, kbps);
                    } else {
                        fetch('/api/downloads/quality-all', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: {
                                'Accept': 'application/json',
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ quality: String(kbps) }),
                        }).catch(() => {});
                    }
                });
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
        prefs.syncTierGroup(hub.settingsPlaybackTiers, prefs.playbackKbps());
        prefs.syncTierGroup(hub.settingsDownloadTiers, prefs.downloadKbps());
        this._update_labels();
    }

    _update_labels() {
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
