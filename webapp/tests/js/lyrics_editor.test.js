import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LyricsEditorController } from '../../static/js/player/lyrics_editor.js';

function mount_lyrics_dom() {
    document.body.innerHTML = `
        <div id="lrc-lines"></div>
        <div id="lrc-editor" class="hidden"></div>
        <textarea id="lyrics-editor"></textarea>
        <div id="lyrics-save-status" class="hidden"></div>
    `;
}

function make_hub(overrides = {}) {
    mount_lyrics_dom();
    return {
        lrcLinesContainer: document.getElementById('lrc-lines'),
        lrcEditor: document.getElementById('lrc-editor'),
        lyricsEditor: document.getElementById('lyrics-editor'),
        lyricsSaveStatus: document.getElementById('lyrics-save-status'),
        lrcEditLines: [],
        lastLyricsPayload: {},
        currentTrackId: 't1',
        playlistId: 'p1',
        audio: null,
        ...overrides,
    };
}

function make_editor(hub) {
    const lyrics = {
        fetchLyrics: vi.fn(() => Promise.resolve()),
        setLyricsMode: vi.fn(),
    };
    return {
        editor: new LyricsEditorController({ hub: hub }, lyrics),
        lyrics: lyrics,
    };
}

function rows(hub) {
    return Array.from(hub.lrcLinesContainer.querySelectorAll('.lrc-line'));
}

function row_at(hub, index) {
    return rows(hub)[index];
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    delete window.SpolocalPlayerHub;
    delete window.__playlistsCatalog;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('renderLrcEditor', () => {
    it('starts with no lines when the payload has no lrc data', () => {
        const hub = make_hub({ lastLyricsPayload: {} });
        const { editor } = make_editor(hub);
        editor.renderLrcEditor();
        expect(hub.lrcEditLines).toEqual([]);
        expect(hub.lrcLinesContainer.children.length).toBe(0);
    });

    it('copies the payload lines without mutating the payload', () => {
        const hub = make_hub({
            lastLyricsPayload: { lrc_data: [{ time_ms: 1000, text: 'a' }] },
        });
        const { editor } = make_editor(hub);
        editor.renderLrcEditor();
        expect(hub.lrcEditLines).toEqual([{ time_ms: 1000, text: 'a' }]);
        expect(hub.lrcEditLines[0]).not.toBe(hub.lastLyricsPayload.lrc_data[0]);
        hub.lrcEditLines[0].text = 'changed';
        expect(hub.lastLyricsPayload.lrc_data[0].text).toBe('a');
    });

    it('renders one row and one gap per line', () => {
        const hub = make_hub({
            lastLyricsPayload: {
                lrc_data: [
                    { time_ms: 1000, text: 'a' },
                    { time_ms: 2000, text: 'b' },
                ],
            },
        });
        const { editor } = make_editor(hub);
        editor.renderLrcEditor();
        expect(rows(hub).length).toBe(2);
        expect(hub.lrcLinesContainer.querySelectorAll('.lrc-insert-gap').length).toBe(2);
    });
});

describe('formatLrcTimestamp', () => {
    it('formats zero', () => {
        const { editor } = make_editor(make_hub());
        expect(editor.formatLrcTimestamp(0)).toBe('[00:00.00]');
    });

    it('formats minutes, seconds and centiseconds', () => {
        const { editor } = make_editor(make_hub());
        expect(editor.formatLrcTimestamp(61234)).toBe('[01:01.23]');
        expect(editor.formatLrcTimestamp(600000)).toBe('[10:00.00]');
        expect(editor.formatLrcTimestamp(3599999)).toBe('[59:59.99]');
    });
});

describe('parseLrcTimestamp', () => {
    it('parses two-digit centiseconds', () => {
        const { editor } = make_editor(make_hub());
        expect(editor.parseLrcTimestamp('[01:02.34]')).toBe(62340);
    });

    it('parses three-digit milliseconds', () => {
        const { editor } = make_editor(make_hub());
        expect(editor.parseLrcTimestamp('[01:02.345]')).toBe(62345);
    });

    it('parses zero', () => {
        const { editor } = make_editor(make_hub());
        expect(editor.parseLrcTimestamp('[00:00.00]')).toBe(0);
    });

    it('returns null for invalid input', () => {
        const { editor } = make_editor(make_hub());
        expect(editor.parseLrcTimestamp('nope')).toBeNull();
        expect(editor.parseLrcTimestamp('[00:00.5]')).toBeNull();
        expect(editor.parseLrcTimestamp('')).toBeNull();
    });
});

describe('adjust_timestamp', () => {
    it('adds the delta', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.adjust_timestamp(0, 1000);
        expect(hub.lrcEditLines[0].time_ms).toBe(2000);
    });

    it('never goes below zero', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.adjust_timestamp(0, -5000);
        expect(hub.lrcEditLines[0].time_ms).toBe(0);
    });

    it('ignores a missing line', () => {
        const hub = make_hub({ lrcEditLines: [] });
        const { editor } = make_editor(hub);
        expect(function () {
            editor.adjust_timestamp(3, 1000);
        }).not.toThrow();
    });
});

