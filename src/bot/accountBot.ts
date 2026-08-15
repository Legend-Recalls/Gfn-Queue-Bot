import { EventEmitter } from "node:events";

import { AuthManager, AuthExpiredError, StoredAccount } from "../gfn/auth";
import {
  SESSION_STATUS,
  SessionError,
  SessionInfo,
  createSession,
  getActiveSessions,
  pollSession,
  stopSession,
} from "../gfn/session";
import type { DeviceFingerprint } from "../gfn/fingerprint";
import type { MetricsStore, QueueSample } from "../metrics/store";
import type { ApiCircuitBreaker } from "./circuitBreaker";
import type { RateLimiter } from "./rateLimiter";

export type AccountPhase =
  | "idle"
  | "starting"
  | "queueing"
  | "ready"
  | "holding"
  | "claimed"
  | "ending"
  | "cooldown"
  | "error"
  | "paused"
  | "needs_relogin";

export interface AccountStatus {
  userId: string;
  displayName: string;
  email?: string;
  phase: AccountPhase;
  appId: string;
  sessionId?: string;
  serverIp?: string;
  streamingBaseUrl?: string;
  queuePosition?: number;
  startedAt?: number;
  reachedReadyAt?: number;
  holdStartedAt?: number;
  holdExpiresAt?: number;
  claimedAt?: number;
  /** Timestamp of the last time the orchestrator activated this bot's queue. */
  lastActivatedAt?: number;
  /** True when in holding phase but the buffer period hasn't elapsed yet. */
  isBuffering?: boolean;
  lastError?: string;
  lastUpdateAt: number;
  pollIntervalMs: number;
  cooldownUntil?: number;
  consecutiveErrors: number;
  currentSampleId?: string;
}

export interface AccountBotConfig {
  appId: string;
  pollIntervalMs?: number;
  maxQueueMs?: number;
  cooldownMs?: number;
  resolution?: string;
  fps?: number;
  zone?: string;
  streamingBaseUrl?: string;
  /** How long to hold a ready session before ending it (ms). 0 = legacy measure-only mode. */
  sessionHoldMs?: number;
  /** Buffer after reaching ready before the session is considered claimable (ms). */
  sessionBufferMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 20_000;
const DEFAULT_MAX_QUEUE_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_HOLD_MS = 55 * 60 * 1000;  // 55 minutes
const DEFAULT_SESSION_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;
const REQUEST_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const HOLD_POLL_INTERVAL_MS = 2 * 60_000; // server-side hold checks can be much less frequent

export interface ClaimInfo {
  userId: string;
  displayName: string;
  email?: string;
  sessionId: string;
  serverIp?: string;
  streamingBaseUrl?: string;
  holdStartedAt: number;
  holdExpiresAt: number;
  remainingMs: number;
}

export class AccountBot extends EventEmitter {
  readonly userId: string;
  status: AccountStatus;
  private timer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private stopping = false;
  private holdReadyEmitted = false;
  private queueRequested = false;
  private readonly streamingBaseUrl?: string;

