import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { AuthManager } from "./gfn/auth";
import { MetricsStore } from "./metrics/store";
import { BotOrchestrator } from "./bot/orchestrator";
import { DashboardServer } from "./dashboard/server";

const execAsync = promisify(exec);

const DATA_DIR = process.env.QUEUE_BOT_DATA_DIR ?? join(process.cwd(), "data");
const DASHBOARD_PORT = Number(process.env.QUEUE_BOT_PORT ?? 5174);
const ACCOUNTS_FILE = join(DATA_DIR, "accounts.json");
const METRICS_FILE = join(DATA_DIR, "metrics.json");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const auth = new AuthManager(ACCOUNTS_FILE);
const metrics = new MetricsStore(METRICS_FILE);
const orchestrator = new BotOrchestrator(auth, metrics, DATA_DIR);

async function openBrowser(url: string): Promise<void> {
  if (process.env.QUEUE_BOT_NO_OPEN === "1") {
    console.log(`[Browser] Open ${url} manually.`);
    return;
  }
  try {
    if (process.platform === "win32") {
      await execAsync(`start "" "${url}"`, { shell: "cmd.exe" });
    } else if (process.platform === "darwin") {
      await execAsync(`open "${url}"`);
    } else {
      await execAsync(`xdg-open "${url}"`);
    }
  } catch (error) {
    console.warn("[Browser] Could not open browser automatically:", error);
    console.log(`[Browser] Please open ${url} manually.`);
  }
}

async function main(): Promise<void> {
  await auth.load();
  await metrics.load();
  await orchestrator.loadConfig();
  orchestrator.reconcileBots();

  const dashboard = new DashboardServer({
    port: DASHBOARD_PORT,
    auth,
    orchestrator,
    metrics,
    openBrowser: (url) => { void openBrowser(url); },
  });
  await dashboard.start();

  const shutdown = async () => {
    console.log("\n[Shutdown] Stopping bot and dashboard…");
    await dashboard.stop();
    await orchestrator.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch((error) => {
  console.error("[Fatal]", error);
  process.exit(1);
});
