import { beforeEach, describe, expect, it } from 'vitest';

import { PlaylistPlayerState } from '../../static/js/player/player_state.js';

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('PlaylistPlayerState', () => {
    it('falls back to an empty hub when none is given', () => {
        const state = new PlaylistPlayerState();
        expect(state.hub).toEqual({});
        expect(state.currentTrackId).toBe(undefined);
        expect(state.seeking).toBe(false);
        expect(state.audio).toBe(undefined);
    });

    it('falls back to an empty hub for a falsy hub', () => {
        expect(new PlaylistPlayerState(null).hub).toEqual({});
    });

    it('exposes the current track id', () => {
        const state = new PlaylistPlayerState({ currentTrackId: 't1' });
        expect(state.currentTrackId).toBe('t1');
    });

    it('coerces seeking to a boolean', () => {
        expect(new PlaylistPlayerState({ seeking: true }).seeking).toBe(true);
        expect(new PlaylistPlayerState({ seeking: 1 }).seeking).toBe(true);
        expect(new PlaylistPlayerState({ seeking: 0 }).seeking).toBe(false);
        expect(new PlaylistPlayerState({ seeking: undefined }).seeking).toBe(false);
    });

    it('exposes the audio element', () => {
        const audio = { paused: true };
        expect(new PlaylistPlayerState({ audio }).audio).toBe(audio);
    });

    it('reads through to the hub after it changes', () => {
        const hub = { currentTrackId: 't1' };
        const state = new PlaylistPlayerState(hub);
        hub.currentTrackId = 't2';
        expect(state.currentTrackId).toBe('t2');
    });
});