  constructor(
    private readonly auth: AuthManager,
    private readonly metrics: MetricsStore,
    account: StoredAccount,
    private readonly config: AccountBotConfig,
    private readonly fingerprint?: DeviceFingerprint,
    private readonly rateLimiter?: RateLimiter,
    private readonly circuitBreaker?: ApiCircuitBreaker,
  ) {
    super();
    this.userId = account.user.userId;
    this.streamingBaseUrl = config.streamingBaseUrl ?? account.provider.streamingServiceUrl;
    this.status = {
      userId: account.user.userId,
      displayName: account.user.displayName,
      email: account.user.email,
      phase: "idle",
      appId: config.appId,
      streamingBaseUrl: this.streamingBaseUrl,
      pollIntervalMs: Math.max(DEFAULT_POLL_INTERVAL_MS, config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
      lastUpdateAt: Date.now(),
      consecutiveErrors: 0,
    };
  }

  start(delayMs = 0): void {
    if (this.status.phase === "paused") return;
    if (this.status.phase === "needs_relogin") return; // terminal until retryAuth clears it
    this.queueRequested = true;
    this.status = { ...this.status, lastActivatedAt: Date.now(), lastUpdateAt: Date.now() };
    if (this.timer) return;
    this.scheduleNext(delayMs);
  }

  standby(): void {
    this.queueRequested = false;
    if (this.status.phase === "idle" || this.status.phase === "error") {
      this.clearTimer();
    }
  }

  pause(): void {
    this.status = { ...this.status, phase: "paused", lastUpdateAt: Date.now() };
    this.clearTimer();
    this.emit("status", this.status);
  }

  resume(): void {
    if (this.status.phase !== "paused") return;
    this.status = { ...this.status, phase: "idle", lastUpdateAt: Date.now() };
    this.emit("status", this.status);
    this.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.queueRequested = false;
    this.clearTimer();
    if (this.status.sessionId && this.status.phase !== "claimed") {
      try {
        const token = await this.auth.resolveToken(this.userId);
        const base = this.status.streamingBaseUrl ?? this.streamingBaseUrl;
        await stopSession({
          token,
          sessionId: this.status.sessionId,
          zone: this.config.zone ?? "",
          serverIp: this.status.serverIp,
          streamingBaseUrl: base,
          fingerprint: this.fingerprint,
        });
      } catch (error) {
        console.warn(`[Bot:${this.userId}] stopSession during shutdown failed:`, error);
      }
    }
  }

  /**
   * Claim the current holding session. Stops the bot from managing it further
   * and returns the session details so the user can connect to GFN.
   * Returns null if this account is not currently in holding phase.
   */
  claim(): ClaimInfo | null {
    if (!this.isClaimable) return null;
    if (!this.status.sessionId || !this.status.holdStartedAt || !this.status.holdExpiresAt) return null;

    const claimedAt = Date.now();
    const remainingMs = Math.max(0, this.status.holdExpiresAt - claimedAt);

    this.metrics.updateSample(
      (s) => s.userId === this.userId && (s.outcome === "running" || s.outcome === "ready"),
      { outcome: "claimed", endedAt: claimedAt },
    );

    this.setStatus({
      phase: "claimed",
      claimedAt,
    });
    this.queueRequested = false;

    // Stop polling — session is now user-managed. Enter cooldown after hold would have expired.
    this.clearTimer();

    console.log(`[Bot:${this.userId}] Session claimed — ${Math.floor(remainingMs / 60_000)}m remaining`);

    return {
      userId: this.userId,
      displayName: this.status.displayName,
      email: this.status.email,
      sessionId: this.status.sessionId,
      serverIp: this.status.serverIp,
      streamingBaseUrl: this.status.streamingBaseUrl ?? this.streamingBaseUrl,
      holdStartedAt: this.status.holdStartedAt,
      holdExpiresAt: this.status.holdExpiresAt,
      remainingMs,
    };
  }

  /**
   * Transition this account into the terminal "needs re-login" state. Stops
   * cycling, clears any in-flight session state, and records a metrics sample.
   * The orchestrator and dashboard are responsible for surfacing + recovery.
   */
  markNeedsRelogin(reason: string): void {
    if (this.status.phase === "needs_relogin") return;
    this.metrics.updateSample(
      (s) => s.userId === this.userId && (s.outcome === "running" || s.outcome === "ready"),
      { outcome: "error", endedAt: Date.now(), errorMessage: reason },
    );
    this.queueRequested = false;
    this.clearTimer();
    this.setStatus({
      phase: "needs_relogin",
      sessionId: undefined,
      serverIp: undefined,
      streamingBaseUrl: this.streamingBaseUrl,
      queuePosition: undefined,
      holdStartedAt: undefined,
      holdExpiresAt: undefined,
      lastError: reason,
    });
    console.error(`[Bot:${this.userId}] needs re-login:`, reason);
    this.emit("auth-expired", { ...this.status });
  }

  /**
   * Recovery path: re-run auth resolution. Resolves true on success (phase reset
   * to idle so the orchestrator can re-queue it); false if still expired.
   */
  async retryAuth(): Promise<boolean> {
    try {
      await this.auth.checkAuth(this.userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Refresh the displayed reason, stay needs_relogin.
      this.setStatus({ phase: "needs_relogin", lastError: message });
      return false;
    }
    this.setStatus({ phase: "idle", lastError: undefined, consecutiveErrors: 0 });
    this.emit("auth-recovered", { ...this.status });
    return true;
  }

  /** Force end the current session and enter cooldown (e.g. if holding capacity exceeded) */
  async release(reason = "released"): Promise<void> {
    if (this.status.sessionId) {
      await this.endCurrentSession("stopped", reason);
    }
  }

  /** Whether this account's session is past the buffer and ready to be claimed. */
  get isClaimable(): boolean {
    if (this.status.phase !== "holding") return false;
    if (!this.status.holdStartedAt || !this.status.holdExpiresAt) return false;
    const now = Date.now();
    if (now >= this.status.holdExpiresAt) return false;
    const bufferMs = this.config.sessionBufferMs ?? DEFAULT_SESSION_BUFFER_MS;
    return now - this.status.holdStartedAt >= bufferMs;
  }

  /** Milliseconds remaining in the hold window, or 0 if not holding. */
  get holdRemainingMs(): number {
    if (!this.status.holdExpiresAt) return 0;
    return Math.max(0, this.status.holdExpiresAt - Date.now());
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    this.clearTimer();
    // Poll on an explicit fixed interval; errors do not change the delay.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, Math.max(0, Math.round(delayMs)));
  }

  private setStatus(patch: Partial<AccountStatus>): void {
    const next = { ...this.status, ...patch, lastUpdateAt: Date.now() };
    // Compute isBuffering: in holding phase but buffer hasn't elapsed
    if (next.phase === "holding" && next.holdStartedAt) {
      const bufferMs = this.config.sessionBufferMs ?? DEFAULT_SESSION_BUFFER_MS;
      next.isBuffering = (Date.now() - next.holdStartedAt) < bufferMs;
    } else {
      next.isBuffering = false;
    }
    this.status = next;
    this.emit("status", this.status);
  }

  private async runCycle(): Promise<void> {
    if (this.stopping || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      // Claimed sessions are user-managed. Never poll, stop, expire, or recycle them.
      if (this.status.phase === "claimed") {
        return;
      }

      // Needs re-login is terminal until retryAuth() clears it. Never cycle.
      if (this.status.phase === "needs_relogin") {
        return;
      }

      // Handle cooldown
      if (this.status.phase === "cooldown") {
        const until = this.status.cooldownUntil ?? 0;
        const remaining = until - Date.now();
        if (remaining > 0) {
          this.scheduleNext(remaining);
          return;
        }
        this.setStatus({ phase: "idle", cooldownUntil: undefined });
        if (!this.queueRequested) {
          return;
        }
      }

      if (!this.status.sessionId && (this.status.phase === "idle" || this.status.phase === "error") && !this.queueRequested) {
        return;
      }

      await this.rateLimiter?.acquire(this.userId);
      if (
        this.stopping ||
        !this.queueRequested ||
        this.status.phase === "paused"
      ) {
        return;
      }
      const token = await this.auth.resolveToken(this.userId);

      if (!this.status.sessionId) {
        await this.startNewSession(token);
      } else if (this.status.phase === "holding") {
        await this.pollHolding(token);
      } else {
        await this.poll(token);
      }
    } catch (error) {
      this.handleCycleError(error);
    } finally {
      this.pollInFlight = false;
    }

    this.scheduleNextForPhase();
  }

  private scheduleNextForPhase(): void {
    const phase = this.status.phase;
    if (phase === "queueing" || phase === "ready") {
      // Poll at the configured fixed interval. API failures are handled by the
      // shared circuit breaker, never by per-account adaptive backoff.
      this.scheduleNext(this.status.pollIntervalMs);
    } else if (phase === "holding") {
      // Check if hold has expired
      if (this.holdRemainingMs <= 0) {
        this.scheduleNext(0);
      } else {
        // Poll at reduced frequency during hold
        const nextPoll = Math.min(HOLD_POLL_INTERVAL_MS, this.holdRemainingMs);
        this.scheduleNext(nextPoll);
      }
    } else if (phase === "claimed") {
      this.clearTimer();
    } else if (phase === "needs_relogin") {
      // Terminal until retryAuth() clears it.
      this.clearTimer();
    } else if (phase === "ending") {
      // ending re-schedules itself after the async work completes
    } else if (phase === "cooldown") {
      const until = this.status.cooldownUntil ?? Date.now() + this.status.pollIntervalMs;
      this.scheduleNext(Math.max(0, until - Date.now()));
    } else if (phase === "error") {
      if (this.queueRequested) {
        this.scheduleNext(this.status.pollIntervalMs);
      }
    } else {
      if (this.queueRequested) {
        this.scheduleNext(this.status.pollIntervalMs);
      }
    }
  }

  private canCallApi(): boolean {
    if (this.circuitBreaker && !this.circuitBreaker.tryAcquire()) {
      this.setStatus({ lastError: "API circuit breaker open" });
      return false;
    }
    return true;
  }

  private recordApiSuccess(): void {
    this.circuitBreaker?.recordSuccess();
  }

  private recordApiFailure(error: unknown): void {
    if (!this.circuitBreaker) return;
    if (this.isCircuitFailure(error)) {
      this.circuitBreaker.recordFailure();
    } else {
      // A structured application response proves the API is reachable.
      this.circuitBreaker.recordSuccess();
    }
  }

  private isCircuitFailure(error: unknown): boolean {
    if (error instanceof SessionError) {
      return error.statusCode === 0 || error.statusCode === 408 || error.statusCode >= 500 ||
        /invalid response body|invalid json|timeout|temporar/i.test(error.statusDescription);
    }
    if (!(error instanceof Error)) return true;
    return /fetch failed|UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|timeout|temporar/i.test(error.message);
  }

  /** Shared session polling request used by queueing and holding phases. */
  private async fetchSession(token: string): Promise<SessionInfo | null | undefined> {
    if (!this.status.sessionId || !this.canCallApi()) return undefined;
    try {
      const info = await pollSession({
        token,
        sessionId: this.status.sessionId,
        zone: this.config.zone ?? "",
        serverIp: this.status.serverIp,
        streamingBaseUrl: this.status.streamingBaseUrl ?? this.streamingBaseUrl,
        fingerprint: this.fingerprint,
      });
      this.recordApiSuccess();
      return info;
    } catch (error) {
      if (error instanceof Error && /404|not[_\\s-]?found/i.test(error.message)) {
        this.recordApiSuccess();
        return null;
      }
      this.recordApiFailure(error);
      throw error;
    }
  }

  private async startNewSession(token: string): Promise<void> {
    this.setStatus({ phase: "starting", lastError: undefined });
    if (!this.canCallApi()) return;
    try {
      const session = await createSession({
        token,
        appId: this.config.appId,
        zone: this.config.zone,
        streamingBaseUrl: this.streamingBaseUrl,
        settings: {
          resolution: this.config.resolution ?? "1920x1080",
          fps: this.config.fps ?? 60,
        },
        fingerprint: this.fingerprint,
      });
      this.recordApiSuccess();
      const sample: QueueSample = {
        userId: this.userId,
        appId: this.config.appId,
        startedAt: Date.now(),
        outcome: "running",
        zone: this.config.zone,
      };
      this.metrics.record(sample);
      this.setStatus({
        phase: this.phaseFromStatus(session.status),
        sessionId: session.sessionId,
        serverIp: session.serverIp,
        streamingBaseUrl: session.streamingBaseUrl,
        queuePosition: session.queuePosition,
        startedAt: sample.startedAt,
        consecutiveErrors: 0,
        currentSampleId: `${this.userId}-${sample.startedAt}`,
      });
      if (session.status === SESSION_STATUS.READY || session.status === SESSION_STATUS.STREAMING) {
        await this.onReachedReady(session);
      }
    } catch (error) {
      this.recordApiFailure(error);
      if (await this.handleSessionCreateLimit(token, error)) return;
      this.handleCycleError(error);
    }
  }

  private async handleSessionCreateLimit(token: string, error: unknown): Promise<boolean> {
    if (!(error instanceof SessionError)) return false;
    if (error.statusCode !== 10 && error.statusCode !== 11) return false;

    const message = this.describeError(error);
    if (error.statusCode === 11) {
      const active = this.streamingBaseUrl
        ? await getActiveSessions(token, this.streamingBaseUrl)
        : [];
      const matching = active.find((session) => String(session.appId) === this.config.appId);

      if (matching) {
        const sample: QueueSample = {
          userId: this.userId,
          appId: this.config.appId,
          startedAt: Date.now(),
          outcome: "running",
          zone: this.config.zone,
        };
        this.metrics.record(sample);
        this.setStatus({
          phase: this.phaseFromStatus(matching.status),
          sessionId: matching.sessionId,
          serverIp: matching.serverIp,
          streamingBaseUrl: matching.streamingBaseUrl,
          queuePosition: undefined,
          startedAt: sample.startedAt,
          lastError: undefined,
          consecutiveErrors: 0,
          currentSampleId: `${this.userId}-${sample.startedAt}`,
        });
        console.warn(`[Bot:${this.userId}] attached to existing active session ${matching.sessionId}`);
        // If already ready/streaming, move to hold instead of ending immediately
        if (matching.status === SESSION_STATUS.READY || matching.status === SESSION_STATUS.STREAMING) {
          await this.onReachedReady(matching as unknown as SessionInfo);
        }
        return true;
      }

      this.enterLimitedCooldown(message, SESSION_LIMIT_COOLDOWN_MS);
      console.warn(`[Bot:${this.userId}] session limit hit; no matching active session found. Cooling down.`);
      return true;
    }

    this.enterLimitedCooldown(message, REQUEST_LIMIT_COOLDOWN_MS);
    console.warn(`[Bot:${this.userId}] request limit hit; cooling down before retrying.`);
    return true;
  }

  private async poll(token: string): Promise<void> {
    if (!this.status.sessionId) return;
    const info = await this.fetchSession(token);
    if (info === undefined) return;
    if (info === null) {
      this.metrics.updateSample(
        (s) => s.userId === this.userId && s.outcome === "running",
        { outcome: "stopped", endedAt: Date.now() },
      );
      this.setStatus({ sessionId: undefined, serverIp: undefined, queuePosition: undefined, phase: "idle" });
      return;
    }

    this.setStatus({
      phase: this.phaseFromStatus(info.status),
      queuePosition: info.queuePosition,
      serverIp: info.serverIp ?? this.status.serverIp,
      streamingBaseUrl: info.streamingBaseUrl ?? this.status.streamingBaseUrl,
      lastError: undefined,
      consecutiveErrors: 0,
    });

    if (info.status === SESSION_STATUS.READY || info.status === SESSION_STATUS.STREAMING) {
      await this.onReachedReady(info);
    } else {
      const maxMs = this.config.maxQueueMs ?? DEFAULT_MAX_QUEUE_MS;
      if (maxMs > 0 && this.status.startedAt && Date.now() - this.status.startedAt > maxMs) {
        console.warn(`[Bot:${this.userId}] hit maxQueueMs; ending session`);
        await this.endCurrentSession("stopped", "Hit max queue time");
      }
    }
  }

  /**
   * Poll a session during the hold phase to detect server-side expiry.
   * Uses a much lower poll frequency to avoid hammering the API.
   */
  private async pollHolding(token: string): Promise<void> {
    if (!this.status.sessionId) return;

    // Check hold expiry first
    if (this.holdRemainingMs <= 0) {
      console.log(`[Bot:${this.userId}] Hold expired; ending session`);
      this.holdReadyEmitted = false;
      await this.endCurrentSession("stopped", "Hold time expired");
      return;
    }

    const info = await this.fetchSession(token);
    if (info === undefined) return;
    if (info === null) {
      // Session was killed server-side while we were holding
      console.warn(`[Bot:${this.userId}] Session disappeared during hold`);
      this.metrics.updateSample(
        (s) => s.userId === this.userId && (s.outcome === "running" || s.outcome === "ready"),
        { outcome: "stopped", endedAt: Date.now() },
      );
      this.setStatus({
        phase: "cooldown",
        sessionId: undefined,
        serverIp: undefined,
        streamingBaseUrl: this.streamingBaseUrl,
        queuePosition: undefined,
        holdStartedAt: undefined,
        holdExpiresAt: undefined,
        cooldownUntil: Date.now() + (this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS),
      });
      this.holdReadyEmitted = false;
      this.emit("hold-ended", { ...this.status, reason: "server-side expiry" });
      return;
    }

    // If GFN ended the session or it's no longer ready/streaming, end hold
    if (info.status !== SESSION_STATUS.READY && info.status !== SESSION_STATUS.STREAMING) {
      console.warn(`[Bot:${this.userId}] Session dropped out of ready state during hold (status=${info.status})`);
      this.metrics.updateSample(
        (s) => s.userId === this.userId && (s.outcome === "running" || s.outcome === "ready"),
        { outcome: "stopped", endedAt: Date.now() },
      );
      this.setStatus({
        phase: "cooldown",
        sessionId: undefined,
        serverIp: undefined,
        streamingBaseUrl: this.streamingBaseUrl,
        queuePosition: undefined,
        holdStartedAt: undefined,
        holdExpiresAt: undefined,
        cooldownUntil: Date.now() + (this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS),
      });
      this.holdReadyEmitted = false;
      this.emit("hold-ended", { ...this.status, reason: "session-dropped" });
      return;
    }

    // Still alive — update server details in case they changed
    this.setStatus({
      serverIp: info.serverIp ?? this.status.serverIp,
      streamingBaseUrl: info.streamingBaseUrl ?? this.status.streamingBaseUrl,
      lastError: undefined,
      consecutiveErrors: 0,
    });

    // Check if buffer has elapsed and session just became claimable (emit once)
    if (!this.holdReadyEmitted) {
      const bufferMs = this.config.sessionBufferMs ?? DEFAULT_SESSION_BUFFER_MS;
      const holdStartedAt = this.status.holdStartedAt ?? Date.now();
      const sinceHoldStart = Date.now() - holdStartedAt;
      if (sinceHoldStart >= bufferMs) {
        this.holdReadyEmitted = true;
        this.emit("hold-ready", { ...this.status });
      }
    }
  }

  private async onReachedReady(info: SessionInfo): Promise<void> {
    if (this.status.phase === "holding" && this.status.holdStartedAt) return;

    const reachedAt = Date.now();
    const holdMs = this.config.sessionHoldMs ?? DEFAULT_SESSION_HOLD_MS;

    this.metrics.updateSample(
      (s) => s.userId === this.userId && s.outcome === "running",
      {
        outcome: "ready",
        reachedReadyAt: reachedAt,
        reachedReadyQueuePosition: info.queuePosition ?? undefined,
      },
    );

    // Hold mode: transition to holding instead of ending
    if (holdMs > 0) {
      const holdExpiresAt = reachedAt + holdMs;
      this.setStatus({
        phase: "holding",
        reachedReadyAt: reachedAt,
        holdStartedAt: reachedAt,
        holdExpiresAt,
        queuePosition: info.queuePosition ?? this.status.queuePosition,
      });
      console.log(
        `[Bot:${this.userId}] Session ready — holding for ${Math.floor(holdMs / 60_000)}m ` +
        `(expires at ${new Date(holdExpiresAt).toLocaleTimeString()})`,
      );
      this.emit("ready", { ...this.status });
      // Emit hold-ready immediately if no buffer
      const bufferMs = this.config.sessionBufferMs ?? DEFAULT_SESSION_BUFFER_MS;
      if (bufferMs <= 0) {
        this.holdReadyEmitted = true;
        this.emit("hold-ready", { ...this.status });
      }
      return;
    }

    // Legacy measure-only mode (sessionHoldMs === 0)
    this.setStatus({
      phase: "ready",
      reachedReadyAt: reachedAt,
      queuePosition: info.queuePosition ?? this.status.queuePosition,
    });
    this.holdReadyEmitted = false;
    this.emit("ready", { ...this.status });
    await this.endCurrentSession("ready");
  }

  private async endCurrentSession(outcome: "ready" | "stopped", errorMessage?: string): Promise<void> {
    if (!this.status.sessionId) return;
    this.setStatus({ phase: "ending" });
    const sampleUpdate: Partial<QueueSample> = { outcome, endedAt: Date.now() };
    if (errorMessage) sampleUpdate.errorMessage = errorMessage;
    this.metrics.updateSample(
      (s) => s.userId === this.userId && (s.outcome === "running" || s.outcome === "ready"),
      sampleUpdate,
    );
    try {
      const token = await this.auth.resolveToken(this.userId);
      const base = this.status.streamingBaseUrl ?? this.streamingBaseUrl;
      await stopSession({
        token,
        sessionId: this.status.sessionId,
        zone: this.config.zone ?? "",
        serverIp: this.status.serverIp,
        streamingBaseUrl: base,
        fingerprint: this.fingerprint,
      });
    } catch (error) {
      console.warn(`[Bot:${this.userId}] stopSession failed (session may already be gone):`, error);
    }
    this.setStatus({
      phase: "cooldown",
      sessionId: undefined,
      serverIp: undefined,
      streamingBaseUrl: this.streamingBaseUrl,
      queuePosition: undefined,
      holdStartedAt: undefined,
      holdExpiresAt: undefined,
      cooldownUntil: Date.now() + (this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS),
    });
    if (!this.stopping) {
      this.queueRequested = true;
    }
    this.holdReadyEmitted = false;
    this.scheduleNext(this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.emit("hold-ended", { ...this.status, reason: outcome });
  }

  private enterLimitedCooldown(message: string, cooldownMs: number): void {
    const consecutive = this.status.consecutiveErrors + 1;
    this.metrics.updateSample(
      (s) => s.userId === this.userId && s.outcome === "running",
      { outcome: "error", endedAt: Date.now(), errorMessage: message },
    );
    this.setStatus({
      phase: "cooldown",
      lastError: message,
      consecutiveErrors: consecutive,
      cooldownUntil: Date.now() + cooldownMs,
    });
  }

  private handleCycleError(error: unknown): void {
    // Auth failures are terminal until the user re-logs in. Detect them first.
    if (this.isAuthError(error)) {
      this.markNeedsRelogin(this.describeError(error));
      return;
    }

    const message = this.describeError(error);
    const consecutive = this.status.consecutiveErrors + 1;

    if (this.status.sessionId && this.isTransientSessionError(error)) {
      this.setStatus({
        lastError: message,
        consecutiveErrors: consecutive,
      });
      console.warn(`[Bot:${this.userId}] transient session poll error; keeping ${this.status.phase} session ${this.status.sessionId}:`, message);
      return;
    }

    if (this.status.sessionId && this.isTerminalSessionError(error)) {
      this.metrics.updateSample(
        (s) => s.userId === this.userId && (s.outcome === "running" || s.outcome === "ready"),
        { outcome: "error", endedAt: Date.now(), errorMessage: message },
      );
      this.setStatus({
        phase: "cooldown",
        sessionId: undefined,
        serverIp: undefined,
        streamingBaseUrl: this.streamingBaseUrl,
        queuePosition: undefined,
        holdStartedAt: undefined,
        holdExpiresAt: undefined,
        lastError: message,
        consecutiveErrors: consecutive,
        cooldownUntil: Date.now() + (this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS),
      });
      this.queueRequested = false;
      this.holdReadyEmitted = false;
      console.warn(`[Bot:${this.userId}] terminal session error; clearing session:`, message);
      return;
    }

    this.metrics.updateSample(
      (s) => s.userId === this.userId && s.outcome === "running",
      { outcome: "error", endedAt: Date.now(), errorMessage: message },
    );
    const nextPhase = this.status.sessionId ? this.status.phase : "error";
    this.setStatus({
      phase: nextPhase,
      lastError: message,
      consecutiveErrors: consecutive,
    });
    console.error(`[Bot:${this.userId}] cycle error; retrying at the fixed poll interval:`, message);
  }

  /**
   * Detect a hard auth failure that should transition the account to
   * needs_relogin rather than retrying pointlessly.
   *
   * - AuthExpiredError (refresh failed AND token hard-expired) → always.
   * - SessionError / HTTP indicating 401/403 / INVALID_TOKEN / UNAUTHORIZED →
   *   only after a small threshold (consecutiveErrors >= 2) so a single
   *   transient 401 doesn't misclassify a healthy account.
   */
  private isAuthError(error: unknown): boolean {
    if (AuthExpiredError.is(error)) return true;
    if (!(error instanceof Error)) return false;

    const text = error instanceof SessionError
      ? `${error.statusCode} ${error.statusDescription}`
      : error.message;
    if (!/401|403|unauthor|invalid[_\s-]?token|token[_\s-]?(expir|invalid)/i.test(text)) {
      return false;
    }
    // Require two consecutive auth-ish failures before declaring dead, to avoid
    // misclassifying a one-off blip. AuthExpiredError above is unconditional.
    return this.status.consecutiveErrors + 1 >= 2;
  }

  private isTransientSessionError(error: unknown): boolean {
    if (error instanceof SessionError) {
      return error.statusCode === 408 || /invalid response body|invalid json/i.test(error.statusDescription);
    }
    if (!(error instanceof Error)) return false;
    return /fetch failed|UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(error.message);
  }

  private isTerminalSessionError(error: unknown): boolean {
    if (error instanceof SessionError) {
      return error.statusCode === 46 || error.statusCode === 69 || /ABANDONED|TERMINATED/i.test(error.statusDescription);
    }
    if (!(error instanceof Error)) return false;
    return /404|not[_\s-]?found/i.test(error.message);
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = error.cause;
    if (cause && typeof cause === "object") {
      const details = cause as { code?: unknown; hostname?: unknown; address?: unknown; port?: unknown; message?: unknown };
      const parts = [
        typeof details.code === "string" ? details.code : undefined,
        typeof details.hostname === "string" ? details.hostname : undefined,
        typeof details.address === "string" ? details.address : undefined,
        typeof details.port === "number" ? String(details.port) : undefined,
        typeof details.message === "string" ? details.message : undefined,
      ].filter(Boolean);
      if (parts.length > 0) {
        return `${error.message} (${parts.join(" ")})`;
      }
    }
    return error.message;
  }

  private phaseFromStatus(status: number | undefined): AccountPhase {
    if (status === SESSION_STATUS.READY || status === SESSION_STATUS.STREAMING) return "ready";
    if (status === SESSION_STATUS.QUEUEING) return "queueing";
    return "queueing";
  }
}
