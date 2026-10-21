import { beforeEach, describe, expect, it } from 'vitest';

import { PlaylistColumnResizer } from '../../static/js/ui/column_resizer.js';

const STORAGE_KEY = 'spolocal_playlist_table_columns_v1';

function mount_table(header_count = 2, col_count = 2) {
    let cols = '';
    for (let i = 0; i < col_count; i++) cols += '<col data-col="' + i + '">';
    let headers = '';
    for (let i = 0; i < header_count; i++) headers += '<th data-col="' + i + '">H' + i + '</th>';
    document.body.innerHTML =
        '<table id="playlist-table"><colgroup>' + cols + '</colgroup>' +
        '<thead><tr>' + headers + '</tr></thead></table>';

    const header_els = Array.from(document.querySelectorAll('thead th'));
    header_els.forEach((header, index) => {
        Object.defineProperty(header, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({
                left: index * 100,
                right: index * 100 + 100,
                width: 100,
                top: 0,
                bottom: 20,
                height: 20,
            }),
        });
    });

    return {
        table: document.getElementById('playlist-table'),
        headers: header_els,
        cols: Array.from(document.querySelectorAll('colgroup col')),
    };
}

function mouse(target, type, client_x, button = 0) {
    target.dispatchEvent(new MouseEvent(type, { clientX: client_x, button, bubbles: true }));
}

function saved_widths() {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
}

beforeEach(() => {
    // End any drag a previous test left open before resetting the document.
    document.dispatchEvent(new MouseEvent('mouseup'));
    localStorage.clear();
    document.body.innerHTML = '';
    document.body.className = '';
});

describe('init', () => {
    it('does nothing without a table', () => {
        expect(() => PlaylistColumnResizer.init()).not.toThrow();
    });

    it('marks the table as initialised', () => {
        const { table } = mount_table();
        PlaylistColumnResizer.init();
        expect(table.dataset.playlistColumnResizerInit).toBe('1');
    });

    it('applies saved widths', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([120, 80]));
        const { cols } = mount_table();
        PlaylistColumnResizer.init();
        expect(cols[0].style.width).toBe('120px');
        expect(cols[1].style.width).toBe('80px');
    });

    it('re-applies saved widths on a second call', () => {
        const { cols } = mount_table();
        PlaylistColumnResizer.init();
        localStorage.setItem(STORAGE_KEY, JSON.stringify([50, 60]));
        PlaylistColumnResizer.init();
        expect(cols[0].style.width).toBe('50px');
        expect(cols[1].style.width).toBe('60px');
    });

    it('stops after marking a table without headers', () => {
        const { table } = mount_table(0, 2);
        PlaylistColumnResizer.init();
        expect(table.dataset.playlistColumnResizerInit).toBe('1');
    });

    it('stops after marking a table without columns', () => {
        const { table } = mount_table(2, 0);
        PlaylistColumnResizer.init();
        expect(table.dataset.playlistColumnResizerInit).toBe('1');
    });

    it('disables text selection on the headers', () => {
        const { headers } = mount_table();
        PlaylistColumnResizer.init();
        expect(headers[0].style.userSelect).toBe('none');
        expect(headers[1].style.userSelect).toBe('none');
    });
});

describe('_applySavedWidths', () => {
    it('does nothing without columns', () => {
        const { table } = mount_table(2, 0);
        expect(() => PlaylistColumnResizer._applySavedWidths(table)).not.toThrow();
    });

    it('does nothing without a saved value', () => {
        const { table, cols } = mount_table();
        PlaylistColumnResizer._applySavedWidths(table);
        expect(cols[0].style.width).toBe('');
    });

    it('ignores invalid JSON', () => {
        localStorage.setItem(STORAGE_KEY, 'not json');
        const { table, cols } = mount_table();
        PlaylistColumnResizer._applySavedWidths(table);
        expect(cols[0].style.width).toBe('');
    });

    it('ignores a non-array value', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ a: 1 }));
        const { table, cols } = mount_table();
        PlaylistColumnResizer._applySavedWidths(table);
        expect(cols[0].style.width).toBe('');
    });

    it('ignores an array shorter than the column list', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([120]));
        const { table, cols } = mount_table();
        PlaylistColumnResizer._applySavedWidths(table);
        expect(cols[0].style.width).toBe('');
    });

    it('clamps to the minimum width and rounds', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([10, 100.6]));
        const { table, cols } = mount_table();
        PlaylistColumnResizer._applySavedWidths(table);
        expect(cols[0].style.width).toBe('24px');
        expect(cols[1].style.width).toBe('101px');
    });
});

