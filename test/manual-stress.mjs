import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRuntime } from "../dist/runtime.js";

async function startHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function createBaseFiles() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "multivibe-stress-"));
  const storePath = path.join(tmp, "accounts.json");
  const oauthStatePath = path.join(tmp, "oauth-state.json");
  const traceFilePath = path.join(tmp, "traces.jsonl");
  const traceStatsHistoryPath = path.join(tmp, "traces-history.jsonl");
  await writeJson(storePath, {
    accounts: [
      {
        id: "acct-1",
        provider: "openai",
        accessToken: "acct-1-token",
        enabled: true,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {},
      },
    ],
    modelAliases: [],
  });
  await writeJson(oauthStatePath, { states: [] });
  return { storePath, oauthStatePath, traceFilePath, traceStatsHistoryPath };
}

function oauthConfig(port) {
  return {
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "test-client",
    scope: "openid profile email offline_access",
    redirectUri: `http://127.0.0.1:${port}/auth/callback`,
  };
}

async function startRuntimeFor(upstreamUrl, files, upstreamRequestTimeoutMs, redirectPort) {
  const runtime = await createRuntime({
    host: "127.0.0.1",
    port: 0,
    adminToken: "test-admin",
    installSignalHandlers: false,
    storePath: files.storePath,
    oauthStatePath: files.oauthStatePath,
    traceFilePath: files.traceFilePath,
    traceStatsHistoryPath: files.traceStatsHistoryPath,
    openaiBaseUrl: upstreamUrl,
    upstreamRequestTimeoutMs,
    oauthConfig: oauthConfig(redirectPort),
  });
  await runtime.start();
  const address = runtime.server.address();
  return { runtime, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function runPool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const current = index < items.length ? items[index++] : undefined;
      if (typeof current === "undefined") return;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

function responseCompletedFrame(text) {
  return (
    "event: response.completed\n" +
    "data: " +
    JSON.stringify({
      type: "response.completed",
      response: {
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: text.length,
          total_tokens: 10 + text.length,
        },
      },
    }) +
    "\n\n"
  );
}

const files = await createBaseFiles();

let requestCounter = 0;
const successUpstream = await startHttpServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/backend-api/wham/usage") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 0 },
          secondary_window: { used_percent: 0 },
        },
      }),
    );
    return;
  }
  if (
    req.method === "GET" &&
    req.url &&
    req.url.startsWith("/backend-api/codex/models")
  ) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
    requestCounter += 1;
    const mode = requestCounter % 4;

    if (mode === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      );
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
      );
      res.write(responseCompletedFrame("hello world"));
      setTimeout(() => {
        if (!res.writableEnded) res.end(": linger\n\n");
      }, 120);
      return;
    }

    if (mode === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      );
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
      );
      res.write(
        'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"hello world"}\n\n',
      );
      setTimeout(() => {
        if (!res.writableEnded) res.end(": linger\n\n");
      }, 120);
      return;
    }

    if (mode === 2) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "json path" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      if (i <= 4) {
        res.write(
          "event: response.output_text.delta\ndata: " +
            JSON.stringify({
              type: "response.output_text.delta",
              delta: String(i),
            }) +
            "\n\n",
        );
        return;
      }
      clearInterval(timer);
      res.write(responseCompletedFrame("1234"));
      setTimeout(() => {
        if (!res.writableEnded) res.end(": linger\n\n");
      }, 120);
    }, 4);
    return;
  }
  res.writeHead(404).end();
});

const successRuntime = await startRuntimeFor(successUpstream.url, files, 70, 20001);
const successStats = { total: 0, stream: 0, buffered: 0 };

await runPool(Array.from({ length: 120 }, (_, i) => i), 12, async (i) => {
  const wantStream = i % 2 === 0;
  const startedAt = Date.now();
  const res = await fetch(`${successRuntime.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.4",
      stream: wantStream,
      input: `hello-${i}`,
    }),
  });
  assert.equal(res.status, 200);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 220, `request ${i} took too long: ${elapsedMs}ms`);
  if (wantStream) {
    const body = await res.text();
    assert.ok(
      body.includes("response.completed") ||
        body.includes("response.output_text.done"),
    );
    successStats.stream += 1;
  } else {
    const body = await res.json();
    const text = body?.output?.[0]?.content?.[0]?.text;
    assert.ok(
      text === "hello world" || text === "1234" || text === "json path",
      `unexpected buffered text: ${text}`,
    );
    successStats.buffered += 1;
  }
  successStats.total += 1;
});

await successRuntime.runtime.shutdown();
await successUpstream.close();

const stallUpstream = await startHttpServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/backend-api/wham/usage") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 0 },
          secondary_window: { used_percent: 0 },
        },
      }),
    );
    return;
  }
  if (
    req.method === "GET" &&
    req.url &&
    req.url.startsWith("/backend-api/codex/models")
  ) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    );
    return;
  }
  res.writeHead(404).end();
});

const stallRuntime = await startRuntimeFor(stallUpstream.url, files, 60, 20002);
const timeoutStats = { buffered504: 0, streamingClosed: 0 };

for (let i = 0; i < 10; i++) {
  const res = await fetch(`${stallRuntime.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.4",
      stream: false,
      input: `stall-buffered-${i}`,
    }),
  });
  assert.equal(res.status, 504);
  timeoutStats.buffered504 += 1;
}

for (let i = 0; i < 10; i++) {
  const startedAt = Date.now();
  const res = await fetch(`${stallRuntime.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.4",
      stream: true,
      input: `stall-stream-${i}`,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < 180,
    `streaming stall ${i} took too long: ${elapsedMs}ms`,
  );
  assert.ok(body.includes("response.output_text.delta"));
  timeoutStats.streamingClosed += 1;
}

await stallRuntime.runtime.shutdown();
await stallUpstream.close();

console.log(JSON.stringify({ successStats, timeoutStats }, null, 2));
