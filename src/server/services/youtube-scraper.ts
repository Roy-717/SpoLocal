import { chromium, Page, Browser } from 'playwright';
import { load } from 'cheerio';
import { createHash } from 'crypto';
import { config } from '../config/index.js';
import { 
  ScrapedTrack, 
  ScrapeResult, 
  YTInitialData, 
  YTInitialPlayerResponse, 
  AudioFormat 
} from '@/shared/types/index.js';
import { 
  YOUTUBE_URLS, 
  YOUTUBE_PATTERNS, 
  SCRAPING_CONSTANTS 
} from '@/constants/index.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { logger } from '../utils/logger.js';

export class YouTubeScraper {
  private rateLimiter: RateLimiter;
  private browser: Browser | null = null;
  private userAgentIndex = 0;
  private requestCount = 0;
  private lastUserAgentRotation = 0;

  constructor() {
    this.rateLimiter = new RateLimiter(
      config.scraping.rateLimit.requestsPerMinute,
      60000, // 1 minute window
      config.scraping.rateLimit.burstLimit
    );
  }

  /**
   * Search for tracks on YouTube
   */
  async searchTracks(query: string, maxResults = 20): Promise<ScrapeResult> {
    try {
      await this.rateLimiter.waitForToken();
      
      const searchUrl = this.buildSearchUrl(query);
      const html = await this.fetchPage(searchUrl);
      
      if (!html) {
        return { tracks: [], error: 'Failed to fetch search results' };
      }

      const tracks = await this.parseSearchResults(html);
      
      return {
        tracks: tracks.slice(0, maxResults),
        totalResults: tracks.length,
      };
    } catch (error) {
      logger.error('Search failed:', error);
      return { 
        tracks: [], 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Get detailed track information including audio formats
   */
  async getTrackDetails(videoId: string): Promise<ScrapedTrack | null> {
    try {
      await this.rateLimiter.waitForToken();
      
      const watchUrl = `${YOUTUBE_URLS.WATCH}?v=${videoId}`;
      const html = await this.fetchPage(watchUrl);
      
      if (!html) {
        return null;
      }

      const track = await this.parseTrackDetails(html, videoId);
      return track;
    } catch (error) {
      logger.error(`Failed to get track details for ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Fetch page content with fallback to Playwright
   */
  private async fetchPage(url: string): Promise<string | null> {
    this.requestCount++;
    
    // Rotate user agent if needed
    if (this.requestCount - this.lastUserAgentRotation >= 
        config.scraping.proxy.rotateAfterRequests) {
      this.rotateUserAgent();
    }

    try {
      // Try regular HTTP request first
      const response = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(SCRAPING_CONSTANTS.DEFAULT_TIMEOUT),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      
      // Check if we got blocked or rate limited
      if (this.isBlockedResponse(html)) {
        logger.warn('Detected blocking, falling back to Playwright');
        return await this.fetchWithPlaywright(url);
      }

      return html;
    } catch (error) {
      logger.warn(`Regular fetch failed for ${url}:`, error);
      
      // Fallback to Playwright if enabled
      if (config.scraping.fallback.enablePlaywright) {
        return await this.fetchWithPlaywright(url);
      }
      
      return null;
    }
  }

  /**
   * Fetch page using Playwright (headless browser)
   */
  private async fetchWithPlaywright(url: string): Promise<string | null> {
    try {
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: true,
          timeout: config.scraping.fallback.playwrightTimeout,
        });
      }

      const page = await this.browser.newPage({
        userAgent: this.getCurrentUserAgent(),
        viewport: { width: 1920, height: 1080 },
      });

      // Set additional headers
      await page.setExtraHTTPHeaders(this.getHeaders());

      // Navigate to page
      await page.goto(url, { 
        waitUntil: 'networkidle', 
        timeout: config.scraping.fallback.playwrightTimeout 
      });

      // Wait for JavaScript to load
      await page.waitForTimeout(2000);

      const html = await page.content();
      await page.close();

      return html;
    } catch (error) {
      logger.error('Playwright fetch failed:', error);
      return null;
    }
  }

  /**
   * Parse search results from HTML
   */
  private async parseSearchResults(html: string): Promise<ScrapedTrack[]> {
    const tracks: ScrapedTrack[] = [];
    
    try {
      // Extract ytInitialData from script tag
      const ytInitialData = this.extractYtInitialData(html);
      
      if (!ytInitialData || !ytInitialData.contents) {
        logger.warn('No ytInitialData found in search results');
        return tracks;
      }

      // Navigate through YouTube's data structure
      const contents = ytInitialData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
      
      if (!contents) {
        logger.warn('Unexpected search results structure');
        return tracks;
      }

      // Process each section
      for (const section of contents) {
        if (section.itemSectionRenderer?.contents) {
          for (const item of section.itemSectionRenderer.contents) {
            const track = this.parseVideoRenderer(item);
            if (track) {
              tracks.push(track);
            }
          }
        }
      }

      return tracks;
    } catch (error) {
      logger.error('Failed to parse search results:', error);
      return tracks;
    }
  }

  /**
   * Parse individual video renderer from search results
   */
  private parseVideoRenderer(item: any): ScrapedTrack | null {
    try {
      const videoRenderer = item.videoRenderer;
      if (!videoRenderer) return null;

      const videoId = videoRenderer.videoId;
      if (!videoId) return null;

      const title = this.extractText(videoRenderer.title);
      const channelName = this.extractText(videoRenderer.ownerText);
      const durationText = this.extractText(videoRenderer.lengthText);
      const viewCountText = this.extractText(videoRenderer.viewCountText);
      
      // Extract thumbnail
      const thumbnail = videoRenderer.thumbnail?.thumbnails?.[0]?.url;
      
      // Parse duration
      const duration = this.parseDuration(durationText);
      
      // Parse view count
      const viewCount = this.parseViewCount(viewCountText);

      return {
        videoId,
        title: title || 'Unknown Title',
        artist: channelName || 'Unknown Artist',
        duration,
        thumbnailUrl: thumbnail || undefined,
        audioFormats: [], // Will be populated when getting track details
        viewCount,
      };
    } catch (error) {
      logger.error('Failed to parse video renderer:', error);
      return null;
    }
  }

  /**
   * Parse track details from watch page
   */
  private async parseTrackDetails(html: string, videoId: string): Promise<ScrapedTrack | null> {
    try {
      const ytInitialPlayerResponse = this.extractYtInitialPlayerResponse(html);
      
      if (!ytInitialPlayerResponse) {
        logger.warn(`No ytInitialPlayerResponse found for ${videoId}`);
        return null;
      }

      const videoDetails = ytInitialPlayerResponse.videoDetails;
      const streamingData = ytInitialPlayerResponse.streamingData;
      
      if (!videoDetails) {
        logger.warn(`No video details found for ${videoId}`);
        return null;
      }

      // Extract audio formats
      const audioFormats = this.extractAudioFormats(streamingData);

      // Get the best thumbnail
      const thumbnail = videoDetails.thumbnail?.thumbnails
        ?.sort((a, b) => b.width - a.width)?.[0]?.url;

      return {
        videoId,
        title: videoDetails.title || 'Unknown Title',
        artist: videoDetails.author || 'Unknown Artist',
        duration: parseInt(videoDetails.lengthSeconds || '0') || 0,
        thumbnailUrl: thumbnail || undefined,
        audioFormats,
        viewCount: parseInt(videoDetails.viewCount || '0') || 0,
      };
    } catch (error) {
      logger.error(`Failed to parse track details for ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Extract ytInitialData from HTML
   */
  private extractYtInitialData(html: string): YTInitialData | null {
    try {
      const match = html.match(/var ytInitialData = ({.+?});/);
      if (!match) return null;

      return JSON.parse(match[1]);
    } catch (error) {
      logger.error('Failed to extract ytInitialData:', error);
      return null;
    }
  }

  /**
   * Extract ytInitialPlayerResponse from HTML
   */
  private extractYtInitialPlayerResponse(html: string): YTInitialPlayerResponse | null {
    try {
      const match = html.match(/var ytInitialPlayerResponse = ({.+?});/);
      if (!match) return null;

      return JSON.parse(match[1]);
    } catch (error) {
      logger.error('Failed to extract ytInitialPlayerResponse:', error);
      return null;
    }
  }

  /**
   * Extract audio formats from streaming data
   */
  private extractAudioFormats(streamingData: any): AudioFormat[] {
    const formats: AudioFormat[] = [];
    
    if (!streamingData) return formats;

    // Process adaptive formats (better quality)
    if (streamingData.adaptiveFormats) {
      for (const format of streamingData.adaptiveFormats) {
        if (format.mimeType?.includes('audio')) {
          formats.push({
            itag: format.itag,
            url: format.url,
            mimeType: format.mimeType,
            bitrate: format.bitrate,
            contentLength: format.contentLength,
            quality: format.quality,
            audioQuality: format.audioQuality,
            audioSampleRate: format.audioSampleRate,
            audioChannels: format.audioChannels,
          });
        }
      }
    }

    // Process regular formats as fallback
    if (streamingData.formats) {
      for (const format of streamingData.formats) {
        if (format.mimeType?.includes('audio')) {
          formats.push({
            itag: format.itag,
            url: format.url,
            mimeType: format.mimeType,
            bitrate: format.bitrate,
            contentLength: format.contentLength,
            quality: format.quality,
            audioQuality: format.audioQuality,
          });
        }
      }
    }

    return formats;
  }

  /**
   * Extract text from YouTube's complex text objects
   */
  private extractText(textObj: any): string | null {
    if (!textObj) return null;
    
    if (typeof textObj === 'string') {
      return textObj;
    }
    
    if (textObj.simpleText) {
      return textObj.simpleText;
    }
    
    if (textObj.runs) {
      return textObj.runs.map((run: any) => run.text).join('');
    }
    
    return null;
  }

  /**
   * Parse duration string to seconds
   */
  private parseDuration(durationText: string | null): number {
    if (!durationText) return 0;
    
    const match = durationText.match(/(\d+):(\d+)/);
    if (!match) return 0;
    
    const minutes = parseInt(match[1]);
    const seconds = parseInt(match[2]);
    
    return minutes * 60 + seconds;
  }

  /**
   * Parse view count string to number
   */
  private parseViewCount(viewCountText: string | null): number {
    if (!viewCountText) return 0;
    
    const match = viewCountText.match(/(\d+(?:,\d+)*)/);
    if (!match) return 0;
    
    return parseInt(match[1].replace(/,/g, ''));
  }

  /**
   * Build search URL with query parameters
   */
  private buildSearchUrl(query: string): string {
    const params = new URLSearchParams({
      search_query: query,
      sp: 'EgIQAQ%3D%3D', // Filter for videos only
    });
    
    return `${YOUTUBE_URLS.SEARCH}?${params.toString()}`;
  }

  /**
   * Get current headers with rotation
   */
  private getHeaders(): Record<string, string> {
    return {
      ...config.scraping.headers,
      'User-Agent': this.getCurrentUserAgent(),
    };
  }

  /**
   * Get current user agent
   */
  private getCurrentUserAgent(): string {
    const userAgents = config.scraping.userAgents;
    return userAgents[this.userAgentIndex % userAgents.length];
  }

  /**
   * Rotate user agent
   */
  private rotateUserAgent(): void {
    this.userAgentIndex = (this.userAgentIndex + 1) % config.scraping.userAgents.length;
    this.lastUserAgentRotation = this.requestCount;
    logger.debug('Rotated user agent');
  }

  /**
   * Check if response indicates we're blocked
   */
  private isBlockedResponse(html: string): boolean {
    const blockingIndicators = [
      'blocked',
      'captcha',
      'unusual traffic',
      'try again later',
      'access denied',
      'rate limited',
    ];
    
    const lowerHtml = html.toLowerCase();
    return blockingIndicators.some(indicator => lowerHtml.includes(indicator));
  }

  /**
   * Generate cache key for scraped data
   */
  private generateCacheKey(url: string): string {
    return createHash('sha256')
      .update(url)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

// Export singleton instance
export const youtubeScraper = new YouTubeScraper();

// Cleanup on process exit
process.on('exit', () => {
  youtubeScraper.cleanup();
});

process.on('SIGINT', async () => {
  await youtubeScraper.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await youtubeScraper.cleanup();
  process.exit(0);
});