import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import type { Account } from "../../types.js";

const { createProxyRouter } = await import("./index.js");
const { nativeRawProtocolBytesConversionAvailable } = await import(
  "../../responses/payload-inspection.js",
);

function postJson(
  port: number,
  body: unknown,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/responses",
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
            contentType: response.headers["content-type"] ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

test("sends the native raw Chat Completions JSON buffer directly", async (t) => {
  if (!nativeRawProtocolBytesConversionAvailable) {
    t.skip("native proxy-core addon is not built");
    return;
  }

  const now = Date.now();
  const account: Account = {
    id: "native-raw-account",
    provider: "openai",
    accessToken: "native-raw-token",
    enabled: true,
    priority: 1,
    expiresAt: now + 60 * 60_000,
    usage: {
      fetchedAt: now,
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 0 },
    },
  };
  const traces: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return new Response(
        JSON.stringify({
          models: [{ slug: "gpt-raw-native", supported_tool_types: ["function"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        object: "chat.completion",
        created: 1710000300,
        model: "gpt-raw-native",
        choices: [{
          message: { role: "assistant", content: "native bytes" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
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
    upsertAccount: async (value: Account) => value,
    patchAccount: async () => account,
  };
  const traceManager = {
    recordTrace: (entry: any) => traces.push(entry),
    beginTrace: async () => "native-raw-trace",
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

  const jsonResponse = await postJson(address.port, {
    model: "gpt-raw-native",
    stream: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  });
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.contentType, /^application\/json/u);
  assert.equal(JSON.parse(jsonResponse.body).output[0].content[0].text, "native bytes");

  const completedTraces = traces.filter((trace) => trace.status === 200);
  assert.equal(completedTraces.length, 1);
  assert.ok(completedTraces.every((trace) => trace.assistantEmptyOutput === false));
  assert.ok(completedTraces.every((trace) => trace.usage?.total_tokens === 9));
});
