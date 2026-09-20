/*
 * Playlist page session entry point.
 * Initializes the session controller and enables column resizing.
 */
import { PlaylistSessionController } from './playlist/session.js?v=106';
import { PlaylistColumnResizer } from './ui/column_resizer.js';
import { PlaylistPlayerState } from './player/player_state.js';
import { MseStreamController } from './player/mse_stream_controller.js?v=8';

const hub = (typeof window !== 'undefined' ? (window.SpolocalPlayerHub = window.SpolocalPlayerHub || {}) : {});
hub.streamBadgeEl = document.getElementById('player-stream-badge');
const state = new PlaylistPlayerState(hub);
const session = new PlaylistSessionController(state);
session.bootstrap();
const mse = new MseStreamController();
window.SpolocalMse = mse;
// Expose transport methods through hub for global access
hub.resolveCurrentPlaySrc = () => session.transport.resolveCurrentPlaySrc();
hub.setPlayUi = (playing) => session.transport.setPlayUi(playing);
hub.playLibraryEntry = (entry) => session.transport.playLibraryEntry(entry);
hub.onMseStreamEnded = () => session.transport.advance_search_stream();
PlaylistColumnResizer.init();
