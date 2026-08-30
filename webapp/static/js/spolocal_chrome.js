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
    const a = e.target.closest && e.target.closest('a.playlist-spa-nav, a.home-spa-nav');
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

    function withCoverCacheBust(url, bust) {
        if (!url) return url;
        const base = String(url).split('?')[0];
        return base + '?v=' + (bust != null ? bust : Date.now());
    }

    function buildPlaylistArtGridEl(tiles, sizeClass, bust) {
        const sz = sizeClass || 'h-8 w-8';
        const cacheBust = bust != null ? bust : Date.now();
        const wrap = document.createElement('div');
        wrap.className = 'grid ' + sz + ' shrink-0 overflow-hidden rounded bg-[#1a1a1a] grid-cols-2';
        wrap.style.gridTemplateRows = 'repeat(2, minmax(0, 1fr))';
        wrap.style.gap = '1px';
        const arr = tiles || [];
        for (let i = 0; i < 4; i++) {
            if (i < arr.length && arr[i]) {
                const cell = document.createElement('div');
                cell.className = 'playlist-art-grid__cell h-full w-full bg-[#282828]';
                const img = document.createElement('img');
                img.src = withCoverCacheBust(arr[i], cacheBust);
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

    const atpPop = document.getElementById('add-to-playlist-popover');
    const atpFilter = document.getElementById('atp-filter');
    const atpListInner = document.getElementById('atp-list-inner');
    const atpNewToggle = document.getElementById('atp-new-toggle');
    const atpNewRow = document.getElementById('atp-new-row');
    const atpNewForm = document.getElementById('atp-new-form');
    const atpNewName = document.getElementById('atp-new-name');
    const atpDownloadTiers = document.getElementById('atp-download-tiers');
    const atpDownloadValue = document.getElementById('atp-download-kbps-value');

    function syncAtpQualityUi() {
        const prefs = window.SpolocalQualityPrefs;
        if (!prefs) return;
        const v = prefs.downloadKbps();
        prefs.syncTierGroup(atpDownloadTiers, v);
        if (atpDownloadValue) atpDownloadValue.textContent = prefs.formatLabel(v);
    }

    if (window.SpolocalQualityPrefs && atpDownloadTiers) {
        window.SpolocalQualityPrefs.bindTierGroup(
            atpDownloadTiers,
            () => window.SpolocalQualityPrefs.downloadKbps(),
            (v) => window.SpolocalQualityPrefs.setDownloadKbps(v),
            () => syncAtpQualityUi(),
        );
    }
    syncAtpQualityUi();

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

    async function reloadPlaylistsCatalog() {
        try {
            const cr = await fetch('/api/playlists/catalog');
            if (!cr.ok) return;
            const data = await cr.json();
            if (Array.isArray(data)) {
                playlistsCatalog = data;
                window.__playlistsCatalog = data;
            }
        } catch (e) {}
    }

    function renderSidebarPlaylistList(activePlaylistId, bust) {
        const list = document.getElementById('sidebar-playlist-list');
        if (!list) return;
        const activeId = (activePlaylistId || '').trim();
        const cacheBust = bust != null ? bust : Date.now();
        list.innerHTML = '';
        playlistsCatalog.forEach(function (pl) {
            const isActive = !!activeId && pl.id === activeId;
            const card = document.createElement('div');
            card.className = 'group playlist-card rounded-md text-sm' + (isActive ? ' nav-active' : '');
            card.dataset.playlistId = pl.id;
            card.dataset.playlistName = pl.name || '';
            const a = document.createElement('a');
            a.href = '/?playlist_id=' + encodeURIComponent(pl.id);
            a.className = 'playlist-spa-nav flex w-full min-w-0 items-center gap-x-3 px-3 py-2 rounded-md' + (isActive ? '' : ' hover:bg-[#282828]');
            const artWrap = document.createElement('div');
            artWrap.className = 'h-10 w-10 shrink-0 overflow-hidden rounded bg-[#1a1a1a]';
            artWrap.appendChild(buildPlaylistArtGridEl(pl.cover_tiles, 'h-full w-full', cacheBust));
            a.appendChild(artWrap);
            const span = document.createElement('span');
            span.className = 'truncate';
            span.textContent = pl.name || '';
            a.appendChild(span);
            card.appendChild(a);
            list.appendChild(card);
        });
    }

    async function afterTrackAddedToPlaylist(plId) {
        await reloadPlaylistsCatalog();
        renderSidebarPlaylistList(plId);
        const cur = window.__spaPlaylistId || new URL(location.href).searchParams.get('playlist_id') || '';
        if (cur === plId) {
            try {
                const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(plId));
                if (r.ok && typeof window.applySpaPlaylist === 'function') {
                    window.applySpaPlaylist(await r.json());
                }
            } catch (e) {}
            return;
        }
        if (typeof window.navigatePlaylist === 'function') {
            await window.navigatePlaylist(plId, true);
            return;
        }
        try {
            const r = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(plId));
            if (!r.ok) return;
            const data = await r.json();
            if (typeof window.applySpaPlaylist === 'function') {
                window.applySpaPlaylist(data);
            }
        } catch (e) {}
    }

    async function parseJsonApiResponse(r, fallbackMsg) {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('application/json')) {
            if (!r.ok) throw new Error(fallbackMsg || 'Request failed.');
            return { ok: true };
        }
        const data = await r.json();
        if (!r.ok) {
            const msg = (data && data.detail) ? String(data.detail) : (fallbackMsg || 'Request failed.');
            throw new Error(msg);
        }
        return data;
    }

    async function addTrackToPlaylist(plId, hit) {
        const fd = new FormData();
        fd.append('title', hit.title || '');
        fd.append('artist', hit.artist || hit.channel || '');
        fd.append('url', hit.url || '');
        fd.append('album', hit.album || '');
        const q = window.SpolocalQualityPrefs ? String(window.SpolocalQualityPrefs.downloadKbps()) : '192';
        fd.append('quality', q);
        const r = await fetch('/playlists/' + encodeURIComponent(plId) + '/tracks', {
            method: 'POST',
            body: fd,
            headers: { Accept: 'application/json' },
        });
        const data = await parseJsonApiResponse(r, 'Could not add track.');
        await afterTrackAddedToPlaylist(plId);
        return data;
    }

    async function createPlaylistFromAtp(name) {
        const r = await fetch('/api/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ name: name }),
        });
        return parseJsonApiResponse(r, 'Could not create playlist.');
    }

    function reset_search_card_buttons() {
        activePreviewVid = null;
        document.querySelectorAll('.preview-btn').forEach(b => {
            b.innerHTML = '<i class="fa-solid fa-play text-black text-sm pl-0.5"></i>';
            b.classList.remove('ring-2', 'ring-white', 'scale-105');
        });
    }
    window.resetSpolocalSearchCards = reset_search_card_buttons;

    function stopPreview(opts) {
        const restore_library = !opts || opts.restore_library !== false;
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.removeAttribute('src');
            previewAudio.load();
        }
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        reset_search_card_buttons();
        const hub = window.SpolocalPlayerHub;
        if (hub && hub.searchStreamActive) {
            if (!restore_library) {
                if (hub.audio) hub.audio.pause();
            } else {
                hub.searchStreamActive = false;
                hub.searchStreamHit = null;
                if (hub.audio) {
                    hub.audio.pause();
                    hub.audio.removeAttribute('src');
                    hub.audio.load();
                }
                if (hub.currentTrackId && hub.titleEl) {
                    let t = (hub.tracks || []).find((x) => x.id === hub.currentTrackId);
                    if (!t && hub.playingTracks) {
                        t = hub.playingTracks.find((x) => x.id === hub.currentTrackId);
                    }
                    if (t) {
                        hub.titleEl.textContent = t.title || '';
                        if (hub.subEl) hub.subEl.textContent = t.artist || '';
                        const prefs = window.SpolocalQualityPrefs;
                        const src = prefs ? prefs.resolvePlaySrc(t) : t.play_src;
                        if (src && hub.audio) {
                            hub.audio.src = src;
                        }
                    }
                }
            }
        }
        if (hub && typeof hub.setPlayUi === 'function') {
            hub.setPlayUi(!!(hub.audio && !hub.audio.paused));
        }
        if (restore_library && hub && hub.lyricsVisible && hub.lyricsController) {
            hub.lyricsController.fetchLyrics(true);
        }
    }

    function streamSrcForVideoId(vid) {
        return '/api/stream?vid=' + encodeURIComponent(vid);
    }
    window.spolocalStreamSrc = streamSrcForVideoId;

    function playPreview(hit, btn) {
        const vid = hit && typeof hit === 'object' ? (hit.video_id || '') : String(hit || '');
        if (!vid) return;
        if (activePreviewVid === vid) { stopPreview(); return; }
        const hub = window.SpolocalPlayerHub;
        stopPreview({ restore_library: false });
        reset_search_card_buttons();
        activePreviewVid = vid;
        btn.innerHTML = '<i class="fa-solid fa-stop text-black text-[10px]"></i>';
        btn.classList.add('ring-2', 'ring-white', 'scale-105');
        if (hub && hub.audio) {
            hub.searchStreamActive = true;
            hub.searchStreamHit = hit;
            hub._mediaDecodeRetries = 0;
            hub.audio.pause();
            const stream_src = streamSrcForVideoId(vid);
            hub.audio.removeAttribute('src');
            hub.audio.load();
            hub.audio.src = stream_src;
            hub.titleEl && (hub.titleEl.textContent = hit.title || '');
            hub.subEl && (hub.subEl.textContent = (hit.artist || hit.channel || ''));
            hub.audio.play().catch((err) => {
                if (err && err.name === 'AbortError') return;
                if (typeof hub.setPlayUi === 'function') hub.setPlayUi(false);
            });
            if (typeof hub.setPlayUi === 'function') hub.setPlayUi(true);
            if (hub.queueVisible && hub.queue) hub.queue.render_queue_list();
            if (hub.lyricsVisible && hub.lyricsController) hub.lyricsController.fetchLyrics(true);
            return;
        }
        if (previewAudio) {
            previewAudio.src = streamSrcForVideoId(vid);
            previewAudio.load();
            previewAudio.play().catch(() => {});
        }
    }

    if (previewAudio) {
        previewAudio.addEventListener('ended', stopPreview);
        previewAudio.addEventListener('error', stopPreview);
    }
    window.stopSearchStream = stopPreview;

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
            btn.addEventListener('click', async function () {
                if (!pendingAddHit) return;
                const hit = pendingAddHit;
                btn.disabled = true;
                try {
                    await addTrackToPlaylist(pl.id, hit);
                    closeAddToPlaylistPopover();
                } catch (e) {
                    alert(e && e.message ? e.message : 'Could not add track.');
                } finally {
                    btn.disabled = false;
                }
            });
            atpListInner.appendChild(btn);
        });
    }

    function openAddToPlaylistPopover(hit, anchor) {
        pendingAddHit = hit;
        lastAtpAnchor = anchor;
        syncAtpQualityUi();
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
        await reloadPlaylistsCatalog();
    } catch (e) { playlistsCatalog = []; }
    window.__playlistsCatalog = playlistsCatalog;
    if (typeof window.refreshHomeView === 'function') window.refreshHomeView();

    if (atpNewToggle && atpNewRow) {
        atpNewToggle.addEventListener('click', function () {
            atpNewRow.classList.toggle('hidden');
        });
    }

    if (atpNewForm) {
        atpNewForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const name = (atpNewName && atpNewName.value ? atpNewName.value : '').trim();
            if (!name) return;
            const submitBtn = atpNewForm.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.disabled = true;
            try {
                const created = await createPlaylistFromAtp(name);
                const plId = created && created.playlist && created.playlist.id;
                if (!plId) throw new Error('Could not create playlist.');
                if (pendingAddHit) {
                    await addTrackToPlaylist(plId, pendingAddHit);
                    closeAddToPlaylistPopover();
                } else {
                    await reloadPlaylistsCatalog();
                    renderSidebarPlaylistList(plId);
                    if (typeof window.navigatePlaylist === 'function') {
                        await window.navigatePlaylist(plId, true);
                    }
                    if (atpNewName) atpNewName.value = '';
                    if (atpNewRow) atpNewRow.classList.add('hidden');
                    renderAtpList();
                }
            } catch (err) {
                alert(err && err.message ? err.message : 'Could not create playlist.');
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
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
        playBtn.title = 'Stream';
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
        runGlobalSearch(currentSearchQuery, searchOffset);
    });
    if (gNextBtn) gNextBtn.addEventListener('click', function () {
        if (!searchHasMore) return;
        searchOffset += PAGE_SIZE;
        runGlobalSearch(currentSearchQuery, searchOffset);
    });

    async function runGlobalSearch(q, offset = 0) {
        if (!gPanel || !gList) return;
        closeAddToPlaylistPopover();
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

    window.refreshSidebarPlaylistList = async function (activePlaylistId) {
        await reloadPlaylistsCatalog();
        const pid = activePlaylistId != null ? activePlaylistId : (window.__spaPlaylistId || '');
        renderSidebarPlaylistList(pid, Date.now());
    };

    window.bustPlaylistCoverImages = function (root) {
        const el = root || document;
        const bust = Date.now();
        el.querySelectorAll('img[src*="/tracks/"][src*="/cover"]').forEach(function (img) {
            const src = img.getAttribute('src');
            if (!src) return;
            img.src = withCoverCacheBust(src, bust);
            img.style.opacity = '';
        });
    };
})();
