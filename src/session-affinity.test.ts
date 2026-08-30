import assert from "node:assert/strict";
import test from "node:test";

import {
  findSessionAffinityAccount,
  preferSessionAffinityAccount,
  SessionAffinityCache,
} from "./session-affinity.js";
import { accountSelectionPool } from "./quota.js";
import type { Account } from "./types.js";

function account(
  id: string,
  primaryUsedPercent = 0,
): Account {
  return {
    id,
    provider: "openai",
    accessToken: `token-${id}`,
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      primary: {
        usedPercent: primaryUsedPercent,
      },
      secondary: {
        usedPercent: 0,
      },
    },
  };
}

test("returns the remembered account for the same session and provider", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");
  const second = account("account-two");

  cache.remember("default", "thread-one", "openai", first.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "openai",
      [first, second],
    )?.id,
    first.id,
  );
});

test("affinity is ignored when the feature is disabled", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");

  cache.remember("default", "thread-one", "openai", first.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      false,
      "default",
      "thread-one",
      "openai",
      [first],
    ),
    undefined,
  );
});

test("sessions have independent affinity", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");
  const second = account("account-two");

  cache.remember("default", "thread-one", "openai", first.id);
  cache.remember("default", "thread-two", "openai", second.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "openai",
      [first, second],
    )?.id,
    first.id,
  );

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-two",
      "openai",
      [first, second],
    )?.id,
    second.id,
  );
});

test("applications have independent affinity for the same session and provider", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");
  const second = account("account-two");

  cache.remember("application-one", "thread-one", "openai", first.id);
  cache.remember("application-two", "thread-one", "openai", second.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "application-one",
      "thread-one",
      "openai",
      [first, second],
    )?.id,
    first.id,
  );
  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "application-two",
      "thread-one",
      "openai",
      [first, second],
    )?.id,
    second.id,
  );
});

test("providers have independent affinity within the same session", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");

  cache.remember("default", "thread-one", "openai", first.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "xai",
      [first],
    ),
    undefined,
  );
});

test("expired affinity is discarded", () => {
  const cache = new SessionAffinityCache(100);
  const first = account("account-one");

  cache.remember("default", "thread-one", "openai", first.id, 1_000);

  assert.equal(
    cache.get("default", "thread-one", "openai", 1_099),
    first.id,
  );

  assert.equal(
    cache.get("default", "thread-one", "openai", 1_100),
    undefined,
  );
});

test("remembering an active session refreshes its TTL", () => {
  const cache = new SessionAffinityCache(100);
  const first = account("account-one");

  cache.remember("default", "thread-one", "openai", first.id, 1_000);
  cache.remember("default", "thread-one", "openai", first.id, 1_090);

  assert.equal(
    cache.get("default", "thread-one", "openai", 1_150),
    first.id,
  );
});

test("evicts the least recently used entry when the cache is full", () => {
  const cache = new SessionAffinityCache(1_000, 2);
  const first = account("account-one");
  const second = account("account-two");
  const third = account("account-three");

  cache.remember("default", "thread-one", "openai", first.id);
  cache.remember("default", "thread-two", "openai", second.id);
  assert.equal(cache.get("default", "thread-one", "openai"), first.id);

  cache.remember("default", "thread-three", "openai", third.id);

  assert.equal(cache.get("default", "thread-one", "openai"), first.id);
  assert.equal(cache.get("default", "thread-two", "openai"), undefined);
  assert.equal(cache.get("default", "thread-three", "openai"), third.id);
});

test("an ineligible sticky account is forgotten", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");
  const second = account("account-two");

  cache.remember("default", "thread-one", "openai", first.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "openai",
      [second],
    ),
    undefined,
  );

  assert.equal(
    cache.get("default", "thread-one", "openai"),
    undefined,
  );
});

test("affinity cannot bypass the five-hour near-limit selection pool", () => {
  const cache = new SessionAffinityCache();
  const nearLimit = account("near-limit", 100);
  const available = account("available", 10);

  cache.remember("default", "thread-one", "openai", nearLimit.id);

  const eligibleAccounts = accountSelectionPool([
    nearLimit,
    available,
  ]);

  assert.deepEqual(
    eligibleAccounts.map((candidate) => candidate.id),
    ["available"],
  );

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "openai",
      eligibleAccounts,
    ),
    undefined,
  );
});

test("session affinity wins over a smart-routing preference within the eligible pool", () => {
  const sticky = account("sticky-account");
  const preferred = account("preferred-account");

  assert.equal(
    preferSessionAffinityAccount(sticky, preferred)?.id,
    "sticky-account",
  );
});

test("smart-routing preference is used when no session affinity exists", () => {
  const preferred = account("preferred-account");

  assert.equal(
    preferSessionAffinityAccount(undefined, preferred)?.id,
    "preferred-account",
  );
});

test("failover replaces affinity and does not bounce back when the old account returns", () => {
  const cache = new SessionAffinityCache();
  const first = account("account-one");
  const second = account("account-two");

  cache.remember("default", "thread-one", "openai", first.id);

  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "openai",
      [first, second],
    )?.id,
    first.id,
  );

  // The sticky account becomes ineligible. Looking it up drops the stale
  // mapping so normal routing can fail over.
  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "thread-one",
      "openai",
      [second],
    ),
    undefined,
  );

  assert.equal(
    cache.get("default", "thread-one", "openai"),
    undefined,
  );

  // Simulate the router selecting the fallback account.
  cache.remember("default", "thread-one", "openai", second.id);

  // The original account becomes eligible again, but the session should
  // remain attached to the account selected during failover.
  assert.equal(
    findSessionAffinityAccount(
      cache,
      true,
      "default",
      "thread-one",
      "openai",
      [first, second],
    )?.id,
    second.id,
  );
});
