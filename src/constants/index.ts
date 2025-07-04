// API Routes
export const API_ROUTES = {
  // Authentication
  LOGIN: '/api/auth/login',
  LOGOUT: '/api/auth/logout',
  REFRESH: '/api/auth/refresh',
  REGISTER: '/api/auth/register',
  
  // Users
  USER_PROFILE: '/api/users/profile',
  USER_PREFERENCES: '/api/users/preferences',
  
  // Tracks
  SEARCH: '/api/tracks/search',
  TRACK_DETAILS: '/api/tracks/:id',
  TRACK_DOWNLOAD: '/api/tracks/download',
  TRACK_STREAM: '/api/tracks/stream/:id',
  TRACK_LIKE: '/api/tracks/:id/like',
  TRACK_UNLIKE: '/api/tracks/:id/unlike',
  
  // Playlists
  PLAYLISTS: '/api/playlists',
  PLAYLIST_DETAILS: '/api/playlists/:id',
  PLAYLIST_TRACKS: '/api/playlists/:id/tracks',
  PLAYLIST_ADD_TRACK: '/api/playlists/:id/tracks',
  PLAYLIST_REMOVE_TRACK: '/api/playlists/:id/tracks/:trackId',
  PLAYLIST_REORDER: '/api/playlists/:id/reorder',
  
  // Queue
  QUEUE: '/api/queue',
  QUEUE_ADD: '/api/queue/add',
  QUEUE_REMOVE: '/api/queue/remove/:id',
  QUEUE_REORDER: '/api/queue/reorder',
  QUEUE_CLEAR: '/api/queue/clear',
  
  // Admin
  ADMIN_STATS: '/api/admin/stats',
  ADMIN_USERS: '/api/admin/users',
  ADMIN_CACHE: '/api/admin/cache',
  ADMIN_LOGS: '/api/admin/logs',
  ADMIN_CONFIG: '/api/admin/config',
} as const;

// YouTube URLs and patterns
export const YOUTUBE_URLS = {
  BASE: 'https://www.youtube.com',
  SEARCH: 'https://www.youtube.com/results',
  WATCH: 'https://www.youtube.com/watch',
  MOBILE_BASE: 'https://m.youtube.com',
} as const;

export const YOUTUBE_PATTERNS = {
  VIDEO_ID: /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  PLAYLIST_ID: /[?&]list=([a-zA-Z0-9_-]+)/,
  TIMESTAMP: /[?&]t=([0-9]+)/,
} as const;

// Audio formats and quality
export const AUDIO_FORMATS = {
  WEBM: 'webm',
  M4A: 'm4a',
  MP3: 'mp3',
  OGG: 'ogg',
} as const;

export const AUDIO_QUALITY_ITAGS = {
  LOW: [139, 140, 141], // 48kbps, 128kbps, 256kbps AAC
  MEDIUM: [140, 141, 251], // 128kbps, 256kbps AAC, 160kbps Opus
  HIGH: [141, 251, 250], // 256kbps AAC, 160kbps Opus, 70kbps Opus
  BEST: [251, 250, 249, 141], // Best available Opus/AAC
} as const;

// Cache constants
export const CACHE_CONSTANTS = {
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB per file
  CLEANUP_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  ACCESS_UPDATE_INTERVAL: 60 * 1000, // 1 minute
  HASH_ALGORITHM: 'sha256',
} as const;

// Playback constants
export const PLAYBACK_CONSTANTS = {
  PRELOAD_THRESHOLD: 30, // seconds
  CROSSFADE_DURATION: 3, // seconds
  VOLUME_STEP: 0.1,
  SEEK_STEP: 10, // seconds
  MIN_PLAYBACK_SPEED: 0.25,
  MAX_PLAYBACK_SPEED: 3.0,
  SPEED_STEP: 0.25,
} as const;

// WebSocket constants
export const WEBSOCKET_CONSTANTS = {
  RECONNECT_INTERVAL: 5000, // 5 seconds
  MAX_RECONNECT_ATTEMPTS: 10,
  PING_INTERVAL: 30000, // 30 seconds
  PONG_TIMEOUT: 10000, // 10 seconds
} as const;

// Scraping constants
export const SCRAPING_CONSTANTS = {
  DEFAULT_TIMEOUT: 30000, // 30 seconds
  RETRY_DELAY: 5000, // 5 seconds
  MAX_RETRIES: 3,
  RATE_LIMIT_WINDOW: 60000, // 1 minute
  RATE_LIMIT_MAX: 10, // requests per window
  USER_AGENT_ROTATION_INTERVAL: 10, // requests
} as const;

// UI Constants
export const UI_CONSTANTS = {
  DEBOUNCE_DELAY: 300, // milliseconds
  ANIMATION_DURATION: 200, // milliseconds
  TOAST_DURATION: 3000, // milliseconds
  MODAL_ANIMATION_DURATION: 150, // milliseconds
} as const;

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS = {
  PLAY_PAUSE: 'Space',
  NEXT_TRACK: 'ArrowRight',
  PREVIOUS_TRACK: 'ArrowLeft',
  VOLUME_UP: 'ArrowUp',
  VOLUME_DOWN: 'ArrowDown',
  MUTE: 'KeyM',
  SHUFFLE: 'KeyS',
  REPEAT: 'KeyR',
  LIKE: 'KeyL',
  SEARCH: 'Slash',
  QUEUE: 'KeyQ',
  PLAYLISTS: 'KeyP',
  FULLSCREEN: 'KeyF',
  ESCAPE: 'Escape',
} as const;

