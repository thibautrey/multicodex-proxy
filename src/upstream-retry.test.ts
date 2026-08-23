import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchUpstreamWithRetry,
  shouldRetryUpstreamOnSameAccount,
} from "./upstream-retry.js";

test("returns quota responses immediately so the router can rotate accounts", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const response = await fetchUpstreamWithRetry(
    "https://example.invalid/responses",
    { method: "POST" },
    {
      maxRetries: 5,
      baseDelayMs: 2_000,
      randomFn: () => 0,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      fetchFn: async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({ error: { message: "Too many requests" } }),
          { status: 429 },
        );
      },
    },
  );

  assert.equal(response.status, 429);
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test("recognizes quota-like business errors even without HTTP 429", async () => {
  let attempts = 0;
  const response = await fetchUpstreamWithRetry(
    "https://example.invalid/responses",
    { method: "POST" },
    {
      maxRetries: 5,
      sleepFn: async () => {
        assert.fail("quota-like errors must not sleep on the same account");
      },
      fetchFn: async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({ error: { message: "Usage limit reached" } }),
          { status: 403 },
        );
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test("keeps same-account retries for transient server errors", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const response = await fetchUpstreamWithRetry(
    "https://example.invalid/responses",
    { method: "POST" },
    {
      maxRetries: 5,
      baseDelayMs: 2_000,
      randomFn: () => 0,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      fetchFn: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("service unavailable", {
              status: 503,
              headers: { "retry-after": "3" },
            })
          : new Response("ok", { status: 200 });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [3_000]);
});

test("keeps retrying transport failures but not quota exceptions", async () => {
  let transportAttempts = 0;
  const transportSleeps: number[] = [];
  const response = await fetchUpstreamWithRetry(
    "https://example.invalid/responses",
    { method: "POST" },
    {
      maxRetries: 2,
      baseDelayMs: 10,
      randomFn: () => 0,
      sleepFn: async (ms) => {
        transportSleeps.push(ms);
      },
      fetchFn: async () => {
        transportAttempts += 1;
        if (transportAttempts === 1) throw new Error("connection refused");
        return new Response("ok", { status: 200 });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(transportAttempts, 2);
  assert.deepEqual(transportSleeps, [10]);

  let quotaAttempts = 0;
  await assert.rejects(
    fetchUpstreamWithRetry(
      "https://example.invalid/responses",
      { method: "POST" },
      {
        maxRetries: 2,
        sleepFn: async () => {
          assert.fail("quota exceptions must not sleep on the same account");
        },
        fetchFn: async () => {
          quotaAttempts += 1;
          throw new Error("usage limit reached");
        },
      },
    ),
    /usage limit reached/,
  );
  assert.equal(quotaAttempts, 1);
});

test("same-account retry classification separates quota from outages", () => {
  assert.equal(shouldRetryUpstreamOnSameAccount(429, ""), false);
  assert.equal(
    shouldRetryUpstreamOnSameAccount(403, "rate limit reached"),
    false,
  );
  assert.equal(
    shouldRetryUpstreamOnSameAccount(503, "service unavailable"),
    true,
  );
  assert.equal(
    shouldRetryUpstreamOnSameAccount(400, "invalid request"),
    false,
  );
});

test("aborts an upstream attempt at the configured deadline", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    fetchUpstreamWithRetry(
      "https://example.invalid/responses",
      { method: "POST" },
      {
        maxRetries: 0,
        requestTimeoutMs: 15,
        totalTimeoutMs: 30,
        fetchFn: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      },
    ),
  );
  assert.ok(Date.now() - startedAt < 500);
});
