import { randomBytes, randomUUID } from "node:crypto";

import {
  GFN_USER_AGENT,
  buildGfnCloudMatchHeaders,
  buildGfnGraphQlHeaders,
  buildGfnLcarsHeaders,
  gfnJwtAuthorization,
  platformToGfnDeviceOs,
} from "./clientHeaders";
import type { DeviceFingerprint } from "./fingerprint";

const DEFAULT_STREAMING_BASE_URL = "https://prod.cloudmatchbeta.nvidiagrid.net/";
const GRAPHQL_URL = "https://games.geforce.com/graphql";
const APP_METADATA_QUERY_HASH = "cf8b620dfd03617017ba7c858cee65197e1ace5180e41be194b39227227ced63";
const DEFAULT_LOCALE = "en_US";

export const SESSION_STATUS = {
  QUEUEING: 1,
  READY: 2,
  STREAMING: 3,
} as const;
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export interface SessionCreateOptions {
  token: string;
  appId: string;
  zone?: string;
  streamingBaseUrl?: string;
  proxyUrl?: string;
  settings?: SessionStreamSettings;
  fingerprint?: DeviceFingerprint;
}

export interface SessionStreamSettings {
  resolution?: string;
  fps?: number;
  colorQuality?: "8bit_420" | "8bit_444" | "10bit_420" | "10bit_444";
  enableCloudGsync?: boolean;
  enableL4S?: boolean;
  keyboardLayout?: string;
  gameLanguage?: string;
}

export interface SessionPollOptions {
  token: string;
  sessionId: string;
  zone: string;
  serverIp?: string;
  streamingBaseUrl?: string;
  clientId?: string;
  deviceId?: string;
  proxyUrl?: string;
  fingerprint?: DeviceFingerprint;
}

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  queuePosition?: number;
  seatSetupStep?: number;
  zone: string;
  streamingBaseUrl: string;
  serverIp?: string;
  signalingServer?: string;
  signalingUrl?: string;
  gpuType?: string;
  clientId?: string;
  deviceId?: string;
  isAdsRequired?: boolean;
  raw?: unknown;
}

export interface ActiveSession {
  sessionId: string;
  status: SessionStatus;
  appId: number;
  serverIp?: string;
  streamingBaseUrl: string;
  zone?: string;
  gpuType?: string;
  resolution?: string;
  fps?: number;
}

export class SessionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusDescription: string,
    public readonly sessionStatus?: number,
    message?: string,
  ) {
    super(message ?? `Session error ${statusCode}: ${statusDescription}`);
    this.name = "SessionError";
  }

  static fromResponse(status: number, body: string): SessionError {
    try {
      const parsed = JSON.parse(body) as {
        requestStatus?: { statusCode?: number; statusDescription?: string };
        session?: { status?: number };
      };
      return new SessionError(
        parsed.requestStatus?.statusCode ?? status,
        parsed.requestStatus?.statusDescription ?? "Unknown",
        parsed.session?.status,
      );
    } catch {
      return new SessionError(status, "Invalid response body");
    }
  }
}

function colorQualityBitDepth(q: SessionStreamSettings["colorQuality"]): number {
  if (q?.startsWith("10bit")) return 1;
  return 0;
}

function colorQualityChromaFormat(q: SessionStreamSettings["colorQuality"]): number {
  if (q?.endsWith("_444")) return 1;
  return 0;
}

function parseResolution(input: string | undefined): { width: number; height: number } {
  const fallback = { width: 1920, height: 1080 };
  if (!input) return fallback;
  const parts = input.split("x").map((part) => Number.parseInt(part, 10));
  if (parts.length < 2) return fallback;
  const w = parts[0];
  const h = parts[1];
  if (w === undefined || h === undefined) return fallback;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fallback;
  return { width: w, height: h };
}

function timezoneOffsetMs(): number {
  return -new Date().getTimezoneOffset() * 60 * 1000;
}

function webRtcSessionMetadata(width: number, height: number): Array<{ key: string; value: string }> {
  return [
    { key: "SubSessionId", value: randomUUID() },
    { key: "wssignaling", value: "1" },
    { key: "GSStreamerType", value: "WebRTC" },
    { key: "networkType", value: "Unknown" },
    { key: "ClientImeSupport", value: "0" },
    {
      key: "clientPhysicalResolution",
      value: JSON.stringify({ horizontalPixels: width, verticalPixels: height }),
    },
    { key: "surroundAudioInfo", value: "2" },
  ];
}

