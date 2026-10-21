/**
 * Home view: listening stats, highlight carousel and random-play controls.
 *
 * All numbers come from localStorage play counters plus the library pool that
 * the server already sends with the home payload, so the view costs no extra
 * requests. Each section keeps its own signature and skips the rebuild when
 * nothing changed, which matters because render() also runs on every play.
 */
export class PlaylistHomeViewController {
    /** @param {import('../player/player_state.js').PlaylistPlayerState} state */
    constructor(state, transport) {
        this.state = state;
        this.transport = transport;
        this._sig = {};
        this._storyScroll = 0;
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

    /** Per-day play counts, capped so the log cannot grow without bound. */
    static read_play_log() {
        try {
            const raw = localStorage.getItem('spolocal_play_log');
            const o = raw ? JSON.parse(raw) : {};
            return o && typeof o === 'object' ? o : {};
        } catch (e) {
            return {};
        }
    }

    static record_play_log() {
        try {
            const log = PlaylistHomeViewController.read_play_log();
            const day = new Date().toISOString().slice(0, 10);
            log[day] = (Number(log[day]) || 0) + 1;
            const days = Object.keys(log).sort();
            while (days.length > 60) delete log[days.shift()];
            localStorage.setItem('spolocal_play_log', JSON.stringify(log));
        } catch (e) {}
    }

    static week_plays(log) {
        const now = Date.now();
        let total = 0;
        for (let i = 0; i < 7; i++) {
            const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
            total += Number(log[day]) || 0;
        }
        return total;
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
            PlaylistHomeViewController.record_play_log();
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
        const data = this.aggregate();
        this.render_stats(data);
        this.render_stories(data);
        this.render_top_playlists(data);
        this.render_top_songs(data);
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

    /** Ranked songs, playlists and headline numbers for the whole view. */
    aggregate() {
        const hub = this.state.hub;
        const track_plays = PlaylistHomeViewController.read_track_plays();
        const playlist_plays = PlaylistHomeViewController.read_playlist_plays();
        const catalog = this.catalog_by_id();
        const pool = Array.isArray(hub.libraryPool) ? hub.libraryPool : [];
        const pool_map = new Map();
        pool.forEach((t) => {
            if (t && t.playlist_id && t.track_id) {
                pool_map.set(PlaylistHomeViewController.track_play_key(t.playlist_id, t.track_id), t);
            }
        });

        const songs = Object.entries(track_plays)
            .map(([key, count]) => ({ key, count: Number(count) || 0, track: pool_map.get(key) }))
            .filter((row) => row.count > 0 && row.track && row.track.play_src)
            .sort((a, b) => b.count - a.count);

        const playlists = Object.entries(playlist_plays)
            .map(([id, count]) => ({ id, count: Number(count) || 0, playlist: catalog.get(String(id)) }))
            .filter((row) => row.count > 0 && row.playlist)
            .sort((a, b) => b.count - a.count);

        const artists = new Map();
        songs.forEach((row) => {
            const name = String(row.track.artist || '').trim();
            if (!name) return;
            artists.set(name, (artists.get(name) || 0) + row.count);
        });
        const top_artist = Array.from(artists.entries()).sort((a, b) => b[1] - a[1])[0];

        const total_plays = Object.values(track_plays).reduce((sum, v) => sum + (Number(v) || 0), 0);
        const log = PlaylistHomeViewController.read_play_log();

        return {
            songs,
            playlists,
            totalPlays: total_plays,
            uniqueSongs: songs.length,
            playlistsPlayed: playlists.length,
            topArtist: top_artist ? { name: top_artist[0], plays: top_artist[1] } : null,
            weekPlays: PlaylistHomeViewController.week_plays(log),
            librarySize: pool.length,
        };
    }

    static plays_label(count) {
        return count + (count === 1 ? ' play' : ' plays');
    }

    render_stats(data) {
        const el = document.getElementById('home-stats');
        if (!el) return;
        const sig = JSON.stringify([data.totalPlays, data.uniqueSongs, data.playlistsPlayed, data.topArtist, data.weekPlays]);
        if (sig === this._sig.stats) return;
        this._sig.stats = sig;
        el.innerHTML = '';
        const tiles = [
            { label: 'Total plays', value: String(data.totalPlays), meta: data.weekPlays ? data.weekPlays + ' in the last 7 days' : 'all time' },
            { label: 'Songs', value: String(data.uniqueSongs), meta: 'played at least once' },
            { label: 'Playlists', value: String(data.playlistsPlayed), meta: 'played at least once' },
            { label: 'Top artist', value: data.topArtist ? data.topArtist.name : '-', meta: data.topArtist ? PlaylistHomeViewController.plays_label(data.topArtist.plays) : 'no plays yet' },
        ];
        tiles.forEach((tile) => {
            const card = document.createElement('div');
            card.className = 'home-stat';
            const label = document.createElement('div');
            label.className = 'home-stat-label';
            label.textContent = tile.label;
            const value = document.createElement('div');
            value.className = 'home-stat-value';
            value.textContent = tile.value;
            value.title = tile.value;
            const meta = document.createElement('div');
            meta.className = 'home-stat-meta';
            meta.textContent = tile.meta;
            card.appendChild(label);
            card.appendChild(value);
            card.appendChild(meta);
            el.appendChild(card);
        });
    }

    build_stories(data) {
        if (!data.totalPlays) {
            return [{ kicker: 'Nothing yet', value: 'Press play', meta: 'Your stats fill in as you listen.', empty: true }];
        }
        const stories = [];
        if (data.topArtist) {
            stories.push({
                kicker: 'Top artist',
                value: data.topArtist.name,
                meta: PlaylistHomeViewController.plays_label(data.topArtist.plays),
            });
        }
        const top_song = data.songs[0];
        if (top_song) {
            const artist = String(top_song.track.artist || '').trim();
            stories.push({
                kicker: 'Top song',
                value: top_song.track.title || 'Unknown',
                meta: (artist ? artist + ' - ' : '') + PlaylistHomeViewController.plays_label(top_song.count),
                art: this.track_cover_url(top_song.track),
            });
        }
        const top_playlist = data.playlists[0];
        if (top_playlist) {
            const tiles = (top_playlist.playlist && top_playlist.playlist.cover_tiles) || [];
            stories.push({
                kicker: 'Top playlist',
                value: top_playlist.playlist.name || 'Playlist',
                meta: PlaylistHomeViewController.plays_label(top_playlist.count),
                art: tiles[0] || '',
            });
        }
        stories.push({
            kicker: 'Last 7 days',
            value: String(data.weekPlays),
            meta: data.weekPlays === 1 ? 'play this week' : 'plays this week',
        });
        stories.push({
            kicker: 'Library',
            value: String(data.librarySize),
            meta: data.librarySize === 1 ? 'song ready to play' : 'songs ready to play',
        });
        return stories;
    }

    track_cover_url(track) {
        if (!track) return '';
        const covers = window.SpolocalCoverUrls;
        if (covers) return covers.trackCoverUrl(track.playlist_id, track.track_id, track.youtube_video_id) || '';
        return '/playlists/' + encodeURIComponent(track.playlist_id) + '/tracks/'
            + encodeURIComponent(track.track_id) + '/cover';
    }

    render_stories(data) {
        const track_el = document.getElementById('home-story-track');
        const dots = document.getElementById('home-story-dots');
        if (!track_el) return;
        const stories = this.build_stories(data);
        const sig = JSON.stringify(stories.map((s) => [s.kicker, s.value, s.meta, s.art || '', !!s.empty]));
        if (sig === this._sig.stories) {
            this.bind_story_controls();
            return;
        }
        this._sig.stories = sig;
        this._storyScroll = track_el.scrollLeft;
        track_el.innerHTML = '';
        if (dots) dots.innerHTML = '';
        stories.forEach((story, index) => {
            const card = document.createElement('article');
            card.className = 'home-story-card' + (story.empty ? ' home-story-card--empty' : '');
            if (story.art) {
                const art = document.createElement('div');
                art.className = 'home-story-art';
                const img = document.createElement('img');
                img.src = story.art;
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.onerror = function () {
                    this.onerror = null;
                    this.style.opacity = '0';
                };
                art.appendChild(img);
                card.appendChild(art);
            }
            const kicker = document.createElement('div');
            kicker.className = 'home-story-kicker';
            kicker.textContent = story.kicker;
            const value = document.createElement('div');
            value.className = 'home-story-value';
            value.textContent = story.value;
            const meta = document.createElement('div');
            meta.className = 'home-story-meta';
            meta.textContent = story.meta;
            card.appendChild(kicker);
            card.appendChild(value);
            card.appendChild(meta);
            track_el.appendChild(card);

            if (dots) {
                const dot = document.createElement('button');
                dot.type = 'button';
                dot.className = 'home-story-dot';
                dot.setAttribute('aria-label', 'Highlight ' + (index + 1));
                dot.addEventListener('click', () => this.scroll_to_story(index));
                dots.appendChild(dot);
            }
        });
        this.bind_story_controls();
        requestAnimationFrame(() => {
            track_el.scrollLeft = this._storyScroll;
            this.sync_story_ui();
        });
    }

    story_step() {
        const track_el = document.getElementById('home-story-track');
        const card = track_el && track_el.firstElementChild;
        if (!card) return 0;
        let gap = 0;
        try {
            gap = parseFloat(getComputedStyle(track_el).columnGap) || 0;
        } catch (e) {}
        return card.getBoundingClientRect().width + gap;
    }

    scroll_story(direction) {
        const track_el = document.getElementById('home-story-track');
        const step = this.story_step();
        if (!track_el || !step) return;
        track_el.scrollBy({ left: direction * step, behavior: 'smooth' });
    }

    scroll_to_story(index) {
        const track_el = document.getElementById('home-story-track');
        const step = this.story_step();
        if (!track_el || !step) return;
        track_el.scrollTo({ left: index * step, behavior: 'smooth' });
    }

    bind_story_controls() {
        const track_el = document.getElementById('home-story-track');
        if (!track_el) return;
        if (!track_el.dataset.homeBound) {
            track_el.dataset.homeBound = '1';
            let raf = 0;
            track_el.addEventListener('scroll', () => {
                if (raf) return;
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    this.sync_story_ui();
                });
            }, { passive: true });
            track_el.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    this.scroll_story(1);
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    this.scroll_story(-1);
                }
            });
        }
        const prev = document.getElementById('home-story-prev');
        if (prev && !prev.dataset.homeBound) {
            prev.dataset.homeBound = '1';
            prev.addEventListener('click', () => this.scroll_story(-1));
        }
        const next = document.getElementById('home-story-next');
        if (next && !next.dataset.homeBound) {
            next.dataset.homeBound = '1';
            next.addEventListener('click', () => this.scroll_story(1));
        }
        this.sync_story_ui();
    }

    sync_story_ui() {
        const track_el = document.getElementById('home-story-track');
        if (!track_el) return;
        const dots = document.getElementById('home-story-dots');
        const prev = document.getElementById('home-story-prev');
        const next = document.getElementById('home-story-next');
        const step = this.story_step();
        const index = step ? Math.round(track_el.scrollLeft / step) : 0;
        if (dots) {
            Array.from(dots.children).forEach((dot, i) => {
                dot.classList.toggle('home-story-dot--active', i === index);
            });
        }
        if (prev) prev.disabled = track_el.scrollLeft <= 2;
        if (next) next.disabled = track_el.scrollLeft + track_el.clientWidth >= track_el.scrollWidth - 2;
    }

    render_top_playlists(data) {
        const container = document.getElementById('home-top-playlists');
        const empty = document.getElementById('home-playlists-empty');
        if (!container) return;
        const ranked = data.playlists.slice(0, 12);
        const sig = JSON.stringify(ranked.map((row) => [row.id, row.count]));
        if (sig === this._sig.playlists) return;
        this._sig.playlists = sig;
        container.innerHTML = '';

        if (!ranked.length) {
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');

        ranked.forEach((row, index) => {
            const pl = row.playlist;
            const card = document.createElement('a');
            card.href = '/?playlist_id=' + encodeURIComponent(row.id);
            card.className = 'playlist-spa-nav group rounded-md bg-[#181818] p-2 hover:bg-[#282828] transition-colors';

            const rank = document.createElement('span');
            rank.className = 'home-rank';
            rank.textContent = '#' + (index + 1);
            card.appendChild(rank);

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
            meta.textContent = PlaylistHomeViewController.plays_label(row.count);
            card.appendChild(meta);
            container.appendChild(card);
        });
    }

    render_top_songs(data) {
        const container = document.getElementById('home-top-songs');
        const empty = document.getElementById('home-songs-empty');
        if (!container) return;
        const ranked = data.songs.slice(0, 12);
        const sig = JSON.stringify(ranked.map((row) => [row.key, row.count]));
        if (sig === this._sig.songs) return;
        this._sig.songs = sig;
        container.innerHTML = '';

        if (!ranked.length) {
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');

        const max_count = ranked[0].count || 1;
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
            img.src = this.track_cover_url(t);
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
            const bar = document.createElement('div');
            bar.className = 'home-song-bar';
            const fill = document.createElement('span');
            fill.style.width = Math.max(4, Math.round((row.count / max_count) * 100)) + '%';
            bar.appendChild(fill);
            text.appendChild(title);
            text.appendChild(artist);
            text.appendChild(bar);

            const count = document.createElement('span');
            count.className = 'home-song-count shrink-0';
            count.textContent = PlaylistHomeViewController.plays_label(row.count);

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
            row_el.appendChild(count);
            row_el.appendChild(like_btn);
            container.appendChild(row_el);
        });

        if (this.transport && typeof this.transport.likes.bind_track_row_like_buttons === 'function') {
            this.transport.likes.bind_track_row_like_buttons();
        }
    }
}
