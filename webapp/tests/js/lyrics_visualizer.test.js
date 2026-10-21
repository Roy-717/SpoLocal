import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LyricsVisualizerController } from '../../static/js/player/lyrics_visualizer.js';
import { LyricsPaperShaders } from '../../static/js/player/lyrics_paper_shaders.js';
import { LyricsWaveField } from '../../static/js/player/lyrics_wave_field.js';
import { LyricsMilkdrop } from '../../static/js/player/lyrics_milkdrop.js';

function make_el(tag, id) {
    const node = document.createElement(tag);
    if (id) node.id = id;
    document.body.appendChild(node);
    return node;
}

function make_select() {
    const select = make_el('select', 'lyrics-visualizer-mode');
    ['solid', 'milkdrop'].forEach((value) => {
        const option = document.createElement('option');
        option.value = value;
        select.appendChild(option);
    });
    return select;
}

function fake_ctx() {
    return {
        setTransform: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
        fillRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        stroke: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
    };
}

function make_hub(overrides) {
    const hub = {
        lyricsVisualizerMode: 'solid',
        lyricsVisualizerModeSelect: null,
        lyricsVisible: false,
        audio: { dataset: {}, addEventListener: vi.fn() },
        titleEl: { textContent: '' },
        subEl: { textContent: '' },
        currentTrackId: null,
        searchStreamActive: false,
        searchStreamHit: null,
        lastPlayedTrackSnapshot: null,
        playingTracks: [],
        tracks: [],
        libraryPool: [],
        audioNormalization: null,
    };
    return Object.assign(hub, overrides || {});
}

function make_controller(overrides) {
    const hub = make_hub(overrides);
    return { controller: new LyricsVisualizerController({ hub }), hub };
}

