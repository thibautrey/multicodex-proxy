import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Account, OAuthFlowState } from "./types.js";

export type OAuthConfig = {
  authorizationUrl: string;
  tokenUrl: string;
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

export function base64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createOAuthState(email: string): OAuthFlowState {
  return {
    id: randomUUID(),
    email,
    codeVerifier: base64url(randomBytes(32)),
    createdAt: Date.now(),
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
  if (config.audience) url.searchParams.set("audience", config.audience);
  return url.toString();
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

export async function exchangeCodeForToken(config: OAuthConfig, code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
  return postForm(config.tokenUrl, body);
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
