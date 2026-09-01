import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_RUNTIME_ADAPTERS,
  authorizationForAccountRequest,
  discoverAndPersistLocalRuntimes,
  discoverLocalRuntimes,
  isDiscoveredLocalRuntimeAccount,
  probeLocalRuntimeCandidate,
  type LocalRuntimeAdapter,
  type LocalRuntimeCandidate,
} from "./local-runtime-discovery.js";
import { AccountStore } from "./store.js";
import type { Account } from "./types.js";

const lmStudio = LOCAL_RUNTIME_ADAPTERS[0];

function modelsResponse(ids: string[]): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: ids.map((id) => ({ id, object: "model" })),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function discoveredAccount(endpoint = "http://127.0.0.1:1234"): Account {
  return {
    id: "local-runtime-lm-studio",
    provider: "openai-compatible",
    upstreamMode: "chat/completions",
    accessToken: "",
    baseUrl: endpoint,
    enabled: true,
    location: "local",
    localRuntime: {
      source: "multivibe-local-discovery",
      adapter: "lm-studio",
      endpoint,
      confirmedModelIds: ["publisher/model"],
      authentication: "none",
    },
  };
}

test("LM Studio discovery confirms models without sending Authorization", async () => {
  let calls = 0;
  const result = await probeLocalRuntimeCandidate(
    lmStudio,
    lmStudio.candidates[0],
    {
      fetchFn: async (input, init) => {
        calls += 1;
        assert.equal(String(input), "http://127.0.0.1:1234/v1/models");
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        assert.ok(init?.signal);
        return modelsResponse(["publisher/model", "embedding-model"]);
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.status, "discovered");
  assert.equal(result.endpoint, "http://127.0.0.1:1234");
  assert.deepEqual(result.confirmedModelIds, [
    "publisher/model",
    "embedding-model",
  ]);
});

test("discovery persists one deterministic account and replay does not duplicate it", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "multivibe-local-runtime-"),
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new AccountStore(path.join(dataDir, "accounts.json"));
  await store.init();
  let calls = 0;
  const options = {
    fetchFn: async () => {
      calls += 1;
      return modelsResponse(["publisher/model"]);
    },
  };

  await discoverAndPersistLocalRuntimes(store, options);
  await discoverAndPersistLocalRuntimes(store, options);

  const accounts = await store.listAccounts();
  assert.equal(calls, 2);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "local-runtime-lm-studio");
  assert.equal(accounts[0].accessToken, "");
  assert.equal(accounts[0].location, "local");
  assert.equal(accounts[0].localRuntime?.authentication, "none");
  assert.equal(accounts[0].localRuntime?.adapter, "lm-studio");
});

test("only exact IPv4 and IPv6 loopback LM Studio origins can omit auth", () => {
  const ipv4 = discoveredAccount();
  const ipv6 = discoveredAccount("http://[::1]:1234");
  assert.equal(isDiscoveredLocalRuntimeAccount(ipv4), true);
  assert.equal(isDiscoveredLocalRuntimeAccount(ipv6), true);
  assert.equal(
    authorizationForAccountRequest(
      ipv4,
      "http://127.0.0.1:1234/v1/chat/completions",
    ),
    undefined,
  );
  assert.equal(
    authorizationForAccountRequest(ipv6, "http://[::1]:1234/v1/models"),
    undefined,
  );

  for (const endpoint of [
    "http://localhost:1234",
    "http://127.1:1234",
    "http://2130706433:1234",
    "http://127.0.0.2:1234",
    "http://0.0.0.0:1234",
  ]) {
    const account = discoveredAccount(endpoint);
    assert.equal(isDiscoveredLocalRuntimeAccount(account), false);
    assert.throws(
      () =>
        authorizationForAccountRequest(
          account,
          `${endpoint}/v1/chat/completions`,
        ),
      /not a discovered local runtime/,
    );
  }
});

