import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAdminRouter, type AdminRoutesOptions } from "./index.js";
import type { HostHarnessView } from "../../host-harness-integrations.js";

const disconnectedHarness = (): HostHarnessView => ({
  id: "example",
  name: "Example",
  category: "cli",
  detected: true,
  detectedBy: ["command:example"],
  configured: false,
  managed: false,
  drifted: false,
  canInstall: true,
  canUninstall: false,
  configPath: "~/.example/config.json",
});

function options(overrides: Partial<AdminRoutesOptions> = {}): AdminRoutesOptions {
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
    ...overrides,
  };
}

async function withServer(adminOptions: AdminRoutesOptions, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(adminOptions));
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

test("harness discovery stays hidden outside MultiVibe Host", async () => {
  await withServer(options(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/host-harnesses`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hostApplication: false, harnesses: [] });
  });
});

test("install provisions one private key and never returns it to the browser", async () => {
  const added: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let installedKey = "";
  const disconnected = disconnectedHarness();
  const connected = { ...disconnected, configured: true, managed: true, canInstall: false, canUninstall: true };
  const manager = {
    list: async () => [disconnected],
    get: async () => disconnected,
    install: async (_id: string, credential: { apiKeyId: string; apiKey: string; application: string }) => {
      installedKey = credential.apiKey;
      assert.equal(credential.application, "harness-example");
      return connected;
    },
    uninstall: async () => ({ view: disconnected, apiKeyId: String(added[0]?.id) }),
  } as unknown as AdminRoutesOptions["hostHarnessIntegrations"];
  const store = {
    getCachedProxyApiKeys: () => [],
    addProxyApiKey: async (entry: Record<string, unknown>) => { added.push(entry); return entry; },
    deleteProxyApiKey: async (id: string) => { deleted.push(id); return true; },
  } as unknown as AdminRoutesOptions["store"];

  await withServer(options({ hostApplication: true, hostHarnessIntegrations: manager, store }), async (baseUrl) => {
    const discovery = await fetch(`${baseUrl}/admin/host-harnesses`);
    assert.deepEqual((await discovery.json() as any).harnesses.map((entry: any) => entry.id), ["example"]);

    const installed = await fetch(`${baseUrl}/admin/host-harnesses/example/install`, { method: "POST" });
    assert.equal(installed.status, 201);
    const raw = await installed.text();
    assert.equal(raw.includes(installedKey), false);
    assert.match(installedKey, /^mv_[A-Za-z0-9_-]{43}$/);
    assert.equal(added.length, 1);

    const removed = await fetch(`${baseUrl}/admin/host-harnesses/example/install`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(deleted, [added[0].id]);
  });
});

test("a failed configuration rolls back the newly provisioned key", async () => {
  const added: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const manager = {
    get: async () => disconnectedHarness(),
    install: async () => { throw new Error("write failed"); },
  } as unknown as AdminRoutesOptions["hostHarnessIntegrations"];
  const store = {
    getCachedProxyApiKeys: () => [],
    addProxyApiKey: async (entry: Record<string, unknown>) => { added.push(entry); return entry; },
    deleteProxyApiKey: async (id: string) => { deleted.push(id); return true; },
  } as unknown as AdminRoutesOptions["store"];

  await withServer(options({ hostApplication: true, hostHarnessIntegrations: manager, store }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/host-harnesses/example/install`, { method: "POST" });
    assert.equal(response.status, 500);
    assert.equal(added.length, 1);
    assert.deepEqual(deleted, [added[0].id]);
  });
});
