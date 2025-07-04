-- YTMusic Streaming Database Schema
-- MySQL 8.0+ required

-- Drop existing database if it exists
DROP DATABASE IF EXISTS ytmusic_streaming;

-- Create database
CREATE DATABASE ytmusic_streaming CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use the database
USE ytmusic_streaming;

-- Users table
CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  preferences JSON DEFAULT '{}',
  INDEX idx_username (username),
  INDEX idx_email (email),
  INDEX idx_created_at (created_at)
);

-- Tracks table
CREATE TABLE tracks (
  id VARCHAR(36) PRIMARY KEY,
  video_id VARCHAR(11) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  artist VARCHAR(255) NOT NULL,
  album VARCHAR(255) DEFAULT NULL,
  duration INT NOT NULL,
  thumbnail_url TEXT DEFAULT NULL,
  audio_url TEXT DEFAULT NULL,
  itag INT DEFAULT NULL,
  quality VARCHAR(20) DEFAULT NULL,
  format VARCHAR(20) DEFAULT NULL,
  file_size BIGINT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  scrape_count INT DEFAULT 0,
  view_count BIGINT DEFAULT 0,
  INDEX idx_video_id (video_id),
  INDEX idx_title (title),
  INDEX idx_artist (artist),
  INDEX idx_album (album),
  INDEX idx_duration (duration),
  INDEX idx_created_at (created_at),
  FULLTEXT idx_search (title, artist, album)
);

-- User tracks (for tracking user-specific data like likes, play counts)
CREATE TABLE user_tracks (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  liked BOOLEAN DEFAULT FALSE,
  play_count INT DEFAULT 0,
  last_played_at TIMESTAMP NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_track (user_id, track_id),
  INDEX idx_user_liked (user_id, liked),
  INDEX idx_user_play_count (user_id, play_count),
  INDEX idx_last_played (last_played_at)
);

-- Playlists table
CREATE TABLE playlists (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT DEFAULT NULL,
  thumbnail_url TEXT DEFAULT NULL,
  is_public BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  track_count INT DEFAULT 0,
  total_duration INT DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_playlists (user_id),
  INDEX idx_public_playlists (is_public),
  INDEX idx_created_at (created_at),
  INDEX idx_name (name)
);

-- Playlist tracks (many-to-many relationship)
CREATE TABLE playlist_tracks (
  id VARCHAR(36) PRIMARY KEY,
  playlist_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  position INT NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  added_by VARCHAR(36) DEFAULT NULL,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_playlist_track (playlist_id, track_id),
  INDEX idx_playlist_position (playlist_id, position),
  INDEX idx_track_playlists (track_id),
  INDEX idx_added_at (added_at)
);

-- Queue items table
CREATE TABLE queue_items (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  position INT NOT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  session_id VARCHAR(255) DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
  INDEX idx_user_queue (user_id, position),
  INDEX idx_session_queue (session_id, position),
  INDEX idx_added_at (added_at)
);

-- User sessions table
CREATE TABLE user_sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  session_token VARCHAR(255) UNIQUE NOT NULL,
  refresh_token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_session_token (session_token),
  INDEX idx_refresh_token (refresh_token),
  INDEX idx_user_sessions (user_id),
  INDEX idx_expires_at (expires_at),
  INDEX idx_active_sessions (is_active, expires_at)
);

-- Playback history table
CREATE TABLE playback_history (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  track_id VARCHAR(36) NOT NULL,
  played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_played INT DEFAULT 0,
  completion_percentage DECIMAL(5,2) DEFAULT 0,
  session_id VARCHAR(255) DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
  INDEX idx_user_history (user_id, played_at),
  INDEX idx_track_history (track_id, played_at),
  INDEX idx_session_history (session_id, played_at)
);

-- Cache entries table
CREATE TABLE cache_entries (
  id VARCHAR(36) PRIMARY KEY,
  cache_key VARCHAR(255) UNIQUE NOT NULL,
  video_id VARCHAR(11) NOT NULL,
  itag INT NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  quality VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  access_count INT DEFAULT 0,
  expires_at TIMESTAMP NULL,
  is_permanent BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (video_id) REFERENCES tracks(video_id) ON DELETE CASCADE,
  INDEX idx_cache_key (cache_key),
  INDEX idx_video_id (video_id),
  INDEX idx_last_accessed (last_accessed_at),
  INDEX idx_expires_at (expires_at),
  INDEX idx_file_size (file_size),
  UNIQUE KEY unique_video_itag (video_id, itag)
);

-- Scrape cache table (for caching scraped data)
CREATE TABLE scrape_cache (
  id VARCHAR(36) PRIMARY KEY,
  cache_key VARCHAR(255) UNIQUE NOT NULL,
  url_hash VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  hit_count INT DEFAULT 0,
  last_hit_at TIMESTAMP NULL,
  INDEX idx_cache_key (cache_key),
  INDEX idx_url_hash (url_hash),
  INDEX idx_expires_at (expires_at),
  INDEX idx_last_hit (last_hit_at)
);

-- Rate limiting table
CREATE TABLE rate_limits (
  id VARCHAR(36) PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  request_count INT DEFAULT 0,
  window_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  window_end TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_identifier_endpoint (identifier, endpoint),
  INDEX idx_window_end (window_end),
  UNIQUE KEY unique_identifier_endpoint_window (identifier, endpoint, window_start)
);

-- Admin logs table
CREATE TABLE admin_logs (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) DEFAULT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) DEFAULT NULL,
  resource_id VARCHAR(36) DEFAULT NULL,
  details JSON DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  user_agent TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user_logs (user_id, created_at),
  INDEX idx_action (action),
  INDEX idx_resource (resource_type, resource_id),
  INDEX idx_created_at (created_at)
);

