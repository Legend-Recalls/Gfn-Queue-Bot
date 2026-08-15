import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AuthManager, StoredAccount } from "../gfn/auth";
import { AccountBot, AccountStatus, AccountBotConfig, ClaimInfo } from "./accountBot";
import { MetricsStore } from "../metrics/store";
import { FingerprintManager } from "../gfn/fingerprint";
import { RateLimiter } from "./rateLimiter";
import { ApiCircuitBreaker } from "./circuitBreaker";

export interface BotConfig {
  appId: string;
  pollIntervalMs: number;
  cooldownMs: number;
  maxQueueMs: number;
  resolution: string;
  fps: number;
  zone?: string;
  streamingBaseUrl?: string;
  enabledAccountIds: string[];
  // Staggered rotation settings
  maxConcurrentHolding: number;
  /**
   * Max accounts that may queue in parallel. Decoupled from maxConcurrentHolding
   * (which caps held/ready sessions). Default high so all enabled accounts build
   * the pipeline; lower it to throttle queue churn.
   */
  maxConcurrentQueueing: number;
  staggerDelayMs: number;
  preemptiveQueueMs: number;
  sessionHoldMs: number;
  sessionBufferMs: number;
  /** Maps bot account userId -> GFN switcher profile name */
  profileAssignments: Record<string, string>;
}

interface ConfigFile {
  bot: BotConfig;
}

const MIN_POLL_INTERVAL_MS = 30_000;

const DEFAULT_BOT_CONFIG: BotConfig = {
  appId: "",
  pollIntervalMs: 30_000,
  cooldownMs: 20_000,
  maxQueueMs: 30 * 60 * 1000,
  resolution: "1920x1080",
  fps: 60,
  enabledAccountIds: [],
  maxConcurrentHolding: 2,
  maxConcurrentQueueing: 64,
  staggerDelayMs: 12 * 60 * 1000,   // 12 minutes
  preemptiveQueueMs: 10 * 60 * 1000,  // 10 minutes
  sessionHoldMs: 55 * 60 * 1000,     // 55 minutes
  sessionBufferMs: 5 * 60 * 1000,    // 5 minutes
  profileAssignments: {},
};

export class BotOrchestrator extends EventEmitter {
  private bots = new Map<string, AccountBot>();
  private config: BotConfig;
  private staticConfigPath: string;
  private evaluateTimeout: NodeJS.Timeout | null = null;
  private readonly fingerprintManager: FingerprintManager;
  private readonly rateLimiter: RateLimiter;
  private readonly circuitBreaker: ApiCircuitBreaker;
  private botConfigKeys = new Map<string, string>();
  private restartingBotIds = new Set<string>();

  constructor(
    private readonly auth: AuthManager,
    private readonly metrics: MetricsStore,
    private readonly dataDir: string,
  ) {
    super();
    this.staticConfigPath = join(dataDir, "config.json");
    this.config = { ...DEFAULT_BOT_CONFIG };
    this.fingerprintManager = new FingerprintManager(dataDir);
    // 10 requests per 10 seconds across all accounts
    this.rateLimiter = new RateLimiter(10, 10_000);
    // Stop all session polling briefly after repeated API/network failures.
    // The rolling window is shared so intermittent failures across accounts
    // still trip protection without per-account backoff decay.
    this.circuitBreaker = new ApiCircuitBreaker(5, 60_000, 60_000);
  }

