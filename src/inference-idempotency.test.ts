import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { handleAnthropicMessages } from "./anthropic-compat.js";

import {
  createInferenceIdempotencyMiddleware,
  hashInferencePayload,
  InferenceIdempotencyCache,
  INFERENCE_IDEMPOTENCY_STATUS_HEADER,
  type InferenceIdempotencyOptions,
} from "./inference-idempotency.js";

type ResponseSnapshot = {
  status: number;
  idempotencyStatus: string | null;
  body: any;
};

const DEFAULT_OPTIONS: InferenceIdempotencyOptions = {
  ttlMs: 60_000,
  inFlightTimeoutMs: 60_000,
  maxEntries: 100,
  maxBytes: 1024 * 1024,
  maxResponseBytes: 256 * 1024,
};

async function startFixture(
  t: test.TestContext,
  handler: express.RequestHandler,
  options: Partial<InferenceIdempotencyOptions> = {},
  observeRequest?: (req: express.Request) => void,
) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    observeRequest?.(req);
    const application = req.header("x-test-application");
    if (application) res.locals.proxyApplication = application;
    next();
  });
  app.use(
    createInferenceIdempotencyMiddleware({
      ...DEFAULT_OPTIONS,
      ...options,
    }),
  );
  app.post(
    ["/v1/responses", "/responses", "/v1/chat/completions", "/v1/messages"],
    handler,
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(
  baseUrl: string,
  path: string,
  application: string | undefined,
  key: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<ResponseSnapshot> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-multivibe-idempotency-key": key,
    ...extraHeaders,
  };
  if (application) headers["x-test-application"] = application;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    idempotencyStatus: response.headers.get(
      INFERENCE_IDEMPOTENCY_STATUS_HEADER,
    ),
    body: await response.json(),
  };
}

test("canonical payload hashing ignores object key order", () => {
  assert.equal(
    hashInferencePayload({ model: "test", input: { b: 2, a: 1 } }),
    hashInferencePayload({ input: { a: 1, b: 2 }, model: "test" }),
  );
  assert.notEqual(
    hashInferencePayload({ model: "test", input: "one" }),
    hashInferencePayload({ model: "test", input: "two" }),
  );
});

test("coalesces concurrent non-stream inference and replays the result", async (t) => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requestCount = 0;
  let secondArrived!: () => void;
  const followerArrived = new Promise<void>((resolve) => {
    secondArrived = resolve;
  });
  const baseUrl = await startFixture(
    t,
    async (_req, res) => {
      calls += 1;
      started();
      await gate;
      res.setHeader("X-MultiVibe-Decision", "cloud");
      res.json({ id: "response-one", object: "response", status: "completed" });
    },
    {},
    () => {
      requestCount += 1;
      if (requestCount === 2) secondArrived();
    },
  );
  const payload = { model: "test", input: "same", stream: false };

  const leader = postJson(baseUrl, "/v1/responses", "app-a", "same-key", payload);
  await requestStarted;
  const follower = postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "same-key",
    payload,
  );
  await followerArrived;
  release();
  const [first, second] = await Promise.all([leader, follower]);
  const replay = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "same-key",
    { input: "same", stream: false, model: "test" },
  );

  assert.equal(calls, 1);
  assert.equal(first.idempotencyStatus, "created");
  assert.equal(second.idempotencyStatus, "coalesced");
  assert.equal(replay.idempotencyStatus, "replayed");
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(replay.body, first.body);
});

test("rejects one application key reused with a different payload", async (t) => {
  let calls = 0;
  const baseUrl = await startFixture(t, (_req, res) => {
    calls += 1;
    res.json({ id: `response-${calls}` });
  });

  const first = await postJson(baseUrl, "/v1/responses", "app-a", "key", {
    model: "test",
    input: "one",
  });
  const conflict = await postJson(baseUrl, "/v1/responses", "app-a", "key", {
    model: "test",
    input: "two",
  });

  assert.equal(first.status, 200);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "idempotency_key_reused");
  const sessionPayload = { model: "test", input: "same" };
  await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "session-key",
    sessionPayload,
    { "thread-id": "thread-one" },
  );
  const sessionConflict = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "session-key",
    sessionPayload,
    { "thread-id": "thread-two" },
  );
  assert.equal(sessionConflict.status, 409);
  await postJson(baseUrl, "/v1/messages", "app-a", "anthropic-key", {
    model: "test",
    messages: [{ role: "user", content: "one" }],
  });
  const anthropicConflict = await postJson(
    baseUrl,
    "/v1/messages",
    "app-a",
    "anthropic-key",
    { model: "test", messages: [{ role: "user", content: "two" }] },
  );
  assert.equal(anthropicConflict.status, 409);
  assert.equal(anthropicConflict.body.type, "error");
  assert.equal(anthropicConflict.body.error.type, "invalid_request_error");
  assert.equal(calls, 3);
});

