import assert from "node:assert/strict";
import test from "node:test";

import {
  accountUsable,
  clearEmptyResponseHistory,
  markEmptyResponseError,
  markQuotaHit,
} from "./quota.js";

import type { Account } from "./types.js";

const MODEL = "gpt-test";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function makeAccount(): Account {
  const now = Date.now();

  return {
    id: "test-account",
    provider: "openai",
    accessToken: "test-token",
    enabled: true,
    usage: {
      fetchedAt: now,
      primary: {
        usedPercent: 10,
        resetAt: now + 2 * HOUR,
      },
      secondary: {
        usedPercent: 20,
        resetAt: now + 4 * DAY,
      },
    },
  };
}

test("successful concurrent response does not clear a quota block", () => {
  const account = makeAccount();
  const fiveHourReset = Date.now() + 2 * HOUR;

  account.usage = {
    fetchedAt: Date.now(),
    primary: {
      usedPercent: 100,
      resetAt: fiveHourReset,
    },
    secondary: {
      usedPercent: 30,
      resetAt: Date.now() + 4 * DAY,
    },
  };

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
  );

  const blockBefore = account.state?.modelBlocks?.[MODEL];

  assert.ok(blockBefore);
  assert.equal(accountUsable(account, MODEL), false);

  // Simulate another request that was already in flight succeeding after
  // this request created the quota block.
  clearEmptyResponseHistory(account, MODEL);

  const blockAfter = account.state?.modelBlocks?.[MODEL];

  assert.ok(blockAfter);
  assert.equal(blockAfter.until, blockBefore.until);
  assert.equal(blockAfter.reason, blockBefore.reason);
  assert.equal(accountUsable(account, MODEL), false);
});

test("successful response still clears a genuine empty-response block", () => {
  const account = makeAccount();

  // Use the real empty-response path instead of constructing modelBlocks
  // manually. Five calls are enough to exceed the current threshold.
  for (let i = 0; i < 5; i += 1) {
    markEmptyResponseError(account, MODEL);
  }

  const block = account.state?.modelBlocks?.[MODEL];

  assert.ok(block);
  assert.match(block.reason, /^empty responses \(/);
  assert.equal(accountUsable(account, MODEL), false);

  clearEmptyResponseHistory(account, MODEL);

  assert.equal(account.state?.modelBlocks?.[MODEL], undefined);
  assert.equal(accountUsable(account, MODEL), true);
});

test("usage-limit uses exhausted five-hour reset plus grace", () => {
  const account = makeAccount();
  const fiveHourReset = Date.now() + 2 * HOUR;

  account.usage = {
    fetchedAt: Date.now(),
    primary: {
      usedPercent: 100,
      resetAt: fiveHourReset,
    },
    secondary: {
      usedPercent: 40,
      resetAt: Date.now() + 4 * DAY,
    },
  };

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
  );

  assert.equal(
    account.state?.modelBlocks?.[MODEL]?.until,
    fiveHourReset + MINUTE,
  );
});

test("usage-limit uses exhausted weekly reset plus grace", () => {
  const account = makeAccount();
  const weeklyReset = Date.now() + 4 * DAY;

  account.usage = {
    fetchedAt: Date.now(),
    primary: {
      usedPercent: 20,
      resetAt: Date.now() + 2 * HOUR,
    },
    secondary: {
      usedPercent: 100,
      resetAt: weeklyReset,
    },
  };

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"type":"usage_limit_reached"}}',
  );

  assert.equal(
    account.state?.modelBlocks?.[MODEL]?.until,
    weeklyReset + MINUTE,
  );
});

test("usage-limit uses the later reset when both windows are exhausted", () => {
  const account = makeAccount();
  const fiveHourReset = Date.now() + 2 * HOUR;
  const weeklyReset = Date.now() + 4 * DAY;

  account.usage = {
    fetchedAt: Date.now(),
    primary: {
      usedPercent: 100,
      resetAt: fiveHourReset,
    },
    secondary: {
      usedPercent: 100,
      resetAt: weeklyReset,
    },
  };

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"type":"usage_limit_reached"}}',
  );

  assert.equal(
    account.state?.modelBlocks?.[MODEL]?.until,
    weeklyReset + MINUTE,
  );
});

test("ordinary 429 does not use an exhausted quota reset", () => {
  const account = makeAccount();
  const now = Date.now();
  const fiveHourReset = now + 3 * HOUR;

  // Deliberately make the snapshot look exhausted. The upstream error text
  // is still only a transient rate limit, so the quota reset must not be used.
  account.usage = {
    fetchedAt: now,
    primary: {
      usedPercent: 100,
      resetAt: fiveHourReset,
    },
    secondary: {
      usedPercent: 30,
      resetAt: now + 4 * DAY,
    },
  };

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"message":"Too many requests"}}',
  );

  const until = account.state?.modelBlocks?.[MODEL]?.until;

  assert.equal(typeof until, "number");
  assert.notEqual(until, fiveHourReset + MINUTE);
  assert.ok(
    until! < fiveHourReset,
    "transient 429 should use the short rate-limit cooldown",
  );
});

test("usage-limit with no usable quota snapshot still creates a fallback block", () => {
  const account = makeAccount();
  const before = Date.now();

  account.usage = undefined;

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"type":"usage_limit_reached"}}',
  );

  const block = account.state?.modelBlocks?.[MODEL];

  assert.ok(block);
  assert.ok(block.until > before);
  assert.equal(accountUsable(account, MODEL), false);
});

test("non-finite quota snapshot values cannot create an invalid block timestamp", () => {
  const account = makeAccount();
  const now = Date.now();

  account.usage = {
    fetchedAt: now,
    primary: {
      usedPercent: Number.NaN,
      resetAt: now + 2 * HOUR,
    },
    secondary: {
      usedPercent: 100,
      resetAt: Number.NaN,
    },
  };

  markQuotaHit(
    account,
    MODEL,
    "quota/rate-limit: 429",
    '{"error":{"type":"usage_limit_reached"}}',
  );

  const block = account.state?.modelBlocks?.[MODEL];

  assert.ok(block);
  assert.ok(
    Number.isFinite(block.until),
    "non-finite quota snapshot values must never produce an invalid block timestamp",
  );
  assert.ok(
    block.until > now && block.until < now + 10 * MINUTE,
    "invalid quota reset values should fall back to the transient rate-limit cooldown",
  );
});

test("clearing empty-response history tolerates a malformed block without a reason", () => {
  const account = makeAccount();

  account.state = {
    modelBlocks: {
      [MODEL]: {
        until: Date.now() + MINUTE,
        reason: undefined,
      } as unknown as { until: number; reason: string },
    },
  };

  assert.doesNotThrow(() => {
    clearEmptyResponseHistory(account, MODEL);
  });

  assert.ok(account.state?.modelBlocks?.[MODEL]);
});
