export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRateMs: number;
  private lastRefill: number;
  private queue: Array<{ userId: string; resolve: () => void }> = [];
  private processTimer: NodeJS.Timeout | null = null;

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
    return new Promise((resolve) => {
      this.queue.push({ userId, resolve });
      this.scheduleProcess(0);
    });
  }

  private scheduleProcess(delayMs: number): void {
    if (this.processTimer) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processQueue();
    }, delayMs);
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;

    this.refill();

    const now = Date.now();
    const next = this.queue[0];
    if (!next) return;

    const globalSpacing = now - this.lastGlobalRequestTime;
    const accountSpacing = now - (this.lastAccountRequestTime.get(next.userId) ?? 0);

    if (
      this.tokens >= 1 &&
      globalSpacing >= this.MIN_CROSS_ACCOUNT_SPACING_MS &&
      accountSpacing >= this.MIN_PER_ACCOUNT_SPACING_MS
    ) {
      this.tokens -= 1;
      this.lastGlobalRequestTime = now;
      this.lastAccountRequestTime.set(next.userId, now);
      this.queue.shift();
      next.resolve();

      if (this.queue.length > 0) {
        this.scheduleProcess(this.MIN_CROSS_ACCOUNT_SPACING_MS);
      }
      return;
    }

    const waitGlobal = Math.max(0, this.MIN_CROSS_ACCOUNT_SPACING_MS - globalSpacing);
    const waitAccount = Math.max(0, this.MIN_PER_ACCOUNT_SPACING_MS - accountSpacing);
    const waitToken = this.tokens < 1 ? this.refillRateMs : 0;
    this.scheduleProcess(Math.max(waitGlobal, waitAccount, waitToken, 100));
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillRateMs) {
      const generated = Math.floor(elapsed / this.refillRateMs);
      this.tokens = Math.min(this.maxTokens, this.tokens + generated);
      this.lastRefill = now;
    }
  }
}