describe('shiftAllTimestamps', () => {
    it('shifts every line', () => {
        const hub = make_hub({
            lrcEditLines: [
                { time_ms: 1000, text: 'a' },
                { time_ms: 5000, text: 'b' },
            ],
        });
        const { editor } = make_editor(hub);
        editor.shiftAllTimestamps(1000);
        expect(hub.lrcEditLines[0].time_ms).toBe(2000);
        expect(hub.lrcEditLines[1].time_ms).toBe(6000);
    });

    it('clamps at zero', () => {
        const hub = make_hub({
            lrcEditLines: [
                { time_ms: 1000, text: 'a' },
                { time_ms: 5000, text: 'b' },
            ],
        });
        const { editor } = make_editor(hub);
        editor.shiftAllTimestamps(-3000);
        expect(hub.lrcEditLines[0].time_ms).toBe(0);
        expect(hub.lrcEditLines[1].time_ms).toBe(2000);
    });

    it('does nothing for an empty list', () => {
        const hub = make_hub({ lrcEditLines: [] });
        const { editor } = make_editor(hub);
        expect(function () {
            editor.shiftAllTimestamps(1000);
        }).not.toThrow();
        expect(hub.lrcEditLines).toEqual([]);
    });
});

describe('renderLrcLinesInEditor', () => {
    it('renders the timestamp, text and controls', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 61234, text: 'hello' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        const row = row_at(hub, 0);
        expect(row.querySelector('.lrc-timestamp').textContent).toBe('[01:01.23]');
        expect(row.querySelector('.lrc-text').value).toBe('hello');
        expect(row.querySelectorAll('.lrc-ts-adj-btn').length).toBe(2);
        expect(row.querySelector('.lrc-delete-btn')).not.toBeNull();
    });

    it('updates the line text on input', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 0, text: 'old' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        const input = row_at(hub, 0).querySelector('.lrc-text');
        input.value = 'new';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(hub.lrcEditLines[0].text).toBe('new');
    });

    it('sets the timestamp to the current playback time on click', () => {
        const hub = make_hub({
            lrcEditLines: [{ time_ms: 0, text: 'a' }],
            audio: { currentTime: 12.5 },
        });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        const timestamp = row_at(hub, 0).querySelector('.lrc-timestamp');
        timestamp.click();
        expect(hub.lrcEditLines[0].time_ms).toBe(12500);
        expect(timestamp.textContent).toBe('[00:12.50]');
    });

    it('leaves the timestamp alone on click without audio', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelector('.lrc-timestamp').click();
        expect(hub.lrcEditLines[0].time_ms).toBe(1000);
    });

    it('saves a manually edited timestamp on Enter', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        const timestamp = row_at(hub, 0).querySelector('.lrc-timestamp');
        timestamp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = hub.lrcLinesContainer.querySelector('input.lrc-timestamp');
        expect(input).not.toBeNull();
        input.value = '[00:05.00]';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(hub.lrcEditLines[0].time_ms).toBe(5000);
        expect(row_at(hub, 0).querySelector('.lrc-timestamp').textContent).toBe('[00:05.00]');
    });

    it('saves a manually edited timestamp on blur', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelector('.lrc-timestamp').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = hub.lrcLinesContainer.querySelector('input.lrc-timestamp');
        input.value = '[00:07.50]';
        input.dispatchEvent(new Event('blur'));
        expect(hub.lrcEditLines[0].time_ms).toBe(7500);
    });

    it('keeps the old timestamp when the manual value is invalid', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelector('.lrc-timestamp').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = hub.lrcLinesContainer.querySelector('input.lrc-timestamp');
        input.value = 'nope';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(hub.lrcEditLines[0].time_ms).toBe(1000);
    });

    it('cancels a manual edit on Escape', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelector('.lrc-timestamp').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const input = hub.lrcLinesContainer.querySelector('input.lrc-timestamp');
        input.value = '[00:09.00]';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(hub.lrcEditLines[0].time_ms).toBe(1000);
        expect(hub.lrcLinesContainer.querySelector('input.lrc-timestamp')).toBeNull();
    });

    it('adds one second with the plus button', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelectorAll('.lrc-ts-adj-btn')[1].click();
        expect(hub.lrcEditLines[0].time_ms).toBe(2000);
    });

    it('subtracts one second with the minus button', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelectorAll('.lrc-ts-adj-btn')[0].click();
        expect(hub.lrcEditLines[0].time_ms).toBe(0);
    });

    it('removes a line with the delete button', () => {
        const hub = make_hub({
            lrcEditLines: [
                { time_ms: 1000, text: 'a' },
                { time_ms: 2000, text: 'b' },
            ],
        });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        row_at(hub, 0).querySelector('.lrc-delete-btn').click();
        expect(hub.lrcEditLines).toEqual([{ time_ms: 2000, text: 'b' }]);
        expect(rows(hub).length).toBe(1);
    });

    it('inserts a line halfway between two lines', () => {
        const hub = make_hub({
            lrcEditLines: [
                { time_ms: 1000, text: 'a' },
                { time_ms: 5000, text: 'b' },
            ],
        });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        hub.lrcLinesContainer.querySelectorAll('.lrc-insert-gap')[0].click();
        expect(hub.lrcEditLines).toEqual([
            { time_ms: 1000, text: 'a' },
            { time_ms: 3000, text: '' },
            { time_ms: 5000, text: 'b' },
        ]);
    });

    it('inserts the last line two seconds after the previous one', () => {
        const hub = make_hub({ lrcEditLines: [{ time_ms: 1000, text: 'a' }] });
        const { editor } = make_editor(hub);
        editor.renderLrcLinesInEditor();
        hub.lrcLinesContainer.querySelectorAll('.lrc-insert-gap')[0].click();
        expect(hub.lrcEditLines).toEqual([
            { time_ms: 1000, text: 'a' },
            { time_ms: 3000, text: '' },
        ]);
    });

});

