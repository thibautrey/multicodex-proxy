import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempDir, getAvailablePort, startRuntime, writeJson } from "./helpers.js";

test("runtime refuses non-loopback binding without admin auth", async () => {
  const { createRuntime } = await import("../dist/runtime.js");
  const tmp = await createTempDir();
  const storePath = path.join(tmp, "accounts.json");
  const oauthStatePath = path.join(tmp, "oauth-state.json");
  await writeJson(storePath, { accounts: [], modelAliases: [] });
  await writeJson(oauthStatePath, { states: [] });

  await assert.rejects(
    () =>
      createRuntime({
        host: "0.0.0.0",
        port: 0,
        adminToken: "",
        installSignalHandlers: false,
        storePath,
        oauthStatePath,
        traceFilePath: path.join(tmp, "traces.jsonl"),
        traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
      }),
    /ADMIN_TOKEN is required/,
  );
});

test("runtime exposes readiness separately from health", async () => {
  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), { accounts: [], modelAliases: [] });
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });
  const runtime = await startRuntime({
    adminToken: "test-admin",
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
  });

  try {
    const health = await fetch(`${runtime.baseUrl}/health`).then((r) => r.json());
    const ready = await fetch(`${runtime.baseUrl}/ready`).then((r) => ({
      status: r.status,
      body: r.status === 200 ? r.json() : r.text(),
    }));

    assert.equal(health.ok, true);
    assert.equal(health.ready, true);
    assert.equal(ready.status, 200);
  } finally {
    await runtime.close();
  }
});

test("runtime serves the loopback OAuth callback helper page", async () => {
  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), { accounts: [], modelAliases: [] });
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });
  const callbackPort = await getAvailablePort();
  const runtime = await startRuntime({
    adminToken: "test-admin",
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
    oauthConfig: {
      authorizationUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "test-client",
      scope: "openid profile email offline_access",
      redirectUri: `http://127.0.0.1:${callbackPort}/auth/callback`,
    },
  });

  try {
    const res = await fetch(
      `http://127.0.0.1:${callbackPort}/auth/callback?code=test-code&state=test-state`,
    );
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(body, /OAuth callback received/);
    assert.match(body, /multivibe-oauth-callback/);
    assert.match(body, /Copy callback URL/);
  } finally {
    await runtime.close();
  }
});