  async loadConfig(): Promise<void> {
    try {
      const raw = await readFile(this.staticConfigPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ConfigFile>;
      const loaded = {
        ...DEFAULT_BOT_CONFIG,
        ...parsed.bot,
        profileAssignments: { ...DEFAULT_BOT_CONFIG.profileAssignments, ...parsed.bot?.profileAssignments },
      };
      this.config = {
        ...loaded,
        pollIntervalMs: Math.max(MIN_POLL_INTERVAL_MS, loaded.pollIntervalMs),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[Orchestrator] failed to load config:", error);
      }
      this.config = { ...DEFAULT_BOT_CONFIG };
      await this.persistConfig();
    }
    await this.fingerprintManager.load();
  }

  private async persistConfig(): Promise<void> {
    const payload: ConfigFile = { bot: this.config };
    await writeFile(this.staticConfigPath, JSON.stringify(payload, null, 2), "utf8");
  }

  getConfig(): BotConfig {
    return { ...this.config, profileAssignments: { ...this.config.profileAssignments } };
  }

  async assignProfile(userId: string, profileName: string): Promise<BotConfig> {
    const nextAssignments = { ...this.config.profileAssignments };
    if (profileName) {
      nextAssignments[userId] = profileName;
    } else {
      delete nextAssignments[userId];
    }
    return this.updateConfig({ profileAssignments: nextAssignments });
  }

  getProfileAssignment(userId: string): string | undefined {
    return this.config.profileAssignments[userId];
  }

  async removeProfileAssignments(profileName: string): Promise<BotConfig> {
    const nextAssignments = Object.fromEntries(
      Object.entries(this.config.profileAssignments).filter(([, assignedProfile]) => assignedProfile !== profileName)
    );
    return this.updateConfig({ profileAssignments: nextAssignments });
  }

  async updateConfig(patch: Partial<BotConfig>): Promise<BotConfig> {
    const nextConfig = {
      ...this.config,
      ...patch,
      profileAssignments: patch.profileAssignments
        ? { ...patch.profileAssignments }
        : { ...this.config.profileAssignments },
    };
    this.config = {
      ...nextConfig,
      pollIntervalMs: Math.max(MIN_POLL_INTERVAL_MS, nextConfig.pollIntervalMs),
    };
    await this.persistConfig();
    this.reconcileBots();
    this.emit("config", this.config);
    return this.getConfig();
  }

  listStatuses(): AccountStatus[] {
    const accounts = this.auth.listAccounts();
    return accounts.map((account) => {
      const bot = this.bots.get(account.user.userId);
      return bot?.status ?? this.synthesizeIdleStatus(account);
    });
  }

  private synthesizeIdleStatus(account: StoredAccount): AccountStatus {
    return {
      userId: account.user.userId,
      displayName: account.user.displayName,
      email: account.user.email,
      phase: "idle",
      appId: this.config.appId,
      streamingBaseUrl: account.provider.streamingServiceUrl,
      pollIntervalMs: this.config.pollIntervalMs,
      lastUpdateAt: Date.now(),
      consecutiveErrors: 0,
    };
  }

  reconcileBots(): void {
    const accounts = this.auth.listAccounts();
    const enabledSet = new Set(this.config.enabledAccountIds);
    const keepUserIds = new Set<string>();

    for (const account of accounts) {
      const isEnabled = enabledSet.has(account.user.userId);
      if (!this.config.appId) continue;
      if (!isEnabled) continue;
      keepUserIds.add(account.user.userId);

      const desiredBotConfig = this.createBotConfig(account);
      const desiredConfigKey = JSON.stringify(desiredBotConfig);
      const existing = this.bots.get(account.user.userId);
      if (existing) {
        if (
          this.botConfigKeys.get(account.user.userId) !== desiredConfigKey &&
          !this.restartingBotIds.has(account.user.userId)
        ) {
          this.restartingBotIds.add(account.user.userId);
          void existing.stop()
            .then(() => {
              if (this.bots.get(account.user.userId) !== existing) return;
              this.bots.delete(account.user.userId);
              this.botConfigKeys.delete(account.user.userId);
              this.spawnBot(account);
            })
            .catch((error) => {
              console.warn(`[Orchestrator] failed to restart bot ${account.user.userId}:`, error);
            })
            .finally(() => this.restartingBotIds.delete(account.user.userId));
        }
        continue;
      }
      this.spawnBot(account, desiredBotConfig, desiredConfigKey);
    }

    for (const [userId, bot] of this.bots.entries()) {
      if (!keepUserIds.has(userId)) {
        void bot.stop().finally(() => {
          this.bots.delete(userId);
          this.botConfigKeys.delete(userId);
          this.restartingBotIds.delete(userId);
        });
        this.bots.delete(userId);
        this.botConfigKeys.delete(userId);
      }
    }

    this.triggerEvaluation();
  }

  private createBotConfig(account: StoredAccount): AccountBotConfig {
    return {
      appId: this.config.appId,
      pollIntervalMs: this.config.pollIntervalMs,
      maxQueueMs: this.config.maxQueueMs,
      cooldownMs: this.config.cooldownMs,
      resolution: this.config.resolution,
      fps: this.config.fps,
      zone: this.config.zone,
      streamingBaseUrl: this.config.streamingBaseUrl ?? account.provider.streamingServiceUrl,
      sessionHoldMs: this.config.sessionHoldMs,
      sessionBufferMs: this.config.sessionBufferMs,
    };
  }

  private spawnBot(
    account: StoredAccount,
    botConfig = this.createBotConfig(account),
    configKey = JSON.stringify(botConfig),
  ): void {
    const fingerprint = this.fingerprintManager.getOrCreate(account.user.userId);
    const bot = new AccountBot(
      this.auth,
      this.metrics,
      account,
      botConfig,
      fingerprint,
      this.rateLimiter,
      this.circuitBreaker,
    );

    bot.on("status", (status) => {
      this.triggerEvaluation();
      this.emit("status", status);
    });

    bot.on("ready", (status) => this.emit("ready", status));

    bot.on("hold-ready", (status) => {
      this.emit("session-available", { userId: account.user.userId, status });
    });

    bot.on("auth-expired", (status) => {
      this.emit("auth-expired", { userId: account.user.userId, status });
      this.triggerEvaluation();
    });

    bot.on("auth-recovered", (status) => {
      this.emit("auth-recovered", { userId: account.user.userId, status });
      this.triggerEvaluation();
    });

    this.bots.set(account.user.userId, bot);
    this.botConfigKeys.set(account.user.userId, configKey);
    this.triggerEvaluation();
  }

  private lastZoneFetchAt = 0;
  private cachedZoneQueuePosition: number | null = null;

  private getTimePerPosition(): number {
    const samples = this.metrics.recent(20).filter(
      (s) =>
        s.appId === this.config.appId &&
        s.zone === this.config.zone &&
        s.reachedReadyQueuePosition &&
        s.reachedReadyAt &&
        s.reachedReadyAt > s.startedAt
    );
    if (samples.length > 0) {
      let totalMs = 0;
      let totalPos = 0;
      for (const s of samples) {
        const duration = (s.reachedReadyAt as number) - s.startedAt;
        const pos = s.reachedReadyQueuePosition as number;
        if (pos > 0) {
          totalMs += duration;
          totalPos += pos;
        }
      }
      if (totalPos > 0) {
        return Math.max(1000, totalMs / totalPos); // at least 1s per position
      }
    }
    return 10000; // fallback: 10 seconds per position
  }

  private getRecentAverageQueueTimeMs(): number | null {
    const samples = this.metrics.recent(10).filter(
      (s) =>
        s.appId === this.config.appId &&
        s.zone === this.config.zone &&
        s.reachedReadyAt &&
        s.reachedReadyAt > s.startedAt
    );
    if (samples.length === 0) return null;
    const total = samples.reduce((sum, s) => sum + ((s.reachedReadyAt as number) - s.startedAt), 0);
    return total / samples.length;
  }

  private async updateZoneQueuePosition(): Promise<void> {
    if (!this.config.zone) {
      this.cachedZoneQueuePosition = null;
      return;
    }
    // Rate limit the API calls to once every 2 minutes
    if (Date.now() - this.lastZoneFetchAt < 2 * 60 * 1000) {
      return;
    }
    try {
      this.lastZoneFetchAt = Date.now();
      const response = await fetch("https://api.printedwaste.com/gfn/queue/", {
        headers: {
          "User-Agent": "opennow-queue-bot",
          Accept: "application/json",
        },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { status?: boolean; data?: Record<string, unknown> };
      if (!body.status || !body.data) return;

      const zoneData = body.data[this.config.zone] as Record<string, unknown> | undefined;
      if (zoneData && typeof zoneData.QueuePosition === "number") {
        this.cachedZoneQueuePosition = zoneData.QueuePosition;
        console.log(`[Orchestrator] Updated cached queue position for zone ${this.config.zone}: ${this.cachedZoneQueuePosition}`);
      }
    } catch (error) {
      console.debug("[Orchestrator] Failed to fetch zone queue position:", error);
    }
  }

  async getExpectedQueueTimeMs(): Promise<number> {
    const timePerPosition = this.getTimePerPosition();
    const queueEtas = Array.from(this.bots.values())
      .filter((bot) => bot.status.phase === "queueing" && typeof bot.status.queuePosition === "number" && bot.status.queuePosition > 0)
      .map((bot) => (bot.status.queuePosition as number) * timePerPosition)
      .sort((a, b) => a - b);

    if (queueEtas.length > 0) {
      return queueEtas[0] as number;
    }

    // 2. Try to update and use the PrintedWaste zone queue position
    if (this.config.zone) {
      await this.updateZoneQueuePosition();
      if (typeof this.cachedZoneQueuePosition === "number" && this.cachedZoneQueuePosition > 0) {
        const timePerPos = this.getTimePerPosition();
        return this.cachedZoneQueuePosition * timePerPos;
      }
    }

    // 3. Check recent historical average queue time
    const recentAvg = this.getRecentAverageQueueTimeMs();
    if (recentAvg !== null) {
      return recentAvg;
    }

    // 4. Fallback to configured preemptiveQueueMs or 10 minutes
    return this.config.preemptiveQueueMs > 0 ? this.config.preemptiveQueueMs : 10 * 60 * 1000;
  }

  private triggerEvaluation(): void {
    if (this.evaluateTimeout) return;
    this.evaluateTimeout = setTimeout(() => {
      this.evaluateTimeout = null;
      void this.evaluateRotation();
    }, 1000);
  }

  /**
   * Evaluate the state of all bots in rotation.
   *
   * Pipeline model: keep `maxConcurrentQueueing` accounts actively queueing in
   * parallel so ready sessions keep arriving, while `maxConcurrentHolding`
   * caps the number of held/ready sessions (GFN-abuse throttle).
   *
   * Invariants preserved:
   *  1. Hold cap — never hold more than maxConcurrentHolding sessions.
   *  2. Coverage  — when a playable hold exists, keep at least one queueing
   *     bot whose ETA lands before the earliest hold expires.
   *
   * Accounts in needs_relogin never participate (terminal until retryAuth).
   */
  private async evaluateRotation(): Promise<void> {
    const activeBots = Array.from(this.bots.values());
    if (activeBots.length === 0) return;

    const now = Date.now();
    const maxHolding = Math.max(1, Math.min(this.config.maxConcurrentHolding, activeBots.length));
    const maxQueueing = Math.max(1, Math.min(this.config.maxConcurrentQueueing, activeBots.length));
    const bufferMs = this.config.sessionBufferMs;
    const safetyMs = Math.max(30_000, Math.min(2 * 60_000, this.config.pollIntervalMs * 4));
    const timePerPosition = this.getTimePerPosition();
    const fallbackQueueMs = await this.getExpectedQueueTimeMs();

    const holdingBots = activeBots
      .filter((bot) => bot.status.phase === "holding" || bot.status.phase === "ready")
      .sort((a, b) => (a.status.holdExpiresAt ?? Number.POSITIVE_INFINITY) - (b.status.holdExpiresAt ?? Number.POSITIVE_INFINITY));
    const queueingBots = activeBots.filter((bot) => bot.status.phase === "starting" || bot.status.phase === "queueing");
    const playableHolding = holdingBots.filter((bot) => bot.status.phase === "ready" || bot.isClaimable);
    const earliestPlayableExpiry = playableHolding
      .map((bot) => bot.status.holdExpiresAt ?? now)
      .sort((a, b) => a - b)[0];

    // Startable = idle or transiently-errored, but NOT needs_relogin/claimed/paused.
    const startableBots = activeBots
      .filter((bot) => bot.status.phase === "idle" || bot.status.phase === "error")
      .sort((a, b) => (a.status.lastActivatedAt ?? 0) - (b.status.lastActivatedAt ?? 0));

    // Invariant 1: release overflow holds beyond the cap (oldest first).
    if (holdingBots.length > maxHolding) {
      const overflow = holdingBots.length - maxHolding;
      const releasable = holdingBots
        .slice()
        .sort((a, b) => (a.status.reachedReadyAt ?? 0) - (b.status.reachedReadyAt ?? 0))
        .slice(0, overflow);
      for (const bot of releasable) {
        console.warn(`[Orchestrator] Releasing excess held session on ${bot.status.displayName}; maxConcurrentHolding=${maxHolding}`);
        void bot.release("holding_overflow");
      }
    }

    // Invariant 2: coverage. When a playable hold exists, ensure a queued
    // replacement arrives before it expires. If none of the current queueing
    // bots will make it in time, that counts as an opening to fill.
    let coverageOpenings = 0;
    if (earliestPlayableExpiry !== undefined) {
      const deadline = earliestPlayableExpiry - safetyMs;
      const arrivesInTime = queueingBots.some((bot) => {
        const pos = bot.status.queuePosition;
        const eta = typeof pos === "number" && pos > 0 ? pos * timePerPosition : fallbackQueueMs;
        return now + eta + bufferMs <= deadline;
      });
      if (!arrivesInTime) coverageOpenings = 1;

      const remainingMs = Math.max(0, earliestPlayableExpiry - now);
      const queueSummary = queueingBots
        .slice(0, 3)
        .map((bot) => {
          const pos = bot.status.queuePosition;
          const position = typeof pos === "number" ? `#${pos}` : "unknown";
          const eta = typeof pos === "number" && pos > 0 ? pos * timePerPosition : fallbackQueueMs;
          return `${bot.status.displayName}:${position}/${Math.ceil(eta / 60_000)}m`;
        })
        .join(", ") || "none";
      console.log(
        `[Orchestrator] Playable coverage ${Math.floor(remainingMs / 60_000)}m remaining; ` +
        `queued: ${queueSummary}; holding ${holdingBots.length}/${maxHolding}, queueing ${queueingBots.length}/${maxQueueing}`,
      );
    } else if (queueingBots.length === 0) {
      // No playable hold AND nothing queueing — kick the pipeline off.
      coverageOpenings = 1;
    }

    // Compute how many queue slots are open under the parallel cap.
    const queueOpenings = Math.max(coverageOpenings, maxQueueing - queueingBots.length);
    if (queueOpenings > 0 && startableBots.length > 0) {
      const toStart = startableBots.slice(0, queueOpenings);
      console.warn(
        `[Orchestrator] Pipeline fill: starting ${toStart.length} account(s) ` +
        `(openings=${queueOpenings}, queueing=${queueingBots.length}/${maxQueueing}, holding=${holdingBots.length}/${maxHolding}).`,
      );
      for (const bot of toStart) bot.start();
      // Park the remaining startable bots so they don't race to start themselves.
      for (const bot of startableBots.slice(queueOpenings)) bot.standby();
    } else if (startableBots.length > 0) {
      // Pipeline is full — keep extras parked.
      for (const bot of startableBots) bot.standby();
    }
  }

  /**
   * User wants to claim the ready session from a holding account.
   */
  claimSession(userId: string): ClaimInfo | null {
    const bot = this.bots.get(userId);
    if (!bot) return null;

    const claimResult = bot.claim();
    if (claimResult) {
      this.emit("session-claimed", { userId, claimResult });
      // Do NOT remove from enabledAccountIds — the bot's "claimed" phase prevents
      // re-queuing automatically, and after cooldown it will re-enter the pipeline.
      // Removing from enabledAccountIds would permanently kill this account's bot.
      this.triggerEvaluation();
    }
    return claimResult;
  }

  /**
   * Recovery path for an account marked needs_relogin. Re-runs auth validation;
   * on success the bot rejoins rotation on the next evaluation tick.
   * Returns { ok: boolean, status } so the dashboard can react.
   */
  async retryAuth(userId: string): Promise<{ ok: boolean }> {
    const bot = this.bots.get(userId);
    if (!bot) return { ok: false };
    const ok = await bot.retryAuth();
    if (ok) this.triggerEvaluation();
    return { ok };
  }

  async shutdown(): Promise<void> {
    if (this.evaluateTimeout) {
      clearTimeout(this.evaluateTimeout);
      this.evaluateTimeout = null;
    }
    await Promise.all(Array.from(this.bots.values()).map((bot) => bot.stop()));
    this.bots.clear();
    this.botConfigKeys.clear();
    this.restartingBotIds.clear();
  }
}