describe('saveLyrics', () => {
    it('does nothing without a current track', async () => {
        const hub = make_hub({ currentTrackId: '' });
        const fetch_mock = vi.fn();
        vi.stubGlobal('fetch', fetch_mock);
        const { editor } = make_editor(hub);
        await editor.saveLyrics();
        expect(fetch_mock).not.toHaveBeenCalled();
    });

    it('saves sorted, non-empty lrc lines in lrc mode', async () => {
        const hub = make_hub({
            lrcEditLines: [
                { time_ms: 2000, text: 'b' },
                { time_ms: 1000, text: 'a' },
                { time_ms: 3000, text: '   ' },
            ],
        });
        hub.lrcEditor.classList.remove('hidden');
        const fetch_mock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
        vi.stubGlobal('fetch', fetch_mock);
        const { editor, lyrics } = make_editor(hub);
        await editor.saveLyrics();

        expect(fetch_mock).toHaveBeenCalledTimes(1);
        const url = fetch_mock.mock.calls[0][0];
        const options = fetch_mock.mock.calls[0][1];
        expect(url).toBe('/playlists/p1/tracks/t1/lyrics/lrc');
        expect(options.method).toBe('POST');
        expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(JSON.parse(options.body)).toEqual({
            lines: [
                { time_ms: 1000, text: 'a' },
                { time_ms: 2000, text: 'b' },
            ],
        });
        expect(lyrics.fetchLyrics).toHaveBeenCalledWith(false);
        expect(lyrics.setLyricsMode).toHaveBeenCalledWith('read');
        expect(hub.lyricsSaveStatus.classList.contains('hidden')).toBe(false);
    });

    it('saves plain lyrics outside lrc mode', async () => {
        const hub = make_hub();
        hub.lyricsEditor.value = 'plain lyrics';
        const fetch_mock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
        vi.stubGlobal('fetch', fetch_mock);
        const { editor, lyrics } = make_editor(hub);
        await editor.saveLyrics();

        const url = fetch_mock.mock.calls[0][0];
        const options = fetch_mock.mock.calls[0][1];
        expect(url).toBe('/playlists/p1/tracks/t1/lyrics');
        expect(JSON.parse(options.body)).toEqual({ lyrics: 'plain lyrics' });
        expect(lyrics.fetchLyrics).toHaveBeenCalledWith(false);
        expect(lyrics.setLyricsMode).toHaveBeenCalledWith('read');
    });

    it('hides the save status after 3.5 seconds', async () => {
        vi.useFakeTimers();
        const hub = make_hub();
        hub.lyricsEditor.value = 'plain';
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
        const { editor } = make_editor(hub);
        await editor.saveLyrics();
        expect(hub.lyricsSaveStatus.classList.contains('hidden')).toBe(false);
        vi.advanceTimersByTime(3500);
        expect(hub.lyricsSaveStatus.classList.contains('hidden')).toBe(true);
    });

    it('alerts the server detail on failure', async () => {
        const hub = make_hub();
        hub.lyricsEditor.value = 'plain';
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false,
            json: async () => ({ detail: 'No permission' }),
        })));
        vi.stubGlobal('alert', vi.fn());
        const { editor, lyrics } = make_editor(hub);
        await editor.saveLyrics();
        expect(window.alert).toHaveBeenCalledWith('No permission');
        expect(lyrics.fetchLyrics).not.toHaveBeenCalled();
        expect(lyrics.setLyricsMode).not.toHaveBeenCalled();
        expect(hub.lyricsSaveStatus.classList.contains('hidden')).toBe(true);
    });

    it('alerts a generic message when the error body is unreadable', async () => {
        const hub = make_hub();
        hub.lyricsEditor.value = 'plain';
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false,
            json: async () => {
                throw new Error('bad json');
            },
        })));
        vi.stubGlobal('alert', vi.fn());
        const { editor } = make_editor(hub);
        await editor.saveLyrics();
        expect(window.alert).toHaveBeenCalledWith('Could not save lyrics.');
    });

    it('alerts on a network error', async () => {
        const hub = make_hub();
        hub.lyricsEditor.value = 'plain';
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
        vi.stubGlobal('alert', vi.fn());
        const { editor } = make_editor(hub);
        await editor.saveLyrics();
        expect(window.alert).toHaveBeenCalledWith('Could not save lyrics.');
    });
});