function buildSessionRequestBody(opts: {
  appId: string;
  deviceId: string;
  settings: Required<Pick<SessionStreamSettings, "resolution" | "fps">> & SessionStreamSettings;
}) {
  const { width, height } = parseResolution(opts.settings.resolution);
  const cq = opts.settings.colorQuality ?? "8bit_420";
  const bitDepth = colorQualityBitDepth(cq);
  const chromaFormat = colorQualityChromaFormat(cq);
  const cloudGsync = opts.settings.enableCloudGsync ?? false;
  const reflex = cloudGsync || (opts.settings.fps ?? 60) >= 120;

  return {
    sessionRequestData: {
      appId: opts.appId,
      internalTitle: null,
      availableSupportedControllers: [],
      networkTestSessionId: null,
      parentSessionId: null,
      clientIdentification: "GFN-PC",
      deviceHashId: opts.deviceId,
      clientVersion: "30.0",
      sdkVersion: "1.0",
      streamerVersion: 1,
      clientPlatformName: "windows",
      clientRequestMonitorSettings: [
        {
          monitorId: 0,
          positionX: 0,
          positionY: 0,
          widthInPixels: width,
          heightInPixels: height,
          framesPerSecond: opts.settings.fps ?? 60,
          sdrHdrMode: 0,
          displayData: {},
          hdr10PlusGamingData: null,
          dpi: 0,
        },
      ],
      useOps: true,
      audioMode: 2,
      metaData: webRtcSessionMetadata(width, height),
      sdrHdrMode: 0,
      clientDisplayHdrCapabilities: null,
      surroundAudioInfo: 0,
      remoteControllersBitmap: 0,
      clientTimezoneOffset: timezoneOffsetMs(),
      enhancedStreamMode: 1,
      appLaunchMode: 1,
      secureRTSPSupported: false,
      partnerCustomData: "",
      accountLinked: true,
      enablePersistingInGameSettings: true,
      userAge: 26,
      requestedStreamingFeatures: {
        reflex,
        bitDepth,
        cloudGsync,
        enabledL4S: opts.settings.enableL4S ?? false,
        supportedHidDevices: 0,
        profile: 0,
        fallbackToLogicalResolution: false,
        chromaFormat,
        prefilterMode: 0,
        prefilterSharpness: 0,
        prefilterNoiseReduction: 0,
        hudStreamingMode: 0,
      },
    },
  };
}

function resolveStreamingBaseUrl(zone: string, provided?: string): string {
  if (provided && provided.trim()) {
    const trimmed = provided.trim();
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
  if (!zone.trim()) {
    return DEFAULT_STREAMING_BASE_URL.replace(/\/$/, "");
  }
  return `https://${zone}.cloudmatchbeta.nvidiagrid.net`;
}

interface ServerInfoResponse {
  metaData?: Array<{ key: string; value: string }>;
}

function extractServerInfoRegionBases(payload: ServerInfoResponse): string[] {
  const metadata = payload.metaData ?? [];
  const byKey = new Map(metadata.map((entry) => [entry.key, entry.value]));
  const regionNames = byKey.get("gfn-regions")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  const localRegionName = byKey.get("local-region")?.trim();
  const orderedRegionNames = [
    ...(localRegionName ? [localRegionName] : []),
    ...regionNames,
  ];
  const bases: string[] = [];
  const seen = new Set<string>();
  for (const regionName of orderedRegionNames) {
    const regionUrl = byKey.get(regionName);
    if (!regionUrl?.startsWith("http")) continue;
    const normalized = regionUrl.trim().replace(/\/$/, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      bases.push(normalized);
    }
  }
  return bases;
}

function isDefaultStreamingServiceBase(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "prod.cloudmatchbeta.nvidiagrid.net" ||
      (hostname.startsWith("prod.") && hostname.endsWith(".nvidiagrid.net"));
  } catch {
    return false;
  }
}

