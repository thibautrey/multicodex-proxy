import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAnonymousUsageSharingWorker, type AnonymousUsageEnvelope } from "./anonymous-usage-sharing.js";
import { createTraceManager } from "./traces.js";
import type { StoreSettings } from "./types.js";

test("daily sharing filters after activation, bounds output, and retries the identical envelope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-anonymous-usage-"));
  const statePath = path.join(directory, "state.json");
  const now = new Date("2026-09-02T12:00:00.000Z");
  const settings: StoreSettings = {
    anonymousUsageSharingEnabled: true,
    anonymousUsageSharingEnabledAt: "2026-09-01T12:00:00.000Z",
  };
  let allowlistLoaded = false;
  let aggregationCalls = 0;
  let allowlistCalls = 0;
  const posted: AnonymousUsageEnvelope[] = [];
  const worker = createAnonymousUsageSharingWorker({
    settingsStore: { getSettings: async () => settings },
    traceSource: {
      aggregateAnonymousOutputTokens: async (sinceMs, untilMs, allowlist) => {
        aggregationCalls += 1;
        assert.equal(allowlistLoaded, true, "the public allowlist must load before local history is read");
        assert.equal(sinceMs, Date.parse("2026-09-01T12:00:00.000Z"));
        assert.equal(untilMs, Date.parse("2026-09-02T00:00:00.000Z"));
        assert.equal(allowlist["public/model"], "hf:public/model");
        return Array.from({ length: 55 }, (_, index) => ({
          modelId: `hf:public/model-${index}`,
          outputTokens: index === 0 ? 2_000_000_000 : index === 1 ? 999 : (100 - index) * 1_000,
        }));
      },
    },
    statePath,
    clock: () => now,
    random: () => 0,
    fetchFn: (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/model-allowlist")) {
        allowlistCalls += 1;
        allowlistLoaded = true;
        return Response.json(
          { schemaVersion: 1, generatedAt: now.toISOString(), models: { "public/model": "hf:public/model" } },
          { headers: { etag: '"allowlist-v1"' } },
        );
      }
      posted.push(JSON.parse(String(init?.body)) as AnonymousUsageEnvelope);
      return posted.length === 1 ? Response.json({ error: "temporary" }, { status: 503 }) : Response.json({ accepted: true }, { status: 202 });
    }) as typeof fetch,
  });

  assert.equal(await worker.runOnce(), "failed");
  const pending = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  assert.equal(pending.pending.models.length, 50);
  assert.equal(pending.pending.models[0].outputTokenThousands, 1_000_000);
  assert.equal(pending.pending.models.some((model: { outputTokenThousands: number }) => model.outputTokenThousands < 1), false);
  assert.equal(pending.pending.periodStart, "2026-09-01T00:00:00.000Z");
  assert.equal(pending.pending.periodEnd, "2026-09-02T00:00:00.000Z");
  assert.equal(JSON.stringify(pending).includes("input"), false);
  assert.equal(JSON.stringify(pending).includes("account"), false);

  assert.equal(await worker.runOnce(), "sent");
  assert.equal(allowlistCalls, 1);
  assert.equal(aggregationCalls, 1);
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[1], posted[0]);
  const completed = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(completed.pending, undefined);
  assert.equal(completed.lastCompletedPeriodEnd, "2026-09-02T00:00:00.000Z");
  worker.stop();
  await fs.rm(directory, { recursive: true, force: true });
});

test("allowlist failure is closed and never reaches trace history or throws into request handling", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-anonymous-usage-"));
  const statePath = path.join(directory, "state.json");
  let aggregationCalls = 0;
  const worker = createAnonymousUsageSharingWorker({
    settingsStore: {
      getSettings: async () => ({
        anonymousUsageSharingEnabled: true,
        anonymousUsageSharingEnabledAt: "2026-09-01T00:00:00.000Z",
      }),
    },
    traceSource: {
      aggregateAnonymousOutputTokens: async () => {
        aggregationCalls += 1;
        return [];
      },
    },
    statePath,
    clock: () => new Date("2026-09-02T12:00:00.000Z"),
    fetchFn: (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch,
  });

  assert.equal(await worker.runOnce(), "failed");
  assert.equal(aggregationCalls, 0);
  await assert.rejects(fs.access(statePath), /ENOENT/u);
  worker.stop();
  await fs.rm(directory, { recursive: true, force: true });
});