// Validation constants
export const VALIDATION_CONSTANTS = {
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
  MIN_USERNAME_LENGTH: 3,
  MAX_USERNAME_LENGTH: 30,
  MAX_PLAYLIST_NAME_LENGTH: 100,
  MAX_PLAYLIST_DESCRIPTION_LENGTH: 500,
  MAX_SEARCH_QUERY_LENGTH: 100,
  MAX_TRACKS_PER_PLAYLIST: 5000,
  MAX_PLAYLISTS_PER_USER: 100,
} as const;

// Pagination constants
export const PAGINATION_CONSTANTS = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE: 1,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  UNKNOWN_ERROR: 'An unknown error occurred',
  VALIDATION_ERROR: 'Validation failed',
  NOT_FOUND: 'Resource not found',
  UNAUTHORIZED: 'Unauthorized access',
  FORBIDDEN: 'Access forbidden',
  RATE_LIMITED: 'Rate limit exceeded',
  SCRAPE_FAILED: 'Failed to scrape content',
  DOWNLOAD_FAILED: 'Failed to download audio',
  PLAYBACK_ERROR: 'Playback error occurred',
  CACHE_FULL: 'Cache storage is full',
  DATABASE_ERROR: 'Database error occurred',
  CONNECTION_ERROR: 'Connection error',
  INVALID_CREDENTIALS: 'Invalid username or password',
  USER_EXISTS: 'User already exists',
  TRACK_NOT_FOUND: 'Track not found',
  PLAYLIST_NOT_FOUND: 'Playlist not found',
  INVALID_AUDIO_FORMAT: 'Invalid audio format',
  AUDIO_NOT_AVAILABLE: 'Audio not available',
} as const;

// Success messages
export const SUCCESS_MESSAGES = {
  LOGIN_SUCCESS: 'Login successful',
  LOGOUT_SUCCESS: 'Logout successful',
  REGISTER_SUCCESS: 'Registration successful',
  PROFILE_UPDATED: 'Profile updated successfully',
  PREFERENCES_UPDATED: 'Preferences updated successfully',
  PLAYLIST_CREATED: 'Playlist created successfully',
  PLAYLIST_UPDATED: 'Playlist updated successfully',
  PLAYLIST_DELETED: 'Playlist deleted successfully',
  TRACK_ADDED: 'Track added to playlist',
  TRACK_REMOVED: 'Track removed from playlist',
  TRACK_LIKED: 'Track liked',
  TRACK_UNLIKED: 'Track unliked',
  TRACK_CACHED: 'Track cached successfully',
  QUEUE_UPDATED: 'Queue updated successfully',
} as const;

// Local storage keys
export const STORAGE_KEYS = {
  AUTH_TOKEN: 'ytmusic_auth_token',
  REFRESH_TOKEN: 'ytmusic_refresh_token',
  USER_PREFERENCES: 'ytmusic_user_preferences',
  PLAYBACK_STATE: 'ytmusic_playback_state',
  QUEUE_STATE: 'ytmusic_queue_state',
  SEARCH_HISTORY: 'ytmusic_search_history',
  THEME: 'ytmusic_theme',
  VOLUME: 'ytmusic_volume',
  OFFLINE_TRACKS: 'ytmusic_offline_tracks',
} as const;

// Media session action types
export const MEDIA_SESSION_ACTIONS = {
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT_TRACK: 'nexttrack',
  PREVIOUS_TRACK: 'previoustrack',
  SEEK_BACKWARD: 'seekbackward',
  SEEK_FORWARD: 'seekforward',
  SEEK_TO: 'seekto',
  STOP: 'stop',
} as const;

// File extensions
export const FILE_EXTENSIONS = {
  WEBM: '.webm',
  M4A: '.m4a',
  MP3: '.mp3',
  OGG: '.ogg',
  JSON: '.json',
  LOG: '.log',
} as const;

// MIME types
export const MIME_TYPES = {
  WEBM_AUDIO: 'audio/webm',
  M4A_AUDIO: 'audio/mp4',
  MP3_AUDIO: 'audio/mpeg',
  OGG_AUDIO: 'audio/ogg',
  JSON: 'application/json',
  TEXT: 'text/plain',
} as const;

// Regular expressions
export const REGEX_PATTERNS = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  USERNAME: /^[a-zA-Z0-9_-]{3,30}$/,
  SEARCH_QUERY: /^[^<>{}[\]\\`]*$/,
  PLAYLIST_NAME: /^[^<>{}[\]\\`"']*$/,
  VIDEO_ID: /^[a-zA-Z0-9_-]{11}$/,
  DURATION: /^(\d{1,2}:)?(\d{1,2}):(\d{2})$/,
} as const;

// Date formats
export const DATE_FORMATS = {
  ISO: 'YYYY-MM-DDTHH:mm:ss.sssZ',
  DISPLAY: 'MMM DD, YYYY',
  TIME: 'HH:mm:ss',
  RELATIVE: 'relative',
} as const;

// Feature flags
export const FEATURE_FLAGS = {
  ENABLE_ADMIN_PANEL: true,
  ENABLE_OFFLINE_MODE: true,
  ENABLE_SOCIAL_FEATURES: false,
  ENABLE_ANALYTICS: false,
  ENABLE_BETA_FEATURES: false,
} as const;