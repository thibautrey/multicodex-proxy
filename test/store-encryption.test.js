import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createTempDir } from "./helpers.js";

test("account store encrypts persisted state when a key is configured", async () => {
  const tmp = await createTempDir();
  const filePath = path.join(tmp, "accounts.enc.json");
  const { AccountStore } = await import("../dist/store.js");

  const store = new AccountStore(filePath, "super-secret-key");
  await store.init();
  await store.upsertAccount({
    id: "acct-1",
    provider: "openai",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    enabled: true,
    state: {},
  });
  await store.flushIfDirty();

  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /access-secret|refresh-secret/);
  assert.match(raw, /"alg"\s*:\s*"aes-256-gcm"/);

  const reloaded = new AccountStore(filePath, "super-secret-key");
  await reloaded.init();
  const accounts = await reloaded.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accessToken, "access-secret");
  assert.equal(accounts[0].refreshToken, "refresh-secret");
});
