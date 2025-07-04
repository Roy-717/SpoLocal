// Core domain types
export interface Track {
  id: string;
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumbnailUrl?: string;
  audioUrl?: string;
  itag?: number;
  quality?: string;
  format?: string;
  fileSize?: number;
  addedAt: Date;
  lastPlayedAt?: Date;
  playCount: number;
  liked: boolean;
  cached: boolean;
  cacheKey?: string;
}

export interface Playlist {
  id: string;
  userId: string;
  name: string;
  description?: string;
  thumbnailUrl?: string;
  tracks: Track[];
  createdAt: Date;
  updatedAt: Date;
  isPublic: boolean;
  trackCount: number;
  duration: number;
}

export interface User {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
  lastLoginAt: Date;
  preferences: UserPreferences;
  isAdmin: boolean;
}

export interface UserPreferences {
  volume: number;
  playbackSpeed: number;
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  volumeNormalization: boolean;
  audioQuality: AudioQuality;
  theme: Theme;
  keyboardShortcuts: boolean;
}

export interface QueueItem {
  id: string;
  track: Track;
  order: number;
  addedAt: Date;
  addedBy?: string;
}

export interface PlaybackState {
  currentTrack: Track | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isPaused: boolean;
  isLoading: boolean;
  volume: number;
  playbackSpeed: number;
  repeatMode: RepeatMode;
  shuffleEnabled: boolean;
  queue: QueueItem[];
  currentQueueIndex: number;
  history: Track[];
}

export interface SearchResult {
  tracks: Track[];
  totalCount: number;
  query: string;
  filters: SearchFilters;
  searchTime: number;
}

export interface SearchFilters {
  artist?: string;
  album?: string;
  duration?: {
    min?: number;
    max?: number;
  };
  quality?: AudioQuality;
  sortBy?: SearchSortBy;
  sortOrder?: SortOrder;
}

// API types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

export interface PaginatedResponse<T = any> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    totalPages: number;
    totalItems: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  token: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  page?: number;
  limit?: number;
}

export interface DownloadRequest {
  videoId: string;
  quality?: AudioQuality;
  format?: string;
}

export interface DownloadResponse {
  success: boolean;
  track?: Track;
  error?: string;
  progress?: number;
}

// WebSocket types
export interface WebSocketMessage {
  type: WebSocketMessageType;
  data: any;
  timestamp: Date;
  userId?: string;
}

export interface PlaybackSyncMessage {
  type: 'PLAYBACK_SYNC';
  data: PlaybackState;
}

export interface QueueSyncMessage {
  type: 'QUEUE_SYNC';
  data: {
    queue: QueueItem[];
    currentIndex: number;
  };
}

export interface UserJoinMessage {
  type: 'USER_JOIN';
  data: {
    userId: string;
    username: string;
  };
}

export interface UserLeaveMessage {
  type: 'USER_LEAVE';
  data: {
    userId: string;
  };
}

// Scraping types
export interface YTInitialData {
  contents?: any;
  metadata?: any;
  microformat?: any;
  sidebar?: any;
  header?: any;
}

export interface YTInitialPlayerResponse {
  videoDetails?: {
    videoId: string;
    title: string;
    lengthSeconds: string;
    channelId: string;
    shortDescription: string;
    thumbnail: {
      thumbnails: Array<{
        url: string;
        width: number;
        height: number;
      }>;
    };
    viewCount: string;
    author: string;
    isLiveContent: boolean;
  };
  streamingData?: {
    formats: AudioFormat[];
    adaptiveFormats: AudioFormat[];
    expiresInSeconds: string;
  };
  playabilityStatus?: {
    status: string;
    reason?: string;
  };
}

export interface AudioFormat {
  itag: number;
  url: string;
  mimeType: string;
  bitrate: number;
  width?: number;
  height?: number;
  contentLength?: string;
  quality: string;
  fps?: number;
  qualityLabel?: string;
  audioQuality?: string;
  approxDurationMs?: string;
  audioSampleRate?: string;
  audioChannels?: number;
}

