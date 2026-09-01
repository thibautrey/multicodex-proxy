import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import {
  createInferenceIdempotencyMiddleware,
  hashInferencePayload,
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
) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
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
  const baseUrl = await startFixture(t, async (_req, res) => {
    calls += 1;
    started();
    await gate;
    res.setHeader("X-MultiVibe-Decision", "cloud");
    res.json({ id: "response-one", object: "response", status: "completed" });
  });
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
  await new Promise((resolve) => setTimeout(resolve, 10));
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
