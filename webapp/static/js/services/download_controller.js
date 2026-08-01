/**
 * Controller for download progress tracking.
 * Responsibilities:
 * - Poll /api/progress for active and failed downloads
 * - Render download progress cards and error lists
 * - Handle retry actions for failed downloads
 */
export class PlaylistDownloadController {
    /** @param {import('./state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./state.js').PlaylistPlayerState} */
        this.state = state;
        this.progressInFlight = false;
        this.progressTimer = null;
        this.__dlJobsDomKey = '';
        this.__dlErrDomKey = '';
        this._prevJobKeys = new Set();
        this.PROGRESS_MS_VISIBLE = 3000;
        this.PROGRESS_MS_HIDDEN = 12000;
        /** @type {import('../playlist/session.js').PlaylistSessionController|null} */
        this.session = null;
    }

    /** Set cross-controller references after all controllers are created. */
    setCrossRefs(session) {
        this.session = session;
    }

    /** Start polling for download progress. */
    init() {
        const hub = this.state.hub;
        if (!hub) return;

        document.addEventListener('visibilitychange', () => this.armProgressTimer());
        this.armProgressTimer();
        this.refreshProgress();

        if (hub.dlRetryAllErrors) {
            hub.dlRetryAllErrors.addEventListener('click', () => {
                if (hub.dlRetryAllErrors.disabled) return;
                hub.dlRetryAllErrors.disabled = true;
                fetch('/api/downloads/retry-all-errors', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                })
                    .catch(() => {})
                    .finally(() => {
                        this.refreshProgress();
                    });
            });
        }
    }

    fmtSpeed(kbps) {
        if (kbps == null) return '';
        if (kbps >= 1024) return (kbps / 1024).toFixed(1) + ' MB/s';
        return kbps.toFixed(0) + ' KB/s';
    }

    fmtEta(sec) {
        if (sec == null) return '';
        if (sec < 60) return sec + 's';
        return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    }

    armProgressTimer() {
        if (this.progressTimer) clearInterval(this.progressTimer);
        const ms = document.visibilityState === 'hidden' ? this.PROGRESS_MS_HIDDEN : this.PROGRESS_MS_VISIBLE;
        this.progressTimer = setInterval(() => this.refreshProgress(), ms);
    }

    async refreshProgress() {
        const hub = this.state.hub;
        if (this.progressInFlight) return;
        this.progressInFlight = true;
        try {
            const progRes = await fetch('/api/progress');
            const data = await progRes.json();

            let prog;
            let remaining = null;
            let queue_depth = null;
            let errors = [];
            let errors_total = null;
            if (data && typeof data === 'object') {
                if (data.jobs != null && typeof data.remaining === 'number') {
                    prog = data.jobs;
                    remaining = data.remaining;
                    queue_depth = typeof data.queue_depth === 'number' ? data.queue_depth : 0;
                } else {
                    prog = data;
                }
                if (Array.isArray(data.errors)) errors = data.errors;
                if (typeof data.errors_total === 'number') errors_total = data.errors_total;
            } else {
                prog = {};
            }

            const entries = Object.entries(prog && typeof prog === 'object' ? prog : {});
            const active = entries.length;
            const has_pending = (remaining != null && remaining > 0) || active > 0
                || (queue_depth != null && queue_depth > 0);
            const curKeys = new Set(entries.map(([k]) => k));
            let job_completed = false;
            if (this._prevJobKeys.size > 0) {
                for (const k of this._prevJobKeys) {
                    if (!curKeys.has(k)) {
                        job_completed = true;
                        break;
                    }
                }
            }
            this._prevJobKeys = curKeys;

            const jobDomKey = entries.length === 0
                ? (has_pending ? '__pending__:' + String(remaining) + ':' + String(queue_depth) : '__idle__')
                : JSON.stringify(entries.map(([k, v]) => [k, v && v.phase, v && v.percent, v && v.speed, v && v.eta, v && v.title, v && v.artist]));
            const errDomKey = errors.length === 0 ? '__noerr__' : JSON.stringify(errors.map(function (r) {
                return [r.playlist_id, r.track_id, r.error || '', r.title || '', r.artist || ''];
            }));

            if (hub.dlCount) {
                const searching = Object.values(prog || {}).filter(p => p && p.phase === 'searching').length;
                const parts = [];
                if (remaining != null && remaining > 0) parts.push(remaining + ' left');
                if (active > 0) parts.push(active + ' active');
                if (searching > 0) parts.push(searching + ' searching');
                if (queue_depth != null && queue_depth > 0) parts.push(queue_depth + ' queued');
                const label = parts.length ? parts.join(' · ') : 'Idle';
                hub.dlCount.textContent = label;
            }

            if (hub.dlList) {
                if (jobDomKey !== this.__dlJobsDomKey) {
                    this.__dlJobsDomKey = jobDomKey;
                    if (entries.length === 0) {
                        hub.dlList.innerHTML = '';
                        if (!has_pending) {
                            if (hub.dlIdle) {
                                hub.dlIdle.classList.remove('hidden');
                                hub.dlList.appendChild(hub.dlIdle);
                            }
                        } else {
                            if (hub.dlIdle) hub.dlIdle.classList.add('hidden');
                            const pending = document.createElement('p');
                            pending.className = 'text-xs text-[#727272]';
                            const ql = queue_depth || 0;
                            pending.textContent = ql > 0
                                ? ql + ' download' + (ql === 1 ? '' : 's') + ' queued…'
                                : 'Preparing downloads…';
                            hub.dlList.appendChild(pending);
                        }
                    } else {
                        if (hub.dlIdle) hub.dlIdle.classList.add('hidden');
                        hub.dlList.innerHTML = '';
                        entries.forEach(([tid, p]) => {
                            const card = document.createElement('div');
                            card.className = 'rounded-lg bg-[#242424] p-3 text-xs space-y-1.5';

                            const header = document.createElement('div');
                            header.className = 'flex items-center justify-between gap-2';
                            const nameEl = document.createElement('div');
                            nameEl.className = 'font-medium text-white truncate min-w-0';
                            nameEl.textContent = p.title || '';
                            const artistEl = document.createElement('div');
                            artistEl.className = 'text-[#727272] shrink-0';
                            artistEl.textContent = p.artist || '';
                            header.appendChild(nameEl);
                            header.appendChild(artistEl);

                            const meta = document.createElement('div');
                            meta.className = 'flex items-center justify-between text-[#727272]';
                            const phaseEl = document.createElement('span');
                            phaseEl.textContent = p.phase === 'searching' ? 'Searching…'
                                : p.phase === 'converting' ? 'Converting…'
                                : p.phase === 'queued' ? 'Queued…'
                                : p.percent != null ? p.percent + '%' : 'Starting…';
                            const rightEl = document.createElement('span');
                            const eparts = [];
                            if (p.speed) eparts.push(this.fmtSpeed(p.speed));
                            if (p.eta) eparts.push('ETA ' + this.fmtEta(p.eta));
                            rightEl.textContent = eparts.join(' · ');
                            meta.appendChild(phaseEl);
                            meta.appendChild(rightEl);

                            const bar = document.createElement('div');
                            bar.className = 'h-1 rounded-full bg-[#3E3E3E] overflow-hidden';
                            const fill = document.createElement('div');
                            const pct = p.percent != null ? p.percent : (p.phase === 'converting' ? 100 : 0);
                            fill.className = 'h-full rounded-full bg-[#1DB954] transition-all duration-300';
                            fill.style.width = pct + '%';
                            bar.appendChild(fill);

                            card.appendChild(header);
                            card.appendChild(meta);
                            card.appendChild(bar);
                            hub.dlList.appendChild(card);
                        });
                    }
                }
            }

            if (hub.dlErrorCount) {
                const ec = errors_total != null ? errors_total : errors.length;
                hub.dlErrorCount.textContent = String(ec);
            }
            if (hub.dlRetryAllErrors) hub.dlRetryAllErrors.disabled = (errors_total != null ? errors_total : errors.length) === 0;

            if (hub.dlErrorList) {
                if (errDomKey !== this.__dlErrDomKey) {
                    this.__dlErrDomKey = errDomKey;
                    hub.dlErrorList.innerHTML = '';
                    if (errors.length === 0) {
                        const empty = document.createElement('p');
                        empty.className = 'text-xs text-[#727272]';
                        empty.textContent = 'No failed downloads.';
                        hub.dlErrorList.appendChild(empty);
                    } else {
                        errors.forEach((row) => {
                            const card = document.createElement('div');
                            card.className = 'rounded-lg bg-[#242424] p-3 text-xs space-y-2';

                            const header = document.createElement('div');
                            header.className = 'flex items-center justify-between gap-2';
                            const nameEl = document.createElement('div');
                            nameEl.className = 'font-medium text-white truncate min-w-0';
                            nameEl.textContent = row.title || '—';
                            const artistEl = document.createElement('div');
                            artistEl.className = 'text-[#727272] shrink-0';
                            artistEl.textContent = row.artist || '';
                            header.appendChild(nameEl);
                            header.appendChild(artistEl);

                            const meta = document.createElement('div');
                            meta.className = 'flex items-center justify-between gap-2 text-[#727272]';
                            const metaLeft = document.createElement('span');
                            metaLeft.className = 'truncate min-w-0';
                            metaLeft.textContent = row.playlist_name || 'Playlist';
                            const metaRight = document.createElement('span');
                            metaRight.className = 'shrink-0 text-red-400';
                            metaRight.textContent = 'Failed';
                            meta.appendChild(metaLeft);
                            meta.appendChild(metaRight);

                            const err = document.createElement('p');
                            err.className = 'text-[#B3B3B3] leading-snug break-words whitespace-pre-wrap';
                            err.textContent = row.error || 'Unknown error';

                            const bar = document.createElement('div');
                            bar.className = 'h-1 rounded-full bg-[#3E3E3E] overflow-hidden';
                            const fill = document.createElement('div');
                            fill.className = 'h-full rounded-full bg-red-500/70 transition-all duration-300';
                            fill.style.width = '100%';
                            bar.appendChild(fill);

                            const actions = document.createElement('div');
                            actions.className = 'flex items-center flex-wrap';
                            actions.style.paddingTop = '0.375rem';
                            actions.style.paddingBottom = '0.375rem';
                            actions.style.gap = '0.5rem 0.625rem';

                            const retry = document.createElement('button');
                            retry.type = 'button';
                            retry.className = 'text-xs font-semibold text-[#1DB954] hover:text-[#1ed760] py-1';
                            retry.textContent = 'Retry';
                            retry.addEventListener('click', () => {
                                const pid = row.playlist_id;
                                const tid = row.track_id;
                                if (!pid || !tid) return;
                                const fd = new FormData();
                                fetch('/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(tid) + '/download', {
                                    method: 'POST',
                                    body: fd,
                                    credentials: 'same-origin',
                                    redirect: 'manual',
                                }).catch(() => {}).finally(() => {
                                    this.refreshProgress();
                                });
                            });

                            const openPl = document.createElement('button');
                            openPl.type = 'button';
                            openPl.className = 'text-xs font-semibold text-[#B3B3B3] hover:text-white py-1';
                            openPl.textContent = 'Open playlist';
                            openPl.addEventListener('click', () => {
                                const pid = row.playlist_id;
                                if (!pid) return;
                                if (this.session) {
                                    this.session.navigatePlaylist(pid, true);
                                } else {
                                    window.location.href = '/?playlist_id=' + encodeURIComponent(pid);
                                }
                            });

                            actions.appendChild(retry);
                            actions.appendChild(openPl);

                            card.appendChild(header);
                            card.appendChild(meta);
                            card.appendChild(bar);
                            card.appendChild(err);
                            card.appendChild(actions);
                            hub.dlErrorList.appendChild(card);
                        });
                        if (errors_total != null && errors_total > errors.length) {
                            const more = document.createElement('p');
                            more.className = 'text-[10px] text-[#727272] pt-2';
                            more.textContent = 'Showing ' + errors.length + ' of ' + errors_total + ' — use Retry all for the rest.';
                            hub.dlErrorList.appendChild(more);
                        }
                    }
                }
            }

            if (job_completed && this.session) {
                const hub = this.state.hub;
                const pid = hub.playlistId;
                if (pid && !hub.isHomeView) {
                    try {
                        const vr = await fetch('/api/playlist/view?playlist_id=' + encodeURIComponent(pid));
                        if (vr.ok) {
                            const viewData = await vr.json();
                            if (typeof window.applySpaPlaylist === 'function') {
                                window.applySpaPlaylist(viewData);
                            } else {
                                this.session.applySpaPlaylist(viewData);
                            }
                        }
                        if (typeof window.refreshSidebarPlaylistList === 'function') {
                            await window.refreshSidebarPlaylistList(pid);
                        }
                    } catch (refreshErr) {}
                } else if (hub.isHomeView) {
                    try {
                        const hr = await fetch('/api/home/view');
                        if (hr.ok) {
                            const homeData = await hr.json();
                            hub.libraryPool = homeData.library_pool || hub.libraryPool;
                            if (this.session.home) this.session.home.render();
                        }
                    } catch (homeErr) {}
                }
                if (this.session.transport) {
                    this.session.transport.onPlaybackQualityChanged();
                }
            }
        } catch (e) {
        } finally {
            this.progressInFlight = false;
        }
    }

    /** Queue bulk downloads at a quality tier (playlist-specific or whole library). */
    async queueQualityDownloads(playlistId, quality) {
        const q = String(quality);
        const url = playlistId
            ? '/api/playlists/' + encodeURIComponent(playlistId) + '/downloads/quality'
            : '/api/downloads/quality-all';
        try {
            await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ quality: q }),
            });
        } catch (e) {}
        this.refreshProgress();
    }

}
