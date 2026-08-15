import assert from "node:assert/strict";
import test from "node:test";

import { RateLimiter } from "../src/bot/rateLimiter";

test("rate limiter preserves per-account spacing for queued requests", async () => {
  const limiter = new RateLimiter(10, 10_000);
  const firstStartedAt = Date.now();

  const first = limiter.acquire("user-1");
  const second = limiter.acquire("user-1");

  await first;
  const firstResolvedAt = Date.now();
  await second;
  const secondResolvedAt = Date.now();

  assert.ok(firstResolvedAt - firstStartedAt < 500, "first request should resolve immediately");
  assert.ok(
    secondResolvedAt - firstResolvedAt >= 1_800,
    "requests for one account should remain at least roughly two seconds apart",
  );
});
