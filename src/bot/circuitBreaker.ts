export class ApiCircuitBreaker {
  private failureTimes: number[] = [];
  private openedUntil = 0;
  private halfOpenInFlight = false;

  constructor(
    private readonly failureThreshold = 5,
    private readonly failureWindowMs = 60_000,
    private readonly openDurationMs = 60_000,
  ) {}

  /** Return true when one request may be attempted. */
  tryAcquire(): boolean {
    const now = Date.now();
    this.prune(now);

    if (this.openedUntil > now) return false;
    if (this.openedUntil > 0) {
      if (this.halfOpenInFlight) return false;
      this.halfOpenInFlight = true;
    }
    return true;
  }

  /** Record a successful response. Normal successes do not erase recent failures. */
  recordSuccess(): void {
    if (this.openedUntil > 0 || this.halfOpenInFlight) {
      this.failureTimes = [];
    }
    this.openedUntil = 0;
    this.halfOpenInFlight = false;
    this.prune(Date.now());
  }

  /** Record a failed API request, opening the circuit after repeated failures. */
  recordFailure(): void {
    const now = Date.now();
    this.prune(now);
    this.failureTimes.push(now);
    this.halfOpenInFlight = false;

    if (this.openedUntil > 0 || this.failureTimes.length >= this.failureThreshold) {
      this.openedUntil = now + this.openDurationMs;
    }
  }

  get isOpen(): boolean {
    return this.openedUntil > Date.now() || this.halfOpenInFlight;
  }

  get recentFailureCount(): number {
    this.prune(Date.now());
    return this.failureTimes.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.failureWindowMs;
    this.failureTimes = this.failureTimes.filter((timestamp) => timestamp > cutoff);
  }
}
