import assert from "node:assert/strict";
import test from "node:test";

import { ApiCircuitBreaker } from "../src/bot/circuitBreaker";
import { AccountBot } from "../src/bot/accountBot";
import type { AuthManager, StoredAccount } from "../src/gfn/auth";
import type { MetricsStore } from "../src/metrics/store";

const account: StoredAccount = {
  id: "user-1",
  user: {
    userId: "user-1",
    displayName: "User One",
    membershipTier: "FREE",
  },
  provider: {
    idpId: "provider-1",
    code: "NVIDIA",
    displayName: "NVIDIA",
    streamingServiceUrl: "https://api.example/",
  },
  tokens: {
    accessToken: "access-token",
    expiresAt: Date.now() + 60_000,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

test("circuit breaker counts intermittent failures in a rolling window", () => {
  const breaker = new ApiCircuitBreaker(3, 60_000, 60_000);

  breaker.recordFailure();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordFailure();

  assert.equal(breaker.recentFailureCount, 3);
  assert.equal(breaker.tryAcquire(), false, "the API circuit should open after repeated failures");
});

test("circuit breaker permits one half-open probe after opening", () => {
  const breaker = new ApiCircuitBreaker(1, 60_000, 0);
  breaker.recordFailure();

  assert.equal(breaker.tryAcquire(), true);
  assert.equal(breaker.tryAcquire(), false, "only one recovery probe may run at a time");
  breaker.recordSuccess();
  assert.equal(breaker.tryAcquire(), true);
});

test("poll scheduling stays fixed when consecutive errors are present", async () => {
  const auth = { resolveToken: async () => "token" } as unknown as AuthManager;
  const metrics = { record: () => {}, updateSample: () => true } as unknown as MetricsStore;
  const bot = new AccountBot(auth, metrics, account, {
    appId: "123",
    pollIntervalMs: 30_000,
  });
  bot.status = { ...bot.status, phase: "queueing", consecutiveErrors: 8 };

  let scheduledDelay: number | undefined;
  (bot as unknown as { scheduleNext(delayMs: number): void }).scheduleNext = (delayMs) => {
    scheduledDelay = delayMs;
  };
  (bot as unknown as { scheduleNextForPhase(): void }).scheduleNextForPhase();

  assert.equal(scheduledDelay, 30_000);
  await bot.stop();
});
