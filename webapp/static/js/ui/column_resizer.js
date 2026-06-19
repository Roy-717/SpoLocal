export class PlaylistColumnResizer {
    static STORAGE_KEY = 'spolocal_playlist_table_columns_v1';
    static HANDLE_PX = 8;
    static MIN_WIDTH = 24;

    static init() {
        const table = document.getElementById('playlist-table');
        if (!table) {
            return;
        }

        // Always re-apply saved widths on new tables (SPA navigation)
        this._applySavedWidths(table);

        if (table.dataset.playlistColumnResizerInit === '1') {
            return;
        }
        table.dataset.playlistColumnResizerInit = '1';

        const headers = Array.from(table.querySelectorAll('thead th[data-col]'));
        const cols = Array.from(table.querySelectorAll('colgroup col[data-col]'));
        if (!headers.length || !cols.length) {
            return;
        }

        const setColWidth = (col, width) => {
            const px = Math.max(this.MIN_WIDTH, Math.round(Number(width) || 0));
            col.style.width = px + 'px';
            return px;
        };

        const freezeCurrentWidths = () => {
            headers.forEach((header, index) => {
                const col = cols[index];
                if (!col) return;
                setColWidth(col, header.getBoundingClientRect().width);
            });
        };

        const persistWidths = () => {
            const widths = cols.map((col, idx) => {
                const parsed = parseFloat(col.style.width);
                if (Number.isFinite(parsed)) {
                    return Math.max(this.MIN_WIDTH, Math.round(parsed));
                }
                if (headers[idx]) {
                    return Math.max(this.MIN_WIDTH, Math.round(headers[idx].getBoundingClientRect().width));
                }
                return this.MIN_WIDTH;
            });
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(widths));
            } catch (e) {}
        };

        let active = null;
        let startX = 0;
        let startWidth = 0;
        let onMove = null;
        let onUp = null;

        const stopResize = () => {
            if (!active) return;
            active.style.cursor = '';
            document.body.style.cursor = '';
            document.body.classList.remove('playlist-table-columns-resizing');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            active = null;
            onMove = null;
            onUp = null;
            startX = 0;
            startWidth = 0;
            persistWidths();
        };

        const startResize = (header, e) => {
            freezeCurrentWidths();
            active = header;
            startX = e.clientX;
            const col = cols[Number(header.dataset.col)];
            const currentWidth = parseFloat(col && col.style.width ? col.style.width : '');
            startWidth = Number.isFinite(currentWidth) ? currentWidth : header.getBoundingClientRect().width;
            active.style.cursor = 'grabbing';
            document.body.style.cursor = 'grabbing';
            document.body.classList.add('playlist-table-columns-resizing');
            onMove = (ev) => {
                if (!active) return;
                const targetCol = cols[Number(active.dataset.col)];
                if (!targetCol) return;
                const nextWidth = startWidth + (ev.clientX - startX);
                setColWidth(targetCol, nextWidth);
            };
            onUp = stopResize;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        headers.forEach((header) => {
            header.style.userSelect = 'none';
            const edgeHit = (e) => {
                const rect = header.getBoundingClientRect();
                const isOnEdge = (rect.right - e.clientX) <= this.HANDLE_PX;
                header.style.cursor = isOnEdge ? 'grab' : '';
            };
            header.addEventListener('mousemove', edgeHit);
            header.addEventListener('mouseleave', () => { header.style.cursor = ''; });
            header.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const rect = header.getBoundingClientRect();
                if ((rect.right - e.clientX) <= this.HANDLE_PX) {
                    e.preventDefault();
                    startResize(header, e);
                }
            });
        });
    }

    static _applySavedWidths(table) {
        const cols = Array.from(table.querySelectorAll('colgroup col[data-col]'));
        if (!cols.length) return;

        const setColWidth = (col, width) => {
            const px = Math.max(this.MIN_WIDTH, Math.round(Number(width) || 0));
            col.style.width = px + 'px';
        };

        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            const widths = Array.isArray(data) ? data : null;
            if (Array.isArray(widths) && widths.length >= cols.length) {
                cols.forEach((col, index) => setColWidth(col, widths[index]));
            }
        } catch (e) {}
    }
}
