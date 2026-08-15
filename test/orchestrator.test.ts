import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { BotOrchestrator } from "../src/bot/orchestrator";
import type { AuthManager, StoredAccount } from "../src/gfn/auth";
import type { MetricsStore } from "../src/metrics/store";

const account1: StoredAccount = {
  id: "user-1",
  user: {
    userId: "user-1",
    displayName: "User One",
    email: "user@example.com",
    membershipTier: "FREE",
  },
  provider: {
    idpId: "provider-1",
    code: "NVIDIA",
    displayName: "NVIDIA",
    streamingServiceUrl: "https://prod.cloudmatchbeta.nvidiagrid.net/",
  },
  tokens: {
    accessToken: "access",
    idToken: "id",
    expiresAt: Date.now() + 60_000,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const account2: StoredAccount = {
  id: "user-2",
  user: {
    userId: "user-2",
    displayName: "User Two",
    email: "user2@example.com",
    membershipTier: "FREE",
  },
  provider: {
    idpId: "provider-1",
    code: "NVIDIA",
    displayName: "NVIDIA",
    streamingServiceUrl: "https://prod.cloudmatchbeta.nvidiagrid.net/",
  },
  tokens: {
    accessToken: "access2",
    idToken: "id2",
    expiresAt: Date.now() + 60_000,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function createAuth(accounts: StoredAccount[]): AuthManager {
  return {
    listAccounts: () => accounts,
    getAccount: (userId: string) => accounts.find((item) => item.user.userId === userId),
    resolveToken: async (userId: string) => "jwt-token-stub",
  } as unknown as AuthManager;
}

function createMetrics(): MetricsStore {
  return {
    record: () => {},
    updateSample: () => true,
    recent: () => [],
    snapshot: () => [],
  } as unknown as MetricsStore;
}

test("empty enabledAccountIds keeps accounts stopped", async (t) => {
  const tempPath = join(process.cwd(), "test-data-tmp-");
  const dataDir = await mkdtemp(tempPath);
  
  try {
    const orchestrator = new BotOrchestrator(createAuth([account1]), createMetrics(), dataDir);

    await orchestrator.updateConfig({
      appId: "101574611",
      enabledAccountIds: [],
    });

    const internals = orchestrator as unknown as { bots: Map<string, unknown> };
    assert.equal(internals.bots.size, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pipeline fills up to maxConcurrentQueueing in parallel", async () => {
  const tempPath = join(process.cwd(), "test-data-tmp-");
  const dataDir = await mkdtemp(tempPath);
  let orchestrator: BotOrchestrator | undefined;

  try {
    // Five accounts: user-1..user-5. All idle initially.
    const accounts = [1, 2, 3, 4, 5].map((n) => ({
      ...account1,
      id: `user-${n}`,
      user: { ...account1.user, userId: `user-${n}`, displayName: `User ${n}` },
      tokens: { ...account1.tokens, expiresAt: Date.now() + 60_000 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    orchestrator = new BotOrchestrator(createAuth(accounts), createMetrics(), dataDir);

    // Enable all five, cap queueing at 3.
    await orchestrator.updateConfig({
      appId: "101574611",
      enabledAccountIds: ["user-1", "user-2", "user-3", "user-4", "user-5"],
      maxConcurrentQueueing: 3,
    });

    // Drive one evaluation tick directly.
    await (orchestrator as unknown as { evaluateRotation: () => Promise<void> }).evaluateRotation();

    // start() is synchronous: it stamps lastActivatedAt on the chosen bots but
    // does not transition phase until runCycle fires on the next tick (which we
    // shut down before it runs). So assert the scheduling decision instead.
    const internals = orchestrator as unknown as {
      bots: Map<string, { status: { phase: string; lastActivatedAt?: number } }>;
    };

    const all = Array.from(internals.bots.values());
    const started = all.filter((b) => typeof b.status.lastActivatedAt === "number");

    // Exactly 3 should have been started (cap=3); the other 2 should stay parked.
    assert.equal(started.length, 3, `expected 3 started, got ${started.length}`);
    assert.equal(all.length, 5, "all five bots should exist");
  } finally {
    await orchestrator?.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("needs_relogin accounts are excluded from rotation", async () => {
  const tempPath = join(process.cwd(), "test-data-tmp-");
  const dataDir = await mkdtemp(tempPath);
  let orchestrator: BotOrchestrator | undefined;

  try {
    const accounts = [1, 2, 3].map((n) => ({
      ...account1,
      id: `user-${n}`,
      user: { ...account1.user, userId: `user-${n}`, displayName: `User ${n}` },
      tokens: { ...account1.tokens, expiresAt: Date.now() + 60_000 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    orchestrator = new BotOrchestrator(createAuth(accounts), createMetrics(), dataDir);

    await orchestrator.updateConfig({
      appId: "101574611",
      enabledAccountIds: ["user-1", "user-2", "user-3"],
      maxConcurrentQueueing: 64,
    });

    const internals = orchestrator as unknown as {
      bots: Map<string, { status: { phase: string; lastActivatedAt?: number }; markNeedsRelogin(reason: string): void }>;
    };

    // Force one bot into needs_relogin, then re-evaluate.
    const bot = internals.bots.get("user-2")!;
    bot.markNeedsRelogin("simulated token expiry");
    await (orchestrator as unknown as { evaluateRotation: () => Promise<void> }).evaluateRotation();

    const all = Array.from(internals.bots.values());
    // user-2 must stay needs_relogin (terminal).
    const reloginCount = all.filter((b) => b.status.phase === "needs_relogin").length;
    assert.equal(reloginCount, 1, `expected 1 needs_relogin, got: ${all.map((b) => b.status.phase).join(",")}`);
    // The other two should have been started (lastActivatedAt stamped); user-2 must NOT be.
    const started = all.filter((b) => typeof b.status.lastActivatedAt === "number");
    assert.equal(started.length, 2, `expected 2 started, got ${started.length}`);
    assert.equal(internals.bots.get("user-2")!.status.lastActivatedAt, undefined, "needs_relogin bot must not be started");
  } finally {
    await orchestrator?.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("expected queue time calculation is dynamic", async (t) => {
  const tempPath = join(process.cwd(), "test-data-tmp-");
  const dataDir = await mkdtemp(tempPath);
  
  try {
    const mockMetrics: MetricsStore = {
      record: () => {},
      updateSample: () => true,
      recent: (limit?: number) => [
        {
          userId: "user-1",
          appId: "game-1",
          startedAt: 10000,
          reachedReadyAt: 20000, // took 10 seconds
          reachedReadyQueuePosition: 5, // 5 positions -> 2s per position
          outcome: "ready",
          zone: "NP-TEST-01"
        }
      ],
      snapshot: () => [],
    } as unknown as MetricsStore;

    const orchestrator = new BotOrchestrator(createAuth([account1, account2]), mockMetrics, dataDir);
    await orchestrator.updateConfig({ appId: "game-1", zone: "NP-TEST-01" });

    const internals = orchestrator as unknown as {
      bots: Map<string, { status: { phase: string; queuePosition?: number } }>;
      getExpectedQueueTimeMs(): Promise<number>;
    };

    // Case 1: Active queueing bot at position 10. Since recent metrics show 2s/position:
    // Expected time = 10 * 2000ms = 20000ms (20 seconds)
    internals.bots.set("user-1", {
      status: { phase: "queueing", queuePosition: 10 }
    });

    let expected = await internals.getExpectedQueueTimeMs();
    assert.equal(expected, 20_000);

    // Case 2: No active queueing bots. Should fall back to the historical average (which is 10 seconds)
    internals.bots.clear();
    expected = await internals.getExpectedQueueTimeMs();
    assert.equal(expected, 10_000);

    // Case 3: Empty metrics as well, should fallback to configured preemptiveQueueMs or 10 minutes
    const emptyMetrics = {
      recent: () => []
    } as unknown as MetricsStore;

    const orchestratorEmpty = new BotOrchestrator(createAuth([account1]), emptyMetrics, dataDir);
    await orchestratorEmpty.updateConfig({ appId: "game-1", preemptiveQueueMs: 45_000 });
    
    expected = await (orchestratorEmpty as any).getExpectedQueueTimeMs();
    assert.equal(expected, 45_000);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

