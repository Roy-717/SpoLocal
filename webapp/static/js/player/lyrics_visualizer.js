/**
 * Lyrics background visualizer: Milkdrop (butterchurn) with paper-shaders and
 * wave-field fallbacks. Owns the three renderers and the visualizer mode
 * (solid/milkdrop) persisted in localStorage.
 */
import { LyricsWaveField } from './lyrics_wave_field.js?v=88';
import { LyricsMilkdrop } from './lyrics_milkdrop.js?v=88';
import { LyricsPaperShaders } from './lyrics_paper_shaders.js?v=88';

export class LyricsVisualizerController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        this.paper_shaders = null;
        this.wave_field = null;
        this.milkdrop = null;
        this.butterchurn_ready_bound = false;
    }

    /** Create the renderers and bind the mode/playback controls. */
    init() {
        this.paper_shaders = new LyricsPaperShaders(
            document.getElementById('lyrics-paper-host'),
            () => this.state.hub.audioNormalization,
        );
        this.wave_field = new LyricsWaveField(
            document.getElementById('lyrics-wave-canvas'),
            () => this.state.hub.audioNormalization,
        );
        this.milkdrop = new LyricsMilkdrop(
            document.getElementById('lyrics-milk-canvas'),
            () => this.state.hub.audioNormalization,
        );
        this.bind_visualizer_mode();
        this.bind_visualizer_playback();
    }

    bind_visualizer_playback() {
        const hub = this.state.hub;
        if (hub.audio && !hub.audio.dataset.vizPlayBound) {
            hub.audio.dataset.vizPlayBound = '1';
            hub.audio.addEventListener('play', () => {
                if (hub.lyricsVisible) this.sync_lyrics_visuals();
            });
        }
        if (typeof window !== 'undefined' && !this.butterchurn_ready_bound) {
            this.butterchurn_ready_bound = true;
            window.addEventListener('spolocal-butterchurn-ready', () => {
                if (hub.lyricsVisible && hub.lyricsVisualizerMode === 'milkdrop') {
                    this.sync_lyrics_visuals();
                }
            });
        }
    }

    bind_visualizer_mode() {
        const hub = this.state.hub;
        const select = hub.lyricsVisualizerModeSelect;
        if (!select) return;
        const saved = (() => {
            try {
                return localStorage.getItem('spolocal_lyrics_visualizer_mode') || '';
            } catch (e) {
                return '';
            }
        })();
        if (saved === 'solid' || saved === 'milkdrop') {
            hub.lyricsVisualizerMode = saved;
        }
        select.value = hub.lyricsVisualizerMode === 'milkdrop' ? 'milkdrop' : 'solid';
        if (select.dataset.bound) return;
        select.dataset.bound = '1';
        select.addEventListener('change', () => {
            const mode = select.value === 'milkdrop' ? 'milkdrop' : 'solid';
            hub.lyricsVisualizerMode = mode;
            try {
                localStorage.setItem('spolocal_lyrics_visualizer_mode', mode);
            } catch (e) {}
            if (hub.lyricsVisible) this.sync_lyrics_visuals();
        });
    }

    sync_visualizer_mode_ui() {
        const hub = this.state.hub;
        const select = hub.lyricsVisualizerModeSelect;
        if (!select) return;
        select.value = hub.lyricsVisualizerMode === 'milkdrop' ? 'milkdrop' : 'solid';
    }

    current_visualizer_track() {
        const hub = this.state.hub;
        if (hub.searchStreamActive && hub.searchStreamHit) return hub.searchStreamHit;
        const track_id = String(hub.currentTrackId || '').trim();
        if (!track_id) return {};
        const candidates = [
            hub.lastPlayedTrackSnapshot,
            ...(Array.isArray(hub.playingTracks) ? hub.playingTracks : []),
            ...(Array.isArray(hub.tracks) ? hub.tracks : []),
            ...(Array.isArray(hub.libraryPool) ? hub.libraryPool : []),
        ].filter(Boolean);
        const matches = candidates.filter((track) => {
            const id = track.id != null ? track.id : track.track_id;
            return !track_id || String(id || '').trim() === track_id;
        });
        return matches.reduce((merged, track) => Object.assign(merged, track), {}) || {};
    }

    track_metadata_text(track) {
        const metadata = track && track.metadata && typeof track.metadata === 'object'
            ? track.metadata
            : {};
        const values = [
            track && track.genre,
            track && track.genres,
            track && track.music_genre,
            track && track.musicGenre,
            track && track.style,
            track && track.styles,
            track && track.tags,
            metadata.genre,
            metadata.genres,
            metadata.style,
            metadata.tags,
        ];
        return values
            .flatMap((value) => Array.isArray(value) ? value : [value])
            .filter((value) => typeof value === 'string' || typeof value === 'number')
            .join(' ')
            .toLowerCase();
    }

    visualizer_pack_for_track(track) {
        const hub = this.state.hub;
        const title = String((track && track.title) || (hub.titleEl && hub.titleEl.textContent) || '');
        const artist = String((track && (track.artist || track.channel)) || (hub.subEl && hub.subEl.textContent) || '');
        const match_pack = (text) => {
            if (/(milkdrop|psychedelic|psychedelia|psytrance|goa trance|vaporwave)/.test(text)) return 'milkdrop';
            if (/(electronic|edm|electro|house|techno|trance|dubstep|drum\s*(?:and|&)\s*bass|\bdnb\b|synth(?:wave)?|dance|daft|kraftwerk|aphex|skrillex)/.test(text)) return 'electronic';
            if (/(ambient|classical|piano|score|soundtrack|orchestral|instrumental|lo[\s-]?fi|chillout|downtempo)/.test(text)) return 'ambient';
            if (/(rock|metal|punk|grunge|alternative rock|hard rock|indie rock|post-rock|shoegaze|britpop|nu[\s-]?metal|alternative metal|post-grunge|nirvana|radiohead|arctic monkeys|foo fighters?|the killers|led zeppelin|metallica|linkin park|system of a down|limp bizkit|deftones|evanescence)/.test(text)) return 'rock';
            return '';
        };
        const genre_pack = match_pack(this.track_metadata_text(track));
        if (genre_pack) return genre_pack;
        const identity_pack = match_pack(`${title} ${artist}`.toLowerCase());
        if (identity_pack) return identity_pack;
        return 'pop';
    }

    visualizer_renderer_for_pack(pack) {
        return 'wave';
    }

    sync_lyrics_visuals() {
        const hub = this.state.hub;
        const track = this.current_visualizer_track();
        const title = String((track && track.title) || (hub.titleEl && hub.titleEl.textContent) || '');
        const artist = String((track && (track.artist || track.channel)) || (hub.subEl && hub.subEl.textContent) || '');
        const pack = this.visualizer_pack_for_track(track);
        const mode = hub.lyricsVisualizerMode === 'milkdrop' ? 'milkdrop' : 'solid';
        this.sync_visualizer_mode_ui();

        if (this.paper_shaders) this.paper_shaders.stop();
        if (this.wave_field) this.wave_field.stop();
        if (this.milkdrop) this.milkdrop.stop();

        if (mode !== 'milkdrop' || !this.milkdrop) return;

        const milkdrop_pack = pack === 'milkdrop'
            ? this.milkdrop.guess_pack(title, artist)
            : pack;
        this.milkdrop.set_pack(milkdrop_pack);
        this.milkdrop.set_track(title, artist);
        if (this.milkdrop.start()) return;

        if (this.paper_shaders) {
            this.paper_shaders.set_mood('pop');
            this.paper_shaders.set_track_key(title, artist);
            if (this.paper_shaders.start()) return;
        }
        if (this.wave_field) {
            this.wave_field.set_mood('pop');
            this.wave_field.set_track_key(title, artist);
            this.wave_field.start();
        }
    }

    // Convenience wrappers used by the lyrics controller.
    sync() {
        this.sync_lyrics_visuals();
    }

    setPalette(pal) {
        if (this.paper_shaders) this.paper_shaders.set_palette(pal);
        if (this.wave_field) this.wave_field.set_palette(pal);
    }

    resetPalette() {
        if (this.paper_shaders) this.paper_shaders.set_palette(LyricsPaperShaders.default_palette());
        if (this.wave_field) this.wave_field.set_palette(LyricsWaveField.default_palette());
    }

    stop() {
        if (this.paper_shaders) this.paper_shaders.stop();
        if (this.wave_field) this.wave_field.stop();
        if (this.milkdrop) this.milkdrop.stop();
    }
}