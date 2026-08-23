import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  XAI_AUTH_PATH,
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPES,
  XAI_TOKEN_AUTH,
  XAI_USER_AGENT,
  AUXILIARY_REQUEST_TIMEOUT_MS,
} from "./config.js";
import type { Account, OAuthFlowState } from "./types.js";

const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const LEGACY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type XaiTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

export type XaiDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  intervalSeconds: number;
  expiresAt: number;
};

export type XaiDevicePollResult =
  | { status: "pending"; intervalSeconds: number }
  | { status: "success"; token: XaiTokenResponse };

export type XaiImportedCredential = {
  scope: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  userId?: string;
  oidcIssuer: string;
  oidcClientId: string;
};

type FetchLike = typeof fetch;

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function assertTrustedXaiIssuer(
  issuer: string,
  configuredIssuer = XAI_OAUTH_ISSUER,
): string {
  const actual = normalizedUrl(issuer);
  const configured = normalizedUrl(configuredIssuer);
  if (actual !== configured) {
    throw new Error(`untrusted xAI OAuth issuer: ${actual}`);
  }
  return actual;
}

function assertTrustedVerificationUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "accounts.x.ai" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("xAI returned an untrusted verification URL");
  }
  return url.toString();
}

function tokenEndpoint(issuer: string): string {
  return `${assertTrustedXaiIssuer(issuer)}/oauth2/token`;
}

function deviceCodeEndpoint(issuer: string): string {
  return `${assertTrustedXaiIssuer(issuer)}/oauth2/device/code`;
}

function xaiOAuthHeaders(surface: "ui" | "headless" = "ui") {
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "x-grok-client-surface": surface,
  };
}

export function buildXaiUpstreamHeaders(
  accessToken: string,
  options: {
    model?: string;
    conversationId?: string;
    accept?: string;
  } = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    accept: options.accept ?? "text/event-stream",
    "X-XAI-Token-Auth": XAI_TOKEN_AUTH,
    "x-grok-client-version": XAI_CLIENT_VERSION,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "User-Agent": XAI_USER_AGENT,
    ...(options.model
      ? { "x-grok-model-override": options.model }
      : {}),
    ...(options.conversationId
      ? { "x-grok-conv-id": options.conversationId }
      : {}),
  };
}

