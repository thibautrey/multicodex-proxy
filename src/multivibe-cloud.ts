import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AccountStore, OAuthStateStore } from "./store.js";
import type { Account, OAuthFlowState, StoreSettings } from "./types.js";

const CLIENT_ID = "multivibe-core";
const ACCOUNT_ID = "multivibe-cloud";
const SCOPES = [
  "openid",
  "profile",
  "billing:read",
  "projects:read",
  "projects:write",
].join(" ");
const FLOW_LIFETIME_MS = 10 * 60_000;
const API_KEY_LIFETIME_MS = 365 * 24 * 60 * 60_000;
const API_KEY_RENEWAL_MARGIN_MS = 24 * 60 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORE_CALLBACK_PATH = "/admin/cloud/oauth/callback";

type CloudConnection = NonNullable<StoreSettings["multivibeCloud"]>;

class CloudHttpError extends Error {
  constructor(readonly status: number) {
    super("MultiVibe Cloud request failed");
    this.name = "CloudHttpError";
  }
}

export type MultivibeCloudStatus = {
  status: "disconnected" | "connected" | "unavailable";
  balanceUsd?: string;
  subscription?: string;
  apiKeyExpiresAt?: string;
  topupUrl: string;
};

export type MultivibeCloudServiceOptions = {
  authBaseUrl: string;
  apiBaseUrl: string;
  inferenceBaseUrl: string;
  redirectUri: string;
  topupUrl: string;
  fetchImpl?: typeof fetch;
};

function normalizedOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error(`${label} must be an HTTP(S) origin`);
  }
  return parsed.origin;
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function usdValue(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text || !/^(?:0|[1-9]\d{0,12})(?:\.\d{1,6})?$/.test(text)) return undefined;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? text : undefined;
}

function expiresAtFromToken(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : undefined;
}

function expiresAtFromApiKey(value: unknown, fallback: number): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed : fallback;
}

function validAccessToken(value: unknown): string {
  const token = stringValue(value);
  if (!token || token.length > 8192 || /\s/.test(token)) throw new Error("MultiVibe Cloud token response is invalid");
  return token;
}

function validRefreshToken(value: unknown): string | undefined {
  const token = stringValue(value);
  if (token && (token.length > 8192 || /\s/.test(token))) throw new Error("MultiVibe Cloud refresh token response is invalid");
  return token;
}

function currentCloudConnection(settings: StoreSettings): CloudConnection | undefined {
  const value = settings.multivibeCloud;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const accessToken = stringValue(value.accessToken);
  if (!accessToken || accessToken.length > 8192 || /\s/.test(accessToken)) return undefined;
  const rawRefreshToken = stringValue(value.refreshToken);
  if (rawRefreshToken && (rawRefreshToken.length > 8192 || /\s/.test(rawRefreshToken))) return undefined;
  const refreshToken = rawRefreshToken;
  const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
    ? value.expiresAt : undefined;
  const projectId = stringValue(value.projectId);
  const apiKeyExpiresAt = typeof value.apiKeyExpiresAt === "number" && Number.isFinite(value.apiKeyExpiresAt)
    ? value.apiKeyExpiresAt : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(projectId ? { projectId } : {}),
    ...(apiKeyExpiresAt ? { apiKeyExpiresAt } : {}),
  };
}

function existingCloudAccount(accounts: Account[]): Account | undefined {
  return accounts.find((account) => account.id === ACCOUNT_ID && account.multivibeCloud);
}

