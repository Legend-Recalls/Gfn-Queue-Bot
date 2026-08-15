import assert from "node:assert/strict";
import test from "node:test";

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

function createBot(config: ConstructorParameters<typeof AccountBot>[3] = {}): AccountBot {
  const auth = {
    resolveToken: async () => "session-token",
  } as unknown as AuthManager;
  const metrics = {
    record: () => {},
    updateSample: () => true,
  } as unknown as MetricsStore;
  return new AccountBot(auth, metrics, account, {
    appId: "123",
    cooldownMs: 100_000,
    sessionBufferMs: 0,
    ...config,
  });
}

test("claim rejects sessions before the buffer and after expiry", async () => {
  const bot = createBot({ sessionBufferMs: 5_000 });
  const now = Date.now();

  bot.status = {
    ...bot.status,
    phase: "holding",
    sessionId: "session-1",
    holdStartedAt: now - 1_000,
    holdExpiresAt: now + 60_000,
  };
  assert.equal(bot.claim(), null, "a buffered session must not be claimable");

  bot.status = {
    ...bot.status,
    holdStartedAt: now - 60_000,
    holdExpiresAt: now - 1,
  };
  assert.equal(bot.claim(), null, "an expired session must not be claimable");

  bot.status = { ...bot.status, sessionId: undefined };
  await bot.stop();
});

test("ending a probe session keeps the bot queued for the next rotation", async () => {
  const bot = createBot();
  bot.start(60_000);
  (bot as unknown as { clearTimer(): void }).clearTimer();
  bot.status = {
    ...bot.status,
    phase: "ready",
    sessionId: "session-1",
    serverIp: "192.0.2.10",
    streamingBaseUrl: "https://api.example/",
  };

  const originalFetch = globalThis.fetch;
  let stoppedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    stoppedUrl = String(input);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await (bot as unknown as {
      endCurrentSession(outcome: "ready" | "stopped"): Promise<void>;
    }).endCurrentSession("ready");

    const internals = bot as unknown as { queueRequested: boolean };
    assert.equal(internals.queueRequested, true, "completed probes should rejoin the rotation");
    assert.equal(stoppedUrl, "https://api.example/v2/session/session-1", "stop must use the API base, not the signaling IP");
  } finally {
    globalThis.fetch = originalFetch;
    await bot.stop();
  }
});

test("maxQueueMs ends a stalled session even with a stale queue position", async () => {
  const bot = createBot({ maxQueueMs: 1 });
  bot.status = {
    ...bot.status,
    phase: "queueing",
    sessionId: "session-1",
    startedAt: Date.now() - 1_000,
    streamingBaseUrl: "https://api.example/",
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({
      requestStatus: { statusCode: 1 },
      session: {
        sessionId: "session-1",
        status: 1,
        queuePosition: 25,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    await (bot as unknown as { poll(token: string): Promise<void> }).poll("session-token");
    assert.equal(bot.status.phase, "cooldown");
    assert.equal(bot.status.sessionId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await bot.stop();
  }
});
