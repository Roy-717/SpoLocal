import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { config as dotenvConfig } from 'dotenv';

// Load environment variables
dotenvConfig();

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  acquireTimeout: number;
  timeout: number;
}

interface ServerConfig {
  port: number;
  host: string;
  cors: {
    origin: string | string[];
    credentials: boolean;
  };
}

interface WebSocketConfig {
  port: number;
  heartbeatInterval: number;
}

interface ScrapingConfig {
  userAgents: string[];
  headers: Record<string, string>;
  rateLimit: {
    requestsPerMinute: number;
    burstLimit: number;
    backoffMultiplier: number;
    maxBackoffMs: number;
    jitterMs: number;
  };
  fallback: {
    enablePlaywright: boolean;
    playwrightTimeout: number;
    maxRetries: number;
    retryDelay: number;
  };
  proxy: {
    enabled: boolean;
    pool: string[];
    rotateAfterRequests: number;
  };
}

interface AudioConfig {
  quality: {
    default: string;
    options: Array<{
      name: string;
      format: string;
    }>;
  };
  ytdlp: {
    executable: string;
    args: string[];
  };
  cache: {
    maxSizeGB: number;
    cleanupThresholdPercent: number;
    unusedDaysBeforeCleanup: number;
    compressionLevel: number;
  };
}

interface SecurityConfig {
  jwt: {
    secret: string;
    expiresIn: string;
    refreshExpiresIn: string;
  };
  bcrypt: {
    saltRounds: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
    message: string;
  };
  helmet: {
    contentSecurityPolicy: {
      directives: Record<string, string[]>;
    };
  };
}

interface LoggingConfig {
  level: string;
  format: string;
  file: string;
  maxFiles: number;
  maxSize: string;
}

interface AdminConfig {
  enabled: boolean;
  defaultUser: string;
  defaultPassword: string;
  sessionTimeout: number;
}

interface AppConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  websocket: WebSocketConfig;
  scraping: ScrapingConfig;
  audio: AudioConfig;
  security: SecurityConfig;
  logging: LoggingConfig;
  admin: AdminConfig;
  [key: string]: any;
}

