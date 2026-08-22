import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createProxyRouter } from "./index.js";
import type { Account } from "../../types.js";

function postJson(
  port: number,
  body: unknown,
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

test("does not wait for the initial model or usage probes", async (t) => {
  const account: Account = {
    id: "account-without-usage",
    provider: "openai",
    accessToken: "token",
    enabled: true,
  };
  let accounts = [account];
  let releaseModelProbe!: () => void;
  let releaseUsageProbe!: () => void;
  const modelProbe = new Promise<void>((resolve) => {
    releaseModelProbe = resolve;
  });
  const usageProbe = new Promise<void>((resolve) => {
    releaseUsageProbe = resolve;
  });
  let upstreamStarted = false;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      await modelProbe;
      return Response.json({
        models: [{ slug: "gpt-5.3-codex", supported_tool_types: ["function"] }],
      });
    }
    if (url.includes("/backend-api/wham/usage")) {
      await usageProbe;
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: 0 },
          secondary_window: { used_percent: 0 },
        },
      });
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamStarted = true;
      return Response.json({
        id: "response-fast-path",
        object: "response",
        status: "completed",
        model: "gpt-5.3-codex",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    releaseModelProbe();
    releaseUsageProbe();
  });

  const store = {
    getCachedAccounts: () => [...accounts],
    listAccounts: async () => [...accounts],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    markAccountModified: (_id: string, updated: Account) => {
      accounts = [updated];
    },
    upsertAccount: async (updated: Account) => {
      accounts = [updated];
      return updated;
    },
    patchAccount: async (_id: string, patch: Partial<Account>) => {
      accounts = [{ ...accounts[0], ...patch }];
      return accounts[0];
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/v1",
    createProxyRouter({
      store: store as any,
      traceManager: {
        recordTrace: () => undefined,
        beginTrace: async () => "trace",
        completeTrace: async () => undefined,
      } as any,
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

  const response = await postJson(address.port, {
    model: "gpt-5.3-codex",
    input: "hello",
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamStarted, true);

  releaseModelProbe();
  releaseUsageProbe();
});
