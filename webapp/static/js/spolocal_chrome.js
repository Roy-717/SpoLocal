/*
 * Bootstraps the application chrome.
 * Wires global search overlays, mobile drawers, and event actions.
 */
'use strict';

class SpolocalMobileSheetDrawers {
    mount() {
const body = document.body;
const openNavBtn = document.getElementById('mobile-open-nav');
const closeNavBtn = document.getElementById('mobile-close-nav');
const openDlBtn = document.getElementById('mobile-open-dl');
const closeDlBtn = document.getElementById('mobile-close-dl');
const bdNav = document.getElementById('mobile-nav-backdrop');
const bdDl = document.getElementById('mobile-dl-backdrop');

function closeNav() {
    body.classList.remove('mobile-nav-open');
    if (openNavBtn) openNavBtn.setAttribute('aria-expanded', 'false');
}
function closeDl() {
    body.classList.remove('mobile-dl-open');
    if (openDlBtn) openDlBtn.setAttribute('aria-expanded', 'false');
}
function openNav() {
    closeDl();
    document.body.classList.remove('mobile-queue-open');
    window.dispatchEvent(new CustomEvent('spolocal:force-close-queue'));
    body.classList.add('mobile-nav-open');
    if (openNavBtn) openNavBtn.setAttribute('aria-expanded', 'true');
}
function openDl() {
    closeNav();
    document.body.classList.remove('mobile-queue-open');
    window.dispatchEvent(new CustomEvent('spolocal:force-close-queue'));
    body.classList.add('mobile-dl-open');
    if (openDlBtn) openDlBtn.setAttribute('aria-expanded', 'true');
}

if (openNavBtn) {
    openNavBtn.addEventListener('click', function () {
        if (body.classList.contains('mobile-nav-open')) closeNav();
        else openNav();
    });
}
if (closeNavBtn) closeNavBtn.addEventListener('click', closeNav);
if (bdNav) bdNav.addEventListener('click', closeNav);

if (openDlBtn) {
    openDlBtn.addEventListener('click', function () {
        if (body.classList.contains('mobile-dl-open')) closeDl();
        else openDl();
    });
}
if (closeDlBtn) closeDlBtn.addEventListener('click', closeDl);
if (bdDl) bdDl.addEventListener('click', closeDl);

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeNav();
    closeDl();
    window.dispatchEvent(new CustomEvent('spolocal:force-close-queue'));
});

document.addEventListener('click', function (e) {
    const a = e.target.closest && e.target.closest('a.playlist-spa-nav');
    if (!a) return;
    closeNav();
}, true);
    }
}

