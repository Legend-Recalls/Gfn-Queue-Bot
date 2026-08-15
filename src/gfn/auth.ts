import { createHash, randomBytes } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { hostname, userInfo as osUserInfo } from "node:os";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import {
  GFN_USER_AGENT,
  buildNvidiaAuthHeaders,
} from "./clientHeaders";

const SERVICE_URLS_ENDPOINT = "https://pcs.geforcenow.com/v1/serviceUrls";
const TOKEN_ENDPOINT = "https://login.nvidia.com/token";
const CLIENT_TOKEN_ENDPOINT = "https://login.nvidia.com/client_token";
const USERINFO_ENDPOINT = "https://login.nvidia.com/userinfo";
const AUTH_ENDPOINT = "https://login.nvidia.com/authorize";

const CLIENT_ID = "ZU7sPN-miLujMD95LfOQ453IB0AtjM8sMyvgJ9wCXEQ";
const SCOPES = "openid consent email tk_client age";
const DEFAULT_IDP_ID = "PDiAhv2kJTFeQ7WOPqiQ2tRZ7lGhR2X11dXvM4TZSxg";

const REDIRECT_PORTS = [2259, 6460, 7119, 8870, 9096];
const OAUTH_TIMEOUT_MS = 180_000;
const TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const FETCH_MAX_RETRIES = 3;
const FETCH_BASE_DELAY_MS = 1_000;
const CLIENT_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  clientToken?: string;
  expiresAt: number;
  clientTokenExpiresAt?: number;
}

/**
 * Thrown when an account's session is hard-expired AND every refresh path
 * failed. Distinct from a generic Error (transient/network) and from
 * SessionError (cloudmatch API). Callers should transition the account to a
 * terminal "needs re-login" state instead of retrying pointlessly.
 */
export class AuthExpiredError extends Error {
  readonly userId: string;
  constructor(userId: string, message?: string) {
    super(message ?? `Auth session for ${userId} expired and refresh failed. Please re-login.`);
    this.name = "AuthExpiredError";
    this.userId = userId;
  }

  /** Runtime-safe type guard (works across module/instance boundaries). */
  static is(value: unknown): value is AuthExpiredError {
    return value instanceof Error && (value as Error & { name?: string }).name === "AuthExpiredError";
  }
}

/**
 * Retryable fetch wrapper. Retries on transient network errors (DNS, socket,
 * timeout) but NOT on HTTP-level failures (those are the caller's concern).
 */
async function retryableFetch(
  url: string,
  init?: RequestInit,
  maxRetries = FETCH_MAX_RETRIES,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const isTransient =
        /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up|network/i.test(msg);
      if (!isTransient || attempt >= maxRetries) throw error;
      const jitter = Math.random() * 500;
      const backoff = FETCH_BASE_DELAY_MS * 2 ** attempt + jitter;
      console.warn(`[Auth] fetch attempt ${attempt + 1}/${maxRetries + 1} failed (${msg}), retrying in ${Math.round(backoff)}ms`);
      await delay(backoff);
    }
  }
  throw lastError;
}

export interface AuthUser {
  userId: string;
  displayName: string;
  email?: string;
  membershipTier: string;
}

export interface LoginProvider {
  idpId: string;
  code: string;
  displayName: string;
  streamingServiceUrl: string;
  priority?: number;
}

export interface StoredAccount {
  id: string;
  user: AuthUser;
  provider: LoginProvider;
  tokens: AuthTokens;
  createdAt: number;
  updatedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  client_token?: string;
  expires_in?: number;
}

interface ClientTokenResponse {
  client_token: string;
  expires_in?: number;
}

interface ServiceUrlsResponse {
  gfnServiceInfo?: {
    gfnServiceEndpoints?: Array<{
      idpId: string;
      loginProviderCode: string;
      loginProviderDisplayName: string;
      streamingServiceUrl: string;
      loginProviderPriority?: number;
    }>;
  };
}

function defaultProvider(): LoginProvider {
  return {
    idpId: DEFAULT_IDP_ID,
    code: "NVIDIA",
    displayName: "NVIDIA",
    streamingServiceUrl: "https://prod.cloudmatchbeta.nvidiagrid.net/",
    priority: 0,
  };
}

