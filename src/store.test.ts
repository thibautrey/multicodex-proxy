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
