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
