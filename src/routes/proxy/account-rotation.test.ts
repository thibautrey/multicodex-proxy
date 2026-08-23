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

test("rotates to the next account when a 429 is returned as SSE without applying the hang deadline to active routing", async (t) => {
  const now = Date.now();
  let fakeNow = now;
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
  const upstreamBodies: string[] = [];
  let modelDiscoveryRequests = 0;
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  Date.now = () => fakeNow;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      modelDiscoveryRequests += 1;
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

    const headers = new Headers(init?.headers);
    const token = headers.get("authorization") ?? "";
    upstreamTokens.push(token);
    upstreamBodies.push(String(init?.body ?? ""));
    if (token === "Bearer token-one") {
      // HANG_RETRY_MAX_DURATION_MS only bounds the sleep/retry cycle used when
      // every account is exhausted. Advancing beyond its default must not stop
      // an in-progress rotation to another available account.
      fakeNow += 120_001;
      return new Response(
        [
          "event: error",
          'data: {"type":"error","error":{"message":"rate limit reached"}}',
          "",
          "",
        ].join("\n"),
        {
          status: 429,
          headers: { "content-type": "text/event-stream" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        id: "resp_rotated",
        object: "response",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "rotated" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  });

  const updateAccount = (account: Account) => {
    const index = accounts.findIndex((candidate) => candidate.id === account.id);
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
    beginTrace: async () => "stream-trace",
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
    stream: false,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).id, "resp_rotated");
  assert.deepEqual(upstreamTokens, [
    "Bearer token-one",
    "Bearer token-two",
  ]);
  assert.equal(upstreamBodies.length, 2);
  assert.equal(upstreamBodies[1], upstreamBodies[0]);
  assert.equal(JSON.parse(upstreamBodies[0]).input[0].content[0].text, "hello");
  assert.equal(modelDiscoveryRequests, accounts.length);
  assert.equal(
    accounts[0].state?.modelBlocks?.["gpt-5.6-sol"]?.reason,
    "quota/rate-limit: 429",
  );
  assert.equal(
    traces.some(
      (trace) => trace.accountId === "account-one" && trace.status === 429,
    ),
    true,
  );
  assert.equal(
    traces.some(
      (trace) => trace.accountId === "account-two" && trace.status === 200,
    ),
    true,
  );
});
