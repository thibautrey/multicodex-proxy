import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findAvailableResetCreditCount,
  hasReachedScheduledWeeklyResetThreshold,
  maybeConsumeScheduledWeeklyReset,
  rateLimitResetCreditRequest,
} from "./rate-limit-reset.js";
import { AccountStore } from "./store.js";
import type { Account } from "./types.js";

function scheduledAccount(usedPercent: number): Account {
  return {
    id: "account-1",
    provider: "openai",
    email: "test@example.com",
    accessToken: "token",
    enabled: true,
    usage: {
      fetchedAt: Date.now(),
      secondary: { usedPercent },
    },
    state: {
      scheduledWeeklyReset: {
        scheduledAt: Date.now(),
        idempotencyKey: "stable-reset-id",
        thresholdRemainingPercent: 0.5,
      },
    },
  };
}

test("weekly auto-reset threshold starts at exactly 0.5% remaining", () => {
  assert.equal(hasReachedScheduledWeeklyResetThreshold(scheduledAccount(99.49)), false);
  assert.equal(hasReachedScheduledWeeklyResetThreshold(scheduledAccount(99.5)), true);
  assert.equal(hasReachedScheduledWeeklyResetThreshold(scheduledAccount(100)), true);
});

test("available reset credit count supports nested API response shapes", () => {
  assert.equal(
    findAvailableResetCreditCount({ data: { available_count: 2 } }),
    2,
  );
  assert.equal(findAvailableResetCreditCount({ data: {} }), undefined);
});

test("reset credit requests prefer the WHAM route", async () => {
  const urls: string[] = [];
  const account = scheduledAccount(50);
  const result = await rateLimitResetCreditRequest(
    account,
    "https://chatgpt.example",
    false,
    "request-id",
    async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ available: 1 }), { status: 200 });
    },
  );

  assert.deepEqual(result, { available: 1 });
  assert.deepEqual(urls, [
    "https://chatgpt.example/backend-api/wham/rate-limit-reset-credits",
  ]);
});

test("HTML challenge falls back but a JSON permission failure does not", async () => {
  const account = scheduledAccount(50);
  let calls = 0;
  const recovered = await rateLimitResetCreditRequest(
    account,
    "https://chatgpt.example",
    false,
    "request-id",
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          "<html><script src='/cdn-cgi/challenge-platform/test'></script></html>",
          {
            status: 403,
            headers: { "content-type": "text/html" },
          },
        );
      }
      return new Response(JSON.stringify({ available: 1 }), { status: 200 });
    },
  );
  assert.deepEqual(recovered, { available: 1 });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    rateLimitResetCreditRequest(
      account,
      "https://chatgpt.example",
      false,
      "request-id",
      async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      },
    ),
    /403: forbidden/,
  );
  assert.equal(calls, 1);
});

test("scheduled weekly reset consumes once and disarms itself", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-reset-test-"));
  const store = new AccountStore(path.join(tempDir, "accounts.json"));
  const originalFetch = globalThis.fetch;
  let consumeCalls = 0;
  const requestBodies: unknown[] = [];

  try {
    await store.init();
    await store.addOrUpdate(scheduledAccount(99.5));
    globalThis.fetch = async (_input, init) => {
      if (init?.method === "POST") {
        consumeCalls += 1;
        requestBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const first = await maybeConsumeScheduledWeeklyReset(
      "account-1",
      store,
      "https://chatgpt.example",
    );
    const second = await maybeConsumeScheduledWeeklyReset(
      "account-1",
      store,
      "https://chatgpt.example",
    );

    assert.equal(first.status, "consumed");
    assert.equal(second.status, "not-scheduled");
    assert.equal(consumeCalls, 1);
    assert.deepEqual(requestBodies, [
      { redeem_request_id: "stable-reset-id" },
    ]);
    assert.equal(
      store.getCachedAccounts()[0]?.state?.scheduledWeeklyReset,
      undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
