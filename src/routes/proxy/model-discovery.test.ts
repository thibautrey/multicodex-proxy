import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Account } from "../../types.js";
import { AccountStore } from "../../store.js";
import { discoverModels } from "./index.js";

test("refreshes the model catalog after an account is connected", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-models-"));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const store = new AccountStore(path.join(dataDir, "accounts.json"));
  await store.init();
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://opencode.ai/zen/v1/models") {
      modelRequests += 1;
      return Response.json({
        object: "list",
        data: [
          {
            id: "claude-opus-4-6",
            object: "model",
            created: 0,
            owned_by: "opencode",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const openAiBaseUrl = "https://chatgpt.com/backend-api";
  const mistralBaseUrl = "https://api.mistral.ai";
  const zaiBaseUrl = "https://api.z.ai";
  const beforeConnection = await discoverModels(
    store,
    openAiBaseUrl,
    mistralBaseUrl,
    zaiBaseUrl,
  );
  assert.equal(
    beforeConnection.some((model) => model.id === "claude-opus-4-6"),
    false,
  );

  const account: Account = {
    id: "opencode-account",
    provider: "opencode",
    accessToken: "test-access-token",
    baseUrl: "https://opencode.ai/inference/openai",
    enabled: true,
    location: "cloud",
  };
  await store.addOrUpdate(account);

  const afterConnection = await discoverModels(
    store,
    openAiBaseUrl,
    mistralBaseUrl,
    zaiBaseUrl,
  );
  assert.equal(
    afterConnection.some((model) => model.id === "claude-opus-4-6"),
    true,
  );
  assert.equal(modelRequests, 1);
});