function fake_renderer(overrides) {
    return Object.assign({
        stop: vi.fn(),
        start: vi.fn(() => true),
        set_palette: vi.fn(),
        set_mood: vi.fn(),
        set_track_key: vi.fn(),
    }, overrides || {});
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        disconnect() {}
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('constructor', () => {
    it('starts with no renderers', () => {
        const { controller } = make_controller();
        expect(controller.paper_shaders).toBeNull();
        expect(controller.wave_field).toBeNull();
        expect(controller.milkdrop).toBeNull();
        expect(controller.butterchurn_ready_bound).toBe(false);
    });
});

describe('init', () => {
    it('creates the three renderers and binds the mode select', () => {
        const paper_host = make_el('div', 'lyrics-paper-host');
        const wave_canvas = make_el('canvas', 'lyrics-wave-canvas');
        const milk_canvas = make_el('canvas', 'lyrics-milk-canvas');
        wave_canvas.getContext = vi.fn(() => fake_ctx());
        const select = make_select();
        const { controller, hub } = make_controller({ lyricsVisualizerModeSelect: select });
        controller.init();
        expect(controller.paper_shaders.constructor.name).toBe('LyricsPaperShaders');
        expect(controller.wave_field.constructor.name).toBe('LyricsWaveField');
        expect(controller.milkdrop.constructor.name).toBe('LyricsMilkdrop');
        expect(controller.paper_shaders.host).toBe(paper_host);
        expect(controller.wave_field.canvas).toBe(wave_canvas);
        expect(controller.milkdrop.canvas).toBe(milk_canvas);
        expect(select.value).toBe('solid');
        expect(hub.audio.dataset.vizPlayBound).toBe('1');
    });
});

describe('bind_visualizer_playback', () => {
    it('syncs visuals when audio plays while visible', () => {
        const { controller, hub } = make_controller({ lyricsVisible: true });
        const sync = vi.spyOn(controller, 'sync_lyrics_visuals').mockImplementation(() => {});
        controller.bind_visualizer_playback();
        const play = hub.audio.addEventListener.mock.calls[0][1];
        play();
        expect(sync).toHaveBeenCalled();
    });

    it('syncs on the butterchurn ready event in milkdrop mode', () => {
        const { controller, hub } = make_controller({
            lyricsVisible: true,
            lyricsVisualizerMode: 'milkdrop',
        });
        const sync = vi.spyOn(controller, 'sync_lyrics_visuals').mockImplementation(() => {});
        controller.bind_visualizer_playback();
        window.dispatchEvent(new Event('spolocal-butterchurn-ready'));
        expect(sync).toHaveBeenCalled();
    });
});

describe('bind_visualizer_mode', () => {
    it('restores a saved milkdrop mode', () => {
        localStorage.setItem('spolocal_lyrics_visualizer_mode', 'milkdrop');
        const select = make_select();
        const { controller, hub } = make_controller({ lyricsVisualizerModeSelect: select });
        controller.bind_visualizer_mode();
        expect(hub.lyricsVisualizerMode).toBe('milkdrop');
        expect(select.value).toBe('milkdrop');
    });

    it('persists a mode change and syncs when visible', () => {
        const select = make_select();
        const { controller, hub } = make_controller({
            lyricsVisualizerModeSelect: select,
            lyricsVisible: true,
        });
        const sync = vi.spyOn(controller, 'sync_lyrics_visuals').mockImplementation(() => {});
        controller.bind_visualizer_mode();
        select.value = 'milkdrop';
        select.dispatchEvent(new Event('change'));
        expect(hub.lyricsVisualizerMode).toBe('milkdrop');
        expect(localStorage.getItem('spolocal_lyrics_visualizer_mode')).toBe('milkdrop');
        expect(sync).toHaveBeenCalled();
    });

    it('ignores an unknown saved value', () => {
        localStorage.setItem('spolocal_lyrics_visualizer_mode', 'weird');
        const select = make_select();
        const { controller, hub } = make_controller({ lyricsVisualizerModeSelect: select });
        controller.bind_visualizer_mode();
        expect(hub.lyricsVisualizerMode).toBe('solid');
        expect(select.value).toBe('solid');
    });

    it('does nothing without a select', () => {
        const { controller } = make_controller();
        expect(() => controller.bind_visualizer_mode()).not.toThrow();
    });
});

describe('sync_visualizer_mode_ui', () => {
    it('reflects the hub mode on the select', () => {
        const select = make_select();
        const { controller, hub } = make_controller({
            lyricsVisualizerModeSelect: select,
            lyricsVisualizerMode: 'milkdrop',
        });
        controller.sync_visualizer_mode_ui();
        expect(select.value).toBe('milkdrop');
        hub.lyricsVisualizerMode = 'solid';
        controller.sync_visualizer_mode_ui();
        expect(select.value).toBe('solid');
    });
});

describe('current_visualizer_track', () => {
    it('returns the search hit while searching', () => {
        const hit = { video_id: 'abcdefghijk', title: 'Search' };
        const { controller } = make_controller({
            searchStreamActive: true,
            searchStreamHit: hit,
        });
        expect(controller.current_visualizer_track()).toBe(hit);
    });

    it('merges matching track candidates', () => {
        const { controller } = make_controller({
            currentTrackId: 't1',
            lastPlayedTrackSnapshot: { id: 't1', title: 'A' },
            tracks: [{ id: 't1', artist: 'B' }],
        });
        expect(controller.current_visualizer_track()).toEqual({ id: 't1', title: 'A', artist: 'B' });
    });

    it('returns an empty object without a track id', () => {
        const { controller } = make_controller();
        expect(controller.current_visualizer_track()).toEqual({});
    });
});

describe('track_metadata_text', () => {
    it('joins genre fields and metadata into lowercase text', () => {
        const { controller } = make_controller();
        const text = controller.track_metadata_text({
            genre: 'Rock',
            genres: ['Metal', 'Punk'],
            metadata: { style: 'Grunge', tags: ['Loud'] },
        });
        expect(text).toBe('rock metal punk grunge loud');
    });

    it('ignores non-string values', () => {
        const { controller } = make_controller();
        expect(controller.track_metadata_text({ genre: { a: 1 }, tags: [1, null] })).toBe('1');
        expect(controller.track_metadata_text(null)).toBe('');
    });
});

describe('visualizer_pack_for_track', () => {
    it('picks a pack from genre metadata', () => {
        const { controller } = make_controller();
        expect(controller.visualizer_pack_for_track({ genre: 'Techno' })).toBe('electronic');
        expect(controller.visualizer_pack_for_track({ genre: 'Ambient' })).toBe('ambient');
        expect(controller.visualizer_pack_for_track({ genre: 'Psytrance' })).toBe('milkdrop');
    });

    it('falls back to title and artist identity', () => {
        const { controller } = make_controller();
        expect(controller.visualizer_pack_for_track({ title: 'Nirvana', artist: 'Band' })).toBe('rock');
    });

    it('defaults to pop', () => {
        const { controller } = make_controller();
        expect(controller.visualizer_pack_for_track({ title: 'Unknown' })).toBe('pop');
    });
});

describe('visualizer_renderer_for_pack', () => {
    it('always returns the wave renderer', () => {
        const { controller } = make_controller();
        expect(controller.visualizer_renderer_for_pack('rock')).toBe('wave');
        expect(controller.visualizer_renderer_for_pack('milkdrop')).toBe('wave');
    });
});

describe('sync_lyrics_visuals', () => {
    it('stops all renderers in solid mode', () => {
        const { controller } = make_controller({ lyricsVisualizerMode: 'solid' });
        controller.paper_shaders = fake_renderer();
        controller.wave_field = fake_renderer();
        controller.milkdrop = fake_renderer();
        controller.sync_lyrics_visuals();
        expect(controller.paper_shaders.stop).toHaveBeenCalled();
        expect(controller.wave_field.stop).toHaveBeenCalled();
        expect(controller.milkdrop.stop).toHaveBeenCalled();
        expect(controller.milkdrop.start).not.toHaveBeenCalled();
    });

    it('starts milkdrop with the guessed pack', () => {
        const { controller } = make_controller({
            lyricsVisualizerMode: 'milkdrop',
            currentTrackId: 't1',
            tracks: [{ id: 't1', genre: 'psytrance' }],
        });
        controller.paper_shaders = fake_renderer();
        controller.wave_field = fake_renderer();
        controller.milkdrop = fake_renderer({
            guess_pack: vi.fn(() => 'rock'),
            set_pack: vi.fn(),
            set_track: vi.fn(),
        });
        controller.sync_lyrics_visuals();
        expect(controller.milkdrop.set_pack).toHaveBeenCalledWith('rock');
        expect(controller.milkdrop.set_track).toHaveBeenCalled();
        expect(controller.milkdrop.start).toHaveBeenCalled();
        expect(controller.paper_shaders.start).not.toHaveBeenCalled();
    });

    it('falls back to paper shaders then the wave field', () => {
        const { controller } = make_controller({ lyricsVisualizerMode: 'milkdrop' });
        controller.paper_shaders = fake_renderer({ start: vi.fn(() => true) });
        controller.wave_field = fake_renderer();
        controller.milkdrop = fake_renderer({
            start: vi.fn(() => false),
            set_pack: vi.fn(),
            set_track: vi.fn(),
        });
        controller.sync_lyrics_visuals();
        expect(controller.paper_shaders.set_mood).toHaveBeenCalledWith('pop');
        expect(controller.paper_shaders.start).toHaveBeenCalled();
        expect(controller.wave_field.start).not.toHaveBeenCalled();

        controller.paper_shaders.start = vi.fn(() => false);
        controller.sync_lyrics_visuals();
        expect(controller.wave_field.start).toHaveBeenCalled();
    });
});

describe('wrappers', () => {
    it('sync delegates to sync_lyrics_visuals', () => {
        const { controller } = make_controller();
        const spy = vi.spyOn(controller, 'sync_lyrics_visuals').mockImplementation(() => {});
        controller.sync();
        expect(spy).toHaveBeenCalled();
    });

    it('setPalette forwards to paper and wave renderers', () => {
        const { controller } = make_controller();
        controller.paper_shaders = fake_renderer();
        controller.wave_field = fake_renderer();
        const pal = { bg: '#000000' };
        controller.setPalette(pal);
        expect(controller.paper_shaders.set_palette).toHaveBeenCalledWith(pal);
        expect(controller.wave_field.set_palette).toHaveBeenCalledWith(pal);
    });

    it('resetPalette uses the default palettes', () => {
        const { controller } = make_controller();
        controller.paper_shaders = fake_renderer();
        controller.wave_field = fake_renderer();
        controller.resetPalette();
        expect(controller.paper_shaders.set_palette).toHaveBeenCalledWith(LyricsPaperShaders.default_palette());
        expect(controller.wave_field.set_palette).toHaveBeenCalledWith(LyricsWaveField.default_palette());
    });

    it('stop stops every renderer', () => {
        const { controller } = make_controller();
        controller.paper_shaders = fake_renderer();
        controller.wave_field = fake_renderer();
        controller.milkdrop = fake_renderer();
        controller.stop();
        expect(controller.paper_shaders.stop).toHaveBeenCalled();
        expect(controller.wave_field.stop).toHaveBeenCalled();
        expect(controller.milkdrop.stop).toHaveBeenCalled();
    });
});
