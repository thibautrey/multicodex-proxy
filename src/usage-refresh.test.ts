import assert from "node:assert/strict";
import test from "node:test";
import { UsageRefreshCoordinator } from "./usage-refresh.js";
import type { Account } from "./types.js";

function account(fetchedAt?: number): Account {
  return {
    id: "account-1",
    accessToken: "test-token",
    enabled: true,
    usage:
      typeof fetchedAt === "number"
        ? { fetchedAt, primary: { usedPercent: 10 } }
        : undefined,
  };
}

test("blocks the first usage refresh when no snapshot exists", async () => {
  let calls = 0;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    value.usage = { fetchedAt: Date.now(), primary: { usedPercent: 20 } };
    return value;
  });

  const result = await coordinator.prepare(account(), "https://example.test", {
    staleWhileRevalidate: true,
  });

  assert.equal(result.mode, "blocking");
  assert.equal(result.account.usage?.primary?.usedPercent, 20);
  assert.equal(calls, 1);
});

test("serves an account without a usage snapshot while its first probe runs", async () => {
  let release!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    await refreshStarted;
    value.usage = { fetchedAt: Date.now(), primary: { usedPercent: 20 } };
    return value;
  });

  const prepared = await coordinator.prepare(account(), "https://example.test", {
    staleWhileRevalidate: true,
    serveMissingSnapshotWhileRevalidating: true,
  });

  assert.equal(prepared.mode, "background");
  assert.equal(prepared.account.usage, undefined);
  assert.equal(calls, 1);

  release();
  await new Promise((resolve) => setImmediate(resolve));
});

test("does not probe while the usage snapshot is fresh", async () => {
  let calls = 0;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    return value;
  });
  const original = account(Date.now());

  const result = await coordinator.prepare(
    original,
    "https://example.test",
    { staleWhileRevalidate: true },
  );

  assert.equal(result.mode, "fresh");
  assert.equal(result.account, original);
  assert.equal(calls, 0);
});

test("blocks stale usage when stale-while-revalidate is disabled", async () => {
  const staleAt = Date.now() - 10 * 60_000;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    value.usage = { fetchedAt: Date.now() };
    return value;
  });

  const result = await coordinator.prepare(
    account(staleAt),
    "https://example.test",
    { staleWhileRevalidate: false },
  );

  assert.equal(result.mode, "blocking");
  assert.notEqual(result.account.usage?.fetchedAt, staleAt);
});

test("blocks when the existing snapshot exceeds the stale age limit", async () => {
  const staleAt = Date.now() - 60 * 60_000;
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    value.usage = { fetchedAt: Date.now() };
    return value;
  });

  const result = await coordinator.prepare(
    account(staleAt),
    "https://example.test",
    {
      staleWhileRevalidate: true,
      maxStaleAgeMs: 30 * 60_000,
    },
  );

  assert.equal(result.mode, "blocking");
  assert.notEqual(result.account.usage?.fetchedAt, staleAt);
});

test("serves stale usage immediately and persists a newer snapshot", async () => {
  const staleAt = Date.now() - 10 * 60_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updates: Account[] = [];
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    await gate;
    value.usage = { fetchedAt: Date.now(), primary: { usedPercent: 30 } };
    return value;
  });

  const prepared = await coordinator.prepare(
    account(staleAt),
    "https://example.test",
    {
      staleWhileRevalidate: true,
      onBackgroundUpdate: (updated) => {
        updates.push(updated);
      },
    },
  );

  assert.equal(prepared.mode, "background");
  assert.equal(prepared.account.usage?.fetchedAt, staleAt);
  assert.equal(updates.length, 0);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].usage?.primary?.usedPercent, 30);
});

test("coalesces concurrent refreshes for the same account", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    calls += 1;
    await gate;
    value.usage = { fetchedAt: Date.now() };
    return value;
  });
  const stale = account(Date.now() - 10 * 60_000);

  const first = await coordinator.prepare(stale, "https://example.test", {
    staleWhileRevalidate: true,
  });
  const second = await coordinator.prepare(stale, "https://example.test", {
    staleWhileRevalidate: true,
  });

  assert.equal(first.shared, false);
  assert.equal(second.shared, true);
  assert.equal(calls, 1);
  release();
});

test("does not mutate the stale account while refreshing in background", async () => {
  const staleAt = Date.now() - 10 * 60_000;
  const original = account(staleAt);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new UsageRefreshCoordinator(async (value) => {
    value.state = { lastError: "background-only" };
    await gate;
    value.usage = { fetchedAt: Date.now() };
    return value;
  });

  await coordinator.prepare(original, "https://example.test", {
    staleWhileRevalidate: true,
  });
  assert.equal(original.state, undefined);
  assert.equal(original.usage?.fetchedAt, staleAt);
  release();
});
