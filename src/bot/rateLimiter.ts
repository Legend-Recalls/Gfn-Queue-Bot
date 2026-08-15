export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRateMs: number;
  private lastRefill: number;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  // Track timestamps for spacing
  private lastGlobalRequestTime = 0;
  private lastAccountRequestTime = new Map<string, number>();

  // Configuration Constants
  private readonly MIN_CROSS_ACCOUNT_SPACING_MS = 500;
  private readonly MIN_PER_ACCOUNT_SPACING_MS = 2000;

  constructor(maxTokens = 10, windowMs = 10000) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRateMs = windowMs / maxTokens; // time to generate 1 token
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a slot for the request. Resolves when the rate limit and spacing rules are satisfied.
   */
  async acquire(userId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.processQueue(userId);
    });
  }

  private processQueue(userId?: string): void {
    if (this.queue.length === 0) return;

    this.refill();

    const now = Date.now();
    const globalSpacing = now - this.lastGlobalRequestTime;
    const accountSpacing = userId ? now - (this.lastAccountRequestTime.get(userId) ?? 0) : this.MIN_PER_ACCOUNT_SPACING_MS;

    // Check tokens and spacing requirements
    if (
      this.tokens >= 1 &&
      globalSpacing >= this.MIN_CROSS_ACCOUNT_SPACING_MS &&
      accountSpacing >= this.MIN_PER_ACCOUNT_SPACING_MS
    ) {
      // Consume a token and record request time
      this.tokens -= 1;
      this.lastGlobalRequestTime = now;
      if (userId) {
        this.lastAccountRequestTime.set(userId, now);
      }

      const next = this.queue.shift();
      if (next) {
        next.resolve();
      }

      // Process next item in queue asynchronously
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), this.MIN_CROSS_ACCOUNT_SPACING_MS);
      }
    } else {
      // Determine how long to wait before trying again
      const waitGlobal = Math.max(0, this.MIN_CROSS_ACCOUNT_SPACING_MS - globalSpacing);
      const waitAccount = userId ? Math.max(0, this.MIN_PER_ACCOUNT_SPACING_MS - accountSpacing) : 0;
      const waitToken = this.tokens < 1 ? this.refillRateMs : 0;

      const waitMs = Math.max(waitGlobal, waitAccount, waitToken, 100);

      setTimeout(() => this.processQueue(userId), waitMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > this.refillRateMs) {
      const generated = Math.floor(elapsed / this.refillRateMs);
      this.tokens = Math.min(this.maxTokens, this.tokens + generated);
      this.lastRefill = now;
    }
  }
}
