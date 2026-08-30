import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createProxyRouter, waitForHangRetry } from "./index.js";
import type { Account } from "../../types.js";

test("ends the global hang retry cleanly when the client aborts", async () => {
  const controller = new AbortController();
  const waiting = waitForHangRetry(60_000, controller.signal);
  controller.abort();
  assert.equal(await waiting, false);
});

test("aborts an upstream request when the client disconnects before headers", async (t) => {
  const account: Account = {
    id: "account-disconnect",
    provider: "openai",
    accessToken: "token-disconnect",
    enabled: true,
    expiresAt: Date.now() + 60 * 60_000,
    usage: {
      fetchedAt: Date.now(),
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 0 },
    },
  };
  let upstreamAttempts = 0;
  let upstreamAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    upstreamAborted = resolve;
  });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return Response.json({
        models: [{ slug: "gpt-5.3-codex", supported_tool_types: ["function"] }],
      });
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamAttempts += 1;
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          upstreamAborted();
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted();
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${url}`);
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
    upsertAccount: async (updated: Account) => updated,
    patchAccount: async () => account,
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

  const payload = JSON.stringify({
    model: "gpt-5.3-codex",
    stream: false,
    input: "disconnect me",
  });
  const clientRequest = http.request({
    hostname: "127.0.0.1",
    port: address.port,
    path: "/v1/responses",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  });
  clientRequest.on("error", () => undefined);
  clientRequest.end(payload);

  for (let i = 0; i < 100 && upstreamAttempts === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(upstreamAttempts, 1);
  clientRequest.destroy();
  await Promise.race([
    aborted,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("upstream request was not aborted")), 1_000),
    ),
  ]);
  assert.equal(upstreamAttempts, 1);
});

test("does not leak a rejected stream cancellation when the client disconnects", async (t) => {
  const account: Account = {
    id: "account-stream-disconnect",
    provider: "openai",
    accessToken: "token-stream-disconnect",
    enabled: true,
    expiresAt: Date.now() + 60 * 60_000,
    usage: {
      fetchedAt: Date.now(),
      primary: { usedPercent: 0 },
      secondary: { usedPercent: 0 },
    },
  };
  let upstreamStarted = false;
  let upstreamAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    upstreamAborted = resolve;
  });
  const originalFetch = globalThis.fetch;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/backend-api/codex/models")) {
      return Response.json({
        models: [{ slug: "gpt-5.3-codex", supported_tool_types: ["function"] }],
      });
    }
    if (url.includes("/backend-api/codex/responses")) {
      upstreamStarted = true;
      init?.signal?.addEventListener("abort", upstreamAborted, { once: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            return Promise.reject(
              new DOMException("stream cancellation failed", "AbortError"),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    globalThis.fetch = originalFetch;
  });

  const store = {
    getCachedAccounts: () => [account],
    listAccounts: async () => [account],
    getCachedModelAliases: () => [],
    getCachedSettings: () => ({}),
    markAccountModified: () => undefined,
    upsertAccount: async (updated: Account) => updated,
    patchAccount: async () => account,
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

  const payload = JSON.stringify({
    model: "gpt-5.3-codex",
    stream: true,
    input: "disconnect me after headers",
  });
  const clientRequest = http.request({
    hostname: "127.0.0.1",
    port: address.port,
    path: "/v1/responses",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  });
  clientRequest.on("error", () => undefined);
  clientRequest.end(payload);

  for (let i = 0; i < 100 && !upstreamStarted; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(upstreamStarted, true);
  clientRequest.destroy();
  await Promise.race([
    aborted,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("upstream request was not aborted")), 1_000),
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unhandledRejections, []);
});
