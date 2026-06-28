import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Account, OAuthFlowState } from "./types.js";

export type OAuthConfig = {
  authorizationUrl: string;
  tokenUrl: string;
  deviceAuthorizationUrl: string;
  deviceTokenUrl: string;
  deviceVerificationUrl: string;
  deviceRedirectUri: string;
  clientId: string;
  scope: string;
  audience?: string;
  redirectUri: string;
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  expires_in?: number;
};

export type DeviceCodeResponse = {
  device_auth_id: string;
  user_code: string;
  verification_uri?: string;
  verification_url?: string;
  interval?: number | string;
  expires_in?: number | string;
  expires_at?: number | string;
};

export type DeviceTokenPollResponse = {
  authorization_code: string;
  code_challenge?: string;
  code_verifier?: string;
};

export function base64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createOAuthState(
  email: string,
  targetAccountId?: string,
  method: "browser" | "device" = "browser",
): OAuthFlowState {
  return {
    id: randomUUID(),
    email,
    codeVerifier: base64url(randomBytes(32)),
    createdAt: Date.now(),
    method,
    targetAccountId,
    status: "pending",
  };
}

export function buildAuthorizationUrl(config: OAuthConfig, flow: OAuthFlowState): string {
  const challenge = base64url(createHash("sha256").update(flow.codeVerifier).digest());
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", flow.id);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("login_hint", flow.email);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  if (config.audience) url.searchParams.set("audience", config.audience);
  return url.toString();
}

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function postForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint failed ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as TokenResponse;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const error =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.error?.code === "string"
          ? data.error.code
          : text.slice(0, 400);
    throw new Error(error || `device endpoint failed ${res.status}`);
  }
  return data as T;
}

export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri = config.redirectUri,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  return postForm(config.tokenUrl, body);
}

export async function requestDeviceCode(config: OAuthConfig): Promise<DeviceCodeResponse> {
  return postJson<DeviceCodeResponse>(config.deviceAuthorizationUrl, {
    client_id: config.clientId,
  });
}

export async function pollDeviceCode(config: OAuthConfig, flow: OAuthFlowState): Promise<DeviceTokenPollResponse> {
  if (!flow.deviceAuthId || !flow.userCode) {
    throw new Error("device authorization has not been started");
  }
  const res = await fetch(config.deviceTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_auth_id: flow.deviceAuthId,
      user_code: flow.userCode,
    }),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (res.ok) return data as DeviceTokenPollResponse;
  if (res.status === 403 || res.status === 404) {
    throw new Error(
      data?.error?.code ??
        data?.error ??
        "deviceauth_authorization_pending",
    );
  }
  throw new Error(
    data?.error?.code ??
      data?.error ??
      `device authorization failed with status ${res.status}`,
  );
}

export async function refreshAccessToken(config: OAuthConfig, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });
  return postForm(config.tokenUrl, body);
}

function decodeJwtPayload(jwt: string | undefined): any {
  if (!jwt || jwt.split(".").length < 2) return undefined;
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function mergeTokenIntoAccount(account: Account, tokenData: TokenResponse): Account {
  const idToken = decodeJwtPayload(tokenData.id_token);
  const expiresAt = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : account.expiresAt;
  return {
    ...account,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? account.refreshToken,
    expiresAt,
    chatgptAccountId: tokenData.account_id ?? idToken?.account_id ?? account.chatgptAccountId,
    email: account.email ?? idToken?.email,
  };
}

export function accountFromOAuth(flow: OAuthFlowState, tokenData: TokenResponse): Account {
  const idToken = decodeJwtPayload(tokenData.id_token);
  const chatgptAccountId = tokenData.account_id ?? idToken?.account_id;
  return {
    id: chatgptAccountId || randomUUID(),
    email: flow.email || idToken?.email,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
    chatgptAccountId,
    enabled: true,
    priority: 0,
    usage: undefined,
    state: {},
  };
}
