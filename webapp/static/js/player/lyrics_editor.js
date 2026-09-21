/**
 * LRC editor: renders editable timestamped lines and saves them back to the
 * server. Owns ``hub.lrcEditLines`` while editing. Calls back into the lyrics
 * controller to re-fetch and to switch back to read mode after saving.
 */
export class LyricsEditorController {
    /**
     * @param {import('./player_state.js').PlaylistPlayerState} state
     * @param {import('./lyrics_controller.js').PlaylistLyricsController} lyrics
     */
    constructor(state, lyrics) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        this.lyrics = lyrics;
    }

    renderLrcEditor() {
        const hub = this.state.hub;
        if (!hub.lastLyricsPayload.lrc_data) {
            hub.lrcEditLines = [];
        } else {
            // Deep copy so we don't mutate the original
            hub.lrcEditLines = hub.lastLyricsPayload.lrc_data.map(item => ({ ...item }));
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
                    .map(line => ({ ...line })); // Deep copy
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
            await this.lyrics.fetchLyrics(false);
            hub.lyricsSaveStatus.classList.remove('hidden');
            this.lyrics.setLyricsMode('read');
            setTimeout(() => hub.lyricsSaveStatus.classList.add('hidden'), 3500);
        } catch (e) {
            alert('Could not save lyrics.');
        }
    }
}