function subscriptionLabel(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const plan = stringValue(record.planCode) ?? stringValue(record.plan_code) ?? stringValue(record.name);
  if (!plan) return undefined;
  return plan.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export class MultivibeCloudService {
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly inferenceBaseUrl: string;
  private readonly redirectUri: string;
  private readonly topupUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly store: AccountStore,
    private readonly oauthStore: OAuthStateStore,
    options: MultivibeCloudServiceOptions,
  ) {
    this.authBaseUrl = normalizedOrigin(options.authBaseUrl, "MultiVibe Cloud auth base URL");
    this.apiBaseUrl = normalizedOrigin(options.apiBaseUrl, "MultiVibe Cloud API base URL");
    this.inferenceBaseUrl = normalizedOrigin(options.inferenceBaseUrl, "MultiVibe Cloud inference base URL");
    this.redirectUri = this.validRedirectUri(options.redirectUri);
    this.topupUrl = this.validHttpUrl(options.topupUrl, "MultiVibe Cloud top-up URL");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private validRedirectUri(value: string): string {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error("MultiVibe Cloud redirect URI must be an absolute URL"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || !parsed.pathname) {
      throw new Error("MultiVibe Cloud redirect URI is invalid");
    }
    return parsed.toString();
  }

  private validCoreCallbackOrigin(value: string): string {
    const origin = normalizedOrigin(value, "MultiVibe Core callback origin");
    const parsed = new URL(origin);
    const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1) : parsed.hostname;
    if (hostname !== "localhost" && isIP(hostname) === 0) {
      throw new Error("MultiVibe Core callback origin must use an IP address or localhost");
    }
    return new URL(CORE_CALLBACK_PATH, `${origin}/`).toString();
  }

  private validHttpUrl(value: string, label: string): string {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`${label} must be an absolute URL`); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${label} is invalid`);
    }
    return parsed.toString();
  }

  async startConnection(callbackOrigin?: string): Promise<{ flowId: string; authorizeUrl: string }> {
    const redirectUri = callbackOrigin === undefined
      ? this.redirectUri : this.validCoreCallbackOrigin(callbackOrigin);
    const flow: OAuthFlowState = {
      id: randomUUID(),
      email: "",
      codeVerifier: randomBytes(32).toString("base64url"),
      redirectUri,
      createdAt: Date.now(),
      method: "browser",
      status: "pending",
    };
    await this.oauthStore.create(flow);
    const authorizeUrl = new URL(`${this.authBaseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", SCOPES);
    authorizeUrl.searchParams.set("state", flow.id);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge(flow.codeVerifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    return { flowId: flow.id, authorizeUrl: authorizeUrl.toString() };
  }

  async failConnection(flowId: string, message: string): Promise<void> {
    if (!UUID_PATTERN.test(flowId)) return;
    await this.oauthStore.update(flowId, {
      status: "error",
      error: message.slice(0, 300),
      completedAt: Date.now(),
    });
  }

  async completeConnection(flowId: string, code: string): Promise<void> {
    const flow = await this.oauthStore.get(flowId);
    if (!flow || flow.status !== "pending") throw new Error("Cloud connection flow is invalid or expired");
    if (flow.createdAt + FLOW_LIFETIME_MS <= Date.now()) throw new Error("Cloud connection flow is expired");
    if (!/^[A-Za-z0-9_-]{8,512}$/.test(code)) throw new Error("Cloud authorization code is invalid");
    const redirectUri = flow.redirectUri ?? this.redirectUri;

    const response = await this.fetchImpl(`${this.authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: flow.codeVerifier,
      }),
    });
    const tokenData = await this.readJson(response);
    if (!response.ok) throw new CloudHttpError(response.status);
    const accessToken = validAccessToken(tokenData.access_token);
    const refreshToken = validRefreshToken(tokenData.refresh_token);
    const expiresAt = expiresAtFromToken(tokenData.expires_in);
    const connection: CloudConnection = {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.store.patchSettings({ multivibeCloud: connection });
    await this.ensureCloudAccount(connection);
    await this.oauthStore.update(flowId, { status: "success", completedAt: Date.now(), accountId: ACCOUNT_ID });
  }

  async getStatus(): Promise<MultivibeCloudStatus> {
    const settings = await this.store.getSettings();
    let connection = currentCloudConnection(settings);
    if (!connection) return { status: "disconnected", topupUrl: this.topupUrl };

    try {
      connection = await this.refreshConnectionIfNeeded(connection);
      await this.ensureCloudAccount(connection);
      const account = existingCloudAccount(await this.store.listAccounts());
      if (!account) return { status: "disconnected", topupUrl: this.topupUrl };
      const [creditsResult, subscriptionResult] = await Promise.allSettled([
        this.requestJson("/client/v1/credits", connection.accessToken),
        this.requestJson("/client/v1/billing/subscription", connection.accessToken),
      ]);
      if (creditsResult.status !== "fulfilled") throw creditsResult.reason;
      const credits = creditsResult.value as Record<string, unknown>;
      const balance = usdValue(credits.totalAvailableUsd) ?? usdValue(credits.availableUsd);
      if (balance === undefined) throw new Error("MultiVibe Cloud balance response is invalid");
      const subscription = subscriptionResult.status === "fulfilled"
        ? subscriptionResult.value as Record<string, unknown> : undefined;
      const subscriptionName = subscriptionLabel(subscription?.data);
      return {
        status: "connected",
        balanceUsd: balance,
        ...(subscriptionName ? { subscription: subscriptionName } : {}),
        ...(account.expiresAt ? { apiKeyExpiresAt: new Date(account.expiresAt).toISOString() } : {}),
        topupUrl: this.topupUrl,
      };
    } catch (error) {
      if (error instanceof CloudHttpError && (error.status === 400 || error.status === 401)) {
        return { status: "disconnected", topupUrl: this.topupUrl };
      }
      return { status: "unavailable", topupUrl: this.topupUrl };
    }
  }

  private async refreshConnectionIfNeeded(connection: CloudConnection): Promise<CloudConnection> {
    if (!connection.refreshToken || !connection.expiresAt || connection.expiresAt > Date.now() + 60_000) {
      return connection;
    }
    const response = await this.fetchImpl(`${this.authBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: connection.refreshToken,
      }),
    });
    const tokenData = await this.readJson(response);
    if (!response.ok) throw new CloudHttpError(response.status);
    const expiresAt = expiresAtFromToken(tokenData.expires_in);
    const refreshToken = validRefreshToken(tokenData.refresh_token);
    const next: CloudConnection = {
      ...connection,
      accessToken: validAccessToken(tokenData.access_token),
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    await this.store.patchSettings({ multivibeCloud: next });
    return next;
  }

  private async ensureCloudAccount(connection: CloudConnection): Promise<void> {
    const accounts = await this.store.listAccounts();
    const current = existingCloudAccount(accounts);
    if (current && current.expiresAt && current.expiresAt > Date.now() + API_KEY_RENEWAL_MARGIN_MS) {
      return;
    }

    const project = await this.ensureProject(connection.accessToken, connection.projectId);
    const key = await this.createApiKey(connection.accessToken, project.id);
    const account: Account = {
      id: ACCOUNT_ID,
      provider: "openai-compatible",
      upstreamMode: "responses",
      compatibilityMode: "responses",
      accessToken: key.secret,
      baseUrl: this.inferenceBaseUrl,
      enabled: true,
      priority: 0,
      location: "cloud",
      multivibeCloud: true,
      expiresAt: key.expiresAt,
      state: {},
    };
    await this.store.upsertAccount(account);
    await this.store.patchSettings({
      multivibeCloud: {
        ...connection,
        projectId: project.id,
        apiKeyExpiresAt: key.expiresAt,
      },
    });
    await this.store.flushIfDirty();
  }

  private async ensureProject(accessToken: string, projectId?: string): Promise<{ id: string }> {
    if (projectId && UUID_PATTERN.test(projectId)) return { id: projectId };
    const projects = await this.requestJson("/client/v1/projects?limit=50", accessToken);
    const items = Array.isArray((projects as Record<string, unknown>).data)
      ? (projects as Record<string, unknown>).data as Array<Record<string, unknown>> : [];
    const existing = items.find((project) => project.slug === "multivibe-core");
    if (stringValue(existing?.id) && UUID_PATTERN.test(String(existing?.id))) return { id: String(existing?.id) };
    const created = await this.requestJson("/client/v1/projects", accessToken, {
      method: "POST",
      body: { name: "MultiVibe Core", slug: "multivibe-core" },
      idempotencyKey: `multivibe-core-project-${randomUUID()}`,
    });
    if (!UUID_PATTERN.test(String((created as Record<string, unknown>).id ?? ""))) {
      throw new Error("MultiVibe Cloud project response is invalid");
    }
    return { id: String((created as Record<string, unknown>).id) };
  }

  private async createApiKey(accessToken: string, projectId: string): Promise<{ secret: string; expiresAt: number }> {
    const expiresAt = Date.now() + API_KEY_LIFETIME_MS;
    const created = await this.requestJson(`/client/v1/projects/${encodeURIComponent(projectId)}/api-keys`, accessToken, {
      method: "POST",
      body: {
        name: "MultiVibe Core",
        scopes: ["models:read", "responses:write"],
        expires_at: new Date(expiresAt).toISOString(),
      },
      idempotencyKey: `multivibe-core-key-${randomUUID()}`,
    });
    const secret = stringValue((created as Record<string, unknown>).secret);
    if (!secret) throw new Error("MultiVibe Cloud API key response is missing its secret");
    const apiKey = (created as Record<string, unknown>).apiKey;
    const actualExpiresAt = apiKey && typeof apiKey === "object" && !Array.isArray(apiKey)
      ? expiresAtFromApiKey((apiKey as Record<string, unknown>).expiresAt, expiresAt)
      : expiresAt;
    return { secret, expiresAt: actualExpiresAt };
  }

  private async requestJson(path: string, accessToken: string, options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    }
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const data = await this.readJson(response);
    if (!response.ok) throw new CloudHttpError(response.status);
    return data;
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    return data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown> : {};
  }
}
