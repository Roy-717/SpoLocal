/**
 * Lightweight state holder that proxies the legacy global hub.
 *
 * This class serves as a facade to the SpolocalPlayerHub object,
 * providing a cleaner interface for controllers to access player state
 * and DOM elements without relying on the global window scope directly.
 */
export class PlaylistPlayerState {
    /** @param {Object} hub The legacy SpolocalPlayerHub instance. */
    constructor(hub) {
        /** @type {Object} */
        this.hub = hub || {};
    }

    /** @returns {string|null} Current track ID. */
    get currentTrackId() { return this.hub.currentTrackId; }
    /** @returns {boolean} Whether player is currently seeking. */
    get seeking() { return !!this.hub.seeking; }
    /** @returns {HTMLAudioElement|null} The audio element. */
    get audio() { return this.hub.audio; }
}

