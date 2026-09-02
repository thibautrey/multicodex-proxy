import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "./store.js";
import type { Account, ModelAlias } from "./types.js";

test("a mutation arriving during a flush is included before the flush resolves", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  store.markAccountModified("one", {
    id: "one",
    accessToken: "token-one",
    enabled: true,
  });
  const flushing = store.flushIfDirty();
  store.markAccountModified("two", {
    id: "two",
    accessToken: "token-two",
    enabled: true,
  });
  await flushing;

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(
    persisted.accounts.map((account: { id: string }) => account.id).sort(),
    ["one", "two"],
  );
  assert.equal(store.getPersistenceStatus().dirty, false);

  await fs.rm(directory, { recursive: true, force: true });
});

test("dashboard API keys are persisted and can be revoked", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();

  await store.addProxyApiKey({
    id: "key-one",
    application: "staging-worker",
    key: "mv_secret",
    createdAt: 1_700_000_000_000,
  });

  const reloaded = new AccountStore(filePath);
  await reloaded.init();
  assert.deepEqual(await reloaded.listProxyApiKeys(), [
    {
      id: "key-one",
      application: "staging-worker",
      key: "mv_secret",
      createdAt: 1_700_000_000_000,
    },
  ]);

  assert.equal(await reloaded.deleteProxyApiKey("key-one"), true);
  assert.equal(await reloaded.deleteProxyApiKey("missing"), false);
  assert.deepEqual(await reloaded.listProxyApiKeys(), []);

  await fs.rm(directory, { recursive: true, force: true });
});

test("new and upgraded stores materialize anonymous sharing as future-only and enabled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  await fs.writeFile(filePath, JSON.stringify({ accounts: [], settings: {} }), { mode: 0o600 });
  const enabledAt = new Date("2026-09-01T12:34:56.000Z");
  const store = new AccountStore(filePath, () => enabledAt);
  await store.init();

  assert.deepEqual(await store.getSettings(), {
    anonymousUsageSharingEnabled: true,
    anonymousUsageSharingEnabledAt: enabledAt.toISOString(),
  });
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.settings.anonymousUsageSharingEnabled, true);
  assert.equal(persisted.settings.anonymousUsageSharingEnabledAt, enabledAt.toISOString());

  const reloaded = new AccountStore(filePath, () => new Date("2026-09-02T00:00:00.000Z"));
  await reloaded.init();
  assert.equal((await reloaded.getSettings()).anonymousUsageSharingEnabledAt, enabledAt.toISOString());
  await fs.rm(directory, { recursive: true, force: true });
});

test("disabling persists immediately and re-enabling starts a new future-only window", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  let now = new Date("2026-09-01T10:00:00.000Z");
  const store = new AccountStore(filePath, () => now);
  await store.init();
  const initialEnabledAt = (await store.getSettings()).anonymousUsageSharingEnabledAt;

  assert.equal((await store.patchSettings({ anonymousUsageSharingEnabled: false })).anonymousUsageSharingEnabled, false);
  now = new Date("2026-09-03T09:00:00.000Z");
  const reenabled = await store.patchSettings({ anonymousUsageSharingEnabled: true });
  assert.equal(reenabled.anonymousUsageSharingEnabled, true);
  assert.equal(reenabled.anonymousUsageSharingEnabledAt, now.toISOString());
  assert.notEqual(reenabled.anonymousUsageSharingEnabledAt, initialEnabledAt);

  now = new Date("2026-09-04T09:00:00.000Z");
  assert.equal(
    (await store.patchSettings({ anonymousUsageSharingEnabled: true })).anonymousUsageSharingEnabledAt,
    reenabled.anonymousUsageSharingEnabledAt,
  );
  await fs.rm(directory, { recursive: true, force: true });
});

