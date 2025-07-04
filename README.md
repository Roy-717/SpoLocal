# YTMusic Streaming

A self-hosted Spotify-style music streaming web application that scrapes YouTube content without using official APIs. Built with React, Node.js, and MySQL.

## Features

- 🎵 **YouTube Music Scraping** - Direct HTML scraping without APIs
- 🎧 **Gap-free Playback** - Queue management, shuffle, repeat, speed control
- 📱 **Offline-first PWA** - Works without internet once tracks are cached
- 🎨 **Clean UI** - Black/white design with purple (#8f23e8) accents
- 📂 **Playlists & Likes** - CRUD operations with drag-drop ordering
- 🔒 **Privacy-focused** - Only connects to YouTube, no tracking
- ⚡ **Fast Search** - Fuzzy search with filters (artist, album, duration)
- 🎹 **Keyboard Shortcuts** - Full keyboard navigation support
- 👤 **Multi-user** - User accounts with preferences and session memory
- 🛡️ **Rate Limiting** - Adaptive back-off to avoid YouTube blocks
- 🎯 **Admin Panel** - Cache management, user administration

## Architecture

### Backend
- **Node.js + Express** - REST API server
- **MySQL 8** - Database with optimized indexes
- **WebSocket** - Real-time queue synchronization
- **Cheerio/Playwright** - HTML parsing with headless browser fallback
- **yt-dlp integration** - Audio extraction and caching

### Frontend
- **React 18 + TypeScript** - Modern React with hooks
- **Zustand** - Lightweight state management
- **React Query** - Server state management and caching
- **Vite** - Fast development and build tool
- **PWA** - Service worker for offline functionality

### Configuration
- **YAML-based config** - Single `config.yaml` file for all settings
- **Environment variables** - Secure credential management
- **No Docker** - Uses .nvmrc and npm scripts for reproducible builds

## Quick Start

### Prerequisites

- Node.js 18+ (use .nvmrc for exact version)
- MySQL 8.0+
- yt-dlp installed globally
- 4GB+ free disk space for audio cache

### Installation

1. **Clone and setup:**
```bash
git clone <repository-url>
cd ytmusic-streaming
nvm use  # Uses version from .nvmrc
npm install
```

2. **Database setup:**
```bash
# Create MySQL user and database
mysql -u root -p
CREATE USER 'ytmusic'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON ytmusic_streaming.* TO 'ytmusic'@'localhost';
FLUSH PRIVILEGES;
```

3. **Environment configuration:**
```bash
cp .env.example .env
# Edit .env with your database password and secrets
```

4. **Run database migrations:**
```bash
npm run db:migrate
```

5. **Start development servers:**
```bash
npm run dev
```

This starts:
- Backend API server on http://localhost:3000
- Frontend dev server on http://localhost:5173
- WebSocket server on ws://localhost:3001

### Production Build

```bash
npm run build
npm start
```

## Configuration

Edit `config.yaml` to customize:

- **Audio quality and caching** - Set download quality, cache size limits
- **Scraping behavior** - Rate limits, user agent rotation, fallback settings
- **UI appearance** - Colors, layout dimensions, keyboard shortcuts
- **Security settings** - JWT secrets, rate limiting, CORS policies

### Key Configuration Sections

```yaml
audio:
  quality:
    default: "ba[ext=webm]/ba[ext=m4a]/ba"
  cache:
    maxSizeGB: 10
    cleanupThresholdPercent: 90

scraping:
  rateLimit:
    requestsPerMinute: 10
    burstLimit: 5
  fallback:
    enablePlaywright: true

ui:
  theme:
    colors:
      accent: "#8f23e8"
```

## Usage

### Default Admin Account
- Username: `admin`
- Password: `admin123` (change immediately!)

### API Endpoints

**Search:**
```bash
GET /api/tracks/search?q=song+title&limit=20
```

**Download track:**
```bash
POST /api/tracks/download
{
  "videoId": "dQw4w9WgXcQ",
  "quality": "medium"
}
```

**Stream audio:**
```bash
GET /api/tracks/stream/track-id
```

### Keyboard Shortcuts

- `Space` - Play/pause
- `→/←` - Next/previous track
- `↑/↓` - Volume up/down
- `M` - Mute toggle
- `S` - Shuffle toggle
- `R` - Repeat mode cycle
- `L` - Like current track
- `/` - Focus search
- `Q` - Show queue
- `P` - Show playlists

## Development

### Project Structure

```
src/
├── server/           # Backend API
│   ├── config/       # Configuration management
│   ├── controllers/  # Route handlers
│   ├── middleware/   # Express middleware
│   ├── models/       # Database models
│   ├── services/     # Business logic
│   └── utils/        # Helper functions
├── client/           # Frontend React app
│   ├── components/   # React components
│   ├── hooks/        # Custom React hooks
│   ├── pages/        # Page components
│   ├── services/     # Client-side services
│   ├── store/        # Zustand stores
│   └── utils/        # Client utilities
└── shared/           # Shared types and constants
    ├── types/        # TypeScript type definitions
    └── constants/    # Application constants
```

### NPM Scripts

```bash
npm run dev          # Start development servers
npm run build        # Build for production
npm run test         # Run test suite
npm run test:coverage # Run tests with coverage
npm run lint         # Lint code
npm run lint:fix     # Fix linting issues
npm run db:migrate   # Run database migrations
npm run db:seed      # Seed database with test data
```

### Code Style

- **TypeScript** - Strict mode with exact optional properties
- **ESLint + Prettier** - Enforced via pre-commit hooks
- **SOLID principles** - Clean architecture patterns
- **>=90% test coverage** - Jest with ts-jest

## Docker Alternative

This project intentionally avoids Docker for simplicity. Use these alternatives:

- **nvm** for Node version management
- **npm scripts** for all build/dev tasks
- **PM2** for production process management
- **nginx** for reverse proxy (optional)

## Security

- **No external APIs** - Only connects to YouTube
- **Rate limiting** - Prevents IP blocking
- **User agent rotation** - Mimics real browser behavior
- **JWT authentication** - Secure session management
- **Input validation** - Joi schema validation
- **SQL injection protection** - Parameterized queries

## Troubleshooting

### Common Issues

**"Failed to scrape" errors:**
- Check if yt-dlp is installed and updated
- Verify YouTube accessibility from your network
- Enable Playwright fallback in config

**Database connection errors:**
- Verify MySQL is running
- Check credentials in .env file
- Ensure database exists and user has permissions

**High memory usage:**
- Reduce cache size in config.yaml
- Enable cache cleanup (runs automatically)
- Check for memory leaks in logs

**Playback issues:**
- Clear browser cache and localStorage
- Check audio format support in browser
- Verify audio files aren't corrupted

### Debug Mode

```bash
LOG_LEVEL=debug npm run dev
```

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Development Guidelines

- Follow existing code style (enforced by ESLint/Prettier)
- Add tests for new features
- Update documentation for API changes
- Use conventional commit messages

## License

MIT License - see LICENSE file for details.

## Disclaimer

This project is for educational purposes. Users are responsible for compliance with YouTube's Terms of Service and local copyright laws. The authors are not responsible for any misuse of this software.

## Support

- 📖 [Documentation](docs/)
- 🐛 [Issue Tracker](issues/)
- 💬 [Discussions](discussions/)

---

**Note:** This application requires YouTube access and may break if YouTube changes their page structure. Regular updates may be needed to maintain functionality.