export interface ScrapedTrack {
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  thumbnailUrl?: string;
  audioFormats: AudioFormat[];
  viewCount?: number;
  publishedAt?: Date;
}

export interface ScrapeResult {
  tracks: ScrapedTrack[];
  continuation?: string;
  totalResults?: number;
  error?: string;
}

// Cache types
export interface CacheEntry {
  key: string;
  videoId: string;
  itag: number;
  filePath: string;
  fileSize: number;
  mimeType: string;
  quality: string;
  createdAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
}

export interface CacheStats {
  totalSize: number;
  totalFiles: number;
  availableSpace: number;
  hitRate: number;
  oldestEntry: Date;
  newestEntry: Date;
}

// Admin types
export interface AdminStats {
  users: {
    total: number;
    active: number;
    new: number;
  };
  tracks: {
    total: number;
    cached: number;
    totalSize: number;
  };
  playlists: {
    total: number;
    public: number;
    private: number;
  };
  system: {
    uptime: number;
    memory: {
      used: number;
      total: number;
    };
    storage: {
      used: number;
      total: number;
    };
  };
  scraping: {
    requestsToday: number;
    requestsThisHour: number;
    successRate: number;
    avgResponseTime: number;
  };
}

// Enums
export enum RepeatMode {
  OFF = 'off',
  TRACK = 'track',
  QUEUE = 'queue',
}

export enum AudioQuality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  BEST = 'best',
}

export enum Theme {
  LIGHT = 'light',
  DARK = 'dark',
  SYSTEM = 'system',
}

export enum SearchSortBy {
  RELEVANCE = 'relevance',
  TITLE = 'title',
  ARTIST = 'artist',
  DURATION = 'duration',
  DATE_ADDED = 'date_added',
  PLAY_COUNT = 'play_count',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export enum WebSocketMessageType {
  PLAYBACK_SYNC = 'PLAYBACK_SYNC',
  QUEUE_SYNC = 'QUEUE_SYNC',
  USER_JOIN = 'USER_JOIN',
  USER_LEAVE = 'USER_LEAVE',
  TRACK_LIKED = 'TRACK_LIKED',
  TRACK_CACHED = 'TRACK_CACHED',
  PING = 'PING',
  PONG = 'PONG',
}

export enum CacheStrategy {
  LRU = 'lru',
  LFU = 'lfu',
  FIFO = 'fifo',
}

export enum PlaybackEvent {
  PLAY = 'play',
  PAUSE = 'pause',
  NEXT = 'next',
  PREVIOUS = 'previous',
  SEEK = 'seek',
  VOLUME_CHANGE = 'volume_change',
  SPEED_CHANGE = 'speed_change',
  REPEAT_CHANGE = 'repeat_change',
  SHUFFLE_CHANGE = 'shuffle_change',
  TRACK_END = 'track_end',
  TRACK_ERROR = 'track_error',
}

// Error types
export interface AppError {
  code: string;
  message: string;
  details?: any;
  stack?: string;
  timestamp: Date;
}

export enum ErrorCode {
  // General errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  
  // Scraping errors
  SCRAPE_FAILED = 'SCRAPE_FAILED',
  RATE_LIMITED = 'RATE_LIMITED',
  BLOCKED = 'BLOCKED',
  INVALID_URL = 'INVALID_URL',
  
  // Audio errors
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  AUDIO_NOT_AVAILABLE = 'AUDIO_NOT_AVAILABLE',
  PLAYBACK_ERROR = 'PLAYBACK_ERROR',
  
  // Cache errors
  CACHE_FULL = 'CACHE_FULL',
  CACHE_ERROR = 'CACHE_ERROR',
  
  // Database errors
  DATABASE_ERROR = 'DATABASE_ERROR',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
}