test("a non-allowlisted port or API path is refused", async () => {
  const candidate: LocalRuntimeCandidate = {
    endpoint: "http://127.0.0.1:1235",
    modelsUrl: "http://127.0.0.1:1235/v1/models",
  };
  await assert.rejects(
    probeLocalRuntimeCandidate(lmStudio, candidate, {
      fetchFn: async () => modelsResponse(["model"]),
    }),
    /port 1234/,
  );
  assert.throws(
    () =>
      authorizationForAccountRequest(
        discoveredAccount(),
        "http://127.0.0.1:1234/private",
      ),
    /outside the discovered LM Studio API boundary/,
  );
  for (const ambiguous of [
    "http://127.0.0.1:1234/v1/models?",
    "http://127.0.0.1:1234/v1/models#",
    "http://user@127.0.0.1:1234/v1/models",
  ]) {
    assert.throws(
      () => authorizationForAccountRequest(discoveredAccount(), ambiguous),
      /outside the discovered LM Studio API boundary/,
    );
  }
});

test("redirects are never followed, including to remote origins", async () => {
  let redirectMode: RequestRedirect | undefined;
  let calls = 0;
  const adapter: LocalRuntimeAdapter = {
    ...lmStudio,
    candidates: [lmStudio.candidates[0]],
  };
  const results = await discoverLocalRuntimes({
    adapters: [adapter],
    fetchFn: async (_input, init) => {
      calls += 1;
      redirectMode = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://remote.example/v1/models" },
      });
    },
  });

  assert.equal(calls, 1);
  assert.equal(redirectMode, "manual");
  assert.equal(results[0].status, "unavailable");
});

test("a stalled probe is bounded by its deadline", async () => {
  const adapter: LocalRuntimeAdapter = {
    ...lmStudio,
    candidates: [lmStudio.candidates[0]],
  };
  const startedAt = Date.now();
  const results = await discoverLocalRuntimes({
    adapters: [adapter],
    timeoutMs: 20,
    fetchFn: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        );
      }),
  });

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(results[0].status, "unavailable");
  assert.match(
    results[0].status === "unavailable" ? results[0].error ?? "" : "",
    /timed out/,
  );
});

test("oversized, invalid, and empty model catalogs are rejected", async () => {
  await assert.rejects(
    probeLocalRuntimeCandidate(lmStudio, lmStudio.candidates[0], {
      maxResponseBytes: 32,
      fetchFn: async () => modelsResponse(["a-model-id-that-is-too-long"]),
    }),
    /too large/,
  );
  await assert.rejects(
    probeLocalRuntimeCandidate(lmStudio, lmStudio.candidates[0], {
      fetchFn: async () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }),
    /not valid JSON/,
  );
  await assert.rejects(
    probeLocalRuntimeCandidate(lmStudio, lmStudio.candidates[0], {
      fetchFn: async () => modelsResponse([]),
    }),
    /at least one model/,
  );
});

test("a remote account without a token is refused before any request", () => {
  const remote: Account = {
    ...discoveredAccount(),
    id: "remote-without-token",
    baseUrl: "https://remote.example",
    location: "cloud",
    localRuntime: undefined,
  };
  assert.throws(
    () =>
      authorizationForAccountRequest(
        remote,
        "https://remote.example/v1/chat/completions",
      ),
    /not a discovered local runtime/,
  );
});

test("undeclared adapters perform no process, file, port, or network scan", async () => {
  const calls: string[] = [];
  const results = await discoverLocalRuntimes({
    fetchFn: async (input) => {
      calls.push(String(input));
      return modelsResponse(["publisher/model"]);
    },
  });

  assert.deepEqual(calls, ["http://127.0.0.1:1234/v1/models"]);
  assert.equal(results[0]?.adapter, "lm-studio");
  assert.equal(results[0]?.status, "discovered");
  assert.equal(results.slice(1).every((result) => result.status === "not-configured"), true);
  assert.equal(results.some((result) => result.adapter === "ollama"), true);
  assert.equal(results.some((result) => result.adapter === "manual-openai-compatible"), true);
});
