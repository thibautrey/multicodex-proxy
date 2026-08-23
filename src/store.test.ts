import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore, cleanupOrphanedTmpFiles } from "./store.js";

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

test("recovers the account store from its last valid backup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const filePath = path.join(directory, "accounts.json");
  const store = new AccountStore(filePath);
  await store.init();
  await store.addOrUpdate({ id: "one", accessToken: "token-one", enabled: true });
  await store.addOrUpdate({ id: "two", accessToken: "token-two", enabled: true });
  await fs.writeFile(filePath, "{corrupt", "utf8");

  const recovered = new AccountStore(filePath);
  await recovered.init();
  assert.deepEqual(
    recovered.getCachedAccounts().map((account) => account.id),
    ["one"],
  );
  const restoredRaw = await fs.readFile(filePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(restoredRaw));
  await fs.rm(directory, { recursive: true, force: true });
});

test("removes UUID-suffixed orphan temporary files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-store-"));
  const orphan = path.join(directory, "accounts.json.tmp-deadbeef");
  const unrelated = path.join(directory, "notes.tmp-user");
  await fs.writeFile(orphan, "temporary", "utf8");
  await fs.writeFile(unrelated, "keep", "utf8");
  await cleanupOrphanedTmpFiles(directory);
  await assert.rejects(fs.access(orphan));
  await fs.access(unrelated);
  await fs.rm(directory, { recursive: true, force: true });
});