export async function requestXaiDeviceCode(
  fetchImpl: FetchLike = fetch,
): Promise<XaiDeviceCode> {
  const body = new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPES.join(" "),
    referrer: "grok-build",
  });
  const response = await fetchImpl(deviceCodeEndpoint(XAI_OAUTH_ISSUER), {
    method: "POST",
    headers: xaiOAuthHeaders(),
    body,
    signal: AbortSignal.timeout(AUXILIARY_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const json = parseJson(text);
  if (!response.ok) {
    throw new Error(
      `xAI device authorization failed ${response.status}: ${String(
        json?.error_description ?? json?.error ?? text,
      ).slice(0, 300)}`,
    );
  }

  const deviceCode = String(json?.device_code ?? "").trim();
  const userCode = String(json?.user_code ?? "").trim();
  const verificationUrl = assertTrustedVerificationUrl(
    String(json?.verification_uri ?? ""),
  );
  const verificationUrlComplete = json?.verification_uri_complete
    ? assertTrustedVerificationUrl(String(json.verification_uri_complete))
    : undefined;
  if (!deviceCode || !/^[A-Za-z0-9-]+$/.test(userCode)) {
    throw new Error("xAI device authorization returned invalid code fields");
  }
  const intervalSeconds = Math.max(1, Number(json?.interval ?? 5) || 5);
  const expiresInSeconds = Math.max(
    60,
    Number(json?.expires_in ?? 900) || 900,
  );
  return {
    deviceCode,
    userCode,
    verificationUrl,
    verificationUrlComplete,
    intervalSeconds,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

export async function pollXaiDeviceCode(
  deviceCode: string,
  intervalSeconds = 5,
  fetchImpl: FetchLike = fetch,
): Promise<XaiDevicePollResult> {
  if (!deviceCode.trim()) throw new Error("missing xAI device code");
  const body = new URLSearchParams({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: XAI_OAUTH_CLIENT_ID,
  });
  const response = await fetchImpl(tokenEndpoint(XAI_OAUTH_ISSUER), {
    method: "POST",
    headers: xaiOAuthHeaders(),
    body,
    signal: AbortSignal.timeout(AUXILIARY_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const json = parseJson(text);
  if (response.ok) {
    const accessToken = String(json?.access_token ?? "").trim();
    if (!accessToken) {
      throw new Error("xAI token response did not include an access token");
    }
    return {
      status: "success",
      token: {
        access_token: accessToken,
        refresh_token:
          typeof json?.refresh_token === "string"
            ? json.refresh_token
            : undefined,
        expires_in:
          typeof json?.expires_in === "number"
            ? json.expires_in
            : Number(json?.expires_in) || undefined,
        id_token:
          typeof json?.id_token === "string" ? json.id_token : undefined,
      },
    };
  }

  const error = String(json?.error ?? "");
  if (error === "authorization_pending") {
    return {
      status: "pending",
      intervalSeconds: Math.max(1, intervalSeconds),
    };
  }
  if (error === "slow_down") {
    return {
      status: "pending",
      intervalSeconds: Math.max(1, intervalSeconds) + 5,
    };
  }
  throw new Error(
    `xAI device authorization failed: ${String(
      json?.error_description ?? error ?? text,
    ).slice(0, 300)}`,
  );
}

export async function refreshXaiAccessToken(
  account: Account & { refreshToken: string },
  fetchImpl: FetchLike = fetch,
): Promise<Account> {
  const issuer = assertTrustedXaiIssuer(
    account.oidcIssuer ?? XAI_OAUTH_ISSUER,
  );
  const clientId = account.oidcClientId ?? XAI_OAUTH_CLIENT_ID;
  if (clientId !== XAI_OAUTH_CLIENT_ID) {
    throw new Error("xAI account uses an unexpected OAuth client id");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
    client_id: clientId,
  });
  const response = await fetchImpl(tokenEndpoint(issuer), {
    method: "POST",
    headers: xaiOAuthHeaders("headless"),
    body,
    signal: AbortSignal.timeout(AUXILIARY_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const json = parseJson(text);
  if (!response.ok) {
    throw new Error(
      `xAI token refresh failed ${response.status}: ${String(
        json?.error_description ?? json?.error ?? text,
      ).slice(0, 300)}`,
    );
  }
  const accessToken = String(json?.access_token ?? "").trim();
  if (!accessToken) {
    throw new Error("xAI refresh response did not include an access token");
  }
  const expiresIn = Number(json?.expires_in);
  return {
    ...account,
    accessToken,
    refreshToken:
      typeof json?.refresh_token === "string" && json.refresh_token.trim()
        ? json.refresh_token
        : account.refreshToken,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : account.expiresAt,
    state: {
      ...account.state,
      needsTokenRefresh: false,
      authBlockedUntil: undefined,
      lastError: undefined,
    },
  };
}

function decodeJwtClaims(token?: string): Record<string, any> {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function accountFromXaiOAuth(
  flow: OAuthFlowState,
  token: XaiTokenResponse,
  existing?: Account,
): Account {
  const claims = {
    ...decodeJwtClaims(token.access_token),
    ...decodeJwtClaims(token.id_token),
  };
  const expiresIn = Number(token.expires_in);
  return {
    ...existing,
    id: existing?.id ?? flow.targetAccountId ?? randomUUID(),
    provider: "xai",
    upstreamMode: existing?.upstreamMode ?? "responses",
    email:
      (typeof claims.email === "string" && claims.email) ||
      flow.email ||
      existing?.email,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? existing?.refreshToken,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : existing?.expiresAt,
    xaiUserId:
      (typeof claims.sub === "string" && claims.sub) ||
      (typeof claims.user_id === "string" && claims.user_id) ||
      existing?.xaiUserId,
    xaiAuthScope: `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`,
    oidcIssuer: XAI_OAUTH_ISSUER,
    oidcClientId: XAI_OAUTH_CLIENT_ID,
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? 0,
    state: {
      ...existing?.state,
      needsTokenRefresh: false,
      authBlockedUntil: undefined,
      lastError: undefined,
    },
  };
}

function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function candidateEntries(value: any): Array<[string, any]> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => [
      String(entry?.auth_scope ?? entry?.scope ?? `account-${index + 1}`),
      entry,
    ]);
  }
  if (Array.isArray(value?.accounts)) {
    return candidateEntries(value.accounts);
  }
  if (value && typeof value === "object" && typeof value.key === "string") {
    return [[String(value.auth_scope ?? value.scope ?? "grok-build"), value]];
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value);
}

export function parseXaiAuthStore(value: unknown): XaiImportedCredential[] {
  const credentials: XaiImportedCredential[] = [];
  for (const [scope, entry] of candidateEntries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const authMode = String(entry.auth_mode ?? "").toLowerCase();
    if (
      authMode === "api_key" ||
      authMode === "web_login" ||
      authMode === "grok" ||
      scope === "xai::api_key"
    ) {
      continue;
    }
    const accessToken = String(entry.key ?? entry.access_token ?? "").trim();
    if (!accessToken) continue;
    const oidcIssuer = assertTrustedXaiIssuer(
      String(entry.oidc_issuer ?? XAI_OAUTH_ISSUER),
    );
    const oidcClientId = String(
      entry.oidc_client_id ?? XAI_OAUTH_CLIENT_ID,
    ).trim();
    if (oidcClientId !== XAI_OAUTH_CLIENT_ID) continue;
    const explicitExpiresAt = parseExpiresAt(entry.expires_at);
    const createdAt = parseExpiresAt(entry.create_time);
    credentials.push({
      scope,
      accessToken,
      refreshToken:
        typeof entry.refresh_token === "string" &&
        entry.refresh_token.trim()
          ? entry.refresh_token
          : undefined,
      expiresAt:
        explicitExpiresAt ??
        (createdAt ? createdAt + LEGACY_TOKEN_TTL_MS : undefined),
      email:
        typeof entry.email === "string" && entry.email.trim()
          ? entry.email
          : undefined,
      userId:
        typeof entry.user_id === "string" && entry.user_id.trim()
          ? entry.user_id
          : undefined,
      oidcIssuer,
      oidcClientId,
    });
  }
  return credentials;
}

export async function loadXaiAuthFile(
  filePath = XAI_AUTH_PATH,
): Promise<XaiImportedCredential[]> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("configured Grok auth path is not a file");
  if (stat.size > MAX_AUTH_FILE_BYTES) {
    throw new Error("configured Grok auth file is unexpectedly large");
  }
  const raw = await fs.readFile(filePath, "utf8");
  const credentials = parseXaiAuthStore(JSON.parse(raw));
  if (!credentials.length) {
    throw new Error(
      "no Grok Build subscription credential found in the configured auth file",
    );
  }
  return credentials;
}