test("turning sharing off aborts an in-flight retry and removes its unsent envelope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-anonymous-usage-"));
  const statePath = path.join(directory, "state.json");
  let settings: StoreSettings = {
    anonymousUsageSharingEnabled: true,
    anonymousUsageSharingEnabledAt: "2026-09-01T00:00:00.000Z",
  };
  let postStartedResolve!: () => void;
  const postStarted = new Promise<void>((resolve) => { postStartedResolve = resolve; });
  let fetchCalls = 0;
  const worker = createAnonymousUsageSharingWorker({
    settingsStore: { getSettings: async () => settings },
    traceSource: {
      aggregateAnonymousOutputTokens: async () => [{ modelId: "hf:public/model", outputTokens: 12_345 }],
    },
    statePath,
    clock: () => new Date("2026-09-02T12:00:00.000Z"),
    fetchFn: (async (input, init) => {
      fetchCalls += 1;
      if (String(input).endsWith("/model-allowlist")) {
        return Response.json({ schemaVersion: 1, models: { "public/model": "hf:public/model" } });
      }
      postStartedResolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }) as typeof fetch,
  });

  const running = worker.runOnce();
  await postStarted;
  assert.equal((await fs.stat(statePath)).isFile(), true);
  settings = { ...settings, anonymousUsageSharingEnabled: false };
  await worker.applySettings(settings);
  assert.equal(await running, "disabled");
  await assert.rejects(fs.access(statePath), /ENOENT/u);
  assert.equal(await worker.runOnce(), "disabled");
  assert.equal(fetchCalls, 2);
  worker.stop();
  await fs.rm(directory, { recursive: true, force: true });
});

test("trace aggregation returns only completed allowlisted output demand", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-anonymous-traces-"));
  const tracePath = path.join(directory, "traces.jsonl");
  const historyPath = path.join(directory, "history.jsonl");
  const base = {
    route: "/v1/responses",
    status: 200,
    isError: false,
    stream: false,
    latencyMs: 10,
    lifecycleState: "completed",
  };
  const records = [
    { ...base, id: "public", at: Date.parse("2026-09-01T13:00:00.000Z"), completedAt: Date.parse("2026-09-01T13:00:00.000Z"), model: "public/model", tokensInput: 999_999, tokensOutput: 1_500 },
    { ...base, id: "requested", at: Date.parse("2026-09-01T14:00:00.000Z"), requestedModel: "another/public", model: "private/resolved", tokensOutput: 2_500 },
    { ...base, id: "private", at: Date.parse("2026-09-01T15:00:00.000Z"), model: "private/model", tokensOutput: 99_000 },
    { ...base, id: "before", at: Date.parse("2026-09-01T11:00:00.000Z"), model: "public/model", tokensOutput: 8_000 },
    { ...base, id: "interrupted", at: Date.parse("2026-09-01T16:00:00.000Z"), lifecycleState: "interrupted", model: "public/model", tokensOutput: 8_000 },
    { ...base, id: "error", at: Date.parse("2026-09-01T17:00:00.000Z"), status: 500, isError: true, model: "public/model", tokensOutput: 8_000 },
  ];
  await fs.writeFile(tracePath, "", { mode: 0o600 });
  await fs.writeFile(historyPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  const manager = createTraceManager({ filePath: tracePath, historyFilePath: historyPath });
  await manager.initialize();

  const totals = await manager.aggregateAnonymousOutputTokens(
    Date.parse("2026-09-01T12:00:00.000Z"),
    Date.parse("2026-09-02T00:00:00.000Z"),
    { "public/model": "hf:public/model", "another/public": "hf:public/model" },
  );
  assert.deepEqual(totals, [{ modelId: "hf:public/model", outputTokens: 4_000 }]);
  assert.equal(JSON.stringify(totals).includes("private"), false);
  assert.equal(JSON.stringify(totals).includes("tokensInput"), false);
  await fs.rm(directory, { recursive: true, force: true });
});
