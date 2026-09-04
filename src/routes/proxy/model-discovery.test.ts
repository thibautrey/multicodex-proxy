import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Account } from "../../types.js";
import { AccountStore } from "../../store.js";
import {
  discoverModels,
  filterProviderAccountsByModelAvailability,
} from "./index.js";

test("model availability cannot erase the last provider candidate", () => {
  const accounts = [{ id: "account-one" }, { id: "account-two" }];

  assert.deepEqual(
    filterProviderAccountsByModelAvailability(
      accounts,
      (account) => account.id === "account-one",
    ),
    [{ id: "account-one" }],
  );
  assert.deepEqual(
    filterProviderAccountsByModelAvailability(accounts, () => false),
    accounts,
  );
});

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

test("reuses the model catalog across repeated runtime account updates", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-models-"));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const store = new AccountStore(path.join(dataDir, "accounts.json"));
  await store.init();
  await store.addOrUpdate({
    id: "opencode-account",
    provider: "opencode",
    accessToken: "test-access-token",
    baseUrl: "https://opencode.ai/inference/openai",
    enabled: true,
    location: "cloud",
  });

  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://opencode.ai/zen/v1/models");
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
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const urls = [
    "https://chatgpt.com/backend-api",
    "https://api.mistral.ai",
    "https://api.z.ai",
  ] as const;
  await discoverModels(store, ...urls);
  const catalogRevision = store.getCatalogRevision();
  const persistenceRevision = store.getRevision();

  const selected = store.getCachedAccounts()[0];
  selected.state = { lastSelectedAt: 1_700_000_000_000 };
  await store.upsertAccount(selected);
  await discoverModels(store, ...urls);

  await store.patchAccount(selected.id, {
    usage: {
      fetchedAt: 1_700_000_000_001,
      secondary: { usedPercent: 50 },
    },
    state: { lastError: "temporary error" },
  });
  await discoverModels(store, ...urls);

  assert.equal(store.getRevision(), persistenceRevision + 2);
  assert.equal(store.getCatalogRevision(), catalogRevision);
  assert.equal(modelRequests, 1);
});

test("refreshes the model catalog after account configuration and alias changes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-models-"));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const store = new AccountStore(path.join(dataDir, "accounts.json"));
  await store.init();
  const account: Account = {
    id: "opencode-account",
    provider: "opencode",
    accessToken: "test-access-token",
    baseUrl: "https://opencode.ai/inference/openai",
    enabled: true,
    location: "cloud",
  };
  await store.addOrUpdate(account);

  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://opencode.ai/zen/v1/models");
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
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const urls = [
    "https://chatgpt.com/backend-api",
    "https://api.mistral.ai",
    "https://api.z.ai",
  ] as const;
  await discoverModels(store, ...urls);
  assert.equal(modelRequests, 1);

  await store.upsertAccount({ ...account, accessToken: "rotated-access-token" });
  await discoverModels(store, ...urls);
  assert.equal(modelRequests, 2);

  await store.upsertModelAlias({
    schemaVersion: 2,
    id: "coding",
    enabled: true,
    rules: [
      {
        id: "default",
        candidates: [{ model: "claude-opus-4-6" }],
        onNoCapacity: "reject",
      },
    ],
  });
  const models = await discoverModels(store, ...urls);
  assert.equal(modelRequests, 3);
  assert.equal(models.some((model) => model.id === "coding"), true);
});

test("discovers models from an explicitly classified tokenless local runtime", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "multivibe-local-models-"),
  );
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const store = new AccountStore(path.join(dataDir, "accounts.json"));
  await store.init();
  await store.addOrUpdate({
    id: "local-runtime-lm-studio",
    provider: "openai-compatible",
    upstreamMode: "chat/completions",
    accessToken: "",
    baseUrl: "http://127.0.0.1:1234",
    enabled: true,
    location: "local",
    localRuntime: {
      source: "multivibe-local-discovery",
      adapter: "lm-studio",
      endpoint: "http://127.0.0.1:1234",
      confirmedModelIds: ["lmstudio-discovered-only"],
      authentication: "none",
    },
  });

  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests += 1;
    assert.equal(String(input), "http://127.0.0.1:1234/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(init?.redirect, "manual");
    return Response.json({
      object: "list",
      data: [
        {
          id: "lmstudio-discovered-only",
          object: "model",
          created: 0,
          owned_by: "local",
        },
      ],
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const models = await discoverModels(
    store,
    "https://chatgpt.com/backend-api",
    "https://api.mistral.ai",
    "https://api.z.ai",
  );
  assert.equal(
    models.some((model) => model.id === "lmstudio-discovered-only"),
    true,
  );
  assert.equal(requests, 1);
});

test("uses the classified Exo catalog path for a discovered local runtime", async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "multivibe-exo-models-"),
  );
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const store = new AccountStore(path.join(dataDir, "accounts.json"));
  await store.init();
  await store.addOrUpdate({
    id: "local-runtime-exo",
    provider: "openai-compatible",
    upstreamMode: "chat/completions",
    accessToken: "",
    baseUrl: "http://127.0.0.1:52415",
    enabled: true,
    location: "local",
    localRuntime: {
      source: "multivibe-local-discovery",
      adapter: "exo",
      endpoint: "http://127.0.0.1:52415",
      confirmedModelIds: ["exo/model"],
      authentication: "none",
    },
  });

  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests += 1;
    assert.equal(String(input), "http://127.0.0.1:52415/models");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(init?.redirect, "manual");
    return Response.json({
      object: "list",
      data: [{ id: "exo/model", object: "model", owned_by: "exo" }],
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const models = await discoverModels(
    store,
    "https://chatgpt.com/backend-api",
    "https://api.mistral.ai",
    "https://api.z.ai",
  );
  assert.equal(models.some((model) => model.id === "exo/model"), true);
  assert.equal(requests, 1);
});