function normalizeProvider(provider: LoginProvider): LoginProvider {
  return {
    ...provider,
    streamingServiceUrl: provider.streamingServiceUrl.endsWith("/")
      ? provider.streamingServiceUrl
      : `${provider.streamingServiceUrl}/`,
  };
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwtPayload<T>(token: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;
  try {
    return JSON.parse(decodeBase64Url(payloadSegment)) as T;
  } catch {
    return null;
  }
}

function toExpiresAt(expiresInSeconds: number | undefined, defaultSeconds = 3600): number {
  return Date.now() + (expiresInSeconds ?? defaultSeconds) * 1000;
}

function isExpired(expiresAt: number | undefined): boolean {
  if (!expiresAt) return true;
  return expiresAt <= Date.now();
}

function isNearExpiry(expiresAt: number | undefined, windowMs: number): boolean {
  if (!expiresAt) return true;
  return expiresAt - Date.now() < windowMs;
}

function generateDeviceId(): string {
  return createHash("sha256")
    .update(`${hostname()}:${osUserInfo().username}:opennow-queue-bot`)
    .digest("hex");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
    .slice(0, 86);

  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return { verifier, challenge };
}

function buildAuthUrl(provider: LoginProvider, challenge: string, port: number): string {
  const redirectUri = `http://localhost:${port}`;
  const nonce = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    device_id: generateDeviceId(),
    scope: SCOPES,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    ui_locales: "en_US",
    nonce,
    prompt: "select_account",
    code_challenge: challenge,
    code_challenge_method: "S256",
    idp_id: provider.idpId,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(): Promise<number> {
  for (const port of REDIRECT_PORTS) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("No available OAuth callback ports");
}

function waitForAuthorizationCode(port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      const html = `<!doctype html><html><head><meta charset="utf-8"><title>OpenNOW Queue Bot Login</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1220;color:#dbe7ff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
<div style="background:#111a2c;padding:28px 32px;border:1px solid #30425f;border-radius:14px;max-width:480px;text-align:center">
<h2 style="margin-top:0">${code ? "Login complete" : "Login failed"}</h2>
<p>${code
  ? "You can close this window and return to the OpenNOW Queue Bot dashboard."
  : `Reason: ${error ?? "unknown"}. You can close this window and try again from the dashboard.`}</p>
</div></body></html>`;

      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);

      server.close(() => {
        if (code) resolve(code);
        else reject(new Error(error ?? "Authorization failed"));
      });
    });

    server.listen(port, "127.0.0.1", () => {
      const timer = setTimeout(() => {
        server.close(() => reject(new Error("Timed out waiting for OAuth callback")));
      }, timeoutMs);
      server.once("close", () => clearTimeout(timer));
    });
  });
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  port: number,
): Promise<AuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `http://localhost:${port}`,
    code_verifier: verifier,
  });

  const response = await retryableFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: buildNvidiaAuthHeaders({
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      includeReferer: true,
    }),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 400)}`);
  }

  const payload = (await response.json()) as TokenResponse;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    expiresAt: toExpiresAt(payload.expires_in),
  };
}

async function refreshAuthTokens(refreshToken: string): Promise<AuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const response = await retryableFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: buildNvidiaAuthHeaders({
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    }),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 400)}`);
  }

  const payload = (await response.json()) as TokenResponse;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    idToken: payload.id_token,
    expiresAt: toExpiresAt(payload.expires_in),
  };
}

