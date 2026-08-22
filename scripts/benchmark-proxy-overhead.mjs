#!/usr/bin/env node

import http from "node:http";
import { performance } from "node:perf_hooks";
import express from "express";
import { createProxyRouter } from "../src/routes/proxy/index.ts";

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return Math.floor(value);
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * quantile)] ?? 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to determine benchmark port"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}

function postJson(port, payload, agent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/responses",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

const samples = numberArgument("samples", 100);
const inputItems = numberArgument("items", 1);
const input = inputItems === 1
  ? "hello"
  : Array.from({ length: inputItems }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: [{
        type: index % 2 ? "output_text" : "input_text",
        text: `benchmark item ${index}`,
      }],
    }));
const requestBody = {
  model: "gpt-5.3-codex",
  input,
};
const responseBody = {
  id: "benchmark-response",
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
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (inputUrl) => {
  const url = String(inputUrl);
  if (url.includes("/backend-api/codex/models")) {
    return Response.json({
      models: [{ slug: "gpt-5.3-codex", supported_tool_types: ["function"] }],
    });
  }
  return Response.json(responseBody);
};

const account = {
  id: "benchmark-account",
  provider: "openai",
  accessToken: "benchmark-token",
  enabled: true,
  usage: {
    fetchedAt: Date.now(),
    primary: { usedPercent: 0 },
    secondary: { usedPercent: 0 },
  },
};
const store = {
  getCachedAccounts: () => [account],
  listAccounts: async () => [account],
  getCachedModelAliases: () => [],
  getCachedSettings: () => ({}),
  markAccountModified: () => undefined,
  upsertAccount: async (value) => value,
  patchAccount: async (_id, patch) => ({ ...account, ...patch }),
};
const preparationSamples = [];
const traceManager = {
  recordTrace(entry) {
    const preparationMs = entry.latencyBreakdown?.preparationMs;
    if (typeof preparationMs === "number") preparationSamples.push(preparationMs);
  },
  beginTrace: async () => "benchmark-trace",
  completeTrace: async () => undefined,
};

const proxyApp = express();
proxyApp.use(express.json({ limit: "100mb" }));
proxyApp.use(
  "/v1",
  createProxyRouter({
    store,
    traceManager,
    openaiBaseUrl: "https://chatgpt.example",
    mistralBaseUrl: "https://mistral.example",
    mistralUpstreamPath: "/v1/responses",
    mistralCompactUpstreamPath: "/v1/responses/compact",
    zaiBaseUrl: "https://zai.example",
    zaiUpstreamPath: "/v1/chat/completions",
    zaiCompactUpstreamPath: "/v1/chat/completions",
    oauthConfig: {},
  }),
);
const directApp = express();
directApp.use(express.json({ limit: "100mb" }));
directApp.post("/v1/responses", (_req, res) => res.json(responseBody));

const proxyServer = await listen(proxyApp);
const directServer = await listen(directApp);
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

try {
  for (let index = 0; index < 20; index += 1) {
    await postJson(proxyServer.port, requestBody, agent);
    await postJson(directServer.port, requestBody, agent);
  }

  const proxySamples = [];
  const directSamples = [];
  for (let index = 0; index < samples; index += 1) {
    const order = index % 2 === 0 ? ["proxy", "direct"] : ["direct", "proxy"];
    for (const name of order) {
      const startedAt = performance.now();
      const port = name === "proxy" ? proxyServer.port : directServer.port;
      const status = await postJson(port, requestBody, agent);
      const elapsedMs = performance.now() - startedAt;
      if (status !== 200) throw new Error(`${name} returned ${status}`);
      (name === "proxy" ? proxySamples : directSamples).push(elapsedMs);
    }
  }

  const proxyMedianMs = median(proxySamples);
  const directMedianMs = median(directSamples);
  const proxyP95Ms = percentile(proxySamples, 0.95);
  const directP95Ms = percentile(directSamples, 0.95);
  const preparationMedianMs = median(preparationSamples);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmark: "local_proxy_round_trip_overhead",
    samples,
    inputItems,
    proxyRoundTripMs: {
      median: proxyMedianMs,
      p95: proxyP95Ms,
    },
    directRoundTripMs: {
      median: directMedianMs,
      p95: directP95Ms,
    },
    estimatedAddedOverheadMs: {
      median: proxyMedianMs - directMedianMs,
      p95: proxyP95Ms - directP95Ms,
    },
    proxyPreparationBeforeFetchMs: {
      median: preparationMedianMs,
      p95: percentile(preparationSamples, 0.95),
    },
    note:
      "Local HTTP benchmark with an in-process upstream fetch stub. It measures proxy work plus one local HTTP hop; it excludes provider, TLS, network, and model latency.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  agent.destroy();
  await Promise.all([proxyServer.close(), directServer.close()]);
  globalThis.fetch = originalFetch;
}