async function resolveCreateSessionBase(
  base: string,
  token: string,
  clientId: string,
  deviceId: string,
): Promise<string> {
  if (!isDefaultStreamingServiceBase(base)) return base;
  try {
    const response = await fetch(`${base}/v2/serverInfo`, {
      method: "GET",
      headers: buildGfnCloudMatchHeaders({ token, clientId, deviceId, includeOrigin: false }),
    });
    if (!response.ok) return base;
    const [localRegionBase] = extractServerInfoRegionBases(await response.json() as ServerInfoResponse);
    if (!localRegionBase || localRegionBase === base) return base;
    console.log(`[Session] createSession resolved ${base} to local region ${localRegionBase}`);
    return localRegionBase;
  } catch (error) {
    console.warn(`[Session] createSession local-region discovery failed:`, error);
    return base;
  }
}

function isZoneHostname(host: string): boolean {
  return host.includes("cloudmatchbeta.nvidiagrid.net") || host.includes("cloudmatch.nvidiagrid.net");
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const v = Math.trunc(value);
    return v > 0 ? v : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const v = Number.parseInt(value, 10);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }
  return undefined;
}

function extractQueuePosition(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const session = (payload as { session?: Record<string, unknown> }).session;
  if (!session) return undefined;
  const direct = toPositiveInt(session.queuePosition);
  if (direct !== undefined) return direct;
  const seatSetup = session.seatSetupInfo as { queuePosition?: unknown } | undefined;
  if (seatSetup) {
    const v = toPositiveInt(seatSetup.queuePosition);
    if (v !== undefined) return v;
  }
  const progress = session.sessionProgress as { queuePosition?: unknown } | undefined;
  if (progress) {
    const v = toPositiveInt(progress.queuePosition);
    if (v !== undefined) return v;
  }
  const progressInfo = session.progressInfo as { queuePosition?: unknown } | undefined;
  if (progressInfo) {
    const v = toPositiveInt(progressInfo.queuePosition);
    if (v !== undefined) return v;
  }
  return undefined;
}