test("isolates idempotency by application and inference route", async (t) => {
  let calls = 0;
  const baseUrl = await startFixture(t, (_req, res) => {
    calls += 1;
    res.json({ id: `response-${calls}` });
  });

  const appA = await postJson(baseUrl, "/v1/responses", "app-a", "key", {
    model: "test",
    input: "same",
  });
  const appB = await postJson(baseUrl, "/v1/responses", "app-b", "key", {
    model: "test",
    input: "same",
  });
  const chat = await postJson(
    baseUrl,
    "/v1/chat/completions",
    "app-a",
    "key",
    { model: "test", messages: [{ role: "user", content: "same" }] },
  );

  assert.equal(calls, 3);
  assert.equal(appA.idempotencyStatus, "created");
  assert.equal(appB.idempotencyStatus, "created");
  assert.equal(chat.idempotencyStatus, "created");
});

test("keeps messages idempotency isolated from its responses loopback", async (t) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.header("x-api-key") === "app-key") {
      res.locals.proxyApplication = "app-a";
    }
    next();
  });
  app.use(createInferenceIdempotencyMiddleware(DEFAULT_OPTIONS));
  let responseCalls = 0;
  app.post("/v1/responses", (_req, res) => {
    responseCalls += 1;
    res.json({
      id: `response-${responseCalls}`,
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  app.post("/v1/messages", (req, res, next) => {
    handleAnthropicMessages(req, res).catch(next);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { "x-api-key": "app-key" };
  const messagesBody = {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32,
  };
  const responsesBody = { model: "test", input: "hello" };

  const messagesFirst = await postJson(
    baseUrl,
    "/v1/messages",
    undefined,
    "messages-first",
    messagesBody,
    headers,
  );
  const responsesSecond = await postJson(
    baseUrl,
    "/v1/responses",
    undefined,
    "messages-first",
    responsesBody,
    headers,
  );
  const responsesFirst = await postJson(
    baseUrl,
    "/v1/responses",
    undefined,
    "responses-first",
    responsesBody,
    headers,
  );
  const messagesSecond = await postJson(
    baseUrl,
    "/v1/messages",
    undefined,
    "responses-first",
    messagesBody,
    headers,
  );

  assert.equal(messagesFirst.idempotencyStatus, "created");
  assert.equal(responsesSecond.idempotencyStatus, "created");
  assert.equal(responsesFirst.idempotencyStatus, "created");
  assert.equal(messagesSecond.idempotencyStatus, "created");
  assert.equal(responseCalls, 4);
});

test("elects one replacement leader after an in-flight timeout", async (t) => {
  let calls = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let observedRequests = 0;
  let allRequestsArrived!: () => void;
  const requestsArrived = new Promise<void>((resolve) => {
    allRequestsArrived = resolve;
  });
  const baseUrl = await startFixture(
    t,
    async (_req, res) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await firstGate;
      }
      res.json({ id: `response-${calls}`, status: "completed" });
    },
    { inFlightTimeoutMs: 500 },
    () => {
      observedRequests += 1;
      if (observedRequests === 4) allRequestsArrived();
    },
  );
  const payload = { model: "test", input: "same" };
  const leader = postJson(baseUrl, "/v1/responses", "app-a", "key", payload);
  await started;
  const followers = Array.from({ length: 3 }, () =>
    postJson(baseUrl, "/v1/responses", "app-a", "key", payload),
  );

  await requestsArrived;
  const followerResults = await Promise.all(followers);
  releaseFirst();
  const leaderResult = await leader;

  assert.equal(calls, 2);
  assert.equal(leaderResult.idempotencyStatus, "created");
  assert.equal(
    followerResults.filter((result) => result.idempotencyStatus === "created")
      .length,
    1,
  );
  assert.ok(
    followerResults
      .filter((result) => result.idempotencyStatus !== "created")
      .every((result) =>
        ["coalesced", "replayed"].includes(String(result.idempotencyStatus)),
      ),
  );
});

test("elects one replacement leader when the original client disconnects", async (t) => {
  let calls = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let observedRequests = 0;
  let allRequestsArrived!: () => void;
  const requestsArrived = new Promise<void>((resolve) => {
    allRequestsArrived = resolve;
  });
  const baseUrl = await startFixture(
    t,
    async (_req, res) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await firstGate;
        return;
      }
      res.json({ id: `response-${calls}`, status: "completed" });
    },
    {},
    () => {
      observedRequests += 1;
      if (observedRequests === 4) allRequestsArrived();
    },
  );
  const payload = { model: "test", input: "same" };
  const endpoint = new URL("/v1/responses", baseUrl);
  let abortLeader!: () => void;
  const leaderClosed = new Promise<void>((resolve, reject) => {
    const request = http.request(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-multivibe-idempotency-key": "key",
          "x-test-application": "app-a",
        },
      },
      () => reject(new Error("leader unexpectedly received a response")),
    );
    request.on("error", () => resolve());
    request.write(JSON.stringify(payload));
    request.end();
    abortLeader = () => request.destroy(new Error("test client disconnect"));
  });
  await started;
  const followers = Array.from({ length: 3 }, () =>
    postJson(baseUrl, "/v1/responses", "app-a", "key", payload),
  );
  await requestsArrived;
  abortLeader();

  const followerResults = await Promise.all(followers);
  await leaderClosed;
  releaseFirst();

  assert.equal(calls, 2);
  assert.equal(
    followerResults.filter((result) => result.idempotencyStatus === "created")
      .length,
    1,
  );
  assert.ok(
    followerResults
      .filter((result) => result.idempotencyStatus !== "created")
      .every((result) =>
        ["coalesced", "replayed"].includes(String(result.idempotencyStatus)),
      ),
  );
});

