/**
 * Play counters kept in localStorage: per track, per playlist and per day.
 * The transport writes them and the home view reads them, so they live here
 * instead of in either caller.
 */
const TRACKS_KEY = 'spolocal_track_plays';
const PLAYLISTS_KEY = 'spolocal_playlist_plays';
const DAYS_KEY = 'spolocal_play_log';
const MAX_DAYS = 60;

export class PlaylistPlayLog {
    static track_key(playlist_id, track_id) {
        return String(playlist_id || '').trim() + '|' + String(track_id || '').trim();
    }

    static read(key) {
        try {
            const raw = localStorage.getItem(key);
            const value = raw ? JSON.parse(raw) : {};
            return value && typeof value === 'object' ? value : {};
        } catch (e) {
            return {};
        }
    }

    static write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {}
    }

    static track_plays() {
        return PlaylistPlayLog.read(TRACKS_KEY);
    }

    static playlist_plays() {
        return PlaylistPlayLog.read(PLAYLISTS_KEY);
    }

    static day_plays() {
        return PlaylistPlayLog.read(DAYS_KEY);
    }

    /** Count one play of a track, its playlist and the day. */
    static count_track(playlist_id, track_id) {
        const pid = String(playlist_id || '').trim();
        const tid = String(track_id || '').trim();
        if (!pid || !tid) return;
        const tracks = PlaylistPlayLog.track_plays();
        const key = PlaylistPlayLog.track_key(pid, tid);
        tracks[key] = (Number(tracks[key]) || 0) + 1;
        PlaylistPlayLog.write(TRACKS_KEY, tracks);
        const playlists = PlaylistPlayLog.playlist_plays();
        playlists[pid] = (Number(playlists[pid]) || 0) + 1;
        PlaylistPlayLog.write(PLAYLISTS_KEY, playlists);
        PlaylistPlayLog.count_day();
    }

    /** Per-day counts, capped so the log cannot grow without bound. */
    static count_day() {
        const days = PlaylistPlayLog.day_plays();
        const today = PlaylistPlayLog.day(0);
        days[today] = (Number(days[today]) || 0) + 1;
        const keys = Object.keys(days).sort();
        while (keys.length > MAX_DAYS) delete days[keys.shift()];
        PlaylistPlayLog.write(DAYS_KEY, days);
    }

    /** YYYY-MM-DD for today minus offset_days. */
    static day(offset_days) {
        return new Date(Date.now() - (offset_days || 0) * 86400000).toISOString().slice(0, 10);
    }

    /** Plays in the last seven days, today included. */
    static week_plays() {
        const days = PlaylistPlayLog.day_plays();
        let total = 0;
        for (let i = 0; i < 7; i++) total += Number(days[PlaylistPlayLog.day(i)]) || 0;
        return total;
    }
}