function normalizeSession(payload: unknown, zone: string, streamingBaseUrl: string): SessionInfo {
  const obj = payload as {
    requestStatus?: { statusCode?: number; statusDescription?: string };
    session?: {
      sessionId?: string;
      status?: number;
      seatSetupInfo?: { seatSetupStep?: number };
      connectionInfo?: Array<{ ip?: string | string[]; resourcePath?: string; usage?: number; port?: number }>;
      sessionControlInfo?: { ip?: string | string[] };
      gpuType?: string;
      sessionAdsRequired?: boolean;
      isAdsRequired?: boolean;
    };
  };

  if (obj.requestStatus?.statusCode !== 1) {
    throw SessionError.fromResponse(200, JSON.stringify(payload));
  }

  const session = obj.session;
  if (!session?.sessionId) {
    throw new SessionError(0, "Missing sessionId in response");
  }

  const connections = session.connectionInfo ?? [];
  const sigConn = connections.find((c) => c.usage === 14);
  const sigIpRaw = sigConn?.ip;
  const sigIp = Array.isArray(sigIpRaw) ? sigIpRaw[0] : sigIpRaw;
  const controlIpRaw = session.sessionControlInfo?.ip;
  const controlIp = Array.isArray(controlIpRaw) ? controlIpRaw[0] : controlIpRaw;
  const serverIp = sigIp ?? controlIp;

  let signalingUrl: string | undefined;
  let signalingServer: string | undefined;
  if (sigConn?.resourcePath?.startsWith("rtsps://")) {
    const host = sigConn.resourcePath.slice("rtsps://".length).split(":")[0];
    signalingUrl = `wss://${host}/nvst/`;
    signalingServer = host;
  } else if (serverIp) {
    signalingUrl = `wss://${serverIp}:443/nvst/`;
    signalingServer = serverIp;
  }

  const status = (session.status ?? 0) as SessionStatus;
  const isAdsRequired = Boolean(session.sessionAdsRequired ?? session.isAdsRequired);

  return {
    sessionId: session.sessionId,
    status,
    queuePosition: extractQueuePosition(payload),
    seatSetupStep:
      typeof session.seatSetupInfo?.seatSetupStep === "number"
        ? session.seatSetupInfo.seatSetupStep
        : undefined,
    zone,
    streamingBaseUrl,
    serverIp,
    signalingServer,
    signalingUrl,
    gpuType: session.gpuType,
    isAdsRequired,
    raw: payload,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw SessionError.fromResponse(response.status, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SessionError(response.status, "Invalid JSON from cloudmatch");
  }
}

async function fetchWithOptionalProxy(
  url: string,
  init: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  if (!proxyUrl) {
    return fetch(url, init);
  }
  console.warn("[Session] proxyUrl is not supported in this build; using direct fetch");
  return fetch(url, init);
}

function randomDeviceId(): string {
  return randomBytes(16).toString("hex");
}

export async function createSession(opts: SessionCreateOptions): Promise<SessionInfo> {
  if (!opts.token) throw new Error("Missing token for session creation");
  if (!/^\d+$/.test(opts.appId)) throw new Error(`Invalid appId '${opts.appId}' (must be numeric)`);

  const settings: Required<Pick<SessionStreamSettings, "resolution" | "fps">> & SessionStreamSettings = {
    resolution: opts.settings?.resolution ?? "1920x1080",
    fps: opts.settings?.fps ?? 60,
    ...opts.settings,
  };
  const clientId = opts.fingerprint?.clientId ?? randomUUID();
  const deviceId = opts.fingerprint?.deviceId ?? randomDeviceId();
  const requestedBase = resolveStreamingBaseUrl(opts.zone ?? "", opts.streamingBaseUrl);
  const base = await resolveCreateSessionBase(requestedBase, opts.token, clientId, deviceId);
  const keyboardLayout = settings.keyboardLayout ?? (process.platform === "darwin" ? "com.apple.keylayout.ABC" : "00000409");
  const languageCode = settings.gameLanguage ?? "en_US";
  const url = `${base}/v2/session?${new URLSearchParams({ keyboardLayout, languageCode }).toString()}`;
  const body = buildSessionRequestBody({ appId: opts.appId, deviceId, settings });

  const response = await fetchWithOptionalProxy(
    url,
    {
      method: "POST",
      headers: buildGfnCloudMatchHeaders({
        token: opts.token,
        clientId,
        deviceId,
        includeOrigin: true,
        fingerprint: opts.fingerprint,
      }),
      body: JSON.stringify(body),
    },
    opts.proxyUrl,
  );
  const payload = await readJson(response);
  const info = normalizeSession(payload, opts.zone ?? "", base);
  return { ...info, clientId, deviceId };
}

export async function pollSession(opts: SessionPollOptions): Promise<SessionInfo> {
  if (!opts.token) throw new Error("Missing token for session polling");

  const base = resolveStreamingBaseUrl(opts.zone, opts.streamingBaseUrl);
  const baseHost = new URL(base).hostname;
  const pollProxy = isZoneHostname(baseHost) ? opts.proxyUrl : undefined;
  const url = `${base}/v2/session/${opts.sessionId}`;
  const headers = buildGfnCloudMatchHeaders({
    token: opts.token,
    clientId: opts.clientId,
    deviceId: opts.deviceId,
    includeOrigin: false,
    fingerprint: opts.fingerprint,
  });

  const response = await fetchWithOptionalProxy(
    url,
    { method: "GET", headers },
    pollProxy,
  );
  const payload = await readJson(response);
  return normalizeSession(payload, opts.zone, base);
}

export async function stopSession(opts: {
  token: string;
  sessionId: string;
  zone: string;
  serverIp?: string;
  streamingBaseUrl?: string;
  clientId?: string;
  deviceId?: string;
  proxyUrl?: string;
  fingerprint?: DeviceFingerprint;
}): Promise<void> {
  if (!opts.token) throw new Error("Missing token for session stop");
  const base = resolveStreamingBaseUrl(opts.zone, opts.streamingBaseUrl);
  const url = `${base}/v2/session/${opts.sessionId}`;
  const response = await fetchWithOptionalProxy(
    url,
    {
      method: "DELETE",
      headers: buildGfnCloudMatchHeaders({
        token: opts.token,
        clientId: opts.clientId,
        deviceId: opts.deviceId,
        includeOrigin: false,
        fingerprint: opts.fingerprint,
      }),
    },
    opts.proxyUrl,
  );
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw SessionError.fromResponse(response.status, text);
  }
}

