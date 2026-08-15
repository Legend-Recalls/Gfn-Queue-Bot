import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthManager, LoginProvider, StoredAccount } from "../gfn/auth";
import { resolveLaunchAppId } from "../gfn/session";
import { BotOrchestrator, BotConfig } from "../bot/orchestrator";
import { MetricsStore, MetricsSnapshot, QueueSample } from "../metrics/store";
import { AccountStatus } from "../bot/accountBot";
import { browseCatalog } from "../gfn/games";
import { deleteProfile, isGFNRunning, listProfiles, loadProfile, logout, saveProfile } from "../../gfn-switcher/switcher";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, "..", "..", "web");

export interface DashboardServerOptions {
  port: number;
  auth: AuthManager;
  orchestrator: BotOrchestrator;
  metrics: MetricsStore;
  openBrowser: (url: string) => void;
}

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private sseClients = new Set<ServerResponse>();
  private pendingLogins = new Map<string, { providerCode?: string; startedAt: number }>();

  constructor(private readonly options: DashboardServerOptions) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    this.options.orchestrator.on("status", (status) => this.broadcastSse({ type: "status", status }));
    this.options.orchestrator.on("ready", (status) => this.broadcastSse({ type: "ready", status }));
    this.options.orchestrator.on("config", (config) => this.broadcastSse({ type: "config", config }));
    this.options.orchestrator.on("session-available", (data) => this.broadcastSse({ type: "session-available", ...data }));
    this.options.orchestrator.on("session-claimed", (data) => this.broadcastSse({ type: "session-claimed", ...data }));
    this.options.orchestrator.on("auth-expired", (data) => this.broadcastSse({ type: "auth-expired", ...data }));
    this.options.orchestrator.on("auth-recovered", (data) => this.broadcastSse({ type: "auth-recovered", ...data }));
    this.cachedProviders = await this.options.auth.getProviders();
    return new Promise((resolve) => {
      this.server!.listen(this.options.port, "127.0.0.1", () => {
        const host = `http://127.0.0.1:${this.options.port}`;
        console.log(`[Dashboard] Open ${host} in your browser.`);
        this.options.openBrowser(host);
        resolve(host);
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private broadcastSse(payload: object): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(data); } catch { this.sseClients.delete(client); }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.options.port}`);
      if (req.method === "GET" && url.pathname === "/api/gfn-profiles") return this.handleListGfnProfiles(req, res);
      if (req.method === "POST" && url.pathname === "/api/gfn-profiles/save") return this.handleSaveGfnProfile(req, res);
      if (req.method === "POST" && url.pathname === "/api/gfn-profiles/load") return this.handleLoadGfnProfile(req, res);
      if (req.method === "POST" && url.pathname === "/api/gfn-profiles/delete") return this.handleDeleteGfnProfile(req, res);
      if (req.method === "POST" && url.pathname === "/api/gfn-profiles/new-login") return this.handleNewGfnLogin(req, res);
      if (req.method === "POST" && url.pathname === "/api/accounts/assign-profile") return this.handleAssignProfile(req, res);
      if (req.method === "POST" && url.pathname === "/api/accounts/retry-auth") return this.handleRetryAuth(req, res);
      if (req.method === "POST" && url.pathname === "/api/accounts/play") return this.handlePlaySession(req, res);
      if (req.method === "POST" && url.pathname === "/api/accounts/claim") return this.handleClaimAccount(req, res);
      if (req.method === "GET" && url.pathname === "/api/rotation") {
        const statuses = this.options.orchestrator.listStatuses();
        return this.respondJson(res, {
          holding: statuses.filter(s => s.phase === "holding" || s.phase === "ready"),
          config: this.options.orchestrator.getConfig()
        });
      }
      if (req.method === "GET" && url.pathname === "/api/state") return this.respondJson(res, this.snapshot());
      if (req.method === "GET" && url.pathname === "/api/metrics") return this.respondJson(res, this.options.metrics.snapshot(undefined, this.options.orchestrator.getConfig().appId));
      if (req.method === "GET" && url.pathname === "/api/recent") return this.respondJson(res, this.options.metrics.recent(50));
      if (req.method === "GET" && url.pathname === "/api/events") return this.startSse(res);
      if (req.method === "GET" && url.pathname === "/api/providers") return this.respondJson(res, await this.options.auth.getProviders());
      if (req.method === "POST" && url.pathname === "/api/config") return this.handleConfigUpdate(req, res);
      if (req.method === "POST" && url.pathname === "/api/login") return this.handleLoginStart(req, res);
      if (req.method === "POST" && url.pathname === "/api/accounts/remove") return this.handleRemoveAccount(req, res);
      if (req.method === "POST" && url.pathname === "/api/accounts/start") return this.handleAccountControl(req, res, "start");
      if (req.method === "POST" && url.pathname === "/api/accounts/stop") return this.handleAccountControl(req, res, "stop");
      if (req.method === "POST" && url.pathname === "/api/resolve-game") return this.handleResolveGame(req, res);
      if (req.method === "GET" && url.pathname === "/api/games") return this.handleBrowseGames(url, res);
      if (req.method === "GET" && url.pathname === "/api/zones") return this.handleGetZones(res);
      if (req.method === "GET" && url.pathname.startsWith("/api/pending-logins")) {
        return this.respondJson(res, Array.from(this.pendingLogins.entries()).map(([id, info]) => ({ id, ...info })));
      }
      if (req.method === "GET") return this.serveStatic(url.pathname, res);
      res.statusCode = 405;
      res.end("Method not allowed");
    } catch (error) {
      console.error("[Dashboard] handler error:", error);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(error instanceof Error ? error.message : "Internal error");
    }
  }

  private snapshot(): {
    config: BotConfig;
    accounts: AccountStatus[];
    providers: LoginProvider[];
    metrics: MetricsSnapshot[];
    recent: QueueSample[];
  } {
    const appId = this.options.orchestrator.getConfig().appId;
    return {
      config: this.options.orchestrator.getConfig(),
      accounts: this.options.orchestrator.listStatuses(),
      providers: this.cachedProviders ?? [],
      metrics: this.options.metrics.snapshot(undefined, appId),
      recent: this.options.metrics.recent(20),
    };
  }

  private cachedProviders: LoginProvider[] = [];

  private respondJson(res: ServerResponse, body: unknown): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  private startSse(res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    this.sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(`: keep-alive\n\n`); } catch { /* ignore */ }
    }, 15_000);
    res.on("close", () => {
      clearInterval(ping);
      this.sseClients.delete(res);
    });
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const safePath = pathname === "/" ? "/index.html" : pathname;
    const fullPath = join(WEB_ROOT, safePath);
    if (!fullPath.startsWith(WEB_ROOT)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(fullPath);
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[extname(fullPath).toLowerCase()] ?? "application/octet-stream");
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not found");
    }
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    return JSON.parse(text);
  }

  private async handleConfigUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as Partial<BotConfig>;
    const updated = await this.options.orchestrator.updateConfig(body);
    this.respondJson(res, updated);
  }

  private async handleLoginStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { providerIdpId?: string; openInBrowser?: boolean };
    const id = `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingLogins.set(id, { providerCode: body.providerIdpId, startedAt: Date.now() });
    const openBrowser = (url: string) => {
      if (body.openInBrowser !== false) this.options.openBrowser(url);
    };
    void this.options.auth.loginInteractive({ idpId: body.providerIdpId, openBrowser })
      .then((account) => {
        this.pendingLogins.delete(id);
        this.broadcastSse({ type: "account-added", account: publicAccount(account) });
      })
      .catch((error) => {
        this.pendingLogins.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        this.broadcastSse({ type: "login-error", id, message });
        console.error("[Dashboard] login failed:", message);
      });
    this.respondJson(res, { id, status: "pending", message: "Open the printed URL in a browser to complete login." });
  }

  private async handleRemoveAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { userId: string };
    if (!body.userId) {
      res.statusCode = 400;
      res.end("userId required");
      return;
    }
    await this.options.auth.removeAccount(body.userId);
    const config = this.options.orchestrator.getConfig();
    if (config.enabledAccountIds.includes(body.userId)) {
      await this.options.orchestrator.updateConfig({
        enabledAccountIds: config.enabledAccountIds.filter((id) => id !== body.userId),
      });
    }
    this.broadcastSse({ type: "account-removed", userId: body.userId });
    this.respondJson(res, { ok: true });
  }

  private async handleListGfnProfiles(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const profiles = listProfiles();
    this.respondJson(res, { profiles });
  }

  private async handleSaveGfnProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { profileName?: string; overwrite?: boolean; force?: boolean };
    const profileName = body.profileName?.trim();
    if (!profileName) {
      res.statusCode = 400;
      res.end("profileName required");
      return;
    }

    if (!body.overwrite && listProfiles().some((profile) => profile.name === profileName)) {
      res.statusCode = 409;
      res.end("GFN profile already exists");
      return;
    }

    const running = isGFNRunning();
    if (running && !body.force) {
      this.respondJson(res, {
        status: "running_warning",
        message: "Saving the current GFN login will close GeForce NOW briefly. Continue?",
      });
      return;
    }

    try {
      saveProfile(profileName);
      this.respondJson(res, { ok: true, profiles: listProfiles() });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleLoadGfnProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { profileName?: string; force?: boolean };
    const profileName = body.profileName?.trim();
    if (!profileName) {
      res.statusCode = 400;
      res.end("profileName required");
      return;
    }

    if (!listProfiles().some((profile) => profile.name === profileName)) {
      res.statusCode = 404;
      res.end("GFN profile not found");
      return;
    }

    const running = isGFNRunning();
    if (running && !body.force) {
      this.respondJson(res, {
        status: "running_warning",
        message: "Switching profiles will close the running GeForce NOW instance. Continue?",
      });
      return;
    }

    try {
      const profile = loadProfile(profileName);
      if (!profile) throw new Error(`Profile '${profileName}' could not be loaded`);
      this.respondJson(res, { ok: true, profile, profiles: listProfiles() });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleDeleteGfnProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { profileName?: string };
    const profileName = body.profileName?.trim();
    if (!profileName) {
      res.statusCode = 400;
      res.end("profileName required");
      return;
    }

    try {
      if (!deleteProfile(profileName)) {
        res.statusCode = 404;
        res.end("GFN profile not found");
        return;
      }
      const config = await this.options.orchestrator.removeProfileAssignments(profileName);
      this.respondJson(res, { ok: true, config, profiles: listProfiles() });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleNewGfnLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { force?: boolean };
    const running = isGFNRunning();
    if (running && !body.force) {
      this.respondJson(res, {
        status: "running_warning",
        message: "Starting a new GFN login will close the running GeForce NOW instance and clear the active login. Continue?",
      });
      return;
    }

    try {
      logout();
      this.respondJson(res, { ok: true, profiles: listProfiles() });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleAssignProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { userId: string; profileName: string };
    if (!body.userId) {
      res.statusCode = 400;
      res.end("userId required");
      return;
    }
    if (body.profileName && !listProfiles().some((profile) => profile.name === body.profileName)) {
      res.statusCode = 404;
      res.end("GFN profile not found");
      return;
    }
    const config = await this.options.orchestrator.assignProfile(body.userId, body.profileName);
    this.respondJson(res, { ok: true, config });
  }

  private async handleRetryAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { userId: string };
    if (!body.userId) {
      res.statusCode = 400;
      res.end("userId required");
      return;
    }
    if (!this.options.auth.getAccount(body.userId)) {
      res.statusCode = 404;
      res.end("account not found");
      return;
    }
    try {
      const result = await this.options.orchestrator.retryAuth(body.userId);
      if (!result.ok) {
        res.statusCode = 409;
        res.end("Account still needs re-login. Refresh tokens could not be recovered.");
        return;
      }
      this.respondJson(res, { ok: true });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handlePlaySession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { userId: string; force?: boolean };
    if (!body.userId) {
      res.statusCode = 400;
      res.end("userId required");
      return;
    }
    
    const statuses = this.options.orchestrator.listStatuses();
    const status = statuses.find(s => s.userId === body.userId);
    if (!status) {
      res.statusCode = 404;
      res.end("Account status not found");
      return;
    }
    
    if (status.phase !== "holding" && status.phase !== "ready" && status.phase !== "claimed") {
      res.statusCode = 400;
      res.end(`Account is in phase ${status.phase}, cannot play session`);
      return;
    }

    const profileName = this.options.orchestrator.getProfileAssignment(body.userId);
    if (!profileName) {
      res.statusCode = 400;
      res.end("No GFN profile assigned to this account. Please assign one in the Accounts section.");
      return;
    }

    if (!listProfiles().some((profile) => profile.name === profileName)) {
      res.statusCode = 404;
      res.end(`Assigned GFN profile '${profileName}' was not found.`);
      return;
    }

    const running = isGFNRunning();
    if (running && !body.force) {
      this.respondJson(res, {
        status: "running_warning",
        message: "GeForce NOW is currently running. Playing this session will close the active instance. Do you want to continue?"
      });
      return;
    }

    const claimResult = status.phase === "claimed"
      ? {
          userId: status.userId,
          displayName: status.displayName,
          email: status.email,
          sessionId: status.sessionId ?? "",
          serverIp: status.serverIp,
          streamingBaseUrl: status.streamingBaseUrl,
          holdStartedAt: status.holdStartedAt ?? status.reachedReadyAt ?? Date.now(),
          holdExpiresAt: status.holdExpiresAt ?? Date.now(),
          remainingMs: Math.max(0, (status.holdExpiresAt ?? Date.now()) - Date.now()),
        }
      : this.options.orchestrator.claimSession(body.userId);
    if (!claimResult || !claimResult.sessionId) {
      res.statusCode = 400;
      res.end("Failed to claim session. It might have expired or already been claimed.");
      return;
    }

    // Load the profile (kills GFN, restores files, and restarts GFN)
    try {
      const loadedProfile = loadProfile(profileName);
      if (!loadedProfile) {
        throw new Error(`Profile '${profileName}' could not be loaded`);
      }
    } catch (e) {
      res.statusCode = 500;
      res.end(`Failed to load GFN profile: ${(e as Error).message}`);
      return;
    }

    this.respondJson(res, { ok: true, claim: claimResult });
  }

  private async handleClaimAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { userId: string };
    if (!body.userId) {
      res.statusCode = 400;
      res.end("userId required");
      return;
    }
    const claimResult = this.options.orchestrator.claimSession(body.userId);
    if (!claimResult) {
      res.statusCode = 400;
      res.end("Session not available for claim or invalid account");
      return;
    }
    this.respondJson(res, { ok: true, claim: claimResult });
  }

  private async handleAccountControl(req: IncomingMessage, res: ServerResponse, action: "start" | "stop"): Promise<void> {
    const body = (await this.readJson(req)) as { userId: string };
    if (!body.userId) {
      res.statusCode = 400;
      res.end("userId required");
      return;
    }
    if (!this.options.auth.getAccount(body.userId)) {
      res.statusCode = 404;
      res.end("account not found");
      return;
    }

    const config = this.options.orchestrator.getConfig();
    if (action === "start" && !config.appId) {
      res.statusCode = 400;
      res.end("Set a game appId before starting an account");
      return;
    }

    const enabled = new Set(config.enabledAccountIds);
    if (action === "start") {
      enabled.add(body.userId);
    } else {
      enabled.delete(body.userId);
    }

    const updated = await this.options.orchestrator.updateConfig({ enabledAccountIds: Array.from(enabled) });
    this.broadcastSse({ type: "account-control", userId: body.userId, action });
    this.respondJson(res, { ok: true, action, config: updated });
  }

  private async handleResolveGame(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readJson(req)) as { appIdOrUuid: string; userId?: string };
    if (!body.appIdOrUuid) {
      res.statusCode = 400;
      res.end("appIdOrUuid required");
      return;
    }
    const targetUser = body.userId ?? this.options.auth.listAccounts()[0]?.user.userId;
    if (!targetUser) {
      res.statusCode = 400;
      res.end("Add an account first to resolve games");
      return;
    }
    const token = await this.options.auth.resolveToken(targetUser);
    const account = this.options.auth.getAccount(targetUser);
    const providerBase = account?.provider.streamingServiceUrl;
    try {
      const resolved = await resolveLaunchAppId(token, body.appIdOrUuid, providerBase);
      if (!resolved) {
        res.statusCode = 404;
        res.end("Game not found");
        return;
      }
      this.respondJson(res, resolved);
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleBrowseGames(url: URL, res: ServerResponse): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    const userIdParam = url.searchParams.get("userId");
    const targetUser = userIdParam ?? this.options.auth.listAccounts()[0]?.user.userId;
    if (!targetUser) {
      res.statusCode = 400;
      res.end("Add an account first to browse games");
      return;
    }
    try {
      const token = await this.options.auth.resolveToken(targetUser);
      const account = this.options.auth.getAccount(targetUser);
      const providerStreamingBaseUrl = account?.provider.streamingServiceUrl;
      const result = await browseCatalog({
        token,
        providerStreamingBaseUrl,
        searchQuery: q,
        fetchCount: 120,
      });
      this.respondJson(res, result);
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleGetZones(res: ServerResponse): Promise<void> {
    try {
      const response = await fetch("https://api.printedwaste.com/gfn/queue/", {
        headers: {
          "User-Agent": "opennow-queue-bot",
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`PrintedWaste API returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as { status?: boolean; data?: Record<string, unknown> };
      if (!body.status || !body.data) {
        throw new Error("PrintedWaste API returned status:false or invalid structure");
      }

      const zones: Array<{ id: string; region: string; queuePosition: number; etaMs?: number }> = [];
      for (const [zoneId, rawZone] of Object.entries(body.data)) {
        if (!rawZone || typeof rawZone !== "object" || Array.isArray(rawZone)) {
          continue;
        }
        const zone = rawZone as Record<string, unknown>;
        if (!zoneId.startsWith("NP-") || zoneId.startsWith("NPA-")) {
          continue;
        }
        zones.push({
          id: zoneId,
          region: typeof zone.Region === "string" ? zone.Region : "Unknown",
          queuePosition: typeof zone.QueuePosition === "number" ? zone.QueuePosition : 0,
          etaMs: typeof zone.eta === "number" ? zone.eta : undefined,
        });
      }

      zones.sort((a, b) => a.id.localeCompare(b.id));

      this.respondJson(res, { zones });
    } catch (error) {
      console.error("[Dashboard] Failed to fetch zones from PrintedWaste:", error);
      const fallbackZones = [
        { id: "NP-AMS-06", region: "EU", queuePosition: 0 },
        { id: "NP-AMS-05", region: "EU", queuePosition: 0 },
        { id: "NP-FRK-04", region: "EU", queuePosition: 0 },
        { id: "NP-FRK-05", region: "EU", queuePosition: 0 },
        { id: "NP-LON-04", region: "EU", queuePosition: 0 },
        { id: "NP-LON-03", region: "EU", queuePosition: 0 },
        { id: "NP-PAR-04", region: "EU", queuePosition: 0 },
        { id: "NP-PAR-03", region: "EU", queuePosition: 0 },
        { id: "NP-SOF-02", region: "EU", queuePosition: 0 },
        { id: "NP-ASH-03", region: "US", queuePosition: 0 },
        { id: "NP-ASH-04", region: "US", queuePosition: 0 },
        { id: "NP-CHI-03", region: "US", queuePosition: 0 },
        { id: "NP-CHI-04", region: "US", queuePosition: 0 },
        { id: "NP-DAL-03", region: "US", queuePosition: 0 },
        { id: "NP-DAL-04", region: "US", queuePosition: 0 },
        { id: "NP-LAX-02", region: "US", queuePosition: 0 },
        { id: "NP-LAX-03", region: "US", queuePosition: 0 },
        { id: "NP-MIA-02", region: "US", queuePosition: 0 },
        { id: "NP-NWK-02", region: "US", queuePosition: 0 },
        { id: "NP-ORL-02", region: "US", queuePosition: 0 },
        { id: "NP-SJC-03", region: "US", queuePosition: 0 },
        { id: "NP-SJC-04", region: "US", queuePosition: 0 },
      ];
      this.respondJson(res, { zones: fallbackZones, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function publicAccount(account: StoredAccount) {
  return {
    userId: account.user.userId,
    displayName: account.user.displayName,
    email: account.user.email,
    membershipTier: account.user.membershipTier,
    providerCode: account.provider.code,
    providerDisplayName: account.provider.displayName,
  };
}
