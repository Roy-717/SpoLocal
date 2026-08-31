/**
 * Controller for lyrics display, fetching, and editing.
 * Responsibilities:
 * - Fetch lyrics from the server and render them (plain text or LRC)
 * - Synchronize LRC highlighting with audio playback
 * - Manage LRC editor state and persistence
 * - Dynamically calculate and apply lyrics panel colors based on cover art
 */
export class PlaylistLyricsController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state, transport, queue) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./transport_controller.js').PlaylistTransportController|null} */
        this.transport = transport;
        /** @type {import('./queue_controller.js').PlaylistQueueController|null} */
        this.queue = queue;
    }

    /** Initialize lyrics-related event wiring (toggle buttons, editor actions). */
    init() {
        const hub = this.state.hub;
        if (!hub) return;
        // Avoid double-binding when init runs multiple times
        if (hub._lyrics_controller_bound) return;
        hub._lyrics_controller_bound = true;
        hub.lyricsController = this;
        hub.lyricsUserScrollUntil = 0;
        this.bind_lyrics_user_scroll();

        // Toggle lyrics panel
        if (Array.isArray(hub.lyricsToggleButtons)) {
            hub.lyricsToggleButtons.forEach(btn => {
                if (!btn) return;
                if (btn.dataset.lyricsBound) return;
                btn.dataset.lyricsBound = '1';
                btn.addEventListener('click', () => {
                    this.toggleLyrics();
                });
            });
        }

        // Tabs and editor controls
        if (hub.lyricsTabRead && !hub.lyricsTabRead.dataset.bound) {
            hub.lyricsTabRead.dataset.bound = '1';
            hub.lyricsTabRead.addEventListener('click', () => { this.setLyricsMode('read'); });
        }
        if (hub.lyricsTabEdit && !hub.lyricsTabEdit.dataset.bound) {
            hub.lyricsTabEdit.dataset.bound = '1';
            hub.lyricsTabEdit.addEventListener('click', () => { this.setLyricsMode('edit'); });
        }
        if (hub.lyricsCancelEdit && !hub.lyricsCancelEdit.dataset.bound) {
            hub.lyricsCancelEdit.dataset.bound = '1';
            hub.lyricsCancelEdit.addEventListener('click', () => { this.setLyricsMode('read'); });
        }

        // Global shift buttons
        if (hub.lrcShiftMinus && !hub.lrcShiftMinus.dataset.bound) {
            hub.lrcShiftMinus.dataset.bound = '1';
            hub.lrcShiftMinus.addEventListener('click', () => { this.shiftAllTimestamps(-1000); });
        }
        if (hub.lrcShiftPlus && !hub.lrcShiftPlus.dataset.bound) {
            hub.lrcShiftPlus.dataset.bound = '1';
            hub.lrcShiftPlus.addEventListener('click', () => { this.shiftAllTimestamps(1000); });
        }

        // Lyrics close button
        if (hub.lyricsClose && !hub.lyricsClose.dataset.bound) {
            hub.lyricsClose.dataset.bound = '1';
            hub.lyricsClose.addEventListener('click', () => {
                if (hub.lyricsVisible) {
                    this.toggleLyrics();
                }
            });
        }

        // Save / editor actions (wire if save button exists)
        if (hub.lyricsSaveBtn && !hub.lyricsSaveBtn.dataset.bound) {
            hub.lyricsSaveBtn.dataset.bound = '1';
            hub.lyricsSaveBtn.addEventListener('click', async () => {
                try { await this.saveLyrics(); } catch (e) {}
            });
        }
    }

    bind_lyrics_user_scroll() {
        const hub = this.state.hub;
        if (hub._lyricsUserScrollBound) return;
        hub._lyricsUserScrollBound = true;
        const pause_autoscroll = (e) => {
            if (!hub.lyricsVisible) return;
            const wrap = hub.lyricsViewWrap;
            const panel = hub.lyricsPanel;
            const t = e.target;
            if (!wrap || !t) return;
            if (wrap.contains(t) || (panel && panel.contains(t))) {
                hub.lyricsUserScrollUntil = Date.now() + 2000;
                this.stop_lyrics_scroll_anim();
            }
        };
        document.addEventListener('wheel', pause_autoscroll, { capture: true, passive: true });
        document.addEventListener('touchmove', pause_autoscroll, { capture: true, passive: true });
        document.addEventListener('pointerdown', (e) => {
            if (!hub.lyricsVisible || e.pointerType === 'mouse' && e.button !== 0) return;
            const wrap = hub.lyricsViewWrap;
            if (e.target && e.target.closest && e.target.closest('.lyrics-line')) return;
            if (wrap && wrap.contains(e.target)) {
                hub.lyricsUserScrollUntil = Date.now() + 2000;
                this.stop_lyrics_scroll_anim();
            }
        }, { capture: true });
    }

    async fetchLyrics(showEmptyMessage) {
        const hub = this.state.hub;
        // Cancel any in-flight request
        if (hub.lyricsAbortController) {
            hub.lyricsAbortController.abort();
            hub.lyricsAbortController = null;
        }

        // Bump generation — any older in-flight response will see a mismatch and discard itself
        const myGen = ++hub.lyricsFetchGen;

        // Clear display immediately
        hub.lastLyricsPayload = { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null };
        hub.lyricsBody.textContent = '';
        hub.lyricsEditor.value = '';
        hub.lrcEditLines = [];
        if (hub.lrcLinesContainer) hub.lrcLinesContainer.innerHTML = '';
        hub.lyricsEmptyHint.classList.add('hidden');
        hub.lyricsNoAudioHint.classList.add('hidden');
        this.sync_search_lyrics_chrome();
        const searchVid = hub.searchStreamActive && hub.searchStreamHit
            ? String(hub.searchStreamHit.video_id || '').trim()
            : '';
        if (!hub.currentTrackId && !searchVid) {
            hub.lastLyricsPayload = { lyrics: '', source: 'none', has_audio: false, lrc_data: null, lrc_raw: null };
            hub.lyricsBody.textContent = 'Select a song to play.';
            return;
        }

        hub.lyricsBody.textContent = 'Loading…';

        const ctrl = new AbortController();
        hub.lyricsAbortController = ctrl;

        try {
            let r;
            if (searchVid) {
                r = await fetch('/api/stream/chapters?vid=' + encodeURIComponent(searchVid), { signal: ctrl.signal });
            } else {
                const lyricsPid = String(hub.playingPlaylistId || hub.playlistId || '').trim();
                r = await fetch(
                    '/playlists/' + encodeURIComponent(lyricsPid) + '/tracks/' + encodeURIComponent(hub.currentTrackId) + '/lyrics',
                    { signal: ctrl.signal }
                );
            }
            if (myGen !== hub.lyricsFetchGen) return;
            if (!r.ok) throw new Error('bad status');
            const j = await r.json();
            if (myGen !== hub.lyricsFetchGen) return;
            this.applyLyricsPayload(j, showEmptyMessage);
        } catch (e) {
            if (myGen !== hub.lyricsFetchGen) return;
            if (e.name === 'AbortError') return;
            hub.lyricsBody.textContent = 'Could not load lyrics.';
        }
    }

    sync_search_lyrics_chrome() {
        const hub = this.state.hub;
        const searchOn = !!(hub.searchStreamActive && hub.searchStreamHit);
        if (hub.lyricsTitle) {
            hub.lyricsTitle.textContent = searchOn ? 'Chapters' : 'Lyrics';
        }
        if (hub.lyricsModeSwitch) {
            hub.lyricsModeSwitch.classList.toggle('hidden', searchOn);
        }
        if (searchOn && hub.lyricsMode !== 'read') {
            this.setLyricsMode('read');
        }
        if (hub.lyricsEmptyHint && hub._lyricsEmptyHintDefault == null) {
            hub._lyricsEmptyHintDefault = hub.lyricsEmptyHint.innerHTML;
        }
        if (hub.lyricsEmptyHint && hub._lyricsEmptyHintDefault != null && !searchOn) {
            hub.lyricsEmptyHint.innerHTML = hub._lyricsEmptyHintDefault;
        }
    }

    applyLyricsPayload(j, showHints) {
        const hub = this.state.hub;
        hub.lastLyricsPayload = {
            lyrics: j.lyrics || '',
            source: j.source || 'none',
            has_audio: !!j.has_audio,
            lrc_data: j.lrc_data || null,
            lrc_raw: j.lrc_raw || null
        };
        hub.lyricsBody.textContent = '';
        hub.lyricsEmptyHint.classList.add('hidden');
        hub.lyricsNoAudioHint.classList.add('hidden');
        const searchOn = !!(hub.searchStreamActive && hub.searchStreamHit);
        if (!hub.currentTrackId && !searchOn) {
            return;
        }
        if (!searchOn && !hub.lastLyricsPayload.has_audio) {
            hub.lyricsNoAudioHint.classList.remove('hidden');
            return;
        }

        const text = (hub.lastLyricsPayload.lyrics || '').trim();
        if (text) {
            if (hub.lastLyricsPayload.lrc_data && Array.isArray(hub.lastLyricsPayload.lrc_data) && hub.lastLyricsPayload.lrc_data.length > 0) {
                this.renderLrcLines(hub.lastLyricsPayload.lrc_data);
                if (hub.lyricsMode === 'read') {
                    this.updateLyricsActiveLine();
                }
            } else {
                this.render_plain_lyrics_lines(hub.lastLyricsPayload.lyrics);
            }
        } else if (showHints) {
            if (searchOn && hub.lyricsEmptyHint) {
                hub.lyricsEmptyHint.textContent = 'No chapter timestamps on this video.';
                hub.lyricsEmptyHint.classList.remove('hidden');
            } else {
                hub.lyricsEmptyHint.classList.remove('hidden');
            }
        }
        if (!searchOn && hub.lyricsMode === 'edit') {
            this.setLyricsMode('edit');
        }
    }

    render_plain_lyrics_lines(raw) {
        const hub = this.state.hub;
        hub.lyricsBody.textContent = '';
        const body = (raw || '').replace(/\r\n/g, '\n');
        const parts = body.split('\n');
        const containerWidth = hub.lyricsBody.clientWidth;

        const lineElements = parts.map(function(chunk) {
            const line = document.createElement('div');
            line.textContent = chunk;
            line.className = 'lyrics-line lyrics-line--static nowrap';
            line.style.fontWeight = '700';
            hub.lyricsBody.appendChild(line);
            return line;
        });

        hub.lyricsBody.offsetHeight;
        lineElements.forEach(function(line) {
            const boldWidth = line.scrollWidth;
            const scaledWidth = boldWidth * 1.15;
            if (scaledWidth > containerWidth - 8) {
                line.classList.remove('nowrap');
                line.classList.add('wrap');
            }
            line.style.fontWeight = '';
        });
    }

    renderLrcLines(lrcData) {
        const hub = this.state.hub;
        hub.lyricsBody.textContent = '';

        // We measure each line in its WORST-CASE state (active: bold + scaled 1.15x).
        // If the bold version still fits within container, the line stays single-line.
        // Otherwise we let it wrap. CSS max-width: 86% caps wrapped lines to fit when scaled.
        const containerWidth = hub.lyricsBody.clientWidth;

        const createLine = (item) => {
            const line = document.createElement('div');
            line.textContent = item.text;
            line.dataset.timeMs = item.time_ms;
            line.addEventListener('click', () => {
                const timeMs = parseInt(line.dataset.timeMs, 10);
                if (!isNaN(timeMs) && hub.audio) {
                    hub.audio.currentTime = timeMs / 1000;
                    if (hub.audio.paused) {
                        hub.audio.play().catch(err => { if (this.transport) this.transport.handlePlayError(err); });
                    }
                }
                hub.lyricsUserScrollUntil = Date.now() + 2000;
                const wrap = hub.lyricsViewWrap;
                if (wrap) {
                    const wrap_rect = wrap.getBoundingClientRect();
                    const line_rect = line.getBoundingClientRect();
                    const delta = (line_rect.top + line_rect.height / 2) - (wrap_rect.top + wrap_rect.height / 2);
                    this.animate_lyrics_wrap_scroll(wrap, wrap.scrollTop + delta, true);
                }
            });
            return line;
        };

        // Render all lines as nowrap + BOLD (active-state weight) to measure worst-case width.
        const lineElements = lrcData.map((item) => {
            const line = createLine(item);
            line.className = 'lyrics-line nowrap';
            line.style.fontWeight = '700'; // measure as if active
            hub.lyricsBody.appendChild(line);
            return line;
        });

        // Force layout, then check each line's BOLD rendered width.
        // Account for the 1.15x scale by requiring boldWidth * 1.15 <= containerWidth.
        hub.lyricsBody.offsetHeight;
        lineElements.forEach(function(line) {
            const boldWidth = line.scrollWidth;
            const scaledWidth = boldWidth * 1.15;
            if (scaledWidth > containerWidth - 8) {
                line.classList.remove('nowrap');
                line.classList.add('wrap');
            }
            line.style.fontWeight = ''; // remove inline override; CSS controls active state
        });
    }

    updateLyricsActiveLine() {
        const hub = this.state.hub;
        if (!hub.audio || !hub.lastLyricsPayload.lrc_data || !hub.lyricsVisible || hub.lyricsMode !== 'read') return;

        const currentTimeMs = Math.floor(hub.audio.currentTime * 1000);
        const lines = hub.lyricsBody.querySelectorAll('.lyrics-line');
        if (!lines.length) return;

        // Find the active line (exactly at current time)
        let activeIndex = -1;
        for (let i = 0; i < hub.lastLyricsPayload.lrc_data.length; i++) {
            if (hub.lastLyricsPayload.lrc_data[i].time_ms <= currentTimeMs) {
                activeIndex = i;
            } else {
                break;
            }
        }

        // Update classes
        lines.forEach(function(line, idx) {
            if (idx === activeIndex) {
                line.classList.add('active');
            } else {
                line.classList.remove('active');
            }
        });

        // Auto-scroll to keep active line centered
        const wrap = hub.lyricsViewWrap;
        if (!wrap || activeIndex < 0 || !lines[activeIndex]) return;
        if (hub.lyricsUserScrollUntil && Date.now() < hub.lyricsUserScrollUntil) return;
        const line = lines[activeIndex];
        const wrap_rect = wrap.getBoundingClientRect();
        const line_rect = line.getBoundingClientRect();
        const delta = (line_rect.top + line_rect.height / 2) - (wrap_rect.top + wrap_rect.height / 2);
        if (Math.abs(delta) < 4) return;
        if (hub._lyricsFollowIndex === activeIndex && hub._lyricsScrollAnim) return;
        hub._lyricsFollowIndex = activeIndex;
        this.animate_lyrics_wrap_scroll(wrap, wrap.scrollTop + delta);
    }

    stop_lyrics_scroll_anim() {
        const hub = this.state.hub;
        if (hub._lyricsScrollAnim) {
            cancelAnimationFrame(hub._lyricsScrollAnim);
            hub._lyricsScrollAnim = 0;
        }
    }

    animate_lyrics_wrap_scroll(wrap, target_top, force) {
        const hub = this.state.hub;
        this.stop_lyrics_scroll_anim();
        const start = wrap.scrollTop;
        const dist = target_top - start;
        if (Math.abs(dist) < 4) return;
        const dur = 480;
        const t0 = performance.now();
        const step = (now) => {
            if (!force && hub.lyricsUserScrollUntil && Date.now() < hub.lyricsUserScrollUntil) {
                hub._lyricsScrollAnim = 0;
                return;
            }
            const p = Math.min(1, (now - t0) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            wrap.scrollTop = start + dist * eased;
            if (p < 1) hub._lyricsScrollAnim = requestAnimationFrame(step);
            else hub._lyricsScrollAnim = 0;
        };
        hub._lyricsScrollAnim = requestAnimationFrame(step);
    }

    renderLrcEditor() {
        const hub = this.state.hub;
        if (!hub.lastLyricsPayload.lrc_data) {
            hub.lrcEditLines = [];
        } else {
            // Deep copy so we don't mutate the original
            hub.lrcEditLines = hub.lastLyricsPayload.lrc_data.map(item => ({...item}));
        }
        this.renderLrcLinesInEditor();
    }

    formatLrcTimestamp(timeMs) {
        const minutes = Math.floor(timeMs / 60000);
        const seconds = Math.floor((timeMs % 60000) / 1000);
        const centis = Math.floor((timeMs % 1000) / 10);
        return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}]`;
    }

    parseLrcTimestamp(timestampStr) {
        const match = timestampStr.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
        if (!match) return null;
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const millisStr = match[3];
        const millis = millisStr.length === 2 ? parseInt(millisStr, 10) * 10 : parseInt(millisStr, 10);
        return (minutes * 60 + seconds) * 1000 + millis;
    }

    adjust_timestamp(index, delta) {
        const hub = this.state.hub;
        const line = hub.lrcEditLines[index];
        if (!line) return;
        line.time_ms = Math.max(0, line.time_ms + delta);
        this.renderLrcLinesInEditor();
    }

    shiftAllTimestamps(delta) {
        const hub = this.state.hub;
        if (!hub.lrcEditLines || !hub.lrcEditLines.length) return;
        for (const line of hub.lrcEditLines) {
            line.time_ms = Math.max(0, line.time_ms + delta);
        }
        this.renderLrcLinesInEditor();
    }

    renderLrcLinesInEditor() {
        const hub = this.state.hub;
        hub.lrcLinesContainer.innerHTML = '';

        hub.lrcEditLines.forEach((line, index) => {
            const row = document.createElement('div');
            row.className = 'lrc-line';

            // Timestamp button
            const timestamp = document.createElement('span');
            timestamp.className = 'lrc-timestamp';
            timestamp.textContent = this.formatLrcTimestamp(line.time_ms);
            timestamp.title = "Click to set to current playback time, double-click to edit";
            timestamp.addEventListener('click', () => {
                // Set timestamp to current audio position
                if (hub.audio) {
                    const newTimeMs = Math.floor(hub.audio.currentTime * 1000);
                    hub.lrcEditLines[index].time_ms = newTimeMs;
                    timestamp.textContent = this.formatLrcTimestamp(newTimeMs);
                }
            });
            timestamp.addEventListener('dblclick', (e) => {
                // Double-click to manually edit timestamp
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'lrc-timestamp';
                input.style.width = '4.5rem';
                input.value = this.formatLrcTimestamp(hub.lrcEditLines[index].time_ms);
                input.style.background = 'rgba(29, 185, 84, 0.25)';

                const saveTimestamp = () => {
                    const newTs = this.parseLrcTimestamp(input.value);
                    if (newTs !== null) {
                        hub.lrcEditLines[index].time_ms = newTs;
                    }
                    this.renderLrcLinesInEditor();
                };

                input.addEventListener('blur', saveTimestamp);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') {
                        ke.preventDefault();
                        saveTimestamp();
                    }
                    if (ke.key === 'Escape') {
                        this.renderLrcLinesInEditor();
                    }
                });

                timestamp.replaceWith(input);
                input.focus();
                input.select();
            });

            // Text input
            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.className = 'lrc-text';
            textInput.value = line.text;
            textInput.placeholder = "Lyrics line...";
            textInput.addEventListener('input', (e) => {
                hub.lrcEditLines[index].text = e.target.value;
            });

            // Timestamp adjust buttons
            const adjustBtn = (label, delta) => {
                const btn = document.createElement('button');
                btn.className = 'lrc-ts-adj-btn';
                btn.textContent = label;
                btn.title = `${label === '+' ? 'Add' : 'Subtract'} 1 second`;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.adjust_timestamp(index, delta);
                });
                return btn;
            };
            const minusBtn = adjustBtn('−', -1000);
            const plusBtn = adjustBtn('+', 1000);

            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'lrc-delete-btn';
            deleteBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            deleteBtn.title = "Remove line";
            deleteBtn.addEventListener('click', () => {
                hub.lrcEditLines.splice(index, 1);
                this.renderLrcLinesInEditor();
            });

            row.appendChild(timestamp);
            row.appendChild(minusBtn);
            row.appendChild(plusBtn);
            row.appendChild(textInput);
            row.appendChild(deleteBtn);
            hub.lrcLinesContainer.appendChild(row);

            // Insert-gap between this line and the next
            const gap = document.createElement('div');
            gap.className = 'lrc-insert-gap';
            gap.title = 'Insert line here';
            gap.addEventListener('click', (e) => {
                e.stopPropagation();
                const prevMs = hub.lrcEditLines[index] ? hub.lrcEditLines[index].time_ms : 0;
                const nextMs = hub.lrcEditLines[index + 1] ? hub.lrcEditLines[index + 1].time_ms : prevMs + 2000;
                const newTimeMs = Math.round((prevMs + nextMs) / 2);
                hub.lrcEditLines.splice(index + 1, 0, { time_ms: newTimeMs, text: '' });
                this.renderLrcLinesInEditor();
            });
            hub.lrcLinesContainer.appendChild(gap);
        });
    }

    async saveLyrics() {
        const hub = this.state.hub;
        if (!hub.currentTrackId) return;
        hub.lyricsSaveStatus.classList.add('hidden');

        // Check if we're in LRC editing mode
        const isLrcMode = !hub.lrcEditor.classList.contains('hidden');

        try {
            let r;
            if (isLrcMode) {
                // Save LRC with timestamps - filter out empty lines and sort by timestamp
                let linesToSave = hub.lrcEditLines
                    .filter(line => line.text.trim())
                    .map(line => ({...line})); // Deep copy
                // Sort by timestamp
                linesToSave.sort((a, b) => a.time_ms - b.time_ms);
                r = await fetch('/playlists/' + encodeURIComponent(hub.playlistId) + '/tracks/' + encodeURIComponent(hub.currentTrackId) + '/lyrics/lrc', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lines: linesToSave })
                });
            } else {
                // Save plain text lyrics
                r = await fetch('/playlists/' + encodeURIComponent(hub.playlistId) + '/tracks/' + encodeURIComponent(hub.currentTrackId) + '/lyrics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lyrics: hub.lyricsEditor.value })
                });
            }

            if (!r.ok) {
                let msg = 'Could not save lyrics.';
                try {
                    const err = await r.json();
                    if (typeof err.detail === 'string') msg = err.detail;
                } catch (x) {}
                alert(msg);
                return;
            }
            await this.fetchLyrics(false);
            hub.lyricsSaveStatus.classList.remove('hidden');
            this.setLyricsMode('read');
            setTimeout(() => hub.lyricsSaveStatus.classList.add('hidden'), 3500);
        } catch (e) {
            alert('Could not save lyrics.');
        }
    }

    toggleLyrics() {
        const hub = this.state.hub;
        if (!hub.lyricsPanel) return;
        hub.lyricsVisible = !hub.lyricsVisible;
        if (hub.lyricsVisible && hub.queueVisible) {
            hub.queueVisible = false;
            document.body.classList.remove('mobile-queue-open');
            if (hub.queuePanel) hub.queuePanel.setAttribute('aria-hidden', 'true');
            if (this.queue) this.queue.sync_queue_button_ui();
        }
        if (hub.lyricsVisible) {
            if (typeof window.closeGlobalSearch === 'function') window.closeGlobalSearch();
            // Sync bottom edge with the player bar's actual height
            const playerBar = document.getElementById('player-bar');
            if (playerBar) {
                hub.lyricsPanel.style.bottom = playerBar.offsetHeight + 'px';
            }
        } else {
            hub.lyricsPanel.style.bottom = '';
        }
        hub.lyricsPanel.classList.toggle('hidden', !hub.lyricsVisible);
        this.sync_lyrics_toggle_buttons();
        if (hub.lyricsVisible) {
            hub.lyricsSaveStatus.classList.add('hidden');
            this.setLyricsMode('read');
            this.fetchLyrics(true);
        } else {
            // Reset colors when closing to avoid flash of old colors on next open
            this.resetLyricsColors();
        }
    }

    sync_lyrics_toggle_buttons() {
        const hub = this.state.hub;
        if (!hub.lyricsToggleButtons) return;
        hub.lyricsToggleButtons.forEach(btn => {
            if (!btn) return;
            btn.setAttribute('aria-pressed', String(hub.lyricsVisible));
            btn.classList.toggle('player-control-btn--active', hub.lyricsVisible);
        });
    }

    setLyricsMode(mode) {
        const hub = this.state.hub;
        if (hub.searchStreamActive) mode = 'read';
        hub.lyricsMode = mode;
        const readOn = mode === 'read';
        const currentTextColor = hub.lyricsPanel.style.getPropertyValue('--lyrics-text-color') || '#ffffff';
        // Use stored background-dark flag if available; default to dark (the app's natural state)
        const bgIsDark = (hub.lyricsBgIsDark === true || hub.lyricsBgIsDark === false)
            ? hub.lyricsBgIsDark
            : true;
        const activeText = bgIsDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';

        const tabClass = 'lyrics-tab';

        if (readOn) {
            hub.lyricsTabRead.className = tabClass;
            hub.lyricsTabRead.style.backgroundColor = bgIsDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
            hub.lyricsTabRead.style.color = currentTextColor;
            hub.lyricsTabEdit.className = tabClass;
            hub.lyricsTabEdit.style.backgroundColor = 'transparent';
            hub.lyricsTabEdit.style.color = activeText;
        } else {
            hub.lyricsTabRead.className = tabClass;
            hub.lyricsTabRead.style.backgroundColor = 'transparent';
            hub.lyricsTabRead.style.color = activeText;
            hub.lyricsTabEdit.className = tabClass;
            hub.lyricsTabEdit.style.backgroundColor = bgIsDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
            hub.lyricsTabEdit.style.color = currentTextColor;
        }
        hub.lyricsViewWrap.classList.toggle('hidden', !readOn);
        hub.lyricsEditWrap.classList.toggle('hidden', readOn);
        if (readOn) {
            hub.lyricsSaveStatus.classList.add('hidden');
            // Update active lyrics line when switching to read mode
            this.updateLyricsActiveLine();
        } else {
            const can = hub.lastLyricsPayload.has_audio;
            hub.lyricsEditActions.classList.toggle('hidden', !can);
            hub.lyricsEditDisabled.classList.toggle('hidden', can);

            // Show appropriate editor based on lyrics source
            const isLrc = hub.lastLyricsPayload.source === 'lrc' && hub.lastLyricsPayload.lrc_data;
            if (isLrc) {
                hub.lyricsEditor.classList.add('hidden');
                hub.lrcEditor.classList.remove('hidden');
                this.renderLrcEditor();
            } else {
                hub.lyricsEditor.classList.remove('hidden');
                hub.lrcEditor.classList.add('hidden');
                hub.lyricsEditor.value = hub.lastLyricsPayload.lyrics || '';
            }
        }
    }

    isColorDark(hexColor) {
        if (!hexColor || typeof hexColor !== 'string') return true;
        let r, g, b;
        if (hexColor.startsWith('#')) {
            const hex = hexColor.replace('#', '');
            r = parseInt(hex.substring(0, 2), 16);
            g = parseInt(hex.substring(2, 4), 16);
            b = parseInt(hex.substring(4, 6), 16);
        } else if (hexColor.startsWith('rgb')) {
            const match = hexColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
                r = parseInt(match[1], 10);
                g = parseInt(match[2], 10);
                b = parseInt(match[3], 10);
            }
        }
        if (isNaN(r) || isNaN(g) || isNaN(b)) return true;
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance < 0.5;
    }

    applyLyricsColors(colors) {
        const hub = this.state.hub;
        if (!hub.lyricsPanel) return;
        hub.lyricsBgIsDark = colors.isDark;
        hub.lyricsPanel.style.backgroundColor = colors.background;
        hub.lyricsPanel.style.setProperty('--lyrics-text-color', colors.text);
        hub.lyricsPanel.style.setProperty('--lyrics-bg-color', colors.background);
        // Set dim/hover colors based on actual text color so inactive lines stay readable
        const alpha = colors.isDark ? '0.45' : '0.4';
        const hoverAlpha = colors.isDark ? '0.75' : '0.65';
        const [tr, tg, tb] = colors.isDark ? [255,255,255] : [0,0,0];
        hub.lyricsPanel.style.setProperty('--lyrics-line-dim-color', `rgba(${tr},${tg},${tb},${alpha})`);
        hub.lyricsPanel.style.setProperty('--lyrics-line-hover-color', `rgba(${tr},${tg},${tb},${hoverAlpha})`);

        const hintElements = hub.lyricsPanel.querySelectorAll('p[id$="-hint"]');
        hintElements.forEach(el => {
            el.style.color = colors.isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
        });

        const editDisabled = document.getElementById('lyrics-edit-disabled');
        if (editDisabled) {
            editDisabled.style.color = colors.text;
        }

        const tabs = hub.lyricsPanel.querySelectorAll('.lyrics-tab');
        const isReadMode = hub.lyricsMode === 'read';
        tabs.forEach(tab => {
            const isActive = (isReadMode && tab.id === 'lyrics-tab-read') || (!isReadMode && tab.id === 'lyrics-tab-edit');
            if (isActive) {
                tab.style.color = colors.text;
                tab.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
            } else {
                tab.style.color = colors.isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
                tab.style.backgroundColor = 'transparent';
            }
        });

        const editor = document.getElementById('lyrics-editor');
        if (editor) {
            editor.style.color = colors.text;
            editor.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        }

        const closeBtn = document.getElementById('lyrics-close');
        if (closeBtn) {
            closeBtn.style.color = colors.isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
        }

        const lyricsTitle = document.getElementById('lyrics-title');
        if (lyricsTitle) {
            lyricsTitle.style.color = colors.text;
        }

        const modeSwitch = document.getElementById('lyrics-mode-switch');
        if (modeSwitch) {
            modeSwitch.style.backgroundColor = colors.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
        }
    }

    resetLyricsColors() {
        const hub = this.state.hub;
        if (!hub.lyricsPanel) return;
        hub.lyricsPanel.style.backgroundColor = '#121212';
        hub.lyricsPanel.style.setProperty('--lyrics-text-color', '#ffffff');
        hub.lyricsPanel.style.setProperty('--lyrics-bg-color', '#121212');
        hub.lyricsPanel.style.setProperty('--lyrics-line-dim-color', 'rgba(255,255,255,0.45)');
        hub.lyricsPanel.style.setProperty('--lyrics-line-hover-color', 'rgba(255,255,255,0.75)');

        const hints = hub.lyricsPanel.querySelectorAll('p[id$="-hint"]');
        hints.forEach(el => el.style.color = '');

        const editDisabled = document.getElementById('lyrics-edit-disabled');
        if (editDisabled) editDisabled.style.color = '';

        const tabs = hub.lyricsPanel.querySelectorAll('.lyrics-tab');
        tabs.forEach(tab => {
            tab.style.color = '';
            tab.style.backgroundColor = '';
        });

        const editor = document.getElementById('lyrics-editor');
        if (editor) {
            editor.style.color = '';
            editor.style.backgroundColor = '';
        }

        const closeBtn = document.getElementById('lyrics-close');
        if (closeBtn) closeBtn.style.color = '';

        const lyricsTitle = document.getElementById('lyrics-title');
        if (lyricsTitle) lyricsTitle.style.color = '';

        const modeSwitch = document.getElementById('lyrics-mode-switch');
        if (modeSwitch) modeSwitch.style.backgroundColor = '';
    }

    calculateLyricsColors(img) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const size = 64;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);

        try {
            ctx.getImageData(0, 0, 1, 1);
        } catch (e) {
            throw new Error('Canvas tainted');
        }

        const data = ctx.getImageData(0, 0, size, size).data;
        const colorMap = new Map();
        let totalR = 0, totalG = 0, totalB = 0, count = 0;

        for (let i = 0; i < data.length; i += 16) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];

            if (a < 128) continue;

            totalR += r;
            totalG += g;
            totalB += b;
            count++;

            const key = `${Math.min(248, Math.round(r / 8) * 8)},${Math.min(248, Math.round(g / 8) * 8)},${Math.min(248, Math.round(b / 8) * 8)}`;
            colorMap.set(key, (colorMap.get(key) || 0) + 1);
        }

        let dominantKey = null;
        let maxCount = 0;
        for (const [key, cnt] of colorMap) {
            if (cnt > maxCount) {
                maxCount = cnt;
                dominantKey = key;
            }
        }

        let bgR, bgG, bgB;
        if (dominantKey) {
            [bgR, bgG, bgB] = dominantKey.split(',').map(Number);
        } else if (count > 0) {
            bgR = Math.round(totalR / count);
            bgG = Math.round(totalG / count);
            bgB = Math.round(totalB / count);
        } else {
            bgR = 18; bgG = 18; bgB = 18;
        }

        const luminance = (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) / 255;
        const isDark = luminance < 0.5;

        // Brighten dark colors so the background is distinguishable from black
        if (isDark) {
            const minBrightness = 40;
            bgR = Math.max(bgR, minBrightness);
            bgG = Math.max(bgG, minBrightness);
            bgB = Math.max(bgB, minBrightness);
        }

        // Always use maximum contrast: white on dark, near-black on light
        const textR = isDark ? 255 : 30;
        const textG = isDark ? 255 : 30;
        const textB = isDark ? 255 : 30;

        // Verify contrast ratio (WCAG formula) - fallback if < 4.5
        const textLum = (0.299 * textR + 0.587 * textG + 0.114 * textB) / 255;
        const lighter = Math.max(luminance, textLum) + 0.05;
        const darker = Math.min(luminance, textLum) + 0.05;
        const contrast = lighter / darker;

        if (contrast < 4.5) {
            bgR = 30; bgG = 30; bgB = 30;
        }

        // Clamp to 0-255 before converting to prevent overflow (e.g. Math.round(255/8)*8 = 256)
        const toHex = (r, g, b) => '#' + [r, g, b].map(x => Math.min(255, Math.max(0, Math.round(x))).toString(16).padStart(2, '0')).join('');
        return {
            background: toHex(bgR, bgG, bgB),
            text: isDark ? '#ffffff' : '#1e1e1e',
            isDark: isDark
        };
    }

    loadCover(trackId, coverPlaylistIdOpt) {
        const hub = this.state.hub;
        hub.coverWrap.classList.add('no-art');
        hub.coverImg.classList.add('hidden');
        // Reset colors immediately to prevent previous track's colors persisting
        this.resetLyricsColors();
        if (!trackId) return;
        const pid = (coverPlaylistIdOpt != null && String(coverPlaylistIdOpt).trim() !== '')
            ? String(coverPlaylistIdOpt).trim()
            : String(hub.playingPlaylistId || hub.playlistId || '').trim();
        if (!pid) return;
        const url = '/playlists/' + encodeURIComponent(pid) + '/tracks/' + encodeURIComponent(trackId) + '/cover';
        if (!hub.coverProbeImg) hub.coverProbeImg = new Image();
        const probe = hub.coverProbeImg;
        probe.crossOrigin = 'anonymous';
        probe.onload = () => {
            hub.coverImg.src = url;
            hub.coverImg.classList.remove('hidden');
            hub.coverWrap.classList.remove('no-art');
            this.extractCoverColors(probe);
        };
        probe.onerror = () => {
            hub.coverImg.removeAttribute('src');
            hub.coverImg.classList.add('hidden');
            hub.coverWrap.classList.add('no-art');
            this.resetLyricsColors();
        };
        probe.src = url;
    }

    extractCoverColors(img) {
        try {
            const colors = this.calculateLyricsColors(img);
            if (colors && colors.background && colors.text) {
                this.applyLyricsColors(colors);
            } else {
                this.resetLyricsColors();
            }
        } catch (e) {
            this.resetLyricsColors();
        }
    }
}
