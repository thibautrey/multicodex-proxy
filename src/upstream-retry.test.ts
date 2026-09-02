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
  const attemptStarts: number[] = [];
  const retries: Array<{ attempt: number; status?: number; error?: string }> = [];
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
      onAttemptStart: (attempt) => {
        attemptStarts.push(attempt);
      },
      onAttemptRetry: (event) => {
        retries.push(event);
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [3_000]);
  assert.deepEqual(attemptStarts, [1, 2]);
  assert.deepEqual(retries, [
    { attempt: 1, status: 503, error: "service unavailable" },
  ]);
});

test("keeps retrying transport failures but not quota exceptions", async () => {
  let transportAttempts = 0;
  const transportSleeps: number[] = [];
  const transportAttemptStarts: number[] = [];
  const transportRetries: Array<{ attempt: number; error?: string }> = [];
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
      onAttemptStart: (attempt) => {
        transportAttemptStarts.push(attempt);
      },
      onAttemptRetry: (event) => {
        transportRetries.push(event);
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(transportAttempts, 2);
  assert.deepEqual(transportSleeps, [10]);
  assert.deepEqual(transportAttemptStarts, [1, 2]);
  assert.deepEqual(transportRetries, [
    { attempt: 1, error: "connection refused" },
  ]);


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

test("does not start an upstream attempt when the request is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;

  await assert.rejects(
    fetchUpstreamWithRetry(
      "https://example.invalid/responses",
      { method: "POST", signal: controller.signal },
      {
        fetchFn: async () => {
          attempts += 1;
          return new Response("unexpected", { status: 200 });
        },
      },
    ),
    /aborted/i,
  );
  assert.equal(attempts, 0);
});

test("stops retry backoff when the request is aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  let receivedSignal: AbortSignal | undefined;

  await assert.rejects(
    fetchUpstreamWithRetry(
      "https://example.invalid/responses",
      { method: "POST", signal: controller.signal },
      {
        maxRetries: 2,
        baseDelayMs: 10_000,
        randomFn: () => 0,
        fetchFn: async () => {
          attempts += 1;
          throw new Error("connection refused");
        },
        sleepFn: async (_ms, signal) => {
          receivedSignal = signal;
          controller.abort();
        },
      },
    ),
    /aborted/i,
  );

  assert.equal(attempts, 1);
  assert.equal(receivedSignal, controller.signal);
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
