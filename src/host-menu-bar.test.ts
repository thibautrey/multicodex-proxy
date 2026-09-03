import assert from "node:assert/strict";
import test from "node:test";
import { buildHostMenuBarAccountsSummary } from "./host-menu-bar.js";
import type { Account } from "./types.js";

test("buildHostMenuBarAccountsSummary preserves SwiftBar quota aggregation", () => {
  const now = 1_800_000_000_000;
  const accounts: Account[] = [
    {
      id: "first-secret-id",
      provider: "openai",
      email: "first@example.com",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      enabled: true,
      usage: {
        fetchedAt: now - 1_000,
        primary: { usedPercent: 20, resetAt: now + 60_000 },
        secondary: { usedPercent: 40, resetAt: now + 120_000 },
      },
    },
    {
      id: "second-secret-id",
      provider: "openai",
      accessToken: "another-secret-token",
      enabled: true,
      usage: {
        fetchedAt: now - 2_000,
        primary: { usedPercent: 60 },
        secondary: { usedPercent: 100 },
        monthly: { usedPercent: 10 },
      },
      state: {
        modelBlocks: { "gpt-5.5": { until: now + 30_000, reason: "rate_limit" } },
        lastError: "sensitive upstream error",
      },
    },
    {
      id: "not-openai",
      provider: "mistral",
      accessToken: "mistral-secret",
      enabled: true,
      usage: { fetchedAt: now, primary: { usedPercent: 5 } },
    },
  ];

  const summary = buildHostMenuBarAccountsSummary(accounts, now);

  assert.equal(summary.accounts.length, 2);
  assert.deepEqual(summary.quota, {
    fiveHourRemainingPercent: 60,
    fiveHourAccountCount: 2,
    weeklyRemainingPercent: 30,
    weeklyAccountCount: 2,
  });
  assert.equal(summary.accounts[0].displayName, "first@example.com");
  assert.equal(summary.accounts[0].fiveHour?.remainingPercent, 80);
  assert.equal(summary.accounts[1].displayName, "OpenAI account 2");
  assert.equal(summary.accounts[1].status, "limited");
  assert.equal(summary.accounts[1].monthly?.remainingPercent, 90);

  const serialized = JSON.stringify(summary);
  for (const secret of [
    "secret-access-token",
    "secret-refresh-token",
    "another-secret-token",
    "first-secret-id",
    "second-secret-id",
    "sensitive upstream error",
    "mistral-secret",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("buildHostMenuBarAccountsSummary reports unavailable and attention states safely", () => {
  const now = 1_800_000_000_000;
  const summary = buildHostMenuBarAccountsSummary([
    {
      id: "paused",
      provider: "openai",
      accessToken: "secret",
      enabled: false,
      usage: { fetchedAt: now, quotaStatus: "unsupported" },
    },
    {
      id: "reauth",
      provider: "openai",
      accessToken: "secret",
      enabled: true,
      state: { needsTokenRefresh: true },
      usage: {
        fetchedAt: Number.NaN,
        primary: { usedPercent: Number.POSITIVE_INFINITY, resetAt: Number.NaN },
      },
    },
  ], now);

  assert.deepEqual(summary.quota, {
    fiveHourAccountCount: 0,
    weeklyAccountCount: 0,
  });
  assert.equal(summary.accounts[0].status, "paused");
  assert.equal(summary.accounts[0].usageStatus, "unsupported");
  assert.equal(summary.accounts[1].status, "attention");
  assert.equal(summary.accounts[1].usageStatus, "pending");
  assert.equal(summary.accounts[1].fetchedAt, undefined);
});
