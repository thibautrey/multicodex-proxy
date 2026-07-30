import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFromXaiOAuth,
  assertTrustedXaiIssuer,
  buildXaiUpstreamHeaders,
  parseXaiAuthStore,
  pollXaiDeviceCode,
  requestXaiDeviceCode,
} from "./xai.js";
import {
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_ISSUER,
} from "./config.js";

test("parses official Grok auth.json session entries and skips API keys", () => {
  const credentials = parseXaiAuthStore({
    [`${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`]: {
      key: "session-token",
      auth_mode: "oidc",
      email: "grok@example.test",
      user_id: "user-123",
      refresh_token: "refresh-token",
      expires_at: "2026-08-01T12:00:00Z",
      oidc_issuer: XAI_OAUTH_ISSUER,
      oidc_client_id: XAI_OAUTH_CLIENT_ID,
    },
    "xai::api_key": {
      key: "paid-api-key",
      auth_mode: "api_key",
    },
    "https://accounts.x.ai/sign-in": {
      key: "legacy-session-token",
      auth_mode: "web_login",
    },
  });

  assert.equal(credentials.length, 1);
  assert.deepEqual(credentials[0], {
    scope: `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`,
    accessToken: "session-token",
    refreshToken: "refresh-token",
    expiresAt: Date.parse("2026-08-01T12:00:00Z"),
    email: "grok@example.test",
    userId: "user-123",
    oidcIssuer: XAI_OAUTH_ISSUER,
    oidcClientId: XAI_OAUTH_CLIENT_ID,
  });
});

test("builds the Grok Build subscription headers used by the official CLI", () => {
  const headers = buildXaiUpstreamHeaders("session-token", {
    model: "grok-code-fast-1",
    conversationId: "conv-123",
  });

  assert.equal(headers.authorization, "Bearer session-token");
  assert.equal(headers["X-XAI-Token-Auth"], "xai-grok-cli");
  assert.equal(headers["x-grok-client-version"], XAI_CLIENT_VERSION);
  assert.equal(headers["x-grok-client-identifier"], XAI_CLIENT_IDENTIFIER);
  assert.equal(headers["x-grok-model-override"], "grok-code-fast-1");
  assert.equal(headers["x-grok-conv-id"], "conv-123");
  assert.equal(headers.accept, "text/event-stream");
});

test("creates a refreshable xAI account from device OAuth tokens", () => {
  const account = accountFromXaiOAuth(
    {
      id: "flow-1",
      email: "",
      codeVerifier: "",
      createdAt: Date.now(),
      method: "device",
      provider: "xai",
      status: "pending",
    },
    {
      access_token: "header.payload.signature",
      refresh_token: "refresh-token",
      expires_in: 3600,
    },
  );

  assert.equal(account.provider, "xai");
  assert.equal(account.upstreamMode, "responses");
  assert.equal(account.accessToken, "header.payload.signature");
  assert.equal(account.refreshToken, "refresh-token");
  assert.equal(account.oidcIssuer, XAI_OAUTH_ISSUER);
  assert.equal(account.oidcClientId, XAI_OAUTH_CLIENT_ID);
  assert.ok((account.expiresAt ?? 0) > Date.now());
});

test("rejects OAuth issuers outside the configured xAI authority", () => {
  assert.throws(
    () => assertTrustedXaiIssuer("https://auth.x.ai.evil.example"),
    /untrusted xAI OAuth issuer/,
  );
});

test("starts xAI device OAuth with the official client contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const device = await requestXaiDeviceCode((async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(
      JSON.stringify({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete:
          "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
        interval: 7,
        expires_in: 900,
      }),
      { status: 200 },
    );
  }) as typeof fetch);

  assert.equal(requestUrl, `${XAI_OAUTH_ISSUER}/oauth2/device/code`);
  assert.equal(
    new Headers(requestInit?.headers).get("x-grok-client-surface"),
    "ui",
  );
  const form = new URLSearchParams(String(requestInit?.body));
  assert.equal(form.get("client_id"), XAI_OAUTH_CLIENT_ID);
  assert.match(form.get("scope") ?? "", /\bgrok-cli:access\b/);
  assert.equal(device.userCode, "ABCD-EFGH");
  assert.equal(device.intervalSeconds, 7);
});

test("maps xAI device polling pending and rotated-token responses", async () => {
  const pending = await pollXaiDeviceCode(
    "device-secret",
    5,
    (async () =>
      new Response(JSON.stringify({ error: "slow_down" }), {
        status: 400,
      })) as typeof fetch,
  );
  assert.deepEqual(pending, {
    status: "pending",
    intervalSeconds: 10,
  });

  const success = await pollXaiDeviceCode(
    "device-secret",
    5,
    (async () =>
      new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
        { status: 200 },
      )) as typeof fetch,
  );
  assert.equal(success.status, "success");
  if (success.status === "success") {
    assert.equal(success.token.access_token, "access-token");
    assert.equal(success.token.refresh_token, "rotated-refresh-token");
  }
});
