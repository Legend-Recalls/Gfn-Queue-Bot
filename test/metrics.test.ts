import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MetricsStore } from "../src/metrics/store";

test("metrics retain queue results after a ready session stops", async () => {
  const dataDir = await mkdtemp(join(process.cwd(), "test-metrics-"));
  try {
    const metrics = new MetricsStore(join(dataDir, "metrics.json"));
    metrics.record({
      userId: "user-1",
      appId: "game-1",
      startedAt: 1_000,
      reachedReadyAt: 6_000,
      endedAt: 7_000,
      outcome: "stopped",
    });

    const [snapshot] = metrics.snapshot("user-1", "game-1", Number.MAX_SAFE_INTEGER);
    assert.equal(snapshot?.readyCount, 1);
    assert.equal(snapshot?.avgQueueMs, 5_000);
    assert.equal(snapshot?.lastReadyAt, 6_000);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("percentiles use interpolated queue durations", async () => {
  const dataDir = await mkdtemp(join(process.cwd(), "test-metrics-"));
  try {
    const metrics = new MetricsStore(join(dataDir, "metrics.json"));
    for (const [index, queueMs] of [1_000, 2_000, 3_000, 4_000].entries()) {
      metrics.record({
        userId: "user-1",
        appId: "game-1",
        startedAt: index * 10_000,
        reachedReadyAt: index * 10_000 + queueMs,
        outcome: "stopped",
      });
    }

    const [snapshot] = metrics.snapshot("user-1", "game-1", Number.MAX_SAFE_INTEGER);
    assert.equal(snapshot?.avgQueueMs, 2_500);
    assert.equal(snapshot?.p50QueueMs, 2_500);
    assert.ok(Math.abs((snapshot?.p95QueueMs ?? 0) - 3_850) < 0.000001);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("metrics report the latest ready timestamp, not insertion order", async () => {
  const dataDir = await mkdtemp(join(process.cwd(), "test-metrics-"));
  try {
    const metrics = new MetricsStore(join(dataDir, "metrics.json"));
    metrics.record({
      userId: "user-1",
      appId: "game-1",
      startedAt: 1_000,
      reachedReadyAt: 9_000,
      outcome: "stopped",
    });
    metrics.record({
      userId: "user-1",
      appId: "game-1",
      startedAt: 2_000,
      reachedReadyAt: 5_000,
      outcome: "stopped",
    });

    const [snapshot] = metrics.snapshot("user-1", "game-1", Number.MAX_SAFE_INTEGER);
    assert.equal(snapshot?.lastReadyAt, 9_000);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
