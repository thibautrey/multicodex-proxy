import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AccountStore, OAuthStateStore } from "./store.js";
import { MultivibeCloudService } from "./multivibe-cloud.js";
import type { Account, OAuthFlowState, StoreSettings } from "./types.js";

const projectId = "00000000-0000-4000-8000-000000000001";

function fakeStores(initial: {
  settings?: StoreSettings;
  accounts?: Account[];
} = {}) {
  let settings = { ...(initial.settings ?? {}) };
  let accounts = [...(initial.accounts ?? [])];
  const states = new Map<string, OAuthFlowState>();
  const settingsPatches: Partial<StoreSettings>[] = [];
  const store = {
    async getSettings() { return settings; },
    async patchSettings(patch: Partial<StoreSettings>) {
      settingsPatches.push(patch);
      settings = { ...settings, ...patch };
      return settings;
    },
    async listAccounts() { return [...accounts]; },
    async upsertAccount(account: Account) {
      const index = accounts.findIndex((candidate) => candidate.id === account.id);
      if (index === -1) accounts.push(account);
      else accounts[index] = account;
      return account;
    },
    async flushIfDirty() {},
  } as unknown as AccountStore;
  const oauthStore = {
    async create(state: OAuthFlowState) { states.set(state.id, state); },
    async get(id: string) { return states.get(id); },
    async update(id: string, patch: Partial<OAuthFlowState>) {
      const current = states.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      states.set(id, next);
      return next;
    },
  } as unknown as OAuthStateStore;
  return {
    store,
    oauthStore,
    states,
    settingsPatches,
    get settings() { return settings; },
    get accounts() { return accounts; },
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function service(
  stores: ReturnType<typeof fakeStores>,
  fetchImpl: typeof fetch,
) {
  return new MultivibeCloudService(stores.store, stores.oauthStore, {
    authBaseUrl: "https://auth.example.test",
    apiBaseUrl: "https://app.example.test",
    inferenceBaseUrl: "https://api.example.test",
    redirectUri: "http://127.0.0.1:1455/admin/cloud/oauth/callback",
    topupUrl: "https://app.example.test/billing",
    fetchImpl,
  });
}

test("Cloud connection uses PKCE and provisions a local API-key account", async () => {
  const stores = fakeStores();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cloud = service(stores, async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/token")) {
      return response({ access_token: "cloud-access", refresh_token: "cloud-refresh", expires_in: 3600 });
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/client/v1/projects" && init?.method === "GET") return response({ data: [] });
    if (parsedUrl.pathname === "/client/v1/projects" && init?.method === "POST") return response({ id: projectId });
    if (url.includes(`/client/v1/projects/${projectId}/api-keys`)) {
      return response({
        secret: "mvk_cloud_secret",
        apiKey: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      });
    }
    throw new Error(`unexpected Cloud call: ${url}`);
  });

  const started = await cloud.startConnection();
  const authorizeUrl = new URL(started.authorizeUrl);
  const flow = stores.states.get(started.flowId)!;
  assert.equal(authorizeUrl.pathname, "/oauth/authorize");
  assert.equal(authorizeUrl.searchParams.get("client_id"), "multivibe-core");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/admin/cloud/oauth/callback");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorizeUrl.searchParams.get("code_challenge"),
    createHash("sha256").update(flow.codeVerifier).digest("base64url"),
  );

  await cloud.completeConnection(started.flowId, "authorization-code");
  assert.equal(stores.states.get(started.flowId)?.status, "success");
  assert.deepEqual(stores.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    baseUrl: account.baseUrl,
    accessToken: account.accessToken,
    location: account.location,
    multivibeCloud: account.multivibeCloud,
  })), [{
    id: "multivibe-cloud",
    provider: "openai-compatible",
    baseUrl: "https://api.example.test",
    accessToken: "mvk_cloud_secret",
    location: "cloud",
    multivibeCloud: true,
  }]);
  assert.equal(stores.settings.multivibeCloud?.projectId, projectId);
  assert.equal(calls.filter((call) => call.init?.method === "POST").length, 3);
});

test("Cloud status reports balance and subscription without exposing the API key", async () => {
  const stores = fakeStores({
    settings: {
      multivibeCloud: {
        accessToken: "cloud-access",
        projectId,
      },
    },
    accounts: [{
      id: "multivibe-cloud",
      provider: "openai-compatible",
      accessToken: "mvk_cloud_secret",
      baseUrl: "https://api.example.test",
      enabled: true,
      location: "cloud",
      multivibeCloud: true,
      expiresAt: Date.now() + 2 * 86_400_000,
    }],
  });
  const seen: string[] = [];
  const cloud = service(stores, async (input, init) => {
    seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    if (String(input).endsWith("/client/v1/credits")) return response({ totalAvailableUsd: "12.50" });
    if (String(input).endsWith("/client/v1/billing/subscription")) return response({ data: { planCode: "credit-50", state: "active" } });
    throw new Error("unexpected Cloud call");
  });

  const status = await cloud.getStatus();
  assert.deepEqual(status, {
    status: "connected",
    balanceUsd: "12.50",
    subscription: "Credit 50",
    apiKeyExpiresAt: new Date(stores.accounts[0]!.expiresAt!).toISOString(),
    topupUrl: "https://app.example.test/billing",
  });
  assert.equal(seen.length, 2);
  assert.equal(seen.every((entry) => entry.endsWith("Bearer cloud-access")), true);
  assert.equal(JSON.stringify(status).includes("mvk_cloud_secret"), false);
});

test("Cloud status rotates an expired OAuth session and keeps the local API key", async () => {
  const stores = fakeStores({
    settings: {
      multivibeCloud: {
        accessToken: "expired-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1_000,
        projectId,
      },
    },
    accounts: [{
      id: "multivibe-cloud",
      provider: "openai-compatible",
      accessToken: "mvk_cloud_secret",
      baseUrl: "https://api.example.test",
      enabled: true,
      location: "cloud",
      multivibeCloud: true,
      expiresAt: Date.now() + 2 * 86_400_000,
    }],
  });
  const calls: string[] = [];
  const cloud = service(stores, async (input, init) => {
    const url = String(input);
    calls.push(`${url} ${init?.method ?? "GET"}`);
    if (url.endsWith("/oauth/token")) return response({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    if (url.endsWith("/client/v1/credits")) return response({ totalAvailableUsd: "0" });
    if (url.endsWith("/client/v1/billing/subscription")) return response({ data: null });
    throw new Error(`unexpected Cloud call: ${url}`);
  });

  const status = await cloud.getStatus();
  assert.equal(status.status, "connected");
  assert.equal(status.balanceUsd, "0");
  assert.equal(stores.settings.multivibeCloud?.accessToken, "rotated-access");
  assert.equal(stores.settings.multivibeCloud?.refreshToken, "rotated-refresh");
  assert.deepEqual(stores.accounts[0]?.accessToken, "mvk_cloud_secret");
  assert.equal(calls[0]?.endsWith("/oauth/token POST"), true);
});
