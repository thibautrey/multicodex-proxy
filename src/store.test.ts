import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "./store.js";

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