export async function getActiveSessions(
  token: string,
  streamingBaseUrl: string,
): Promise<ActiveSession[]> {
  if (!token) throw new Error("Missing token for getActiveSessions");
  const trimmed = streamingBaseUrl.trim().replace(/\/$/, "");
  const url = `${trimmed}/v2/session`;
  const response = await fetch(url, {
    method: "GET",
    headers: buildGfnCloudMatchHeaders({ token, includeOrigin: false }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`[Session] getActiveSessions failed: ${response.status}`);
    return [];
  }
  let parsed: { requestStatus?: { statusCode?: number }; sessions?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed.requestStatus?.statusCode !== 1) return [];

  return (parsed.sessions ?? [])
    .filter((s) => [1, 2, 3].includes((s.status as number) ?? 0))
    .map((s) => {
      const connections = (s.connectionInfo as Array<{ usage?: number; ip?: string | string[] }> | undefined) ?? [];
      const conn = connections.find((c) => c.usage === 14 && c.ip);
      const connIpRaw = conn?.ip;
      const connIp = Array.isArray(connIpRaw) ? connIpRaw[0] : connIpRaw;
      const controlIpRaw = (s.sessionControlInfo as { ip?: string | string[] } | undefined)?.ip;
      const controlIp = Array.isArray(controlIpRaw) ? controlIpRaw[0] : controlIpRaw;
      const serverIp = connIp ?? controlIp;
      const monitor = ((s.monitorSettings as Array<Record<string, unknown>> | undefined) ?? [])[0];
      return {
        sessionId: s.sessionId as string,
        status: ((s.status as number) ?? 0) as SessionStatus,
        appId: Number((s.sessionRequestData as { appId?: number | string } | undefined)?.appId ?? 0),
        serverIp,
        streamingBaseUrl: trimmed,
        gpuType: s.gpuType as string | undefined,
        resolution: monitor
          ? `${monitor.widthInPixels ?? 0}x${monitor.heightInPixels ?? 0}`
          : undefined,
        fps: monitor?.framesPerSecond as number | undefined,
      };
    });
}

export async function resolveVpcId(
  token: string,
  providerStreamingBaseUrl?: string,
  fingerprint?: DeviceFingerprint,
): Promise<string> {
  const base = (providerStreamingBaseUrl?.trim() || DEFAULT_STREAMING_BASE_URL);
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const response = await fetch(`${normalized}v2/serverInfo`, {
    headers: buildGfnLcarsHeaders({
      token,
      clientType: "NATIVE",
      clientStreamer: "NVIDIA-CLASSIC",
      includeUserAgent: true,
      includeEmptyTokenAuthorization: true,
      fingerprint,
    }),
  });
  if (!response.ok) return "GFN-PC";
  const payload = (await response.json()) as { requestStatus?: { serverId?: string } };
  return payload.requestStatus?.serverId ?? "GFN-PC";
}

function isNumericId(value: string | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export interface ResolvedGame {
  appId: string;
  title: string;
  thumbnailUrl?: string;
  storeUrl?: string;
}

export async function resolveLaunchAppId(
  token: string,
  appIdOrUuid: string,
  providerStreamingBaseUrl?: string,
  fingerprint?: DeviceFingerprint,
): Promise<ResolvedGame | null> {
  if (isNumericId(appIdOrUuid)) {
    return { appId: appIdOrUuid, title: `appId ${appIdOrUuid}` };
  }
  const vpcId = await resolveVpcId(token, providerStreamingBaseUrl, fingerprint);
  const variables = JSON.stringify({
    vpcId,
    locale: DEFAULT_LOCALE,
    appIds: [appIdOrUuid],
  });
  const extensions = JSON.stringify({
    persistedQuery: { sha256Hash: APP_METADATA_QUERY_HASH },
  });
  const params = new URLSearchParams({
    requestType: "appMetaData",
    extensions,
    huId: randomUUID(),
    variables,
  });
  const response = await fetch(`${GRAPHQL_URL}?${params.toString()}`, {
    headers: {
      ...buildGfnGraphQlHeaders(token, fingerprint),
      "Content-Type": "application/graphql",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`App metadata failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const payload = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: { apps?: { items?: Array<{ id: string; title?: string; thumbnailUrl?: string; variants?: Array<{ id?: string; storeUrl?: string }> }> } };
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join(", "));
  }
  const app = payload.data?.apps?.items?.[0];
  if (!app) return null;
  const numericVariant = (app.variants ?? []).find((v) => v.id && /^\d+$/.test(v.id));
  const numericAppId = numericVariant?.id ?? (isNumericId(app.id) ? app.id : null);
  if (!numericAppId) return null;
  return {
    appId: numericAppId,
    title: app.title ?? `appId ${numericAppId}`,
    thumbnailUrl: app.thumbnailUrl,
    storeUrl: numericVariant?.storeUrl,
  };
}
