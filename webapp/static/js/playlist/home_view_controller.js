/**
 * Home view: most-played stats from localStorage and random-play controls.
 */
export class PlaylistHomeViewController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state, transport) {
        this.state = state;
        this.transport = transport;
    }

    static track_play_key(playlist_id, track_id) {
        return String(playlist_id || '').trim() + '|' + String(track_id || '').trim();
    }

    static read_track_plays() {
        try {
            const raw = localStorage.getItem('spolocal_track_plays');
            const o = raw ? JSON.parse(raw) : {};
            return o && typeof o === 'object' ? o : {};
        } catch (e) {
            return {};
        }
    }

    static read_playlist_plays() {
        try {
            const raw = localStorage.getItem('spolocal_playlist_plays');
            const o = raw ? JSON.parse(raw) : {};
            return o && typeof o === 'object' ? o : {};
        } catch (e) {
            return {};
        }
    }

    static record_track_play(playlist_id, track_id) {
        const pid = String(playlist_id || '').trim();
        const tid = String(track_id || '').trim();
        if (!pid || !tid) return;
        try {
            const key = PlaylistHomeViewController.track_play_key(pid, tid);
            const track_plays = PlaylistHomeViewController.read_track_plays();
            track_plays[key] = (Number(track_plays[key]) || 0) + 1;
            localStorage.setItem('spolocal_track_plays', JSON.stringify(track_plays));
            const pl_plays = PlaylistHomeViewController.read_playlist_plays();
            pl_plays[pid] = (Number(pl_plays[pid]) || 0) + 1;
            localStorage.setItem('spolocal_playlist_plays', JSON.stringify(pl_plays));
        } catch (e) {}
    }

    bind_controls() {
        const btn = document.getElementById('home-random-toggle');
        if (!btn || btn.dataset.homeBound) return;
        btn.dataset.homeBound = '1';
        btn.addEventListener('click', () => {
            const hub = this.state.hub;
            hub.randomMode = !hub.randomMode;
            this.sync_random_ui();
            if (hub.randomMode && this.transport) {
                this.transport.play_random_from_library();
            }
        });
        this.sync_random_ui();
    }

    sync_random_ui() {
        const hub = this.state.hub;
        const btn = document.getElementById('home-random-toggle');
        const status = document.getElementById('home-random-status');
        if (btn) {
            btn.textContent = hub.randomMode ? 'Stop random' : 'Start random';
            btn.classList.toggle('bg-[#3E3E3E]', hub.randomMode);
            btn.classList.toggle('text-white', hub.randomMode);
            btn.classList.toggle('bg-[#1DB954]', !hub.randomMode);
            btn.classList.toggle('text-black', !hub.randomMode);
        }
        if (status) status.classList.toggle('hidden', !hub.randomMode);
    }

    render() {
        this.render_top_playlists();
        this.render_top_songs();
        this.bind_controls();
    }

    catalog_by_id() {
        const map = new Map();
        const catalog = Array.isArray(window.__playlistsCatalog) ? window.__playlistsCatalog : [];
        catalog.forEach((pl) => {
            if (pl && pl.id) map.set(String(pl.id), pl);
        });
        return map;
    }

    render_top_playlists() {
        const container = document.getElementById('home-top-playlists');
        const empty = document.getElementById('home-playlists-empty');
        if (!container) return;
        container.innerHTML = '';
        const plays = PlaylistHomeViewController.read_playlist_plays();
        const catalog = this.catalog_by_id();
        const ranked = Object.entries(plays)
            .map(([id, count]) => ({ id, count: Number(count) || 0 }))
            .filter((row) => row.count > 0 && catalog.has(row.id))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        if (!ranked.length) {
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');

        ranked.forEach((row) => {
            const pl = catalog.get(row.id);
            const card = document.createElement('a');
            card.href = '/?playlist_id=' + encodeURIComponent(row.id);
            card.className = 'playlist-spa-nav group rounded-md bg-[#181818] p-2 hover:bg-[#282828] transition-colors';
            const art = document.createElement('div');
            art.className = 'playlist-art-grid grid aspect-square w-full min-h-0 min-w-0 grid-cols-2 overflow-hidden rounded-sm bg-[#1a1a1a] mb-1';
            art.style.gridTemplateRows = 'repeat(2, minmax(0, 1fr))';
            art.style.gap = '1px';
            const tiles = (pl && pl.cover_tiles) || [];
            for (let i = 0; i < 4; i++) {
                const cell = document.createElement('div');
                cell.className = 'playlist-art-grid__cell h-full w-full bg-[#282828]';
                if (tiles[i]) {
                    const img = document.createElement('img');
                    img.src = tiles[i];
                    img.alt = '';
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.onerror = function () {
                        this.onerror = null;
                        this.style.opacity = '0';
                    };
                    cell.appendChild(img);
                }
                art.appendChild(cell);
            }
            card.appendChild(art);
            const name = document.createElement('div');
            name.className = 'truncate text-xs font-semibold text-white leading-tight';
            name.textContent = (pl && pl.name) || 'Playlist';
            card.appendChild(name);
            const meta = document.createElement('div');
            meta.className = 'text-[10px] text-[#727272] mt-0.5 leading-tight';
            meta.textContent = row.count + (row.count === 1 ? ' play' : ' plays');
            card.appendChild(meta);
            container.appendChild(card);
        });
    }

    render_top_songs() {
        const container = document.getElementById('home-top-songs');
        const empty = document.getElementById('home-songs-empty');
        if (!container) return;
        container.innerHTML = '';
        const plays = PlaylistHomeViewController.read_track_plays();
        const pool = Array.isArray(this.state.hub.libraryPool) ? this.state.hub.libraryPool : [];
        const pool_map = new Map();
        pool.forEach((t) => {
            if (t && t.playlist_id && t.track_id) {
                pool_map.set(PlaylistHomeViewController.track_play_key(t.playlist_id, t.track_id), t);
            }
        });

        const ranked = Object.entries(plays)
            .map(([key, count]) => ({ key, count: Number(count) || 0, track: pool_map.get(key) }))
            .filter((row) => row.count > 0 && row.track && row.track.play_src)
            .sort((a, b) => b.count - a.count)
            .slice(0, 12);

        if (!ranked.length) {
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');

        ranked.forEach((row, idx) => {
            const t = row.track;
            const row_el = document.createElement('div');
            row_el.className = 'track-row home-song-row track-row--playable flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-[#282828]';
            row_el.dataset.playlistId = t.playlist_id;
            row_el.dataset.trackId = t.track_id;
            row_el.dataset.playSrc = t.play_src;
            row_el.dataset.title = t.title || '';
            row_el.dataset.artist = t.artist || '';
            row_el.dataset.album = t.album != null ? String(t.album) : '';

            const num = document.createElement('span');
            num.className = 'w-6 text-center text-sm text-[#727272] tabular-nums shrink-0';
            num.textContent = String(idx + 1);

            const art = document.createElement('div');
            art.className = 'h-10 w-10 shrink-0 overflow-hidden rounded bg-[#1a1a1a]';
            const img = document.createElement('img');
            const covers = window.SpolocalCoverUrls;
            img.src = covers
                ? covers.trackCoverUrl(t.playlist_id, t.track_id, t.youtube_video_id)
                : ('/playlists/' + encodeURIComponent(t.playlist_id) + '/tracks/' + encodeURIComponent(t.track_id) + '/cover');
            img.alt = '';
            img.loading = 'lazy';
            img.className = 'h-full w-full object-cover';
            img.onerror = function () { this.style.opacity = '0'; };
            art.appendChild(img);

            const text = document.createElement('div');
            text.className = 'min-w-0 flex-1';
            const title = document.createElement('div');
            title.className = 'track-row-title truncate text-sm font-medium text-white';
            title.textContent = t.title || '';
            const artist = document.createElement('div');
            artist.className = 'track-row-artist truncate text-xs text-[#B3B3B3]';
            artist.textContent = t.artist || '';
            text.appendChild(title);
            text.appendChild(artist);

            const like_btn = document.createElement('button');
            like_btn.type = 'button';
            like_btn.className = 'track-row-like shrink-0 h-8 w-8 flex items-center justify-center rounded-full text-[#B3B3B3] hover:text-white';
            like_btn.dataset.playlistId = t.playlist_id;
            like_btn.dataset.trackId = t.track_id;
            like_btn.setAttribute('aria-label', 'Like');
            like_btn.innerHTML = '<i class="fa-regular fa-heart text-sm"></i>';

            row_el.appendChild(num);
            row_el.appendChild(art);
            row_el.appendChild(text);
            row_el.appendChild(like_btn);
            container.appendChild(row_el);
        });

        if (this.transport && typeof this.transport.likes.bind_track_row_like_buttons === 'function') {
            this.transport.likes.bind_track_row_like_buttons();
        }
    }
}
