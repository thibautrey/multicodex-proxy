import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { AccountStore } from "./store.js";
import type { Account } from "./types.js";
import type { OAuthConfig } from "./oauth.js";
import type { TraceManager } from "./traces.js";
import {
  createRealtimeRouter,
  realtimeCallUrl,
  type RealtimeProxyOptions,
} from "./realtime-proxy.js";

const oauthConfig: OAuthConfig = {
  clientId: "test-client",
  authorizationUrl: "https://example.test/authorize",
  tokenUrl: "https://example.test/token",
  deviceAuthorizationUrl: "https://example.test/device",
  deviceTokenUrl: "https://example.test/device/token",
  deviceVerificationUrl: "https://example.test/device/verify",
  deviceRedirectUri: "http://localhost/device",
  redirectUri: "http://localhost/callback",
  scope: "openid",
};

async function makeStore(accounts: Account[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-realtime-"));
  const store = new AccountStore(path.join(dir, "accounts.json"));
  await store.init();
  for (const account of accounts) await store.addOrUpdate(account);
  return { store, dir };
}

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function options(
  store: AccountStore,
  overrides: Partial<RealtimeProxyOptions> = {},
): RealtimeProxyOptions {
  return {
    store,
    oauthConfig,
    traceManager: { recordTrace() {} } as unknown as TraceManager,
    chatgptBaseUrl: "https://chatgpt.com",
    provider: "openai",
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

test("realtimeCallUrl preserves the native ChatGPT and public API layouts", () => {
  const chatgpt: Account = {
    id: "chatgpt",
    provider: "openai",
    accessToken: "token",
    enabled: true,
  };
  assert.equal(
    realtimeCallUrl(chatgpt, {
      chatgptBaseUrl: "https://chatgpt.com/",
      provider: "openai",
    }),
    "https://chatgpt.com/backend-api/realtime/calls",
  );
  assert.equal(
    realtimeCallUrl(
      { ...chatgpt, provider: "openai-compatible", baseUrl: "https://api.openai.com/v1/" },
      { chatgptBaseUrl: "https://chatgpt.com", provider: "openai-compatible" },
    ),
    "https://api.openai.com/v1/realtime/calls",
  );
});

test("POST realtime/calls forwards multipart SDP opaquely with account auth", async (t) => {
  const { store, dir } = await makeStore([
    {
      id: "account-1",
      provider: "openai",
      accessToken: "upstream-secret",
      chatgptAccountId: "workspace-1",
      enabled: true,
    },
  ]);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const boundary = "codex-realtime-call-boundary";
  const multipart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sdp"\r\nContent-Type: application/sdp\r\n\r\nv=0\r\n--${boundary}--\r\n`,
  );
  let received: { url?: string; auth?: string; account?: string; body?: Buffer } = {};
  globalThis.fetch = async (input, init) => {
    received = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization") ?? undefined,
      account: new Headers(init?.headers).get("chatgpt-account-id") ?? undefined,
      body: Buffer.from(await new Response(init?.body).arrayBuffer()),
    };
    return new Response("v=0\r\na=answer\r\n", {
      status: 201,
      headers: { "content-type": "application/sdp" },
    });
  };

  const app = express();
  app.use("/v1", createRealtimeRouter(options(store)));
  const server = await listen(app);
  t.after(server.close);

  const response = await originalFetch(`${server.url}/v1/realtime/calls`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: "Bearer local-proxy-key",
    },
    body: multipart,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/sdp");
  assert.equal(await response.text(), "v=0\r\na=answer\r\n");
  assert.equal(received.url, "https://chatgpt.com/backend-api/realtime/calls");
  assert.equal(received.auth, "Bearer upstream-secret");
  assert.equal(received.account, "workspace-1");
  assert.deepEqual(received.body, multipart);
});

test("POST realtime/calls rotates accounts after a quota response", async (t) => {
  const { store, dir } = await makeStore([
    { id: "a", provider: "openai", accessToken: "token-a", enabled: true, priority: 1 },
    { id: "b", provider: "openai", accessToken: "token-b", enabled: true, priority: 2 },
  ]);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const attempted: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get("authorization") ?? "";
    attempted.push(token);
    if (token.endsWith("token-a")) {
      return new Response(JSON.stringify({ error: "quota exceeded" }), {
        status: 429,
      });
    }
    return new Response("answer", {
      status: 200,
      headers: { "content-type": "application/sdp" },
    });
  };
  const app = express();
  app.use(createRealtimeRouter(options(store)));
  const server = await listen(app);
  t.after(server.close);
  const response = await originalFetch(`${server.url}/realtime/calls`, {
    method: "POST",
    headers: { "content-type": "application/sdp" },
    body: "offer",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "answer");
  assert.deepEqual(attempted, ["Bearer token-a", "Bearer token-b"]);
});

test("POST realtime/calls rejects missing and unsupported bodies before upstream", async (t) => {
  const { store, dir } = await makeStore([
    { id: "a", provider: "openai", accessToken: "token-a", enabled: true },
  ]);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = express();
  app.use(createRealtimeRouter(options(store)));
  const server = await listen(app);
  t.after(server.close);

  const missing = await fetch(`${server.url}/realtime/calls`, {
    method: "POST",
    headers: { "content-type": "application/sdp" },
  });
  assert.equal(missing.status, 400);
  const unsupported = await fetch(`${server.url}/realtime/calls`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "offer",
  });
  assert.equal(unsupported.status, 415);
});

test("GET settings/voices forwards the eligibility query to ChatGPT", async (t) => {
  const { store, dir } = await makeStore([
    { id: "a", provider: "openai", accessToken: "token-a", enabled: true },
  ]);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let upstreamUrl = "";
  const traces: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input) => {
    upstreamUrl = String(input);
    return Response.json({ selected: "cove", voices: ["cove"] });
  };
  const app = express();
  app.use(
    "/v1",
    createRealtimeRouter(
      options(store, {
        traceManager: {
          recordTrace(entry: Record<string, unknown>) {
            traces.push(entry);
          },
        } as unknown as TraceManager,
      }),
    ),
  );
  const server = await listen(app);
  t.after(server.close);
  const response = await originalFetch(
    `${server.url}/v1/settings/voices?spoken_language=fr-FR&voice_mode=advanced`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    selected: "cove",
    voices: ["cove"],
  });
  assert.equal(
    upstreamUrl,
    "https://chatgpt.com/backend-api/settings/voices?spoken_language=fr-FR&voice_mode=advanced",
  );
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.status, 200);
  assert.equal(traces[0]?.model, "realtime-voices");
});
