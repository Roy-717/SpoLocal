/**
 * Media Session API integration plus playback-position persistence.
 * Keeps the OS/notification media controls and the "resume where you left
 * off" progress in sync with playback.
 */
export class PlaylistMediaSessionController {
    /**
     * @param {import('./player_state.js').PlaylistPlayerState} state
     * @param {import('./transport_controller.js').PlaylistTransportController} transport
     */
    constructor(state, transport) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        this.transport = transport;
    }

    updateMediaSessionMetadata(track, artworkPlaylistIdOpt) {
        const hub = this.state.hub;
        if (!('mediaSession' in navigator)) return;
        const baseUrl = location.origin;
        const plArt = (artworkPlaylistIdOpt != null && String(artworkPlaylistIdOpt).trim() !== '')
            ? String(artworkPlaylistIdOpt).trim()
            : String(hub.playingPlaylistId || hub.playlistId || '').trim();
        const covers = window.SpolocalCoverUrls;
        let artworkPath = '';
        if (covers) {
            artworkPath = covers.trackCoverUrl(plArt, track.id, track.youtube_video_id);
        } else if (track.id && plArt) {
            artworkPath = '/playlists/' + encodeURIComponent(plArt) + '/tracks/' + encodeURIComponent(track.id) + '/cover';
        }
        const artworkUrl = artworkPath
            ? (artworkPath.indexOf('http') === 0 ? artworkPath : baseUrl + artworkPath)
            : '';
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: track.title || '',
                artist: track.artist || '',
                album: track.album || '',
                artwork: artworkUrl ? [
                    { src: artworkUrl, sizes: '96x96',  type: 'image/jpeg' },
                    { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
                    { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }
                ] : []
            });
        } catch (e) {}
        this.updateMediaSessionPlaybackState();
    }

    updateMediaSessionPlaybackState() {
        const hub = this.state.hub;
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.playbackState = hub.audio.paused ? 'paused' : 'playing';
        } catch (e) {}
        if (navigator.mediaSession.setPositionState && hub.audio.duration && !hub.audio.paused) {
            try {
                navigator.mediaSession.setPositionState({
                    duration: hub.audio.duration,
                    playbackRate: hub.audio.playbackRate || 1,
                    position: hub.audio.currentTime || 0
                });
            } catch (e) {}
        }
    }

    initMediaSessionHandlers() {
        if (!('mediaSession' in navigator)) return;
        const actions = [
            ['play', () => {
                if (this.state.hub.currentTrackId) this.transport.playTrackById(this.state.hub.currentTrackId);
                else if (this.state.hub.playable.length) this.transport.playTrackById(this.state.hub.playable[0].id);
            }],
            ['pause', () => this.state.hub.audio.pause()],
            ['previoustrack', () => this.transport.playAtDelta(-1)],
            ['nexttrack', () => this.transport.playAtDelta(1)],
            ['seekbackward', (d) => {
                this.transport.seek_audio_to(Math.max(0, this.state.hub.audio.currentTime - (d.seekOffset || 10)));
                this.updateMediaSessionPlaybackState();
            }],
            ['seekforward', (d) => {
                this.transport.seek_audio_to(Math.min(this.state.hub.audio.duration || 0, this.state.hub.audio.currentTime + (d.seekOffset || 10)));
                this.updateMediaSessionPlaybackState();
            }],
            ['seekto', (d) => {
                this.transport.seek_audio_to(d.seekTime);
                this.updateMediaSessionPlaybackState();
            }]
        ];
        actions.forEach((pair) => {
            try { navigator.mediaSession.setActionHandler(pair[0], pair[1]); } catch (e) {}
        });
    }

    persistPlaybackProgress() {
        const hub = this.state.hub;
        try {
            if (!hub.currentTrackId || !hub.playingPlaylistId) return;
            localStorage.setItem(hub.LS_LAST_PL, hub.playingPlaylistId);
            localStorage.setItem(hub.LS_LAST_TR, hub.currentTrackId);
            localStorage.setItem(hub.LS_LAST_POS, String(Math.max(0, hub.audio.currentTime || 0)));
        } catch (e) {}
    }
}