-- Application settings table
CREATE TABLE app_settings (
  id VARCHAR(36) PRIMARY KEY,
  key_name VARCHAR(100) UNIQUE NOT NULL,
  value JSON NOT NULL,
  description TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by VARCHAR(36) DEFAULT NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_key_name (key_name),
  INDEX idx_updated_at (updated_at)
);

-- Search history table
CREATE TABLE search_history (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) DEFAULT NULL,
  query VARCHAR(255) NOT NULL,
  filters JSON DEFAULT NULL,
  results_count INT DEFAULT 0,
  search_time_ms INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45) DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user_searches (user_id, created_at),
  INDEX idx_query (query),
  INDEX idx_created_at (created_at)
);

-- System stats table (for monitoring)
CREATE TABLE system_stats (
  id VARCHAR(36) PRIMARY KEY,
  metric_name VARCHAR(100) NOT NULL,
  metric_value DECIMAL(15,4) NOT NULL,
  metric_unit VARCHAR(20) DEFAULT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tags JSON DEFAULT NULL,
  INDEX idx_metric_name (metric_name),
  INDEX idx_recorded_at (recorded_at),
  INDEX idx_metric_name_time (metric_name, recorded_at)
);

-- Indexes for performance optimization
CREATE INDEX idx_tracks_search ON tracks(title, artist, album);
CREATE INDEX idx_user_tracks_activity ON user_tracks(user_id, last_played_at, play_count);
CREATE INDEX idx_playlist_tracks_order ON playlist_tracks(playlist_id, position);
CREATE INDEX idx_queue_user_order ON queue_items(user_id, position);
CREATE INDEX idx_cache_lru ON cache_entries(last_accessed_at, access_count);
CREATE INDEX idx_playback_recent ON playback_history(user_id, played_at DESC);

-- Triggers for maintaining data consistency

-- Update playlist track count and duration
DELIMITER $$
CREATE TRIGGER update_playlist_stats_insert
AFTER INSERT ON playlist_tracks
FOR EACH ROW
BEGIN
  UPDATE playlists p
  SET track_count = (
    SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id
  ),
  total_duration = (
    SELECT COALESCE(SUM(t.duration), 0) 
    FROM playlist_tracks pt 
    JOIN tracks t ON pt.track_id = t.id 
    WHERE pt.playlist_id = p.id
  )
  WHERE p.id = NEW.playlist_id;
END$$

CREATE TRIGGER update_playlist_stats_delete
AFTER DELETE ON playlist_tracks
FOR EACH ROW
BEGIN
  UPDATE playlists p
  SET track_count = (
    SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id
  ),
  total_duration = (
    SELECT COALESCE(SUM(t.duration), 0) 
    FROM playlist_tracks pt 
    JOIN tracks t ON pt.track_id = t.id 
    WHERE pt.playlist_id = p.id
  )
  WHERE p.id = OLD.playlist_id;
END$$

-- Update user track play count
CREATE TRIGGER update_user_track_play_count
AFTER INSERT ON playback_history
FOR EACH ROW
BEGIN
  INSERT INTO user_tracks (id, user_id, track_id, play_count, last_played_at)
  VALUES (
    UUID(),
    NEW.user_id,
    NEW.track_id,
    1,
    NEW.played_at
  )
  ON DUPLICATE KEY UPDATE
    play_count = play_count + 1,
    last_played_at = NEW.played_at;
END$$

-- Update cache access statistics
CREATE TRIGGER update_cache_access
AFTER UPDATE ON cache_entries
FOR EACH ROW
BEGIN
  IF NEW.last_accessed_at > OLD.last_accessed_at THEN
    UPDATE cache_entries 
    SET access_count = access_count + 1 
    WHERE id = NEW.id;
  END IF;
END$$

DELIMITER ;

-- Insert default admin user (password: admin123)
INSERT INTO users (id, username, email, password_hash, is_admin, created_at) 
VALUES (
  UUID(),
  'admin',
  'admin@ytmusic.local',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewvLAhcSgkGKBfEm', -- bcrypt hash of 'admin123'
  TRUE,
  NOW()
);

-- Insert default app settings
INSERT INTO app_settings (id, key_name, value, description) VALUES
(UUID(), 'max_cache_size_gb', '10', 'Maximum cache size in GB'),
(UUID(), 'default_audio_quality', '"medium"', 'Default audio quality for new users'),
(UUID(), 'rate_limit_per_hour', '100', 'Rate limit per hour for regular users'),
(UUID(), 'enable_public_registration', 'true', 'Allow public user registration'),
(UUID(), 'max_playlist_tracks', '5000', 'Maximum tracks per playlist'),
(UUID(), 'cache_cleanup_interval_hours', '24', 'Cache cleanup interval in hours'),
(UUID(), 'scrape_timeout_seconds', '30', 'Scraping timeout in seconds'),
(UUID(), 'max_concurrent_downloads', '5', 'Maximum concurrent downloads'),
(UUID(), 'enable_offline_mode', 'true', 'Enable offline mode features'),
(UUID(), 'session_timeout_hours', '168', 'Session timeout in hours (7 days)');

-- Grant privileges (adjust as needed for your setup)
-- CREATE USER 'ytmusic'@'localhost' IDENTIFIED BY 'your_password_here';
-- GRANT ALL PRIVILEGES ON ytmusic_streaming.* TO 'ytmusic'@'localhost';
-- FLUSH PRIVILEGES;