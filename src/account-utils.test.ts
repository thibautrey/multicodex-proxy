import assert from "node:assert/strict";
import test from "node:test";
import {
  accountNeedsRequestPreparation,
  ensureValidToken,
  isTokenRefreshNeeded,
} from "./account-utils.js";
import type { OAuthConfig } from "./oauth.js";
import type { Account } from "./types.js";

const oauthConfig: OAuthConfig = {
  authorizationUrl: "https://benchmark.invalid/authorize",
  tokenUrl: "https://benchmark.invalid/token",
  deviceAuthorizationUrl: "https://benchmark.invalid/device",
  deviceTokenUrl: "https://benchmark.invalid/device-token",
  deviceVerificationUrl: "https://benchmark.invalid/verify",
  deviceRedirectUri: "https://benchmark.invalid/device-callback",
  clientId: "test-client",
  scope: "openid",
  redirectUri: "https://benchmark.invalid/callback",
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "account-1",
    accessToken: "access-token",
    enabled: true,
    ...overrides,
  };
}

test("returns the original account when the token is still valid", async () => {
  const original = account({ expiresAt: Date.now() + 60 * 60_000 });

  const result = await ensureValidToken(original, oauthConfig);

  assert.equal(result, original);
});

test("detects the token refresh boundary synchronously", () => {
  const now = Date.now();
  assert.equal(
    isTokenRefreshNeeded(
      account({
        expiresAt: now + 5 * 60_000,
        refreshToken: "refresh-token",
      }),
      now,
    ),
    true,
  );
  assert.equal(
    isTokenRefreshNeeded(
      account({
        expiresAt: now + 5 * 60_000 + 1,
        refreshToken: "refresh-token",
      }),
      now,
    ),
    false,
  );
  assert.equal(
    isTokenRefreshNeeded(
      account({
        provider: "mistral",
        expiresAt: now - 1,
        refreshToken: "refresh-token",
      }),
      now,
    ),
    false,
  );
});

test("skips request preparation only for unchanged account snapshots", () => {
  const now = Date.now();
  const fresh = account({
    expiresAt: now + 60 * 60_000,
    usage: { fetchedAt: now },
  });
  assert.equal(accountNeedsRequestPreparation(fresh, now), false);
  assert.equal(
    accountNeedsRequestPreparation(
      { ...fresh, usage: { fetchedAt: now - 60 * 60_000 } },
      now,
    ),
    true,
  );
  assert.equal(
    accountNeedsRequestPreparation(
      {
        ...fresh,
        state: {
          scheduledWeeklyReset: {
            scheduledAt: now,
            idempotencyKey: "reset-1",
            thresholdRemainingPercent: 0.5,
          },
        },
      },
      now,
    ),
    true,
  );
  assert.equal(
    accountNeedsRequestPreparation({ ...fresh, enabled: false }, now),
    false,
  );
});

test("returns a new account on refresh failure without mutating the store snapshot", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "refresh rejected" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  const original = account({
    expiresAt: Date.now() - 1,
    refreshToken: "refresh-token",
    state: { lastError: "previous" },
  });

  try {
    const result = await ensureValidToken(original, oauthConfig);

    assert.notEqual(result, original);
    assert.deepEqual(original.state, { lastError: "previous" });
    assert.equal(result.state?.needsTokenRefresh, true);
    assert.match(result.state?.lastError ?? "", /refresh token failed/);
    assert.equal(result.state?.recentErrors?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a new account after a successful refresh", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  const original = account({
    expiresAt: Date.now() - 1,
    refreshToken: "refresh-token",
  });

  try {
    const result = await ensureValidToken(original, oauthConfig);

    assert.notEqual(result, original);
    assert.equal(original.accessToken, "access-token");
    assert.equal(result.accessToken, "new-access-token");
    assert.equal(result.refreshToken, "new-refresh-token");
    assert.equal(result.state?.needsTokenRefresh, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("coalesces concurrent OpenAI token refreshes", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    await gate;
    return Response.json({ access_token: "shared-token", expires_in: 3600 });
  };
  const expired = account({
    expiresAt: Date.now() - 1,
    refreshToken: "rotating-refresh-token",
  });

  try {
    const first = ensureValidToken(expired, oauthConfig);
    const second = ensureValidToken(expired, oauthConfig);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.accessToken, "shared-token");
    assert.equal(b.accessToken, "shared-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
