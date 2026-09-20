/**
 * Song Mix page: YouTube Mix streams for one seed track.
 */
export class SongMixController {
    constructor(state) {
        this.state = state;
        this.fetch_gen = 0;
    }

    open_from_payload(payload) {
        const playlist_id = String((payload && payload.playlistId) || '').trim();
        const track_id = String((payload && payload.trackId) || '').trim();
        const vid = String((payload && payload.ytid) || '').trim();
        if (vid.length !== 11 && (!playlist_id || !track_id)) {
            alert('No YouTube id for this song.');
            return;
        }
        void this.open({
            playlist_id: playlist_id,
            track_id: track_id,
            video_id: vid,
            title: (payload && payload.title) || '',
            artist: (payload && payload.artist) || '',
            push: true,
        });
    }

    async open(opts) {
        const hub = this.state.hub;
        const playlist_id = String(opts.playlist_id || '').trim();
        const track_id = String(opts.track_id || '').trim();
        const video_id = String(opts.video_id || '').trim();
        const title = String(opts.title || '');
        const artist = String(opts.artist || '');
        const push = opts.push !== false;
        const gen = ++this.fetch_gen;
        hub.songMixView = true;
        if (hub.lyricsVisible && hub.lyricsPanel) {
            hub.lyricsVisible = false;
            hub.lyricsPanel.classList.add('hidden');
            hub.lyricsPanel.style.bottom = '';
        }
        if (typeof window.closeGlobalSearch === 'function') window.closeGlobalSearch();
        this.render_shell(title, artist);
        const params = new URLSearchParams();
        if (playlist_id) params.set('playlist_id', playlist_id);
        if (track_id) params.set('track_id', track_id);
        if (video_id) params.set('vid', video_id);
        params.set('limit', '24');
        try {
            const r = await fetch('/api/track/mix?' + params.toString());
            if (gen !== this.fetch_gen) return;
            if (!r.ok) {
                this.set_msg('Could not load mix.');
                return;
            }
            const data = await r.json();
            if (gen !== this.fetch_gen) return;
            const seed = data.seed || {};
            const hits = Array.isArray(data.hits) ? data.hits : [];
            const seed_title = seed.title || title || 'Mix';
            const seed_artist = seed.artist || artist || '';
            this.render_shell(seed_title, seed_artist);
            const grid = document.getElementById('song-mix-grid');
            const msg = document.getElementById('song-mix-msg');
            if (!hits.length) {
                if (msg) {
                    msg.textContent = 'No mix for this song.';
                    msg.classList.remove('hidden');
                }
                return;
            }
            if (msg) msg.classList.add('hidden');
            for (let i = 0; i < 40 && typeof window.renderSpolocalMixRows !== 'function'; i++) {
                await new Promise((res) => setTimeout(res, 50));
            }
            if (gen !== this.fetch_gen) return;
            if (typeof window.renderSpolocalMixRows === 'function') {
                window.renderSpolocalMixRows(grid, hits, { plus_menu: true, table_id: 'song-mix-table' });
            }
            if (push) {
                const url = new URL(location.href);
                url.search = '';
                if (playlist_id) url.searchParams.set('playlist_id', playlist_id);
                if (track_id) url.searchParams.set('track_id', track_id);
                url.searchParams.set('view', 'mix');
                history.pushState({ view: 'mix', playlistId: playlist_id, trackId: track_id }, '', url);
            }
        } catch (e) {
            if (gen !== this.fetch_gen) return;
            this.set_msg('Could not load mix (network).');
        }
    }

    warm_hit_streams(hits) {
        const ids = [];
        (hits || []).forEach((hit) => {
            const vid = String((hit && hit.video_id) || '').trim();
            if (vid.length === 11 && ids.indexOf(vid) < 0) ids.push(vid);
        });
        const queue = ids.slice();
        const worker = async () => {
            while (queue.length) {
                const vid = queue.shift();
                if (!vid) return;
                try {
                    await fetch('/api/stream/prepare?vid=' + encodeURIComponent(vid));
                } catch (e) {}
            }
        };
        void worker();
        void worker();
    }

    set_msg(text) {
        const msg = document.getElementById('song-mix-msg');
        if (!msg) return;
        msg.textContent = text || '';
        msg.classList.toggle('hidden', !text);
    }

    render_shell(title, artist) {
        const shell = document.getElementById('spa-main');
        if (!shell) return;
        const h = document.createElement('div');
        h.id = 'playlist-scroll-root';
        h.className = 'flex-1 min-h-0 overflow-y-auto p-4 pb-[calc(var(--app-player-inset-mobile)_+_0.75rem)] lg:pb-24';
        const head = document.createElement('div');
        head.className = 'p-6 border-b border-[#282828] -mx-4 -mt-4 mb-4';
        const kind = document.createElement('div');
        kind.className = 'text-xs text-[#727272]';
        kind.textContent = 'MIX';
        const h1 = document.createElement('h1');
        h1.className = 'text-4xl font-bold tracking-tighter truncate';
        h1.textContent = title || 'Song mix';
        const sub = document.createElement('p');
        sub.className = 'text-sm text-[#B3B3B3] mt-1';
        sub.textContent = artist ? ('Radio from ' + artist) : 'Streamed YouTube Mix';
        head.appendChild(kind);
        head.appendChild(h1);
        head.appendChild(sub);
        const body = document.createElement('div');
        body.className = 'w-full max-w-none min-w-0';
        const msg = document.createElement('p');
        msg.id = 'song-mix-msg';
        msg.className = 'text-sm text-[#727272] mb-4';
        msg.textContent = 'Loading mix…';
        const grid = document.createElement('div');
        grid.id = 'song-mix-grid';
        grid.className = 'w-full min-h-[4rem]';
        body.appendChild(msg);
        body.appendChild(grid);
        h.appendChild(head);
        h.appendChild(body);
        shell.innerHTML = '';
        shell.appendChild(h);
    }
}
