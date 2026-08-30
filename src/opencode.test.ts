import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFromOpenCodeOAuth,
  normalizeOpenCodeApiRoot,
  openCodeUsageUrl,
  pollOpenCodeDeviceCode,
  requestOpenCodeDeviceCode,
} from "./opencode.js";
import {
  OPENCODE_CONSOLE_URL,
  OPENCODE_OAUTH_CLIENT_ID,
} from "./config.js";

test("normalizes OpenCode API roots and derives Go usage endpoints", () => {
  assert.equal(
    normalizeOpenCodeApiRoot("https://opencode.ai/zen/go/v1/"),
    "https://opencode.ai/zen/go",
  );
  assert.equal(
    openCodeUsageUrl("https://opencode.ai/zen"),
    "https://opencode.ai/zen/go/v1/usage",
  );
  assert.equal(
    openCodeUsageUrl("https://opencode.ai/zen/go"),
    "https://opencode.ai/zen/go/v1/usage",
  );
});

test("starts OpenCode Console device OAuth with the official contract", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: any;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri_complete: "/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 7,
    });
  };

  try {
    const device = await requestOpenCodeDeviceCode();
    assert.equal(requestUrl, `${OPENCODE_CONSOLE_URL}/auth/device/code`);
    assert.deepEqual(requestBody, { client_id: OPENCODE_OAUTH_CLIENT_ID });
    assert.equal(device.userCode, "ABCD-EFGH");
    assert.equal(
      device.verificationUrl,
      "https://opencode.ai/device?user_code=ABCD-EFGH",
    );
    assert.equal(device.intervalSeconds, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps OpenCode device polling pending and successful responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ error: "slow_down" }, { status: 400 });
    assert.deepEqual(await pollOpenCodeDeviceCode("device", 5), {
      status: "pending",
      intervalSeconds: 10,
    });

    globalThis.fetch = async () =>
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      });
    const success = await pollOpenCodeDeviceCode("device", 5);
    assert.equal(success.status, "success");
    if (success.status === "success") {
      assert.equal(success.token.accessToken, "access-token");
      assert.equal(success.token.refreshToken, "refresh-token");
      assert.ok((success.token.expiresAt ?? 0) > Date.now());
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates an OpenCode account and discovers its Go API root", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer access-token",
    );
    if (url.endsWith("/api/user")) {
      return Response.json({ id: "usr_123", email: "user@example.test" });
    }
    if (url.endsWith("/api/orgs")) {
      return Response.json([{ id: "org_123", name: "Example Org" }]);
    }
    if (url.endsWith("/api/config")) {
      assert.equal(new Headers(init?.headers).get("x-org-id"), "org_123");
      return Response.json({
        config: {
          provider: {
            opencode: { api: "https://opencode.ai/zen/go/v1" },
          },
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const account = await accountFromOpenCodeOAuth(
      {
        id: "flow",
        email: "",
        codeVerifier: "",
        createdAt: Date.now(),
        method: "device",
        provider: "opencode",
        status: "pending",
      },
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 3600_000,
      },
    );

    assert.equal(account.provider, "opencode");
    assert.equal(account.email, "user@example.test");
    assert.equal(account.opencodeAccountId, "usr_123");
    assert.equal(account.opencodeOrgId, "org_123");
    assert.equal(account.opencodeOrgName, "Example Org");
    assert.equal(account.baseUrl, "https://opencode.ai/zen/go");
    assert.equal(account.upstreamMode, "responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
