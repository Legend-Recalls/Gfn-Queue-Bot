import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface QueueSample {
  userId: string;
  appId: string;
  startedAt: number;
  reachedReadyAt?: number;
  reachedReadyQueuePosition?: number;
  endedAt?: number;
  outcome: "running" | "ready" | "stopped" | "error" | "rate_limited" | "claimed";
  errorMessage?: string;
  zone?: string;
  holdDurationMs?: number;
}

export interface MetricsSnapshot {
  userId: string;
  appId: string;
  sampleCount: number;
  readyCount: number;
  claimedCount: number;
  errorCount: number;
  avgQueueMs: number | null;
  p50QueueMs: number | null;
  p95QueueMs: number | null;
  fastestQueueMs: number | null;
  lastSampleAt: number | null;
  lastReadyAt: number | null;
  bestPositionReached: number | null;
}

export interface MetricsStoreSnapshot {
  samples: QueueSample[];
  updatedAt: number;
}

const MAX_SAMPLES = 5000;

export class MetricsStore {
  private samples: QueueSample[] = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MetricsStoreSnapshot;
      this.samples = Array.isArray(parsed.samples) ? parsed.samples : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[Metrics] failed to load:", error);
      }
      this.samples = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const snapshot: MetricsStoreSnapshot = {
      samples: this.samples.slice(-MAX_SAMPLES),
      updatedAt: Date.now(),
    };
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  record(sample: QueueSample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
    void this.persist();
  }

  updateSample(predicate: (s: QueueSample) => boolean, patch: Partial<QueueSample>): boolean {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const sample = this.samples[i];
      if (sample && predicate(sample)) {
        Object.assign(sample, patch);
        void this.persist();
        return true;
      }
    }
    return false;
  }

  snapshot(userId?: string, appId?: string, windowMs = 24 * 60 * 60 * 1000): MetricsSnapshot[] {
    const cutoff = Date.now() - windowMs;
    const matching = this.samples.filter((s) => {
      if (s.startedAt < cutoff) return false;
      if (userId && s.userId !== userId) return false;
      if (appId && s.appId !== appId) return false;
      return true;
    });
    const byKey = new Map<string, QueueSample[]>();
    for (const s of matching) {
      const key = `${s.userId}::${s.appId}`;
      const list = byKey.get(key) ?? [];
      list.push(s);
      byKey.set(key, list);
    }
    const out: MetricsSnapshot[] = [];
    for (const [key, list] of byKey.entries()) {
      const [uid, aid] = key.split("::");
      if (!uid || !aid) continue;
      // Keep successful queue times in the ranking even after the held session
      // is later stopped or expires.
      const readySamples = list.filter(
        (s) =>
          typeof s.reachedReadyAt === "number" &&
          s.reachedReadyAt >= s.startedAt &&
          s.outcome !== "error" &&
          s.outcome !== "rate_limited",
      );
      const queueMs = readySamples
        .map((s) => (s.reachedReadyAt as number) - s.startedAt)
        .sort((a, b) => a - b);
      out.push({
        userId: uid,
        appId: aid,
        sampleCount: list.length,
        readyCount: readySamples.length,
        claimedCount: list.filter((s) => s.outcome === "claimed").length,
        errorCount: list.filter((s) => s.outcome === "error" || s.outcome === "rate_limited").length,
        avgQueueMs: queueMs.length === 0 ? null : queueMs.reduce((a, b) => a + b, 0) / queueMs.length,
        p50QueueMs: queueMs.length === 0 ? null : percentile(queueMs, 0.5),
        p95QueueMs: queueMs.length === 0 ? null : percentile(queueMs, 0.95),
        fastestQueueMs: queueMs.length === 0 ? null : queueMs[0] ?? null,
        lastSampleAt: list[list.length - 1]?.startedAt ?? null,
        lastReadyAt: readySamples.reduce<number | null>(
          (latest, sample) => Math.max(latest ?? Number.NEGATIVE_INFINITY, sample.reachedReadyAt as number),
          null,
        ),
        bestPositionReached: list
          .map((s) => s.reachedReadyQueuePosition)
          .filter((q): q is number => typeof q === "number")
          .reduce((best, q) => (best === null || q < best ? q : best), null as number | null),
      });
    }
    out.sort((a, b) => {
      const av = a.p50QueueMs ?? Number.POSITIVE_INFINITY;
      const bv = b.p50QueueMs ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
    return out;
  }

  recent(limit = 50): QueueSample[] {
    return this.samples.slice(-limit);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;

  const position = (sorted.length - 1) * p;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}
