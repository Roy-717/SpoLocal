/*
 * Playlist page session entry point.
 * Initializes the session controller and enables column resizing.
 */
import { PlaylistSessionController } from './playlist/session.js?v=89';
import { PlaylistColumnResizer } from './ui/column_resizer.js';
import { PlaylistPlayerState } from './player/player_state.js';

const hub = (typeof window !== 'undefined' ? (window.SpolocalPlayerHub = window.SpolocalPlayerHub || {}) : {});
hub.streamBadgeEl = document.getElementById('player-stream-badge');
const state = new PlaylistPlayerState(hub);
const session = new PlaylistSessionController(state);
session.bootstrap();
// Expose transport methods through hub for global access
hub.resolveCurrentPlaySrc = () => session.transport.resolveCurrentPlaySrc();
hub.setPlayUi = (playing) => session.transport.setPlayUi(playing);
hub.playLibraryEntry = (entry) => session.transport.playLibraryEntry(entry);
PlaylistColumnResizer.init();
