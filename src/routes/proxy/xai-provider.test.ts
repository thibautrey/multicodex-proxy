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
          "x-session-id": "conversation-123",
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

test("routes Responses requests through the Grok Build subscription contract", async (t) => {
  const now = Date.now();
  const account: Account = {
    id: "xai-account",
    provider: "xai",
    upstreamMode: "responses",
    accessToken: "xai-session-token",
    refreshToken: "xai-refresh-token",
    expiresAt: now + 60 * 60_000,
    enabled: true,
    usage: { fetchedAt: now },
  };
  const requests: Array<{
    url: string;
    headers: Headers;
    body: string;
  }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/models")) {
      assert.equal(headers.get("authorization"), "Bearer xai-session-token");
      assert.equal(headers.get("x-xai-token-auth"), "xai-grok-cli");
      return new Response(
        JSON.stringify({ data: [{ id: "grok-code-fast-1" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    requests.push({
      url,
      headers,
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({
        id: "resp_grok",
        object: "response",
        status: "completed",
        model: "grok-code-fast-1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "from grok" }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
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
    markAccountModified: () => undefined,
    upsertAccount: async (next: Account) => next,
    patchAccount: async () => account,
  };
  const traceManager = {
    recordTrace: () => undefined,
    beginTrace: async () => "stream-trace",
    completeTrace: async () => undefined,
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
    model: "grok-code-fast-1",
    input: "hello",
    stream: false,
  });

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).id, "resp_grok");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://cli-chat-proxy.grok.com/v1/responses",
  );
  assert.equal(
    requests[0].headers.get("authorization"),
    "Bearer xai-session-token",
  );
  assert.equal(
    requests[0].headers.get("x-xai-token-auth"),
    "xai-grok-cli",
  );
  assert.equal(
    requests[0].headers.get("x-grok-model-override"),
    "grok-code-fast-1",
  );
  assert.equal(
    requests[0].headers.get("x-grok-conv-id"),
    "conversation-123",
  );
  assert.equal(JSON.parse(requests[0].body).model, "grok-code-fast-1");
});
