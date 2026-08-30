import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseAccount,
  parseOpenCodeUsage,
  refreshUsageIfNeeded,
} from "./quota.js";
import type { Account } from "./types.js";

function account(
  id: string,
  primaryUsedPercent: number | undefined,
  secondaryUsedPercent: number | undefined,
): Account {
  return {
    id,
    accessToken: `token-${id}`,
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      primary:
        primaryUsedPercent === undefined
          ? undefined
          : { usedPercent: primaryUsedPercent },
      secondary:
        secondaryUsedPercent === undefined
          ? undefined
          : { usedPercent: secondaryUsedPercent },
    },
  };
}

test("does not treat a missing quota window as untouched usage", () => {
  const withoutFiveHourQuota = account("without-five-hour", undefined, 0);
  const untouchedOnBothWindows = account("with-five-hour", 0, 0);

  assert.equal(
    chooseAccount([withoutFiveHourQuota, untouchedOnBothWindows])?.id,
    "with-five-hour",
  );
});

test("does not treat a missing usage snapshot as untouched usage", () => {
  const unknownUsage: Account = {
    id: "unknown-usage",
    accessToken: "token-unknown",
    enabled: true,
  };
  const untouchedOnBothWindows = account("known-untouched", 0, 0);

  assert.equal(
    chooseAccount([unknownUsage, untouchedOnBothWindows])?.id,
    "known-untouched",
  );
});

test("balances equal weekly usage between accounts with different quota windows", () => {
  const withFiveHourQuota = account("with-five-hour-balanced", 0, 0);
  const withoutFiveHourQuota = account("without-five-hour-balanced", undefined, 0);

  const selected = [
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
  ];

  assert.deepEqual(selected, [
    "with-five-hour-balanced",
    "without-five-hour-balanced",
    "with-five-hour-balanced",
    "without-five-hour-balanced",
  ]);
});

test("stops using a five-hour account near its limit when a weekly-only account exists", () => {
  const withFiveHourQuota = account("with-five-hour-near-limit", 90, 0);
  const withoutFiveHourQuota = account("without-five-hour-near-limit", undefined, 0);

  assert.equal(
    chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id,
    "without-five-hour-near-limit",
  );
});

test("does not use an exhausted five-hour account to equalize weekly usage", () => {
  const withFiveHourQuota = account("with-five-hour-exhausted", 100, 0);
  const otherFiveHourQuota = account("other-five-hour-available", 10, 50);

  assert.equal(
    chooseAccount([withFiveHourQuota, otherFiveHourQuota])?.id,
    "other-five-hour-available",
  );
});

test("keeps a five-hour account in rotation below the near-limit threshold", () => {
  const withFiveHourQuota = account("with-five-hour-below-limit", 89, 0);
  const withoutFiveHourQuota = account("without-five-hour-below-limit", undefined, 0);

  const first = chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id;
  const second = chooseAccount([withFiveHourQuota, withoutFiveHourQuota])?.id;

  assert.notEqual(first, second);
});

test("normalizes OpenCode Go rolling, weekly, and monthly quotas", () => {
  const usage = parseOpenCodeUsage({
    usage: {
      rolling: {
        status: "ok",
        percent: 12.5,
        resetsAt: "2026-08-29T16:00:00.000Z",
      },
      weekly: {
        status: "ok",
        percent: 34,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
      monthly: {
        status: "rate-limited",
        percent: 100,
        resetsAt: "2026-09-15T00:00:00.000Z",
      },
    },
  });

  assert.equal(usage.primary?.usedPercent, 12.5);
  assert.equal(usage.primary?.windowSeconds, 5 * 60 * 60);
  assert.equal(usage.secondary?.usedPercent, 34);
  assert.equal(usage.secondary?.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(usage.monthly?.usedPercent, 100);
  assert.equal(
    usage.monthly?.resetAt,
    Date.parse("2026-09-15T00:00:00.000Z"),
  );
});

test("refreshes OpenCode quotas from the account's Go usage endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://opencode.ai/zen/go/v1/usage");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer opencode-key",
    );
    return Response.json({
      usage: {
        rolling: { percent: 8, resetsAt: "2026-08-30T00:00:00Z" },
        weekly: { percent: 21, resetsAt: "2026-09-01T00:00:00Z" },
        monthly: { percent: 55, resetsAt: "2026-09-15T00:00:00Z" },
      },
    });
  };
  const opencode: Account = {
    id: "opencode",
    provider: "opencode",
    accessToken: "opencode-key",
    baseUrl: "https://opencode.ai/zen/go",
    enabled: true,
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      opencode,
      opencode.baseUrl!,
      true,
    );
    assert.equal(refreshed.usage?.primary?.usedPercent, 8);
    assert.equal(refreshed.usage?.secondary?.usedPercent, 21);
    assert.equal(refreshed.usage?.monthly?.usedPercent, 55);
    assert.equal(refreshed.state?.lastError, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes a fresh snapshot after a quota window reset has passed", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async (input) => {
    fetches += 1;
    assert.equal(String(input), "https://chatgpt.example/backend-api/wham/usage");
    return Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          reset_at: Math.floor((Date.now() + 5 * 60 * 60_000) / 1000),
          limit_window_seconds: 5 * 60 * 60,
        },
      },
    });
  };
  const accountWithExpiredWindow: Account = {
    id: "expired-window",
    provider: "openai",
    accessToken: "token-expired-window",
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      primary: {
        usedPercent: 100,
        resetAt: Date.now() - 1_000,
        windowSeconds: 5 * 60 * 60,
      },
    },
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      accountWithExpiredWindow,
      "https://chatgpt.example",
    );
    assert.equal(fetches, 1);
    assert.equal(refreshed.usage?.primary?.usedPercent, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats unavailable OpenCode Go quotas as unsupported instead of an account error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { type: "error", error: { message: "not found" } },
      { status: 404 },
    );
  const opencode: Account = {
    id: "opencode-zen",
    provider: "opencode",
    accessToken: "opencode-key",
    baseUrl: "https://opencode.ai/zen",
    enabled: true,
    state: {
      lastError: "OpenCode usage probe failed 404",
      recentErrors: [
        { at: Date.now(), message: "OpenCode usage probe failed 404" },
        { at: Date.now(), message: "other error" },
      ],
    },
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      opencode,
      opencode.baseUrl!,
      true,
    );
    assert.equal(refreshed.usage?.quotaStatus, "unsupported");
    assert.equal(refreshed.state?.lastError, undefined);
    assert.deepEqual(
      refreshed.state?.recentErrors?.map((error) => error.message),
      ["other error"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps OpenCode authentication failures visible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  const opencode: Account = {
    id: "opencode-invalid",
    provider: "opencode",
    accessToken: "invalid-key",
    baseUrl: "https://opencode.ai/zen/go",
    enabled: true,
  };

  try {
    const refreshed = await refreshUsageIfNeeded(
      opencode,
      opencode.baseUrl!,
      true,
    );
    assert.match(refreshed.state?.lastError ?? "", /failed 401/);
    assert.notEqual(refreshed.usage?.quotaStatus, "unsupported");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
