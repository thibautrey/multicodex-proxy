import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createTempDir, startHttpServer, startRuntime, writeJson } from "./helpers.js";
import { resetDiscoveredModelsCacheForTest } from "../dist/routes/proxy/index.js";

function responseObject(text = "OK") {
  return {
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
      output_tokens: 5,
      total_tokens: 15,
    },
  };
}

test("proxy fails over on model incompatibility and records capability state", async () => {
  const seenAccounts = [];
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      const auth = req.headers.authorization ?? "";
      seenAccounts.push(auth);
      if (auth === "Bearer acct-1-token") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            detail:
              "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseObject("OK")));
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
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
        priority: 0,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {},
      },
      {
        id: "acct-2",
        provider: "openai",
        accessToken: "acct-2-token",
        enabled: true,
        priority: 0,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {},
      },
    ],
    modelAliases: [],
  });
  await writeJson(oauthStatePath, { states: [] });

  const runtime = await startRuntime({
    storePath,
    oauthStatePath,
    traceFilePath,
    traceStatsHistoryPath,
    openaiBaseUrl: upstream.url,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "response");
    assert.equal(seenAccounts.length, 2);
    assert.deepEqual(seenAccounts, [
      "Bearer acct-1-token",
      "Bearer acct-2-token",
    ]);

    await runtime.runtime.store.flushIfDirty();
    const store = JSON.parse(await readFile(storePath, "utf8"));
    const account1 = store.accounts.find((account) => account.id === "acct-1");
    assert.equal(account1.state.blockedUntil, undefined);
    assert.equal(account1.state.blockedReason, undefined);
    assert.match(account1.state.lastError, /model unsupported/i);
    assert.equal(
      account1.state.modelAvailability["gpt-5.4"].supported,
      false,
    );
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("unsupported model responses do not globally block accounts and return upstream 400", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          detail:
            "The 'None' model is not supported when using Codex with a ChatGPT account.",
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  const storePath = path.join(tmp, "accounts.json");
  const oauthStatePath = path.join(tmp, "oauth-state.json");
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
      {
        id: "acct-2",
        provider: "openai",
        accessToken: "acct-2-token",
        enabled: true,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {},
      },
    ],
    modelAliases: [],
  });
  await writeJson(oauthStatePath, { states: [] });

  const runtime = await startRuntime({
    storePath,
    oauthStatePath,
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.detail, /None/);

    await runtime.runtime.store.flushIfDirty();
    const store = JSON.parse(await readFile(storePath, "utf8"));
    for (const account of store.accounts) {
      assert.equal(account.state.blockedUntil, undefined);
      assert.equal(account.state.blockedReason, undefined);
      assert.match(account.state.lastError, /model unsupported/i);
    }
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy request routing does not block on cold model discovery", async () => {
  resetDiscoveredModelsCacheForTest();
  let modelCalls = 0;
  let responseCalls = 0;

  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      modelCalls += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      }, 150);
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      responseCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseObject("OK")));
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(responseCalls, 1);
    assert.equal(modelCalls, 0);
    assert.ok(Date.now() - startedAt < 150);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("stale usage refresh does not block proxy responses", async () => {
  let usageCalls = 0;
  let usageCompleted = false;
  let responseCalls = 0;

  const upstream = await startHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/backend-api/wham/usage") {
      usageCalls += 1;
      setTimeout(() => {
        usageCompleted = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 0 },
              secondary_window: { used_percent: 0 },
            },
          }),
        );
      }, 150);
      return;
    }
    if (
      req.method === "GET" &&
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      responseCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseObject("OK")));
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
    accounts: [
      {
        id: "acct-1",
        provider: "openai",
        accessToken: "acct-1-token",
        enabled: true,
        usage: { fetchedAt: 0, primary: { usedPercent: 0 } },
        state: {},
      },
    ],
    modelAliases: [],
  });
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(responseCalls, 1);
    assert.equal(usageCalls, 1);
    assert.equal(usageCompleted, false);
    assert.ok(Date.now() - startedAt < 150);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(usageCompleted, true);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy does not blindly retry generic upstream 500s for POST responses", async () => {
  let responseCalls = 0;
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      responseCalls += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 500);
    assert.equal(responseCalls, 1);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("successful proxy responses clear stale auth failure state", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseObject("OK")));
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  const storePath = path.join(tmp, "accounts.json");
  await writeJson(storePath, {
    accounts: [
      {
        id: "acct-1",
        provider: "openai",
        accessToken: "acct-1-token",
        enabled: true,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {
          blockedUntil: Date.now() + 60_000,
          blockedReason: "auth failure: 401",
          needsTokenRefresh: true,
          refreshFailureCount: 3,
          refreshBlockedUntil: Date.now() + 60_000,
          lastError: "refresh token failed: token endpoint failed 401",
          recentErrors: [
            { at: Date.now(), message: "usage probe failed 401" },
            { at: Date.now() - 1_000, message: "auth failure: 401" },
            { at: Date.now() - 2_000, message: "quota/rate-limit: 429" },
          ],
        },
      },
    ],
    modelAliases: [],
  });
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath,
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
  });

  try {
    await runtime.runtime.store.upsertAccount({
      ...(await runtime.runtime.store.listAccounts())[0],
      state: {
        blockedUntil: undefined,
        blockedReason: undefined,
        needsTokenRefresh: true,
        refreshFailureCount: 3,
        refreshBlockedUntil: Date.now() + 60_000,
        lastError: "refresh token failed: token endpoint failed 401",
        recentErrors: [
          { at: Date.now(), message: "usage probe failed 401" },
          { at: Date.now() - 1_000, message: "auth failure: 401" },
          { at: Date.now() - 2_000, message: "quota/rate-limit: 429" },
        ],
      },
    });

    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });

    assert.equal(res.status, 200);

    await runtime.runtime.store.flushIfDirty();
    const store = JSON.parse(await readFile(storePath, "utf8"));
    const account = store.accounts.find((entry) => entry.id === "acct-1");
    assert.equal(account.state.needsTokenRefresh, false);
    assert.equal(account.state.refreshFailureCount, 0);
    assert.equal(account.state.refreshBlockedUntil, undefined);
    assert.equal(account.state.lastError, undefined);
    assert.equal(account.state.blockedUntil, undefined);
    assert.equal(account.state.blockedReason, undefined);
    assert.deepEqual(account.state.recentErrors, [
      {
        at: account.state.recentErrors[0].at,
        message: "quota/rate-limit: 429",
      },
    ]);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy keeps a response alive while upstream chunks continue arriving", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (sent <= 3) {
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: `part-${sent}`,
            })}\n\n`,
          );
          return;
        }
        clearInterval(timer);
        res.end(
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: responseObject("slow but valid"),
          })}\n\n`,
        );
      }, 10);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 80,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.output[0].content[0].text, "slow but valid");
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy returns 504 immediately on upstream timeout instead of retrying another account", async () => {
  const seenAccounts = [];
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      seenAccounts.push(req.headers.authorization ?? "");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseObject("too late")));
      }, 80);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
    accounts: [
      {
        id: "acct-1",
        provider: "openai",
        accessToken: "acct-1-token",
        enabled: true,
        priority: 0,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {},
      },
      {
        id: "acct-2",
        provider: "openai",
        accessToken: "acct-2-token",
        enabled: true,
        priority: 1,
        usage: { fetchedAt: Date.now(), primary: { usedPercent: 0 } },
        state: {},
      },
    ],
    modelAliases: [],
  });
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 504);
    assert.equal(seenAccounts.length, 1);
    assert.equal(seenAccounts[0], "Bearer acct-1-token");
    assert.deepEqual(await res.json(), { error: "upstream request timed out" });
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy returns 504 when an upstream response stalls after headers", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
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
      setTimeout(() => {
        if (!res.writableEnded) res.end();
      }, 200);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });

    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: "upstream request timed out" });
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("downstream client disconnects stay in traces without poisoning account errors", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseObject("too late")));
      }, 80);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  const storePath = path.join(tmp, "accounts.json");
  const oauthStatePath = path.join(tmp, "oauth-state.json");
  const traceFilePath = path.join(tmp, "traces.jsonl");
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

  const runtime = await startRuntime({
    storePath,
    oauthStatePath,
    traceFilePath,
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
  });

  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        `${runtime.baseUrl}/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          res.resume();
        },
      );
      req.on("error", (err) => {
        if (err.code === "ECONNRESET" || err.message === "socket hang up") {
          resolve();
          return;
        }
        reject(err);
      });
      req.write(
        JSON.stringify({
          model: "gpt-5.4",
          stream: false,
          input: "reply with ok",
        }),
      );
      req.end();
      setTimeout(() => req.destroy(), 10);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    await runtime.runtime.store.flushIfDirty();

    const store = JSON.parse(await readFile(storePath, "utf8"));
    const account = store.accounts.find((entry) => entry.id === "acct-1");
    assert.equal(account.state?.lastError, undefined);
    assert.equal(account.state?.recentErrors, undefined);

    const traces = (await readFile(traceFilePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const trace = traces.at(-1);
    assert.equal(trace.status, 499);
    assert.equal(trace.isError, false);
    assert.equal(trace.error, "downstream client disconnected");
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy closes a stalled streamed response without crashing after headers are sent", async () => {
  let calls = 0;
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseObject("recovered")));
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const firstStartedAt = Date.now();
    const first = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: "reply with ok",
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const firstElapsed = Date.now() - firstStartedAt;
    assert.ok(firstElapsed < 180, `expected stall close promptly, got ${firstElapsed}ms`);
    assert.match(firstBody, /response\.output_text\.delta/);

    const second = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.output[0].content[0].text, "recovered");
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy closes streamed responses once response.completed arrives", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
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
      res.write(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: responseObject("done"),
        })}\n\n`,
      );
      setTimeout(() => {
        if (!res.writableEnded) res.end(": upstream lingered\n\n");
      }, 200);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: "reply with ok",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    const elapsedMs = Date.now() - startedAt;
    assert.match(body, /response\.completed/);
    assert.ok(elapsedMs < 180, `expected proxy to close promptly, got ${elapsedMs}ms`);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy preserves control frames for native streamed responses", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_123", object: "response", status: "in_progress" },
        })}\n\n`,
      );
      res.write(
        `event: response.in_progress\ndata: ${JSON.stringify({
          type: "response.in_progress",
          response: { id: "resp_123", object: "response", status: "in_progress" },
        })}\n\n`,
      );
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      );
      res.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: responseObject("done"),
        })}\n\n`,
      );
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: "reply with ok",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /response\.created/);
    assert.match(body, /response\.in_progress/);
    assert.match(body, /response\.output_text\.delta/);
    assert.match(body, /response\.completed/);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy detects native streamed responses even when upstream omits content-type", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      res.writeHead(200);
      res.flushHeaders();
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123","object":"response","status":"in_progress"}}\n\n',
      );
      setTimeout(() => {
        res.end(
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: responseObject("done"),
          })}\n\n`,
        );
      }, 400);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 500,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: "reply with ok",
      }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstChunk = new TextDecoder().decode(first.value, { stream: true });
    assert.match(firstChunk, /response\.created/);
    assert.ok(Date.now() - startedAt < 250);
    await reader.cancel();
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy forwards partial native response chunks before a full SSE frame is complete", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
    ) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/backend-api/codex/responses") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const createdFrame =
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_123",
            object: "response",
            status: "in_progress",
            metadata: { pad: "x".repeat(4096) },
          },
        })}\n\n`;
      const splitAt = Math.floor(createdFrame.length / 2);
      res.write(createdFrame.slice(0, splitAt));
      setTimeout(() => {
        res.write(createdFrame.slice(splitAt));
        res.end(
          'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"ok"}\n\n',
        );
      }, 150);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 500,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: "reply with ok",
      }),
    });

    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstChunkMs = Date.now() - startedAt;
    const decoder = new TextDecoder();
    let body = first.done ? "" : decoder.decode(first.value, { stream: true });
    assert.ok(firstChunkMs < 120, `expected first chunk promptly, got ${firstChunkMs}ms`);
    assert.match(body, /response\.created/);

    while (true) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    assert.match(body, /response\.output_text\.done/);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy preserves native streamed responses that end after response.output_text.done", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
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
      res.write(
        'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"hello"}\n\n',
      );
      setTimeout(() => {
        if (!res.writableEnded) res.end(": upstream lingered\n\n");
      }, 200);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: "reply with ok",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    const elapsedMs = Date.now() - startedAt;
    assert.match(body, /response\.output_text\.done/);
    assert.doesNotMatch(body, /response\.completed/);
    assert.ok(elapsedMs < 180, `expected proxy to close promptly, got ${elapsedMs}ms`);
  } finally {
    await runtime.close();
    await upstream.close();
  }
});

test("proxy returns a buffered response once response.output_text.done arrives", async () => {
  const upstream = await startHttpServer(async (req, res) => {
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
      req.url?.startsWith("/backend-api/codex/models")
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
      res.write(
        'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"hello"}\n\n',
      );
      setTimeout(() => {
        if (!res.writableEnded) res.end(": upstream lingered\n\n");
      }, 200);
      return;
    }
    res.writeHead(404).end();
  });

  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), {
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
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });

  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    openaiBaseUrl: upstream.url,
    upstreamRequestTimeoutMs: 25,
  });

  try {
    const startedAt = Date.now();
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        input: "reply with ok",
      }),
    });

    const elapsedMs = Date.now() - startedAt;
    assert.equal(res.status, 200);
    assert.ok(elapsedMs < 180, `expected proxy to return promptly, got ${elapsedMs}ms`);
    const body = await res.json();
    assert.equal(body.output[0].content[0].text, "hello");
  } finally {
    await runtime.close();
    await upstream.close();
  }
});
