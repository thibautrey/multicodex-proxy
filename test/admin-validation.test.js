import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTempDir, startRuntime, writeJson } from "./helpers.js";

test("admin account endpoints reject unknown fields", async () => {
  const tmp = await createTempDir();
  await writeJson(path.join(tmp, "accounts.json"), { accounts: [], modelAliases: [] });
  await writeJson(path.join(tmp, "oauth-state.json"), { states: [] });
  const runtime = await startRuntime({
    storePath: path.join(tmp, "accounts.json"),
    oauthStatePath: path.join(tmp, "oauth-state.json"),
    traceFilePath: path.join(tmp, "traces.jsonl"),
    traceStatsHistoryPath: path.join(tmp, "traces-history.jsonl"),
  });

  try {
    const res = await fetch(`${runtime.baseUrl}/admin/accounts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "test-admin",
      },
      body: JSON.stringify({
        id: "x",
        accessToken: "token",
        enabled: true,
        hackedField: true,
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /unknown fields/i);
  } finally {
    await runtime.close();
  }
});