(async function spolocalChromeBoot() {
    new SpolocalMobileSheetDrawers().mount();
    let playlistsCatalog = [];


    function fmtDur(sec) {
        if (sec == null || !isFinite(sec)) return '';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m + ':' + String(s).padStart(2, '0');
    }

    function buildPlaylistArtGridEl(tiles) {
        const wrap = document.createElement('div');
        wrap.className = 'grid h-8 w-8 shrink-0 overflow-hidden rounded bg-[#1a1a1a] grid-cols-2';
        wrap.style.gridTemplateRows = 'repeat(2, minmax(0, 1fr))';
        wrap.style.gap = '1px';
        const arr = tiles || [];
        for (let i = 0; i < 4; i++) {
            if (i < arr.length && arr[i]) {
                const cell = document.createElement('div');
                cell.className = 'playlist-art-grid__cell h-full w-full bg-[#282828]';
                const img = document.createElement('img');
                img.src = arr[i];
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.onerror = function () {
                    this.onerror = null;
                    this.style.opacity = '0';
                };
                cell.appendChild(img);
                wrap.appendChild(cell);
            } else {
                const ph = document.createElement('div');
                ph.className = 'h-full w-full min-h-0 min-w-0 bg-[#282828]';
                ph.setAttribute('aria-hidden', 'true');
                wrap.appendChild(ph);
            }
        }
        return wrap;
    }

    const topForm = document.getElementById('top-import-form');
    const topInput = document.getElementById('top-import-input');
    const gPanel = document.getElementById('global-search-panel');
    const gLabel = document.getElementById('global-search-label');
    const gMsg = document.getElementById('global-search-msg');
    const gList = document.getElementById('global-search-list');
    const gPager = document.getElementById('global-search-pager');
    const gPrevBtn = document.getElementById('global-prev-btn');
    const gNextBtn = document.getElementById('global-next-btn');
    const gPageLabel = document.getElementById('global-page-label');
    const gClose = document.getElementById('global-search-close');
    const previewAudio = document.getElementById('song-preview-audio');
    const streamBadge = document.getElementById('player-stream-badge');

    const atpPop = document.getElementById('add-to-playlist-popover');
    const atpFilter = document.getElementById('atp-filter');
    const atpListInner = document.getElementById('atp-list-inner');
    const atpNewToggle = document.getElementById('atp-new-toggle');
    const atpNewRow = document.getElementById('atp-new-row');

    const PAGE_SIZE = 6;
    let searchHits = [];
    let searchOffset = 0;
    let searchHasMore = false;
    let currentSearchQuery = '';
    let activePreviewVid = null;
    let previewTimer = null;
    let pendingAddHit = null;
    let lastAtpAnchor = null;
    let atpGhostAnchor = null;

    function isUrl(s) {
        return /^https?:\/\//i.test(s) || /^spotify:/i.test(s);
    }

    function addHidden(form, name, value) {
        const inp = document.createElement('input');
        inp.type = 'hidden'; inp.name = name; inp.value = value;
        form.appendChild(inp);
    }

    function stopPreview() {
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.removeAttribute('src');
            previewAudio.load();
        }
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        activePreviewVid = null;
        document.querySelectorAll('.preview-btn').forEach(b => {
            b.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
            b.classList.remove('ring-2', 'ring-white', 'scale-105');
        });
    }

    function playPreview(hit, btn) {
        const vid = hit && typeof hit === 'object' ? (hit.video_id || '') : String(hit || '');
        if (!vid) return;
        if (activePreviewVid === vid) { stopPreview(); return; }
        stopPreview();
        activePreviewVid = vid;
        btn.innerHTML = '<i class="fa-solid fa-stop text-black text-[10px]"></i>';
        btn.classList.add('ring-2', 'ring-white', 'scale-105');
        // Use the main player directly
        const hub = window.SpolocalPlayerHub;
        if (hub && hub.audio && hub.audio.src) {
            hub.audio.src = (hit && typeof hit === 'object' && hit.preview_url) ? hit.preview_url : ('/api/preview?vid=' + encodeURIComponent(vid));
            hub.audio.load();
            hub.audio.play().catch(err => {
                hub.audio.pause();
                hub.titleEl && (hub.titleEl.textContent = hit.title || '');
                hub.subEl && (hub.subEl.textContent = hit.artist || '');
            });
            previewTimer = setTimeout(stopPreview, 30000);
            // Update player UI
            hub.currentTrackId = vid;
            hub.titleEl && (hub.titleEl.textContent = hit.title || '');
            hub.subEl && (hub.subEl.textContent = (hit.artist || hit.channel || ''));
            // Show stream indicator
            const streamBadge = hub.streamBadgeEl;
            if (streamBadge) {
                streamBadge.classList.remove('hidden');
                streamBadge.textContent = 'Ⓢ';
                streamBadge.title = 'Stream';
            }
            if (hub.queueVisible && hub.queue) hub.queue.render_queue_list();
            return;
        }
        // Fallback to playPreview via playTrackById
        const fallbackHub = window.SpolocalPlayerHub;
        if (fallbackHub && fallbackHub.playTrackById) {
            fallbackHub.playTrackById(vid);
            stopPreview = function() {
                if (previewAudio) {
                    previewAudio.pause();
                    previewAudio.removeAttribute('src');
                    previewAudio.load();
                }
                if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
                activePreviewVid = null;
                document.querySelectorAll('.preview-btn').forEach(b => {
                    b.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
                    b.classList.remove('ring-2', 'ring-white', 'scale-105');
                });
            };
            previewTimer = setTimeout(stopPreview, 30000);
        } else {
            // Original fallback
            if (hit && typeof hit === 'object' && hit.preview_url) {
                previewAudio.src = hit.preview_url;
            } else {
                previewAudio.src = '/api/preview?vid=' + encodeURIComponent(vid);
            }
            previewAudio.load();
            previewAudio.play().catch(() => {});
            previewTimer = setTimeout(stopPreview, 30000);
        }
    }

    if (previewAudio) {
        previewAudio.addEventListener('ended', stopPreview);
        previewAudio.addEventListener('error', stopPreview);
    }

    function closeAddToPlaylistPopover() {
        pendingAddHit = null;
        lastAtpAnchor = null;
        if (atpGhostAnchor && atpGhostAnchor.parentNode) {
            atpGhostAnchor.parentNode.removeChild(atpGhostAnchor);
        }
        atpGhostAnchor = null;
        if (atpPop) atpPop.classList.add('hidden');
        if (atpNewRow) atpNewRow.classList.add('hidden');
        if (atpFilter) atpFilter.value = '';
    }

    function closeGlobalSearch() {
        closeAddToPlaylistPopover();
        stopPreview();
        if (gPanel) gPanel.classList.add('hidden');
    }

    function positionAddPopover(anchor) {
        if (!atpPop || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        const popW = 280;
        let left = rect.left;
        let top = rect.bottom + 6;
        if (left + popW > window.innerWidth - margin) {
            left = window.innerWidth - popW - margin;
        }
        if (left < margin) left = margin;
        const estH = Math.min(420, window.innerHeight * 0.72);
        if (top + estH > window.innerHeight - margin) {
            top = rect.top - estH - 6;
        }
        if (top < margin) top = margin;
        atpPop.style.left = left + 'px';
        atpPop.style.top = top + 'px';
    }

    function renderAtpList() {
        if (!atpListInner) return;
        atpListInner.innerHTML = '';
        const q = (atpFilter && atpFilter.value ? atpFilter.value : '').trim().toLowerCase();
        const filtered = playlistsCatalog.filter(function (pl) {
            if (pl.system_locked) return false;
            return !q || (pl.name && pl.name.toLowerCase().indexOf(q) !== -1);
        });

        if (!filtered.length) {
            const empty = document.createElement('p');
            empty.className = 'px-3 py-4 text-center text-xs text-[#727272]';
            empty.textContent = playlistsCatalog.length ? 'No matching playlists.' : 'No playlists yet — use New playlist above.';
            atpListInner.appendChild(empty);
            return;
        }
        filtered.forEach(function (pl) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-white hover:bg-[#3e3e3e]';
            btn.appendChild(buildPlaylistArtGridEl(pl.cover_tiles));
            const span = document.createElement('span');
            span.className = 'min-w-0 truncate';
            span.textContent = pl.name || '';
            btn.appendChild(span);
            btn.addEventListener('click', function () {
                if (!pendingAddHit) return;
                const f = document.createElement('form');
                f.method = 'post';
                f.action = '/playlists/' + encodeURIComponent(pl.id) + '/tracks';
                f.style.display = 'none';
                addHidden(f, 'title', pendingAddHit.title || '');
                addHidden(f, 'artist', pendingAddHit.artist || pendingAddHit.channel || '');
                addHidden(f, 'url', pendingAddHit.url || '');
                addHidden(f, 'album', pendingAddHit.album || '');
                document.body.appendChild(f);
                closeAddToPlaylistPopover();
                f.submit();
            });
            atpListInner.appendChild(btn);
        });
    }

    function openAddToPlaylistPopover(hit, anchor) {
        pendingAddHit = hit;
        lastAtpAnchor = anchor;
        if (atpNewRow) atpNewRow.classList.add('hidden');
        if (atpFilter) atpFilter.value = '';
        renderAtpList();
        if (atpPop) {
            atpPop.classList.remove('hidden');
            positionAddPopover(anchor);
        }
        if (atpFilter) {
            setTimeout(function () { atpFilter.focus(); }, 50);
        }
    }

    function openAddToPlaylistAtPoint(hit, clientX, clientY) {
        if (typeof window.closeContextMenu === 'function') {
            window.closeContextMenu();
        }
        closeAddToPlaylistPopover();
        const ghost = document.createElement('button');
        ghost.type = 'button';
        ghost.className = 'open-add-to-playlist';
        ghost.setAttribute('aria-hidden', 'true');
        ghost.style.cssText = 'position:fixed;left:' + clientX + 'px;top:' + clientY + 'px;width:1px;height:1px;padding:0;margin:0;border:0;opacity:0;pointer-events:none;z-index:10000;';
        document.body.appendChild(ghost);
        atpGhostAnchor = ghost;
        openAddToPlaylistPopover(hit, ghost);
    }
    try { window.openAddToPlaylistAtPoint = openAddToPlaylistAtPoint; } catch (e) {}

    try {
        const cr = await fetch('/api/playlists/catalog');
        if (cr.ok) {
            const data = await cr.json();
            if (Array.isArray(data)) playlistsCatalog = data;
        }
    } catch (e) { playlistsCatalog = []; }
    window.__playlistsCatalog = playlistsCatalog;

    if (atpNewToggle && atpNewRow) {
        atpNewToggle.addEventListener('click', function () {
            atpNewRow.classList.toggle('hidden');
        });
    }

    if (atpFilter) {
        atpFilter.addEventListener('input', renderAtpList);
    }

    document.addEventListener('click', function (e) {
        if (!atpPop || atpPop.classList.contains('hidden')) return;
        if (atpPop.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.open-add-to-playlist')) return;
        closeAddToPlaylistPopover();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (atpPop && !atpPop.classList.contains('hidden')) {
            closeAddToPlaylistPopover();
            e.preventDefault();
            return;
        }
        if (gPanel && !gPanel.classList.contains('hidden')) {
            closeGlobalSearch();
            e.preventDefault();
        }
    });

    window.addEventListener('resize', function () {
        if (atpPop && !atpPop.classList.contains('hidden') && lastAtpAnchor) {
            positionAddPopover(lastAtpAnchor);
        }
    });

    if (gClose) gClose.addEventListener('click', closeGlobalSearch);

    function buildYoutubeHitCard(hit) {
        const card = document.createElement('div');
        card.className = 'group w-full max-w-[140px] mx-auto rounded-md bg-[#181818] p-2 pb-2 transition-colors hover:bg-[#282828]';
    
        const artWrap = document.createElement('div');
        artWrap.className = 'relative aspect-square w-full overflow-hidden rounded-md shadow-lg bg-[#282828]';

        const img = document.createElement('img');
        img.alt = hit.title || '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.className = 'h-full w-full object-cover';
        const vid = hit.video_id || '';
        img.src = vid
            ? ('https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/default.jpg')
            : (hit.thumbnail_url || '');
        img.addEventListener('error', function () {
            this.onerror = null;
            if (vid) {
                this.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(vid) + '/mqdefault.jpg';
            }
        });
        artWrap.appendChild(img);

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'preview-btn absolute bottom-2 right-2 flex h-12 w-12 items-center justify-center rounded-full bg-[#1DB954] text-black shadow-lg transition-all duration-200 hover:scale-105 max-lg:opacity-100 lg:opacity-0 lg:translate-y-1 lg:group-hover:opacity-100 lg:group-hover:translate-y-0 lg:focus:opacity-100 lg:focus:translate-y-0 focus:outline-none';
        playBtn.title = 'Preview (~30 s)';
        playBtn.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
        if (!hit.video_id) {
            playBtn.classList.add('hidden');
        }
        playBtn.addEventListener('click', function (ev) { ev.stopPropagation(); playPreview(hit, playBtn); });
        artWrap.appendChild(playBtn);
        card.appendChild(artWrap);

        const textWrap = document.createElement('div');
        textWrap.className = 'mt-3 min-w-0 px-0.5';
        const titleEl = document.createElement('div');
        titleEl.className = 'truncate text-sm font-semibold leading-tight text-white';
        titleEl.textContent = hit.title || '';
        textWrap.appendChild(titleEl);
        // Time in its own row
        const timeRow = document.createElement('div');
        timeRow.className = 'mt-1 flex items-center gap-2';
        const metaEl = document.createElement('div');
        metaEl.className = 'truncate text-sm text-[#B3B3B3]';
        let meta = (hit.year ? hit.year + ' • ' : '') + (hit.artist || hit.channel || '');
        metaEl.textContent = meta || '—';
        const timeEl = document.createElement('div');
        timeEl.className = 'text-xs text-[#727272] tabular-nums';
        timeEl.textContent = fmtDur(hit.duration_sec || 0);
        timeRow.appendChild(metaEl);
        timeRow.appendChild(timeEl);
        textWrap.appendChild(timeRow);
        card.appendChild(textWrap);

        const addRow = document.createElement('div');
        addRow.className = 'mt-3 px-0.5';
        const badge = document.createElement('span');
        badge.id = 'player-stream-badge';
        badge.className = 'hidden text-[10px] sm:text-xs shrink-0 w-3.5 sm:w-4 text-center';
        badge.style.color = '#1DB954';
        badge.style.marginLeft = '4px';
        badge.style.marginRight = '4px';
        badge.textContent = 'Ⓢ';
        const bAdd = document.createElement('button');
        bAdd.type = 'button';
        bAdd.className = 'open-add-to-playlist w-full rounded-full bg-transparent py-1.5 text-center text-xs font-semibold text-[#B3B3B3] ring-1 ring-[#3E3E3E] transition hover:bg-[#1DB954] hover:text-black hover:ring-[#1DB954]';
        bAdd.textContent = 'Add to playlist';
        bAdd.addEventListener('click', function (ev) {
            ev.stopPropagation();
            ev.preventDefault();
            openAddToPlaylistPopover(hit, bAdd);
        });
        addRow.appendChild(badge);
        addRow.appendChild(bAdd);
        card.appendChild(addRow);

        return card;
    }

    function renderYoutubeHitsIntoContainer(container, hits, gridClassName) {
        if (!container) return;
        container.innerHTML = '';
        if (!hits || !hits.length) return;
        const grid = document.createElement('div');
        grid.className = gridClassName || 'grid grid-cols-3 gap-x-3 gap-y-4 w-full pb-2';
        hits.forEach(function (hit) {
            grid.appendChild(buildYoutubeHitCard(hit));
        });
        container.appendChild(grid);
    }

    /** @type {IntersectionObserver|null} */
    let playlistRecommendationsObserver = null;

    function disconnectPlaylistRecommendationsObserver() {
        if (playlistRecommendationsObserver) {
            playlistRecommendationsObserver.disconnect();
            playlistRecommendationsObserver = null;
        }
    }

    /** Scroll container for the playlist track list + recommendations (never the window). */
    function findPlaylistScrollRoot(el) {
        const byId = document.getElementById('playlist-scroll-root');
        if (byId && el && byId.contains(el)) return byId;
        let p = el.parentElement;
        while (p && p !== document.documentElement) {
            try {
                const cs = window.getComputedStyle(p);
                const oy = cs.overflowY;
                if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
                    return p;
                }
            } catch (e) { /* ignore */ }
            p = p.parentElement;
        }
        return null;
    }

    async function fetchPlaylistRecommendationsWhenVisible(pid) {
        const grid = document.getElementById('playlist-recommendations-grid');
        const msg = document.getElementById('playlist-recommendations-msg');
        stopPreview();
        if (!grid || !pid) return;
        grid.innerHTML = '';
        if (msg) {
            msg.textContent = 'Loading recommendations…';
            msg.classList.remove('hidden');
        }
        try {
            const r = await fetch('/api/playlist/recommendations?playlist_id=' + encodeURIComponent(pid) + '&limit=12');
            if (String(pid) !== String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '')) {
                return;
            }
            if (!r.ok) {
                if (msg) {
                    msg.textContent = 'Could not load recommendations.';
                    msg.classList.remove('hidden');
                }
                return;
            }
            const hits = await r.json();
            if (String(pid) !== String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '')) {
                return;
            }
            if (!hits.length) {
                if (msg) {
                    msg.textContent = 'No recommendations right now. Try search above or add more tracks.';
                    msg.classList.remove('hidden');
                }
                return;
            }
            if (msg) msg.classList.add('hidden');
            renderYoutubeHitsIntoContainer(grid, hits, 'grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-6 w-full pb-2');
        } catch (e) {
            if (String(pid) !== String(typeof window.__spaPlaylistId === 'string' ? window.__spaPlaylistId : '')) {
                return;
            }
            if (msg) {
                msg.textContent = 'Could not load recommendations (network).';
                msg.classList.remove('hidden');
            }
        }
    }

    /**
     * Defer /api/playlist/recommendations until the "Recommended for you" block nears the visible area
     * (playlist pane scroll or viewport).
     */
    function loadPlaylistRecommendations(pid) {
        disconnectPlaylistRecommendationsObserver();
        const section = document.getElementById('playlist-recommendations-section');
        const grid = document.getElementById('playlist-recommendations-grid');
        const msg = document.getElementById('playlist-recommendations-msg');
        stopPreview();
        if (!section || !grid || !pid) return;
        grid.innerHTML = '';
        if (msg) {
            msg.textContent = '';
            msg.classList.add('hidden');
        }
        let layoutTries = 0;
        function attachObserver() {
            const scrollRoot = findPlaylistScrollRoot(section);
            if (!scrollRoot) {
                if (layoutTries++ < 10) {
                    requestAnimationFrame(attachObserver);
                }
                return;
            }
            const obs = new IntersectionObserver(
                function (entries) {
                    for (let i = 0; i < entries.length; i++) {
                        if (!entries[i].isIntersecting) continue;
                        disconnectPlaylistRecommendationsObserver();
                        void fetchPlaylistRecommendationsWhenVisible(pid);
                        return;
                    }
                },
                {
                    root: scrollRoot,
                    rootMargin: '0px',
                    threshold: 0.01,
                }
            );
            playlistRecommendationsObserver = obs;
            obs.observe(section);
        }
        // Wait until flex layout has sized #playlist-scroll-root; otherwise IO falls back to
        // viewport and fires while recommendations are still below the inner scroll fold.
        requestAnimationFrame(function () {
            requestAnimationFrame(attachObserver);
        });
    }

    window.loadPlaylistRecommendations = loadPlaylistRecommendations;

    function renderPage() {
        if (!gList) return;
        gList.innerHTML = '';
        const page = Math.floor(searchOffset / PAGE_SIZE);

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-3 gap-x-3 gap-y-4 w-full pb-2';

        searchHits.forEach(function (hit) {
            grid.appendChild(buildYoutubeHitCard(hit));
        });

        gList.appendChild(grid);

        if (gPageLabel) gPageLabel.textContent = 'Page ' + (page + 1);
        if (gPrevBtn) gPrevBtn.disabled = searchOffset === 0;
        if (gNextBtn) gNextBtn.disabled = !searchHasMore;
        if (gPager) {
            if (!searchHasMore && searchOffset === 0) gPager.classList.add('hidden');
            else gPager.classList.remove('hidden');
        }
        gList.scrollTop = 0;
    }

    if (gPrevBtn) gPrevBtn.addEventListener('click', function () {
        if (searchOffset === 0) return;
        searchOffset = Math.max(0, searchOffset - PAGE_SIZE);
        stopPreview();
        runGlobalSearch(currentSearchQuery, searchOffset);
    });
    if (gNextBtn) gNextBtn.addEventListener('click', function () {
        if (!searchHasMore) return;
        searchOffset += PAGE_SIZE;
        stopPreview();
        runGlobalSearch(currentSearchQuery, searchOffset);
    });

    async function runGlobalSearch(q, offset = 0) {
        if (!gPanel || !gList) return;
        closeAddToPlaylistPopover();
        stopPreview();
        currentSearchQuery = (q || '').trim();
        searchOffset = Math.max(0, Number(offset) || 0);
        searchHits = [];
        searchHasMore = false;
        gPanel.classList.remove('hidden');
        if (gLabel) gLabel.textContent = 'Results for "' + q + '"';
        if (gMsg) { gMsg.textContent = 'Searching…'; gMsg.classList.remove('hidden'); }
        gList.innerHTML = '';
        if (gPager) gPager.classList.add('hidden');
        try {
            const r = await fetch('/api/search/songs?q=' + encodeURIComponent(q) + '&limit=' + PAGE_SIZE + '&offset=' + searchOffset);
            if (!r.ok) {
                const err = await r.json().catch(function () { return {}; });
                if (gMsg) { gMsg.textContent = typeof err.detail === 'string' ? err.detail : 'Search failed'; }
                return;
            }
            const payload = await r.json();
            const hits = Array.isArray(payload) ? payload : (payload.hits || []);
            if (!Array.isArray(payload)) {
                searchHasMore = Boolean(payload.has_more);
            }
            if (gMsg) gMsg.classList.add('hidden');
            if (!hits.length) {
                if (gMsg) { gMsg.textContent = 'No results.'; gMsg.classList.remove('hidden'); }
                if (gPager) gPager.classList.add('hidden');
                return;
            }
            searchHits = hits;
            renderPage();
        } catch (e) {
            if (gMsg) { gMsg.textContent = 'Search failed (network).'; gMsg.classList.remove('hidden'); }
        }
    }

    if (topForm) {
        topForm.addEventListener('submit', function (e) {
            const val = topInput ? topInput.value.trim() : '';
            if (!val) {
                e.preventDefault();
                if (topInput) topInput.focus();
                if (gMsg) {
                    gMsg.textContent = 'Type a search term or paste a link to import.';
                    gMsg.classList.remove('hidden');
                }
                if (gPanel) {
                    gPanel.classList.remove('hidden');
                }
                if (gLabel) {
                    gLabel.textContent = 'Search';
                }
                return;
            }
            if (!isUrl(val)) {
                e.preventDefault();
                runGlobalSearch(val);
            }
        });
    }

    if (typeof window.__spaPlaylistId === 'string' && window.__spaPlaylistId
            && document.getElementById('playlist-recommendations-grid')) {
        loadPlaylistRecommendations(window.__spaPlaylistId);
    }
})();
