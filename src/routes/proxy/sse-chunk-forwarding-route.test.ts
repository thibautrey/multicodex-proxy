import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createProxyRouter } from "./index.js";
import type { Account } from "../../types.js";

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

test("forwards native Responses chunks while preserving diagnostics", async (t) => {
  const now = Date.now();
  let account: Account = {
    id: "account-one",
    provider: "openai",
    accessToken: "token-one",
    enabled: true,
    expiresAt: now + 60 * 60_000,
    usage: {
      fetchedAt: now,
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 0 },
    },
  };
  const completedTraces: any[] = [];
  const originalFetch = globalThis.fetch;
  const upstreamSSE = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"café"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}',
    "",
    "",
  ].join("\n");
  const upstreamBytes = new TextEncoder().encode(upstreamSSE);

  globalThis.fetch = async (input) => {
    if (String(input).includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({
          models: [{ slug: "gpt-5.6-sol", supported_tool_types: ["function"] }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(upstreamBytes.slice(0, 47));
          controller.enqueue(upstreamBytes.slice(47, 91));
          controller.enqueue(upstreamBytes.slice(91));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = {
    getCachedAccounts: () => [account],
    listAccounts: async () => [account],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    markAccountModified: (_id: string, updated: Account) => {
      account = updated;
    },
    upsertAccount: async (updated: Account) => {
      account = updated;
      return updated;
    },
    patchAccount: async (_id: string, patch: Partial<Account>) => {
      account = { ...account, ...patch };
      return account;
    },
  };
  const traceManager = {
    recordTrace: () => undefined,
    beginTrace: async () => "stream-trace",
    completeTrace: async (_id: string, entry: any) => {
      completedTraces.push(entry);
    },
  };
  const capacityTracker = {
    getVersion: () => 1,
    acquire: (_accountId: string, _model: string) => ({
      accountId: _accountId,
      model: _model,
      startedAt: Date.now(),
      release: () => undefined,
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    createProxyRouter({
      store: store as any,
      traceManager: traceManager as any,
      openaiBaseUrl: "https://chatgpt.example",
      mistralBaseUrl: "https://mistral.example",
      mistralUpstreamPath: "/v1/responses",
      mistralCompactUpstreamPath: "/v1/responses/compact",
      zaiBaseUrl: "https://zai.example",
      zaiUpstreamPath: "/v1/chat/completions",
      zaiCompactUpstreamPath: "/v1/chat/completions",
      oauthConfig: {} as any,
      capacityTracker: capacityTracker as any,
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await postJson(address.port, "/v1/responses", {
    model: "gpt-5.6-sol",
    stream: true,
    input: "hello",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body, `: connected\n\n${upstreamSSE}`);
  assert.equal(completedTraces.length, 1);
  assert.deepEqual(completedTraces[0].usage, {
    input_tokens: 10,
    output_tokens: 1,
    total_tokens: 11,
  });
  assert.equal(
    completedTraces[0].responseStreamDiagnostics.sawResponseCompleted,
    true,
  );
  assert.equal(
    completedTraces[0].responseStreamDiagnostics.outputTextDeltaCount,
    1,
  );
});

test("returns an SSE error when a native Responses stream is interrupted", async (t) => {
  const now = Date.now();
  const account: Account = {
    id: "account-one",
    provider: "openai",
    accessToken: "token-one",
    enabled: true,
    expiresAt: now + 60 * 60_000,
    usage: {
      fetchedAt: now,
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 0 },
    },
  };
  const completedTraces: any[] = [];
  const originalFetch = globalThis.fetch;
  const interruptedSSE = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"partial"}',
    "",
    "",
  ].join("\n");

  globalThis.fetch = async (input) => {
    if (String(input).includes("/backend-api/codex/models")) {
      return new Response(JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(interruptedSSE));
          controller.error(new Error("upstream socket closed"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = {
    getCachedAccounts: () => [account],
    listAccounts: async () => [account],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    upsertAccount: async (updated: Account) => updated,
  };
  const traceManager = {
    recordTrace: () => undefined,
    beginTrace: async () => "stream-trace",
    completeTrace: async (_id: string, entry: any) => {
      completedTraces.push(entry);
      throw new Error("trace persistence failed");
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    createProxyRouter({
      store: store as any,
      traceManager: traceManager as any,
      openaiBaseUrl: "https://chatgpt.example",
      mistralBaseUrl: "https://mistral.example",
      mistralUpstreamPath: "/v1/responses",
      mistralCompactUpstreamPath: "/v1/responses/compact",
      zaiBaseUrl: "https://zai.example",
      zaiUpstreamPath: "/v1/chat/completions",
      zaiCompactUpstreamPath: "/v1/chat/completions",
      oauthConfig: {} as any,
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await postJson(address.port, "/v1/responses", {
    model: "gpt-5.6-sol",
    stream: true,
    input: "hello",
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /event: error\ndata: .*stream_interrupted/);
  assert.equal(completedTraces[0].status, 599);
  assert.equal(completedTraces[0].lifecycleState, "interrupted");
});

test("converts a z.ai chat completion SSE to a completed Responses stream", async (t) => {
  const account: Account = {
    id: "zai-account",
    provider: "zai",
    accessToken: "zai-token",
    enabled: true,
  };
  const completedTraces: any[] = [];
  const originalFetch = globalThis.fetch;
  const upstreamSSE = [
    'data: {"id":"chatcmpl-zai","object":"chat.completion.chunk","created":1,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{"content":"ALIAS_E2E_OK"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-zai","object":"chat.completion.chunk","created":1,"model":"glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");

  globalThis.fetch = async (input) => {
    if (String(input).includes("models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "glm-5.3-flash" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(upstreamSSE);
          controller.enqueue(bytes.slice(0, 97));
          controller.enqueue(bytes.slice(97));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = {
    getCachedAccounts: () => [account],
    listAccounts: async () => [account],
    getCachedModelAliases: () => [
      {
        id: "gpt-5.6-sol",
        enabled: true,
        schemaVersion: 2,
        rules: [
          {
            id: "default",
            candidates: [{ model: "glm-5.3-flash" }],
            onNoCapacity: "reject",
          },
        ],
      },
    ],
    getCachedSettings: () => ({}),
    upsertAccount: async (updated: Account) => updated,
  };
  const traceManager = {
    recordTrace: () => undefined,
    beginTrace: async () => "zai-stream-trace",
    completeTrace: async (_id: string, entry: any) => {
      completedTraces.push(entry);
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    createProxyRouter({
      store: store as any,
      traceManager: traceManager as any,
      openaiBaseUrl: "https://chatgpt.example",
      mistralBaseUrl: "https://mistral.example",
      mistralUpstreamPath: "/v1/responses",
      mistralCompactUpstreamPath: "/v1/responses/compact",
      zaiBaseUrl: "https://zai.example",
      zaiUpstreamPath: "/api/coding/paas/v4/chat/completions",
      zaiCompactUpstreamPath: "/api/coding/paas/v4/chat/completions",
      oauthConfig: {} as any,
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await postJson(address.port, "/v1/responses", {
    model: "gpt-5.6-sol",
    stream: true,
    input: "hello",
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body, /chat\.completion\.chunk/);
  assert.match(response.body, /event: response\.output_text\.delta/);
  assert.match(response.body, /ALIAS_E2E_OK/);
  assert.match(response.body, /event: response\.completed/);
  assert.equal(completedTraces.length, 1);
  assert.equal(completedTraces[0].lifecycleState, "completed");
  assert.equal(completedTraces[0].status, 200);
  assert.deepEqual(completedTraces[0].usage, {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  });
});
