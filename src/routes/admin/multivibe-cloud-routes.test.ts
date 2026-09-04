import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type { MultivibeCloudService } from "../../multivibe-cloud.js";

const flowId = "00000000-0000-4000-8000-000000000001";
type CloudRoutesStub = Pick<
  MultivibeCloudService,
  "getStatus" | "startConnection" | "completeConnection" | "failConnection"
>;

function options(multivibeCloud: Partial<CloudRoutesStub>): AdminRoutesOptions {
  return {
    store: {} as AdminRoutesOptions["store"],
    oauthStore: {} as AdminRoutesOptions["oauthStore"],
    traceManager: { pageSizeMax: 100 } as AdminRoutesOptions["traceManager"],
    codexProjectRegistry: {} as AdminRoutesOptions["codexProjectRegistry"],
    oauthConfig: {} as AdminRoutesOptions["oauthConfig"],
    openaiBaseUrl: "https://example.test",
    mistralBaseUrl: "https://example.test",
    zaiBaseUrl: "https://example.test",
    codexProjectRegistrationToken: "",
    configuredProxyApiKeys: [],
    storagePaths: {
      accountsPath: "/data/accounts.json",
      oauthStatePath: "/data/oauth.json",
      tracePath: "/data/traces.jsonl",
      traceStatsHistoryPath: "/data/trace-stats.jsonl",
      codexProjectsPath: "/data/projects.json",
    },
    multivibeCloud: multivibeCloud as MultivibeCloudService,
  };
}

async function withServer(
  multivibeCloud: Partial<CloudRoutesStub>,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(options(multivibeCloud)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Cloud status is exposed without depending on Host mode", async () => {
  await withServer({
    async getStatus() {
      return { status: "disconnected", topupUrl: "https://app.multivibe.cloud/billing" };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/cloud`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      status: "disconnected",
      topupUrl: "https://app.multivibe.cloud/billing",
    });
  });
});

test("Cloud callback rejects malformed state and accepts only the expected query shape", async () => {
  const completed: string[] = [];
  await withServer({
    async completeConnection(state: string, code: string) {
      completed.push(`${state}:${code}`);
    },
    async failConnection() {},
  }, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/admin/cloud/oauth/callback?state=bad&code=valid-code`, { redirect: "manual" });
    assert.equal(malformed.status, 303);
    assert.equal(malformed.headers.get("location"), "/?tab=accounts&cloud=error");

    const unexpected = await fetch(`${baseUrl}/admin/cloud/oauth/callback?state=${flowId}&code=valid-code&extra=1`, { redirect: "manual" });
    assert.equal(unexpected.status, 303);
    assert.equal(unexpected.headers.get("location"), "/?tab=accounts&cloud=error");
    assert.deepEqual(completed, []);

    const valid = await fetch(`${baseUrl}/admin/cloud/oauth/callback?state=${flowId}&code=valid-code`, { redirect: "manual" });
    assert.equal(valid.status, 303);
    assert.equal(valid.headers.get("location"), "/?tab=accounts&cloud=connected");
    assert.deepEqual(completed, [`${flowId}:valid-code`]);
  });
});
