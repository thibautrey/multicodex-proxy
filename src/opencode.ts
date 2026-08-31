import { randomUUID } from "node:crypto";
import {
  OPENCODE_BASE_URL,
  OPENCODE_CONSOLE_URL,
  OPENCODE_OAUTH_CLIENT_ID,
} from "./config.js";
import type { Account, OAuthFlowState } from "./types.js";

export type OpenCodeDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
};

export type OpenCodeToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export type OpenCodePollResult =
  | { status: "pending"; intervalSeconds: number }
  | { status: "success"; token: OpenCodeToken };

type OpenCodeProfile = {
  accountId: string;
  email: string;
  orgId?: string;
  orgName?: string;
  apiRoot?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

function configuredConsoleUrl(): string {
  return OPENCODE_CONSOLE_URL.trim().replace(/\/+$/, "");
}

async function jsonResponse<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.error?.message === "string"
          ? data.error.message
          : text.slice(0, 400);
    throw new Error(`${context} failed ${response.status}${message ? `: ${message}` : ""}`);
  }
  return data as T;
}

async function postConsole<T>(path: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(`${configuredConsoleUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return jsonResponse<T>(response, `OpenCode ${path}`);
}

export function normalizeOpenCodeApiRoot(value?: string): string {
  const normalized = String(value ?? OPENCODE_BASE_URL).trim().replace(/\/+$/, "");
  return normalized.replace(/\/v1$/i, "");
}

export function openCodeUsageUrl(baseUrl?: string): string {
  const root = normalizeOpenCodeApiRoot(baseUrl);
  if (/\/zen$/i.test(root)) return `${root}/go/v1/usage`;
  return `${root}/v1/usage`;
}

export async function requestOpenCodeDeviceCode(): Promise<OpenCodeDeviceCode> {
  const device = await postConsole<{
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }>("/auth/device/code", { client_id: OPENCODE_OAUTH_CLIENT_ID });
  const verificationUrl = new URL(
    device.verification_uri_complete,
    `${configuredConsoleUrl()}/`,
  );
  if (verificationUrl.protocol !== "http:" && verificationUrl.protocol !== "https:") {
    throw new Error("OpenCode returned a non-HTTP verification URL");
  }
  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    verificationUrl: verificationUrl.href,
    intervalSeconds: Math.max(1, Number(device.interval) || 5),
    expiresAt: Date.now() + Math.max(1, Number(device.expires_in) || 900) * 1000,
  };
}

export async function pollOpenCodeDeviceCode(
  deviceCode: string,
  intervalSeconds = 5,
): Promise<OpenCodePollResult> {
  const response = await fetch(`${configuredConsoleUrl()}/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: OPENCODE_OAUTH_CLIENT_ID,
    }),
  });
  const text = await response.text();
  let data: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OpenCode device token returned invalid JSON (${response.status})`);
  }
  if (data.access_token) {
    return {
      status: "success",
      token: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : undefined,
      },
    };
  }
  if (data.error === "authorization_pending") {
    return { status: "pending", intervalSeconds };
  }
  if (data.error === "slow_down") {
    return { status: "pending", intervalSeconds: intervalSeconds + 5 };
  }
  throw new Error(
    data.error ||
      `OpenCode device token failed ${response.status}: ${text.slice(0, 400)}`,
  );
}

export async function refreshOpenCodeAccessToken(account: Account): Promise<OpenCodeToken> {
  if (!account.refreshToken) throw new Error("OpenCode refresh token is missing");
  const server = configuredConsoleUrl();
  if (
    account.opencodeConsoleUrl &&
    account.opencodeConsoleUrl.replace(/\/+$/, "") !== server
  ) {
    throw new Error("untrusted OpenCode Console URL");
  }
  const response = await fetch(`${server}/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: OPENCODE_OAUTH_CLIENT_ID,
    }),
  });
  const token = await jsonResponse<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }>(response, "OpenCode token refresh");
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
  };
}

async function getConsole<T>(
  server: string,
  path: string,
  token: string,
  orgId?: string,
): Promise<T> {
  const response = await fetch(`${server}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(orgId ? { "x-org-id": orgId } : {}),
    },
  });
  return jsonResponse<T>(response, `OpenCode ${path}`);
}

async function fetchOpenCodeProfile(token: string): Promise<OpenCodeProfile> {
  const server = configuredConsoleUrl();
  const [user, orgs] = await Promise.all([
    getConsole<{ id: string; email: string }>(server, "/api/user", token),
    getConsole<Array<{ id: string; name: string }>>(server, "/api/orgs", token),
  ]);
  const org = orgs
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))[0];
  let apiRoot: string | undefined;
  let apiKey: string | undefined;
  let headers: Record<string, string> | undefined;
  try {
    const remote = await getConsole<any>(server, "/api/config", token, org?.id);
    const provider = remote?.config?.provider?.opencode;
    if (typeof provider?.api === "string" && provider.api.trim()) {
      apiRoot = normalizeOpenCodeApiRoot(provider.api);
    }
    const configuredApiKey = provider?.options?.apiKey;
    const configuredHeaders = provider?.options?.headers;
    if (typeof configuredApiKey === "string" && configuredApiKey.trim()) {
      apiKey = configuredApiKey;
    }
    if (
      configuredHeaders &&
      typeof configuredHeaders === "object" &&
      !Array.isArray(configuredHeaders)
    ) {
      const entries = Object.entries(configuredHeaders).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      if (entries.length) headers = Object.fromEntries(entries);
    }
  } catch {
    // Model routing can use the public OpenCode Zen endpoint if config discovery
    // is temporarily unavailable.
  }
  return {
    accountId: user.id,
    email: user.email,
    orgId: org?.id,
    orgName: org?.name,
    apiRoot,
    apiKey,
    headers,
  };
}

export async function accountFromOpenCodeOAuth(
  flow: OAuthFlowState,
  token: OpenCodeToken,
  existing?: Account,
): Promise<Account> {
  const profile = await fetchOpenCodeProfile(token.accessToken);
  if (
    existing?.opencodeAccountId &&
    existing.opencodeAccountId !== profile.accountId
  ) {
    throw new Error(
      `OpenCode account mismatch: expected ${existing.opencodeAccountId}, received ${profile.accountId}`,
    );
  }
  if (existing?.opencodeOrgId && profile.orgId && existing.opencodeOrgId !== profile.orgId) {
    throw new Error(
      `OpenCode organization mismatch: expected ${existing.opencodeOrgId}, received ${profile.orgId}`,
    );
  }
  return {
    ...existing,
    id: existing?.id ?? randomUUID(),
    provider: "opencode",
    upstreamMode: existing?.upstreamMode ?? "responses",
    email: profile.email || flow.email || existing?.email,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? existing?.refreshToken,
    expiresAt: token.expiresAt ?? existing?.expiresAt,
    opencodeAccountId: profile.accountId,
    opencodeOrgId: profile.orgId,
    opencodeOrgName: profile.orgName,
    opencodeConsoleUrl: configuredConsoleUrl(),
    opencodeApiKey: profile.apiKey ?? existing?.opencodeApiKey,
    opencodeHeaders: profile.headers ?? existing?.opencodeHeaders,
    baseUrl: profile.apiRoot ?? existing?.baseUrl,
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? 0,
    location: existing?.location ?? "cloud",
    state: {
      ...existing?.state,
      needsTokenRefresh: false,
      authBlockedUntil: undefined,
      lastError: undefined,
    },
  };
}
