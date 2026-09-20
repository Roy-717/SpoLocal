/**
 * Shuffle/repeat mode state: button UI, persisted order, and shuffled-order
 * bookkeeping. The ordering decisions themselves live here; playback moves to
 * the next track stays in the transport controller.
 */
export class PlaylistShuffleController {
    /** @param {import('./player_state.js').PlaylistPlayerState} state */
    constructor(state) {
        /** @type {import('./player_state.js').PlaylistPlayerState} */
        this.state = state;
        /** @type {import('./queue_controller.js').PlaylistQueueController|null} */
        this.queue = null;
    }

    setQueueRef(queue) {
        this.queue = queue;
    }

    persistShuffle() {
        try { localStorage.setItem(this.state.hub.LS_SHUFFLE, String(this.state.hub.shuffleOn)); } catch (e) {}
    }

    persistRepeat() {
        try { localStorage.setItem(this.state.hub.LS_REPEAT, this.state.hub.repeatMode); } catch (e) {}
    }

    shuffleArrayInPlace(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    }

    persist_shuffle_order_state() {
        const hub = this.state.hub;
        try {
            if (!hub.shuffleOn || !hub.playable.length) {
                localStorage.removeItem(hub.LS_SHUFFLE_ORDER);
                return;
            }
            const pid = String(hub.playlistId || '').trim();
            if (!pid || !hub.shuffledOrder.length) return;
            localStorage.setItem(hub.LS_SHUFFLE_ORDER, JSON.stringify({
                playlist_id: pid,
                order: hub.shuffledOrder.map(function (id) { return String(id); }),
            }));
        } catch (e) {}
    }

    shuffle_order_matches_playable(saved) {
        const hub = this.state.hub;
        if (!Array.isArray(saved) || !hub.playable.length) return false;
        const want = hub.playable.map(function (t) { return String(t.id); }).sort();
        const got = saved.map(function (id) { return String(id); }).sort();
        if (want.length !== got.length) return false;
        for (let i = 0; i < want.length; i++) {
            if (want[i] !== got[i]) return false;
        }
        return true;
    }

    restore_shuffle_order_from_storage() {
        const hub = this.state.hub;
        if (!hub.shuffleOn || !hub.playable.length) return false;
        try {
            const raw = localStorage.getItem(hub.LS_SHUFFLE_ORDER);
            if (!raw) return false;
            const o = JSON.parse(raw);
            if (!o || String(o.playlist_id || '') !== String(hub.playlistId || '')) {
                try { localStorage.removeItem(hub.LS_SHUFFLE_ORDER); } catch (e2) {}
                return false;
            }
            const saved = Array.isArray(o.order) ? o.order : [];
            if (!this.shuffle_order_matches_playable(saved)) {
                try { localStorage.removeItem(hub.LS_SHUFFLE_ORDER); } catch (e2) {}
                return false;
            }
            const mapped = [];
            for (let si = 0; si < saved.length; si++) {
                const sid = String(saved[si]);
                let hit = null;
                for (let pi = 0; pi < hub.playable.length; pi++) {
                    if (String(hub.playable[pi].id) === sid) {
                        hit = hub.playable[pi].id;
                        break;
                    }
                }
                if (hit == null) return false;
                mapped.push(hit);
            }
            hub.shuffledOrder = mapped;
            return true;
        } catch (e) {
            try { localStorage.removeItem(hub.LS_SHUFFLE_ORDER); } catch (e2) {}
            return false;
        }
    }

    rebuildShuffledOrder() {
        const hub = this.state.hub;
        hub.shuffledOrder = hub.playable.map(function (t) { return t.id; });
        this.shuffleArrayInPlace(hub.shuffledOrder);
        this.persist_shuffle_order_state();
    }

    syncShuffleOrderWithPlaylist() {
        const hub = this.state.hub;
        if (!hub.shuffleOn || !hub.playable.length) return;
        const ids = new Set(hub.playable.map(function (t) { return t.id; }));
        if (hub.shuffledOrder.length !== hub.playable.length || hub.shuffledOrder.some(function (id) { return !ids.has(id); })) {
            this.rebuildShuffledOrder();
        }
    }

    updateShuffleRepeatUi() {
        const hub = this.state.hub;
        if (hub.btnShuffle) {
            hub.btnShuffle.classList.toggle('player-control-btn--active', hub.shuffleOn);
            hub.btnShuffle.classList.toggle('player-control-btn--muted', !hub.shuffleOn);
            hub.btnShuffle.setAttribute('aria-pressed', hub.shuffleOn ? 'true' : 'false');
        }
        if (hub.btnRepeat) {
            const active = hub.repeatMode !== 'off';
            hub.btnRepeat.classList.toggle('player-control-btn--active', active);
            hub.btnRepeat.classList.toggle('player-control-btn--muted', !active);
            hub.btnRepeat.setAttribute('aria-pressed', active ? 'true' : 'false');
            let title = 'Repeat: off';
            if (hub.repeatMode === 'all') title = 'Repeat: all';
            else if (hub.repeatMode === 'one') title = 'Repeat one';
            hub.btnRepeat.setAttribute('title', title);
        }
        if (hub.repeatOneBadge) {
            hub.repeatOneBadge.classList.toggle('hidden', hub.repeatMode !== 'one');
        }
        if (hub.queueVisible && this.queue) {
            this.queue.render_queue_list();
        }
    }
}