test("does not retain protocol-specific truncated responses", async (t) => {
  const calls = new Map<string, number>();
  const baseUrl = await startFixture(t, (req, res) => {
    const count = (calls.get(req.path) ?? 0) + 1;
    calls.set(req.path, count);
    if (req.path === "/v1/chat/completions") {
      return res.json({
        id: `chat-${count}`,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "partial" },
          finish_reason: "length",
        }],
      });
    }
    res.json({
      id: `message-${count}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
    });
  });

  for (const [path, body] of [
    [
      "/v1/chat/completions",
      { model: "test", messages: [{ role: "user", content: "hello" }] },
    ],
    [
      "/v1/messages",
      {
        model: "test",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
      },
    ],
  ] as const) {
    const first = await postJson(baseUrl, path, "app-a", `${path}-key`, body);
    const second = await postJson(baseUrl, path, "app-a", `${path}-key`, body);
    assert.equal(first.idempotencyStatus, "created");
    assert.equal(second.idempotencyStatus, "created");
    assert.notDeepEqual(second.body, first.body);
  }

  assert.equal(calls.get("/v1/chat/completions"), 2);
  assert.equal(calls.get("/v1/messages"), 2);
});

test("expires completed entries deterministically", async (t) => {
  let now = 1_000;
  let calls = 0;
  const baseUrl = await startFixture(
    t,
    (_req, res) => {
      calls += 1;
      res.json({ id: `response-${calls}` });
    },
    { ttlMs: 100, now: () => now },
  );
  const payload = { model: "test", input: "same" };

  const first = await postJson(baseUrl, "/v1/responses", "app-a", "key", payload);
  const replay = await postJson(baseUrl, "/v1/responses", "app-a", "key", payload);
  now += 101;
  const expired = await postJson(baseUrl, "/v1/responses", "app-a", "key", payload);

  assert.equal(first.idempotencyStatus, "created");
  assert.equal(replay.idempotencyStatus, "replayed");
  assert.equal(expired.idempotencyStatus, "created");
  assert.equal(calls, 2);
});

test("evicts completed responses within the global byte budget", async (t) => {
  let calls = 0;
  const baseUrl = await startFixture(
    t,
    (_req, res) => {
      calls += 1;
      res.json({ id: `response-${calls}`, output: "x".repeat(80) });
    },
    { maxBytes: 150, maxResponseBytes: 150 },
  );
  const firstPayload = { model: "test", input: "first" };
  const secondPayload = { model: "test", input: "second" };

  await postJson(baseUrl, "/v1/responses", "app-a", "first", firstPayload);
  await postJson(baseUrl, "/v1/responses", "app-a", "second", secondPayload);
  const secondReplay = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "second",
    secondPayload,
  );
  const firstAgain = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "first",
    firstPayload,
  );

  assert.equal(secondReplay.idempotencyStatus, "replayed");
  assert.equal(firstAgain.idempotencyStatus, "created");
  assert.equal(calls, 3);
});

test("byte eviction preserves seen-key conflict protection", () => {
  const cache = new InferenceIdempotencyCache({
    ...DEFAULT_OPTIONS,
    maxEntries: 10,
    maxBytes: 80,
    maxResponseBytes: 80,
  });
  const response = (id: string) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id, output: "x".repeat(35) })),
  });

  const seen = cache.claim("seen-key", "hash-a");
  assert.equal(seen.kind, "leader");
  if (seen.kind !== "leader") return;
  cache.fail(seen.entry);

  for (const scope of ["cached-a", "cached-b"]) {
    const claim = cache.claim(scope, scope);
    assert.equal(claim.kind, "leader");
    if (claim.kind === "leader") cache.complete(claim.entry, response(scope));
  }

  assert.equal(cache.claim("seen-key", "different-hash").kind, "conflict");
  assert.equal(cache.claim("cached-b", "cached-b").kind, "replay");
  assert.equal(cache.claim("cached-a", "cached-a").kind, "leader");
});

test("bypasses streaming, tools, multimodal, and unauthenticated applications", async (t) => {
  let calls = 0;
  const baseUrl = await startFixture(t, (_req, res) => {
    calls += 1;
    res.json({ id: `response-${calls}` });
  });
  const requests = [
    { application: "app-a", body: { model: "test", input: "x", stream: true } },
    {
      application: "app-a",
      body: {
        model: "test",
        input: "x",
        tools: [{ type: "function", name: "lookup" }],
      },
    },
    {
      application: "app-a",
      body: {
        model: "test",
        input: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      },
    },
    { application: undefined, body: { model: "test", input: "x" } },
  ];

  for (const [index, request] of requests.entries()) {
    const first = await postJson(
      baseUrl,
      "/v1/responses",
      request.application,
      `key-${index}`,
      request.body,
    );
    const second = await postJson(
      baseUrl,
      "/v1/responses",
      request.application,
      `key-${index}`,
      request.body,
    );
    assert.equal(first.idempotencyStatus, "bypass");
    assert.equal(second.idempotencyStatus, "bypass");
  }
  assert.equal(calls, requests.length * 2);
});

test("does not retain errors or oversized responses", async (t) => {
  let calls = 0;
  const baseUrl = await startFixture(
    t,
    (req, res) => {
      calls += 1;
      if (req.body.input === "error" && calls === 1) {
        return res.status(500).json({ error: { message: "temporary" } });
      }
      res.json({ id: `response-${calls}`, output: "x".repeat(2_000) });
    },
    { maxResponseBytes: 1_024 },
  );

  const errorPayload = { model: "test", input: "error" };
  const failed = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "error-key",
    errorPayload,
  );
  const changedAfterError = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "error-key",
    { model: "test", input: "changed" },
  );
  const retried = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "error-key",
    errorPayload,
  );
  const largePayload = { model: "test", input: "large" };
  const largeFirst = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "large-key",
    largePayload,
  );
  const largeSecond = await postJson(
    baseUrl,
    "/v1/responses",
    "app-a",
    "large-key",
    largePayload,
  );

  assert.equal(failed.status, 500);
  assert.equal(changedAfterError.status, 409);
  assert.equal(retried.idempotencyStatus, "created");
  assert.equal(largeFirst.idempotencyStatus, "created");
  assert.equal(largeSecond.idempotencyStatus, "created");
  assert.equal(calls, 4);
});