async function requestClientToken(accessToken: string): Promise<{ token: string; expiresAt: number }> {
  const response = await retryableFetch(CLIENT_TOKEN_ENDPOINT, {
    headers: buildNvidiaAuthHeaders({ bearerToken: accessToken }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Client token request failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const payload = (await response.json()) as ClientTokenResponse;
  return { token: payload.client_token, expiresAt: toExpiresAt(payload.expires_in) };
}

async function refreshWithClientToken(
  clientToken: string,
  userId: string,
): Promise<{ access_token: string; refresh_token?: string; id_token?: string; client_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:client_token",
    client_token: clientToken,
    client_id: CLIENT_ID,
    sub: userId,
  });
  const response = await retryableFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: buildNvidiaAuthHeaders({
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    }),
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Client-token refresh failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return (await response.json()) as TokenResponse;
}

function mergeTokenSnapshot(base: AuthTokens, refreshed: TokenResponse): AuthTokens {
  // CRITICAL: Always preserve refreshToken. The client_token grant type does
  // NOT return a refresh_token, so we must carry the original forward.
  const mergedRefreshToken = refreshed.refresh_token || base.refreshToken;
  if (!mergedRefreshToken) {
    console.warn("[Auth] mergeTokenSnapshot: no refreshToken in either base or refreshed — account may become unrecoverable");
  }
  return {
    accessToken: refreshed.access_token,
    refreshToken: mergedRefreshToken,
    idToken: refreshed.id_token ?? base.idToken,
    expiresAt: toExpiresAt(refreshed.expires_in),
    clientToken: refreshed.client_token ?? base.clientToken,
    clientTokenExpiresAt: base.clientTokenExpiresAt,
  };
}

async function fetchUserInfo(tokens: AuthTokens): Promise<AuthUser> {
  const parsed = parseJwtPayload<{ sub?: string; email?: string; preferred_username?: string; gfn_tier?: string }>(
    tokens.idToken ?? tokens.accessToken,
  );
  if (parsed?.sub) {
    return {
      userId: parsed.sub,
      displayName: parsed.preferred_username ?? parsed.email?.split("@")[0] ?? "User",
      email: parsed.email,
      membershipTier: parsed.gfn_tier ?? "FREE",
    };
  }
  const response = await retryableFetch(USERINFO_ENDPOINT, {
    headers: buildNvidiaAuthHeaders({
      bearerToken: tokens.accessToken,
      accept: "application/json",
    }),
  });
  if (!response.ok) throw new Error(`User info failed (${response.status})`);
  const payload = (await response.json()) as { sub: string; preferred_username?: string; email?: string };
  return {
    userId: payload.sub,
    displayName: payload.preferred_username ?? payload.email?.split("@")[0] ?? "User",
    email: payload.email,
    membershipTier: "FREE",
  };
}

async function fetchProviders(): Promise<LoginProvider[]> {
  try {
    const response = await retryableFetch(SERVICE_URLS_ENDPOINT, {
      headers: { Accept: "application/json", "User-Agent": GFN_USER_AGENT },
    });
    if (!response.ok) return [defaultProvider()];
    const payload = (await response.json()) as ServiceUrlsResponse;
    const endpoints = payload.gfnServiceInfo?.gfnServiceEndpoints ?? [];
    const providers = endpoints
      .map<LoginProvider>((entry) => ({
        idpId: entry.idpId,
        code: entry.loginProviderCode,
        displayName:
          entry.loginProviderCode === "BPC" ? "bro.game" : entry.loginProviderDisplayName,
        streamingServiceUrl: entry.streamingServiceUrl,
        priority: entry.loginProviderPriority ?? 0,
      }))
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map(normalizeProvider);
    return providers.length > 0 ? providers : [defaultProvider()];
  } catch {
    return [defaultProvider()];
  }
}

export class AuthManager {
  private providers: LoginProvider[] = [];
  private accounts = new Map<string, StoredAccount>();

  constructor(private readonly statePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as { accounts?: StoredAccount[] };
      this.accounts.clear();
      for (const acc of parsed.accounts ?? []) {
        if (acc?.user?.userId) {
          this.accounts.set(acc.user.userId, { ...acc, provider: normalizeProvider(acc.provider) });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
        return;
      }
      console.warn("[Auth] Failed to load accounts, starting fresh:", error);
      this.accounts.clear();
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const payload = { accounts: Array.from(this.accounts.values()) };
    await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf8");
  }

  listAccounts(): StoredAccount[] {
    return Array.from(this.accounts.values());
  }

  getAccount(userId: string): StoredAccount | undefined {
    return this.accounts.get(userId);
  }

  async removeAccount(userId: string): Promise<void> {
    this.accounts.delete(userId);
    await this.persist();
  }

  async getProviders(): Promise<LoginProvider[]> {
    if (this.providers.length === 0) {
      this.providers = await fetchProviders();
    }
    return this.providers;
  }

  /**
   * Start an OAuth flow for a new account. Returns a promise that resolves with
   * the new account once the user completes login. The dashboard should print
   * `authUrl` for the user to open manually — we cannot open a browser headlessly.
   */
  async loginInteractive(options: { idpId?: string; openBrowser?: (url: string) => void } = {}): Promise<StoredAccount> {
    const providers = await this.getProviders();
    const selected =
      providers.find((p) => p.idpId === options.idpId) ??
      providers[0] ??
      defaultProvider();

    const { verifier, challenge } = generatePkce();
    const port = await findAvailablePort();
    const authUrl = buildAuthUrl(selected, challenge, port);

    console.log(`[Auth] Open this URL in a browser to log in (account will bind to provider: ${selected.displayName}):`);
    console.log(`[Auth] ${authUrl}`);
    options.openBrowser?.(authUrl);

    const code = await waitForAuthorizationCode(port, OAUTH_TIMEOUT_MS);
    let tokens = await exchangeAuthorizationCode(code, verifier, port);
    const user = await fetchUserInfo(tokens);
    try {
      tokens = await this.ensureClientToken(tokens);
    } catch (error) {
      console.warn("[Auth] Could not fetch client token, continuing without it:", error);
    }
    const account: StoredAccount = {
      id: user.userId,
      user,
      provider: normalizeProvider(selected),
      tokens,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.accounts.set(user.userId, account);
    await this.persist();
    return account;
  }

  private async ensureClientToken(tokens: AuthTokens): Promise<AuthTokens> {
    const usable =
      Boolean(tokens.clientToken) &&
      !isNearExpiry(tokens.clientTokenExpiresAt, CLIENT_TOKEN_REFRESH_WINDOW_MS);
    if (usable) return tokens;
    if (isExpired(tokens.expiresAt)) return tokens;
    const ct = await requestClientToken(tokens.accessToken);
    return {
      ...tokens,
      clientToken: ct.token,
      clientTokenExpiresAt: ct.expiresAt,
    };
  }

  /**
   * Return a valid access/id token for the given account, refreshing if needed.
   * Throws if the saved session cannot be recovered.
   */
  async resolveToken(userId: string): Promise<string> {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No account ${userId}`);

    let tokens = account.tokens;
    const needsRefresh = isNearExpiry(tokens.expiresAt, TOKEN_REFRESH_WINDOW_MS);

    if (!needsRefresh) {
      return tokens.idToken ?? tokens.accessToken;
    }

    try {
      tokens = await this.refreshTokens(account, tokens);
    } catch (error) {
      if (isExpired(tokens.expiresAt)) {
        // DON'T remove the account — it still has user info, provider, etc.
        // Mark it with cleared tokens so the dashboard can show "needs re-login".
        console.error(
          `[Auth] Session for ${account.user.displayName} expired and all refresh paths failed. ` +
          `Account preserved — please re-login from the dashboard.`,
        );
        throw new AuthExpiredError(
          userId,
          `Session for ${account.user.displayName} expired and refresh failed. Please re-login.`,
        );
      }
      // Token not yet hard-expired — return the current (still-valid) token
      // and let the next cycle retry the refresh.
      console.warn(
        `[Auth] Refresh failed for ${account.user.displayName} but token still valid for ` +
        `${Math.round((tokens.expiresAt - Date.now()) / 1000)}s — using existing token`,
      );
      return tokens.idToken ?? tokens.accessToken;
    }

    const refreshed: StoredAccount = { ...account, tokens, updatedAt: Date.now() };
    this.accounts.set(userId, refreshed);
    await this.persist();
    return refreshed.tokens.idToken ?? refreshed.tokens.accessToken;
  }

  /**
   * Re-validate the account's auth session outside a session cycle. Used by the
   * "needs re-login" recovery path: forces a refresh attempt (even if the token
   * is not yet near expiry) so a user who re-logged in elsewhere, or a transient
   * refresh outage that has since cleared, can recover without a full restart.
   * Resolves true when the account has a usable token afterwards; rejects with
   * AuthExpiredError when refresh is impossible.
   */
  async checkAuth(userId: string): Promise<boolean> {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No account ${userId}`);

    // Force a refresh attempt regardless of the near-expiry window.
    let tokens = account.tokens;
    try {
      tokens = await this.refreshTokens(account, tokens);
    } catch (error) {
      if (isExpired(tokens.expiresAt)) throw AuthExpiredError.is(error) ? error : new AuthExpiredError(userId, error instanceof Error ? error.message : String(error));
      // Still-valid token — treat as recoverable.
      return true;
    }
    const refreshed: StoredAccount = { ...account, tokens, updatedAt: Date.now() };
    this.accounts.set(userId, refreshed);
    await this.persist();
    return true;
  }

  private async refreshTokens(account: StoredAccount, tokens: AuthTokens): Promise<AuthTokens> {
    // Strategy 1: try client_token grant (fastest, no user interaction)
    if (tokens.clientToken) {
      try {
        const r = await refreshWithClientToken(tokens.clientToken, account.user.userId);
        const merged = mergeTokenSnapshot(tokens, r);
        return await this.ensureClientToken(merged);
      } catch (error) {
        console.warn(`[Auth] client_token refresh failed for ${account.user.displayName}, falling back to refresh_token:`, error);
      }
    }

    // Strategy 2: use refresh_token (standard OAuth)
    if (tokens.refreshToken) {
      try {
        const refreshed = await refreshAuthTokens(tokens.refreshToken);
        // Preserve the refreshToken — refreshAuthTokens already does this internally,
        // but be defensive about it in the merge too.
        const merged: AuthTokens = {
          ...tokens,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || tokens.refreshToken,
          idToken: refreshed.idToken ?? tokens.idToken,
          expiresAt: refreshed.expiresAt,
        };
        // Re-acquire a client_token from the fresh access_token so the next
        // cycle can use the fast path again.
        try {
          return await this.ensureClientToken(merged);
        } catch (ctError) {
          console.warn(`[Auth] client_token re-acquisition failed for ${account.user.displayName}, continuing without:`, ctError);
          return merged;
        }
      } catch (error) {
        console.warn(`[Auth] refresh_token refresh also failed for ${account.user.displayName}:`, error);
        throw error;
      }
    }

    // No mechanism available at all — log a clear actionable message
    console.error(
      `[Auth] No refresh mechanism available for ${account.user.displayName}. ` +
      `Both clientToken and refreshToken are missing. The account needs to be re-authenticated.`,
    );
    throw new Error("No refresh mechanism available");
  }
}
