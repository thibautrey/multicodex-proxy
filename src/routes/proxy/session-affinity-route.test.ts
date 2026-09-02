import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { SessionAffinityCache } from "../../session-affinity.js";
import type { Account } from "../../types.js";
import { createProxyRouter } from "./index.js";

const MODEL = "gpt-5.6-sol";

function account(id: string, primaryUsedPercent = 0): Account {
  return {
    id,
    provider: "openai",
    accessToken: `token-${id}`,
    enabled: true,
    expiresAt: Date.now() + 60 * 60_000,
    usage: {
      fetchedAt: Date.now(),
      primary: { usedPercent: primaryUsedPercent },
      secondary: { usedPercent: 0 },
    },
  };
}

function postJson(
  port: number,
  headers: Record<string, string>,
  body: Record<string, unknown> = { model: MODEL, input: "hello" },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/responses",
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function responseBody() {
  return {
    id: "response-affinity",
    object: "response",
    status: "completed",
    model: MODEL,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  };
}

function createStore(accounts: Account[]) {
  return {
    getCachedAccounts: () => [...accounts],
    listAccounts: async () => [...accounts],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    markAccountModified: (_id: string, updated: Account) => {
      const index = accounts.findIndex((candidate) => candidate.id === updated.id);
      if (index >= 0) accounts[index] = updated;
    },
    upsertAccount: async (updated: Account) => {
      const index = accounts.findIndex((candidate) => candidate.id === updated.id);
      if (index >= 0) accounts[index] = updated;
      return updated;
    },
    patchAccount: async (id: string, patch: Partial<Account>) => {
      const index = accounts.findIndex((candidate) => candidate.id === id);
      if (index < 0) return null;
      accounts[index] = { ...accounts[index], ...patch };
      return accounts[index];
    },
  };
}

function createTraceManager() {
  const traces: any[] = [];
  return {
    traces,
    recordTrace: (entry: any) => traces.push(entry),
    beginTrace: async () => "trace",
    completeTrace: async () => undefined,
  };
}

async function startTestServer(
  store: ReturnType<typeof createStore>,
  sessionAffinityCache = new SessionAffinityCache(),
  policyMiddleware?: express.RequestHandler,
) {
  const app = express();
  app.use(express.json());
  if (policyMiddleware) app.use(policyMiddleware);
  app.use(
    (req, res, next) => {
      res.locals.proxyApplication = req.header("x-test-application") ?? "default";
      next();
    },
  );
  const traceManager = createTraceManager();
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
      sessionAffinityCache,
      sessionAffinityEnabled: true,
    }),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port, traceManager };
}

test("routes repeated requests from one Codex session to the same account", async (t) => {
  const accounts = [account("account-one"), account("account-two")];
  const upstreamTokens: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({ models: [{ slug: MODEL }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server, port } = await startTestServer(createStore(accounts));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const headers = { "thread-id": "thread-affinity" };
  const first = await postJson(port, headers);
  const second = await postJson(port, headers);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(upstreamTokens.length, 2);
  assert.equal(upstreamTokens[1], upstreamTokens[0]);
});

test("keeps the same session affinity isolated by application", async (t) => {
  const accounts = [account("account-one"), account("account-two")];
  const cache = new SessionAffinityCache();
  cache.remember("application-one", "thread-affinity", "openai", accounts[0].id);
  cache.remember("application-two", "thread-affinity", "openai", accounts[1].id);
  const upstreamTokens: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({ models: [{ slug: MODEL }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server, port } = await startTestServer(createStore(accounts), cache);
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const first = await postJson(port, {
    "thread-id": "thread-affinity",
    "x-test-application": "application-one",
  });
  const second = await postJson(port, {
    "thread-id": "thread-affinity",
    "x-test-application": "application-two",
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(upstreamTokens, [
    "Bearer token-account-one",
    "Bearer token-account-two",
  ]);
});

test("uses the Codex thread id as a prompt cache key fallback", async (t) => {
  const accounts = [account("account-one")];
  const upstreamBodies: any[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({ models: [{ slug: MODEL }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server, port } = await startTestServer(createStore(accounts));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const fallback = await postJson(port, { "thread-id": "thread-cache" });
  const exact = await postJson(port, {
    "thread-id": "thread-fallback",
    "session-id": "session-exact",
  });
  const explicit = await postJson(
    port,
    { "thread-id": "thread-fallback" },
    { model: MODEL, input: "hello", prompt_cache_key: "client-key" },
  );
  const withoutSession = await postJson(port, {});

  assert.equal(fallback.status, 200);
  assert.equal(exact.status, 200);
  assert.equal(explicit.status, 200);
  assert.equal(withoutSession.status, 200);
  assert.equal(upstreamBodies.length, 4);
  assert.equal(upstreamBodies[0].prompt_cache_key, "thread-cache");
  assert.equal(upstreamBodies[1].prompt_cache_key, "session-exact");
  assert.equal(upstreamBodies[2].prompt_cache_key, "client-key");
  assert.equal(
    Object.prototype.hasOwnProperty.call(upstreamBodies[3], "prompt_cache_key"),
    false,
  );
});

test("applies quota filtering to a smart-routing fallback after affinity invalidation", async (t) => {
  // Reuse the account ids from the preceding integration test so the shared
  // model-availability snapshot remains valid when the model cache is warm.
  const nearLimit = account("account-one", 100);
  const available = account("account-two", 10);
  const cache = new SessionAffinityCache();
  cache.remember("application-one", "thread-affinity", "openai", nearLimit.id);
  cache.remember("application-two", "thread-affinity", "openai", available.id);
  const upstreamTokens: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({ models: [{ slug: MODEL }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify(responseBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const policyMiddleware: express.RequestHandler = (_req, res, next) => {
    res.locals.multivibePolicyDecision = {
      eligible: [
        {
          config: { model: MODEL },
          resource: { accountId: nearLimit.id, provider: "openai" },
        },
        {
          config: { model: MODEL },
          resource: { accountId: available.id, provider: "openai" },
        },
      ],
    };
    next();
  };
  const { server, port, traceManager } = await startTestServer(
    createStore([nearLimit, available]),
    cache,
    policyMiddleware,
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  const first = await postJson(port, {
    "thread-id": "thread-affinity",
    "x-test-application": "application-one",
  });
  const second = await postJson(port, {
    "thread-id": "thread-affinity",
    "x-test-application": "application-two",
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(upstreamTokens, [
    "Bearer token-account-two",
    "Bearer token-account-two",
  ]);
  const rotatedTrace = traceManager.traces.find(
    (trace: any) => trace.accountId === "account-two" && trace.status === 200,
  );
  assert.equal(rotatedTrace?.accountSelection?.rotated, true);
});