describe('resizing', () => {
    it('resizes the column while dragging and persists on release', () => {
        const { headers, cols } = mount_table();
        PlaylistColumnResizer.init();

        mouse(headers[0], 'mousedown', 95);
        expect(document.body.classList.contains('playlist-table-columns-resizing')).toBe(true);
        expect(headers[0].style.cursor).toBe('grabbing');

        mouse(document, 'mousemove', 115);
        expect(cols[0].style.width).toBe('120px');

        mouse(document, 'mouseup', 115);
        expect(document.body.classList.contains('playlist-table-columns-resizing')).toBe(false);
        expect(headers[0].style.cursor).toBe('');
        expect(saved_widths()).toEqual([120, 100]);
    });

    it('freezes the other columns at their rendered width on grab', () => {
        const { headers, cols } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 95);
        expect(cols[0].style.width).toBe('100px');
        expect(cols[1].style.width).toBe('100px');
    });

    it('matches headers to cols by data-col, not by position', () => {
        document.body.innerHTML =
            '<table id="playlist-table"><colgroup><col data-col="1"><col data-col="0"></colgroup>' +
            '<thead><tr><th data-col="0">A</th><th data-col="1">B</th></tr></thead></table>';
        const headers = Array.from(document.querySelectorAll('thead th'));
        headers.forEach((header, index) => {
            const width = index === 0 ? 100 : 60;
            Object.defineProperty(header, 'getBoundingClientRect', {
                configurable: true,
                value: () => ({
                    left: index * 100,
                    right: index * 100 + width,
                    width: width,
                    top: 0,
                    bottom: 20,
                    height: 20,
                }),
            });
        });
        const cols = Array.from(document.querySelectorAll('colgroup col'));
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 95);
        expect(cols[1].style.width).toBe('100px');
        expect(cols[0].style.width).toBe('60px');
    });

    it('clamps the dragged width to the minimum', () => {
        const { headers, cols } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 95);
        mouse(document, 'mousemove', -500);
        expect(cols[0].style.width).toBe('24px');
    });

    it('ignores a mousedown away from the edge', () => {
        const { headers } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 50);
        expect(document.body.classList.contains('playlist-table-columns-resizing')).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
    });

    it('ignores a non-left button', () => {
        const { headers } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 95, 2);
        expect(document.body.classList.contains('playlist-table-columns-resizing')).toBe(false);
    });

    it('stops following the mouse after release', () => {
        const { headers, cols } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 95);
        mouse(document, 'mouseup', 95);
        mouse(document, 'mousemove', 300);
        expect(cols[0].style.width).toBe('100px');
    });

    it('persists the minimum width for a column without a header', () => {
        const { headers } = mount_table(1, 2);
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousedown', 95);
        mouse(document, 'mouseup', 95);
        expect(saved_widths()).toEqual([100, 24]);
    });
});

describe('edge cursor', () => {
    it('shows grab near the right edge and clears it away from it', () => {
        const { headers } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousemove', 95);
        expect(headers[0].style.cursor).toBe('grab');
        mouse(headers[0], 'mousemove', 50);
        expect(headers[0].style.cursor).toBe('');
    });

    it('clears the cursor when the mouse leaves the header', () => {
        const { headers } = mount_table();
        PlaylistColumnResizer.init();
        mouse(headers[0], 'mousemove', 95);
        headers[0].dispatchEvent(new MouseEvent('mouseleave'));
        expect(headers[0].style.cursor).toBe('');
    });
});
