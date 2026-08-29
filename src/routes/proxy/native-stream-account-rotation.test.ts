import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
process.env.HANG_RETRY_MAX_DURATION_MS = "5000";
process.env.HANG_RETRY_INTERVAL_MS = "1000";
const { createProxyRouter } = await import("./index.js");
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

test("rotates native Responses stream to the next account after upstream 429", async (t) => {
  const now = Date.now();
  const accounts: Account[] = [
    {
      id: "account-one",
      provider: "openai",
      accessToken: "token-one",
      enabled: true,
      priority: 1,
      expiresAt: now + 60 * 60_000,
      usage: {
        fetchedAt: now,
        primary: { usedPercent: 0 },
        secondary: { usedPercent: 0 },
      },
    },
    {
      id: "account-two",
      provider: "openai",
      accessToken: "token-two",
      enabled: true,
      priority: 2,
      expiresAt: now + 60 * 60_000,
      usage: {
        fetchedAt: now,
        primary: { usedPercent: 0 },
        secondary: { usedPercent: 0 },
      },
    },
  ];

  const traces: any[] = [];
  const upstreamTokens: string[] = [];
  let begunTraces = 0;
  let modelDiscoveryRequests = 0;

  const upstreamSSE = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"rotated"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}',
    "",
    "",
  ].join("\n");

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.includes("/backend-api/codex/models")) {
      modelDiscoveryRequests += 1;
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-sol",
              supported_tool_types: ["function"],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const headers = new Headers(init?.headers);
    const token = headers.get("authorization") ?? "";
    upstreamTokens.push(token);

    if (token === "Bearer token-one") {
      return new Response(
        JSON.stringify({
          error: {
            message: "The usage limit has been reached",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(upstreamSSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const updateAccount = (account: Account) => {
    const index = accounts.findIndex(
      (candidate) => candidate.id === account.id,
    );
    if (index >= 0) accounts[index] = account;
  };

  const store = {
    getCachedAccounts: () => [...accounts],
    listAccounts: async () => [...accounts],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    markAccountModified: (_id: string, account: Account) =>
      updateAccount(account),
    upsertAccount: async (account: Account) => {
      updateAccount(account);
      return account;
    },
    patchAccount: async (id: string, patch: Partial<Account>) => {
      const account = accounts.find((candidate) => candidate.id === id);
      if (!account) return null;
      const updated = { ...account, ...patch };
      updateAccount(updated);
      return updated;
    },
  };

  const traceManager = {
    recordTrace: (entry: any) => traces.push(entry),
    beginTrace: async () => {
      begunTraces += 1;
      return `stream-trace-${begunTraces}`;
    },
    completeTrace: async (_id: string, entry: any) => traces.push(entry),
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
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );

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
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ],
  });

  assert.equal(response.status, 200);

  assert.deepEqual(upstreamTokens, [
    "Bearer token-one",
    "Bearer token-two",
  ]);

  assert.match(response.body, /^: connected\n\n/);
  assert.match(response.body, /"delta":"rotated"/);
  assert.doesNotMatch(response.body, /usage limit has been reached/i);

  assert.equal(
    accounts[0].state?.modelBlocks?.["gpt-5.6-sol"]?.reason,
    "quota/rate-limit: 429",
  );

  assert.equal(
    traces.some(
      (trace) =>
        trace.accountId === "account-one" &&
        trace.status === 429,
    ),
    true,
  );

  assert.equal(
    traces.some(
      (trace) =>
        trace.accountId === "account-two" &&
        trace.status === 200,
    ),
    true,
  );

  assert.equal(begunTraces, 2);
  assert.equal(modelDiscoveryRequests, accounts.length);
});

test("native Responses stream terminates cleanly when 429 exhausts all accounts", async (t) => {
  const now = Date.now();
  const accounts: Account[] = [
    {
      id: "account-one",
      provider: "openai",
      accessToken: "token-one",
      enabled: true,
      priority: 1,
      expiresAt: now + 60 * 60_000,
      usage: {
        fetchedAt: now,
        primary: { usedPercent: 0 },
        secondary: { usedPercent: 0 },
      },
    },
  ];

  const traces: any[] = [];
  const upstreamTokens: string[] = [];
  let begunTraces = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-sol",
              supported_tool_types: ["function"],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const headers = new Headers(init?.headers);
    upstreamTokens.push(headers.get("authorization") ?? "");

    return new Response(
      JSON.stringify({
        error: {
          message: "The usage limit has been reached",
        },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json" },
      },
    );
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const updateAccount = (account: Account) => {
    const index = accounts.findIndex(
      (candidate) => candidate.id === account.id,
    );
    if (index >= 0) accounts[index] = account;
  };

  const store = {
    getCachedAccounts: () => [...accounts],
    listAccounts: async () => [...accounts],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    markAccountModified: (_id: string, account: Account) =>
      updateAccount(account),
    upsertAccount: async (account: Account) => {
      updateAccount(account);
      return account;
    },
    patchAccount: async (id: string, patch: Partial<Account>) => {
      const account = accounts.find((candidate) => candidate.id === id);
      if (!account) return null;
      const updated = { ...account, ...patch };
      updateAccount(updated);
      return updated;
    },
  };

  const traceManager = {
    recordTrace: (entry: any) => traces.push(entry),
    beginTrace: async () => {
      begunTraces += 1;
      return `stream-trace-${begunTraces}`;
    },
    completeTrace: async (_id: string, entry: any) => traces.push(entry),
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
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );

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
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ],
  });

  // Native streaming already committed HTTP 200 before the upstream 429.
  assert.equal(response.status, 200);

  assert.deepEqual(upstreamTokens, ["Bearer token-one"]);

  assert.match(response.body, /^: connected\n\n/);
  assert.match(response.body, /event: error/);
  assert.match(response.body, /all accounts exhausted or unavailable/i);

  assert.equal(
    accounts[0].state?.modelBlocks?.["gpt-5.6-sol"]?.reason,
    "quota/rate-limit: 429",
  );

  assert.equal(
    traces.some(
      (trace) =>
        trace.accountId === "account-one" &&
        trace.status === 429,
    ),
    true,
  );

  assert.equal(
    traces.some(
      (trace) =>
        !trace.accountId &&
        trace.status === 429 &&
        /all accounts exhausted or unavailable/i.test(trace.error ?? ""),
    ),
    true,
  );

  // One trace for the failed account attempt and a fresh trace for the
  // terminal "all accounts exhausted" result.
  assert.equal(begunTraces, 2);
});
