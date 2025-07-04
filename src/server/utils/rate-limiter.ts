export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond
  private readonly windowMs: number;

  constructor(
    maxRequests: number,
    windowMs: number,
    burstLimit?: number
  ) {
    this.maxTokens = burstLimit || maxRequests;
    this.tokens = this.maxTokens;
    this.windowMs = windowMs;
    this.refillRate = maxRequests / windowMs;
    this.lastRefill = Date.now();
  }

  /**
   * Wait for a token to become available
   */
  async waitForToken(): Promise<void> {
    await this.refillTokens();
    
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }

    // Calculate wait time
    const waitTime = Math.ceil(1 / this.refillRate);
    
    return new Promise((resolve) => {
      setTimeout(async () => {
        await this.waitForToken();
        resolve();
      }, waitTime);
    });
  }

  /**
   * Check if a request can be made immediately
   */
  canMakeRequest(): boolean {
    this.refillTokens();
    return this.tokens >= 1;
  }

  /**
   * Try to consume a token
   */
  tryConsume(): boolean {
    this.refillTokens();
    
    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    
    return false;
  }

  /**
   * Get remaining tokens
   */
  getRemainingTokens(): number {
    this.refillTokens();
    return Math.floor(this.tokens);
  }

  /**
   * Get time until next token is available
   */
  getTimeUntilNextToken(): number {
    this.refillTokens();
    
    if (this.tokens >= 1) {
      return 0;
    }
    
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  /**
   * Refill tokens based on time passed
   */
  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    
    if (timePassed > 0) {
      const tokensToAdd = timePassed * this.refillRate;
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}