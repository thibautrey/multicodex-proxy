import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createProxyRouter } from "./index.js";

test("runs response modules for buffered native Responses streams", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "<SECRET>" }] }] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const account = { id: "a", provider: "openai-compatible", upstreamMode: "responses", baseUrl: "http://upstream", accessToken: "token", enabled: true };
  const store: any = {
    listAccounts: async () => [account], getCachedAccounts: () => [account], listModelAliases: async () => [],
    getCachedModelAliases: () => [], getCachedSettings: () => ({}), getRevision: () => 1,
    upsertAccount: async () => account, flushIfDirty: async () => undefined,
  };
  const traceManager: any = { recordTrace: () => undefined, beginTrace: async () => "t", completeTrace: async () => undefined };
  const hooks: string[] = [];
  const moduleManager: any = { runHook: async (hook: string, value: any) => { hooks.push(hook); return { value: hook === "response.beforeClient" ? JSON.parse(JSON.stringify(value).replaceAll("<SECRET>", "restored")) : value }; } };
  const app = express(); app.use(express.json()); app.use("/v1", createProxyRouter({ store, traceManager, moduleManager, openaiBaseUrl: "http://unused", mistralBaseUrl: "http://unused", mistralUpstreamPath: "/v1/responses", mistralCompactUpstreamPath: "/v1/responses/compact", zaiBaseUrl: "http://unused", zaiUpstreamPath: "/v1/chat/completions", zaiCompactUpstreamPath: "/v1/chat/completions", oauthConfig: {} as any }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const body = await new Promise<string>((resolve, reject) => { const req = http.request({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers: { "content-type": "application/json" } }, (res) => { let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve(text)); }); req.on("error", reject); req.end(JSON.stringify({ model: "test-model", stream: false, input: "x" })); });
  assert.match(body, /restored/);
  assert.ok(hooks.includes("response.beforeClient"));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
});