test("an existing explicit sharing opt-out remains disabled on upgrade", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  await fs.writeFile(filePath, JSON.stringify({
    accounts: [],
    settings: {
      anonymousUsageSharingEnabled: false,
      anonymousUsageSharingEnabledAt: "2026-08-01T00:00:00.000Z",
    },
  }), { mode: 0o600 });
  const store = new AccountStore(filePath, () => new Date("2026-09-01T00:00:00.000Z"));
  await store.init();
  assert.equal((await store.getSettings()).anonymousUsageSharingEnabled, false);
  await fs.rm(directory, { recursive: true, force: true });
});

test("runtime account telemetry advances persistence without invalidating the catalog", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();

  await store.addOrUpdate({
    id: "openai-account",
    provider: "openai",
    accessToken: "token-one",
    enabled: true,
    location: "cloud",
  });
  const initialPersistenceRevision = store.getRevision();
  const initialCatalogRevision = store.getCatalogRevision();

  // Proxy routing mutates the cached account object in place before persisting
  // lastSelectedAt, so this also guards against reference aliasing.
  const selected = store.getCachedAccounts()[0];
  selected.state = {
    lastSelectedAt: 1_700_000_000_000,
    lastError: "temporary upstream error",
    recentErrors: [
      { at: 1_700_000_000_000, message: "temporary upstream error" },
    ],
  };
  selected.usage = {
    fetchedAt: 1_700_000_000_000,
    secondary: { usedPercent: 25 },
  };
  await store.upsertAccount(selected);

  assert.equal(store.getRevision(), initialPersistenceRevision + 1);
  assert.equal(store.getCatalogRevision(), initialCatalogRevision);

  await store.patchAccount(selected.id, {
    state: { modelBlocks: { "gpt-5.6-sol": { until: 1, reason: "quota" } } },
    usage: { fetchedAt: 1_700_000_000_001, secondary: { usedPercent: 26 } },
  });
  assert.equal(store.getRevision(), initialPersistenceRevision + 2);
  assert.equal(store.getCatalogRevision(), initialCatalogRevision);
});

test("account configuration, membership, and aliases advance the catalog revision", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();

  let account: Account = {
    id: "provider-account",
    provider: "openai",
    email: "before@example.test",
    accessToken: "token-one",
    baseUrl: "https://provider-one.example.test",
    enabled: true,
    priority: 1,
    location: "cloud",
  };
  await store.addOrUpdate(account);
  assert.equal(store.getCatalogRevision(), 1);

  const configurationChanges: Array<Partial<Account>> = [
    { email: "after@example.test" },
    { priority: 2 },
    { enabled: false },
    { provider: "openai-compatible" },
    { baseUrl: "https://provider-two.example.test" },
    { accessToken: "token-two" },
  ];
  for (const patch of configurationChanges) {
    const before = store.getCatalogRevision();
    account = { ...account, ...patch };
    await store.upsertAccount(account);
    assert.equal(store.getCatalogRevision(), before + 1);
  }

  await store.addOrUpdate({
    id: "second-account",
    provider: "mistral",
    accessToken: "token",
    enabled: true,
  });
  assert.equal(store.getCatalogRevision(), 8);
  await store.deleteAccount("second-account");
  assert.equal(store.getCatalogRevision(), 9);

  const alias: ModelAlias = {
    schemaVersion: 2,
    id: "coding",
    enabled: true,
    rules: [
      {
        id: "default",
        candidates: [{ model: "gpt-5.6-sol" }],
        onNoCapacity: "reject",
      },
    ],
  };
  await store.upsertModelAlias(alias);
  assert.equal(store.getCatalogRevision(), 10);

  // Re-saving an identical alias is a durability write, not a catalog change.
  await store.upsertModelAlias(structuredClone(alias));
  assert.equal(store.getCatalogRevision(), 10);
  await store.patchModelAlias(alias.id, { description: "Primary coding model" });
  assert.equal(store.getCatalogRevision(), 11);
  await store.deleteModelAlias(alias.id);
  assert.equal(store.getCatalogRevision(), 12);
});