class ConfigManager {
  private _config: AppConfig | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || join(process.cwd(), 'config.yaml');
  }

  private loadConfig(): AppConfig {
    if (!existsSync(this.configPath)) {
      throw new Error(`Configuration file not found: ${this.configPath}`);
    }

    try {
      const configFile = readFileSync(this.configPath, 'utf8');
      const rawConfig = parse(configFile);
      
      // Process environment variable substitutions
      const processedConfig = this.processEnvironmentVariables(rawConfig);
      
      // Validate required configuration
      this.validateConfig(processedConfig);
      
      return processedConfig;
    } catch (error) {
      throw new Error(`Failed to load configuration: ${error}`);
    }
  }

  private processEnvironmentVariables(obj: any): any {
    if (typeof obj === 'string') {
      // Replace ${VAR_NAME} with environment variable value
      return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const value = process.env[varName];
        if (value === undefined) {
          throw new Error(`Environment variable ${varName} is not set`);
        }
        return value;
      });
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.processEnvironmentVariables(item));
    }
    
    if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.processEnvironmentVariables(value);
      }
      return result;
    }
    
    return obj;
  }

  private validateConfig(config: any): void {
    const requiredPaths = [
      'server.port',
      'server.host',
      'database.host',
      'database.port',
      'database.user',
      'database.password',
      'database.database',
      'security.jwt.secret',
      'admin.defaultPassword',
    ];

    for (const path of requiredPaths) {
      if (!this.getNestedValue(config, path)) {
        throw new Error(`Required configuration missing: ${path}`);
      }
    }

    // Validate JWT secret length
    if (config.security.jwt.secret.length < 32) {
      throw new Error('JWT secret must be at least 32 characters long');
    }

    // Validate ports
    if (config.server.port < 1 || config.server.port > 65535) {
      throw new Error('Server port must be between 1 and 65535');
    }

    if (config.database.port < 1 || config.database.port > 65535) {
      throw new Error('Database port must be between 1 and 65535');
    }

    // Validate cache size
    if (config.audio.cache.maxSizeGB < 1) {
      throw new Error('Maximum cache size must be at least 1GB');
    }
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  get config(): AppConfig {
    if (!this._config) {
      this._config = this.loadConfig();
    }
    return this._config;
  }

  reload(): AppConfig {
    this._config = null;
    return this.config;
  }

  set(path: string, value: any): void {
    if (!this._config) {
      this._config = this.loadConfig();
    }

    const keys = path.split('.');
    let current = this._config;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key && !(key in current)) {
        current[key] = {};
      }
      if (key) {
        current = current[key];
      }
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      current[lastKey] = value;
    }
  }

  get(path: string): any {
    return this.getNestedValue(this.config, path);
  }

  has(path: string): boolean {
    return this.getNestedValue(this.config, path) !== undefined;
  }

  // Helper methods for common configurations
  isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development';
  }

  isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  isTest(): boolean {
    return process.env.NODE_ENV === 'test';
  }

  getLogLevel(): string {
    return process.env.LOG_LEVEL || this.config.logging.level;
  }

  getDatabaseUrl(): string {
    const { host, port, user, password, database } = this.config.database;
    return `mysql://${user}:${password}@${host}:${port}/${database}`;
  }

  getServerUrl(): string {
    const { host, port } = this.config.server;
    return `http://${host}:${port}`;
  }

  getWebSocketUrl(): string {
    const { host } = this.config.server;
    const { port } = this.config.websocket;
    return `ws://${host}:${port}`;
  }

  // Audio configuration helpers
  getAudioQualityFormat(quality: string): string {
    const option = this.config.audio.quality.options.find(opt => opt.name.toLowerCase() === quality.toLowerCase());
    return option ? option.format : this.config.audio.quality.default;
  }

  getYtDlpArgs(quality?: string): string[] {
    const baseArgs = [...this.config.audio.ytdlp.args];
    if (quality) {
      const format = this.getAudioQualityFormat(quality);
      baseArgs.push('--format', format);
    }
    return baseArgs;
  }

  // Security configuration helpers
  getJwtConfig() {
    return {
      secret: this.config.security.jwt.secret,
      expiresIn: this.config.security.jwt.expiresIn,
      refreshExpiresIn: this.config.security.jwt.refreshExpiresIn,
    };
  }

  getBcryptRounds(): number {
    return this.config.security.bcrypt.saltRounds;
  }

  // Rate limiting helpers
  getRateLimitConfig() {
    return {
      windowMs: this.config.security.rateLimit.windowMs,
      max: this.config.security.rateLimit.max,
      message: this.config.security.rateLimit.message,
    };
  }

  getScrapingRateLimit() {
    return {
      requestsPerMinute: this.config.scraping.rateLimit.requestsPerMinute,
      burstLimit: this.config.scraping.rateLimit.burstLimit,
      backoffMultiplier: this.config.scraping.rateLimit.backoffMultiplier,
      maxBackoffMs: this.config.scraping.rateLimit.maxBackoffMs,
      jitterMs: this.config.scraping.rateLimit.jitterMs,
    };
  }

  // Scraping configuration helpers
  getRandomUserAgent(): string {
    const userAgents = this.config.scraping.userAgents;
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  getScrapingHeaders(): Record<string, string> {
    return {
      ...this.config.scraping.headers,
      'User-Agent': this.getRandomUserAgent(),
    };
  }

  // Cache configuration helpers
  getCacheConfig() {
    return {
      maxSizeGB: this.config.audio.cache.maxSizeGB,
      cleanupThresholdPercent: this.config.audio.cache.cleanupThresholdPercent,
      unusedDaysBeforeCleanup: this.config.audio.cache.unusedDaysBeforeCleanup,
      compressionLevel: this.config.audio.cache.compressionLevel,
    };
  }

  // Admin configuration helpers
  getAdminConfig() {
    return {
      enabled: this.config.admin.enabled,
      defaultUser: this.config.admin.defaultUser,
      defaultPassword: this.config.admin.defaultPassword,
      sessionTimeout: this.config.admin.sessionTimeout,
    };
  }
}

// Create singleton instance
const configManager = new ConfigManager();

// Export configuration object
export const config = configManager.config;

// Export configuration manager for advanced usage
export { ConfigManager };

// Export individual configuration sections for convenience
export const dbConfig = config.database;
export const serverConfig = config.server;
export const wsConfig = config.websocket;
export const scrapingConfig = config.scraping;
export const audioConfig = config.audio;
export const securityConfig = config.security;
export const loggingConfig = config.logging;
export const adminConfig = config.admin;