import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTraceManager } from "./traces.js";
import type { TraceEntry } from "./traces.js";

test("trace stats calculate inference speed from request start and end", () => {
  const manager = createTraceManager({
    filePath: "/tmp/multivibe-inference-speed-traces.jsonl",
  });
  const base = 1_728_000_000_000;
  let traceNumber = 0;
  const createTrace = (overrides: Partial<TraceEntry> = {}): TraceEntry => ({
    id: `inference-speed-${traceNumber++}`,
    at: base,
    route: "/responses",
    status: 200,
    isError: false,
    stream: false,
    latencyMs: 1,
    ...overrides,
  });

  const stats = manager.buildTraceStats([
    createTrace({
      at: base + 5_000,
      startedAt: base + 1_000,
      completedAt: base + 3_000,
      latencyMs: 100,
      tokensOutput: 40,
      tokensTotal: 40,
    }),
    createTrace({
      at: base + 3_605_000,
      startedAt: base + 3_601_000,
      completedAt: base + 3_605_000,
      latencyMs: 100,
      tokensOutput: 20,
      tokensTotal: 20,
    }),
    createTrace({
      at: base + 3_606_000,
      latencyMs: 100,
      tokensOutput: 0,
      tokensTotal: 0,
    }),
    createTrace({
      at: base + 3_607_000,
      startedAt: base + 3_606_000,
      latencyMs: 100,
      tokensOutput: 50,
      tokensTotal: 50,
      lifecycleState: "started",
    }),
  ]);

  assert.equal(stats.totals.inferenceRequests, 2);
  assert.equal(stats.totals.inferenceTokensPerSecond, 12.5);
  assert.deepEqual(
    stats.timeseries.map((bucket) => ({
      at: bucket.at,
      speed: bucket.inferenceTokensPerSecond,
      requests: bucket.inferenceRequests,
    })),
    [
      { at: base, speed: 20, requests: 1 },
      { at: base + 3_600_000, speed: 5, requests: 1 },
    ],
  );
});

test("trace initialization warms the cache before the first durable stream", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const filePath = path.join(directory, "nested", "traces.jsonl");
  const historyFilePath = path.join(directory, "nested", "history.jsonl");
  const manager = createTraceManager({ filePath, historyFilePath });

  await manager.initialize();
  const id = await manager.beginTrace({
    at: Date.now(),
    route: "/responses",
    status: 102,
    stream: true,
    latencyMs: 0,
  });

  const diskEntry = JSON.parse((await fs.readFile(filePath, "utf8")).trim());
  assert.equal(diskEntry.id, id);
  assert.equal(diskEntry.lifecycleState, "started");

  await fs.rm(directory, { recursive: true, force: true });
});

test("request headers stay in recent traces but not long-term stats history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  const manager = createTraceManager({ filePath, historyFilePath });

  await manager.appendTrace({
    at: Date.now(),
    route: "/v1/responses",
    status: 200,
    stream: false,
    latencyMs: 10,
    requestHeaders: {
      authorization: "[REDACTED]",
      "x-project-id": "project-alpha",
    },
  });

  const [trace] = await manager.readTraceWindow();
  assert.deepEqual(trace.requestHeaders, {
    authorization: "[REDACTED]",
    "x-project-id": "project-alpha",
  });

  const [listEntry] = await manager.readTraceListWindow();
  assert.equal(listEntry.hasRequestHeaders, true);

  const [historyEntry] = await manager.readStatsHistory();
  assert.equal(historyEntry.requestHeaders, undefined);

  await fs.rm(directory, { recursive: true, force: true });
});

test("Codex project attribution is resolved once and retained in long-term stats", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const manager = createTraceManager({
    filePath: path.join(directory, "traces.jsonl"),
    historyFilePath: path.join(directory, "history.jsonl"),
    resolveCodexProject: (sessionId) =>
      sessionId === "thread-project"
        ? {
            projectId: "prj_example",
            projectName: "example",
            projectRemote: "github.com/acme/example",
            projectRoot: "/workspace/example",
            projectHost: "builder",
          }
        : undefined,
  });
  await manager.initialize();

  manager.recordTrace({
    at: Date.now(),
    route: "/responses",
    codexSessionId: "thread-project",
    status: 200,
    stream: false,
    latencyMs: 10,
  });
  await manager.flushPendingWrites();

  const [recent] = await manager.readTraceWindow();
  assert.equal(recent.projectId, "prj_example");
  assert.equal(recent.codexSessionId, "thread-project");

  const [historical] = await manager.readStatsHistory();
  assert.equal(historical.projectId, "prj_example");
  assert.equal(historical.projectName, "example");
  assert.equal(historical.codexSessionId, undefined);
});

test("explicit LiteLLM project attribution takes precedence over the Codex session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const manager = createTraceManager({
    filePath: path.join(directory, "traces.jsonl"),
    historyFilePath: path.join(directory, "history.jsonl"),
    resolveCodexProject: () => ({
      projectId: "prj_codex",
      projectName: "codex-project",
    }),
  });
  await manager.initialize();

  manager.recordTrace({
    at: Date.now(),
    route: "/responses",
    codexSessionId: "thread-project",
    projectId: "prj_litellm",
    projectName: "litellm-project",
    status: 200,
    stream: false,
    latencyMs: 10,
  });
  await manager.flushPendingWrites();

  const [trace] = await manager.readTraceWindow();
  assert.equal(trace.projectId, "prj_litellm");
  assert.equal(trace.projectName, "litellm-project");
});

test("historical traces keep their recorded cost instead of using current prices", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  await fs.writeFile(
    historyFilePath,
    `${JSON.stringify({
      id: "historical",
      at: Date.now(),
      route: "/responses",
      model: "gpt-5.6-luna",
      status: 200,
      stream: false,
      latencyMs: 10,
      tokensInput: 1_000_000,
      tokensOutput: 0,
      tokensTotal: 1_000_000,
      costUsd: 42,
    })}\n`,
  );
  const manager = createTraceManager({ filePath, historyFilePath });

  const [trace] = await manager.readStatsHistory();
  const stats = manager.buildTraceStats([trace]);

  assert.equal(trace.costUsd, 42);
  assert.equal(trace.pricingVersion, "legacy-recorded");
  assert.equal(stats.totals.costUsd, 42);
  await fs.rm(directory, { recursive: true, force: true });
});

test("usage aggregation falls back to normalized token fields from lightweight history", () => {
  const manager = createTraceManager({
    filePath: "/tmp/multivibe-usage-fallback-traces.jsonl",
  });
  const aggregate = manager.createUsageAggregate();

  manager.addTraceToAggregate(aggregate, {
    id: "trace-1",
    at: Date.now(),
    route: "/responses",
    status: 200,
    isError: false,
    stream: false,
    latencyMs: 10,
    tokensInput: 12,
    tokensOutput: 3,
    tokensTotal: 15,
    usageStatus: "measured",
  });

  assert.deepEqual(manager.finalizeAggregate(aggregate).tokens, {
    prompt: 12,
    completion: 3,
    total: 15,
  });
});

test("missing usage is reported as missing and excluded from cost coverage", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const manager = createTraceManager({
    filePath: path.join(directory, "traces.jsonl"),
    historyFilePath: path.join(directory, "history.jsonl"),
  });

  await manager.appendTrace({
    at: Date.now(),
    route: "/responses",
    model: "gpt-5.6-luna",
    status: 200,
    stream: false,
    latencyMs: 10,
  });
  const [trace] = await manager.readTraceWindow();
  const stats = manager.buildTraceStats([trace]);

  assert.equal(trace.usageStatus, "missing");
  assert.equal(trace.tokensTotal, undefined);
  assert.equal(trace.costUsd, undefined);
  assert.equal(stats.totals.requestsWithUsage, 0);
  assert.equal(stats.totals.requestsWithCost, 0);
  await fs.rm(directory, { recursive: true, force: true });
});

test("legacy synthetic zero usage is reported as missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const historyFilePath = path.join(directory, "history.jsonl");
  await fs.writeFile(
    historyFilePath,
    `${JSON.stringify({
      id: "legacy-missing-usage",
      at: Date.now(),
      route: "/responses",
      model: "gpt-5.6-luna",
      status: 200,
      stream: false,
      latencyMs: 10,
      tokensInput: 0,
      tokensOutput: 0,
      tokensTotal: 0,
      costUsd: 0,
    })}\n`,
  );
  const manager = createTraceManager({
    filePath: path.join(directory, "traces.jsonl"),
    historyFilePath,
  });

  const [trace] = await manager.readStatsHistory();
  const { stats } = await manager.getTraceStats();

  assert.equal(trace.usageStatus, "missing");
  assert.equal(trace.costUsd, undefined);
  assert.equal(stats.totals.requestsWithUsage, 0);
  assert.equal(stats.totals.requestsWithCost, 0);
  await fs.rm(directory, { recursive: true, force: true });
});

test("startup reconciliation restores completed traces missing from history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  const trace = {
    id: "completed-before-shutdown",
    at: Date.now(),
    route: "/responses",
    status: 200,
    isError: false,
    stream: true,
    latencyMs: 10,
    lifecycleState: "completed",
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
  };
  await fs.writeFile(filePath, `${JSON.stringify(trace)}\n`);
  await fs.writeFile(historyFilePath, "");
  const manager = createTraceManager({ filePath, historyFilePath });

  await manager.initialize();
  await manager.seedStatsHistoryIfMissing();
  await manager.seedStatsHistoryIfMissing();
  const historyLines = (await fs.readFile(historyFilePath, "utf8"))
    .trim()
    .split("\n");
  const { stats } = await manager.getTraceStats();

  assert.equal(historyLines.length, 1);
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.totals.tokensTotal, 15);
  await fs.rm(directory, { recursive: true, force: true });
});

test("hidden routes are excluded from precomputed trace stats", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const manager = createTraceManager({
    filePath: path.join(directory, "traces.jsonl"),
    historyFilePath: path.join(directory, "history.jsonl"),
  });

  for (const route of ["/admin/config", "/v1/models", "/responses"]) {
    await manager.appendTrace({
      at: Date.now(),
      route,
      status: 200,
      stream: false,
      latencyMs: 10,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }
  const { totalStored, stats } = await manager.getTraceStats();

  assert.equal(totalStored, 1);
  assert.equal(stats.totals.requests, 1);
  assert.equal(stats.totals.tokensTotal, 2);
  await fs.rm(directory, { recursive: true, force: true });
});

test("stream traces are durable at start and finalized without duplicate stats", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  const manager = createTraceManager({ filePath, historyFilePath });
  const startedAt = Date.now();

  const id = await manager.beginTrace({
    at: startedAt,
    route: "/responses",
    status: 102,
    stream: true,
    latencyMs: 0,
    model: "test-model",
  });

  const initialDiskEntry = JSON.parse((await fs.readFile(filePath, "utf8")).trim());
  assert.equal(initialDiskEntry.id, id);
  assert.equal(initialDiskEntry.lifecycleState, "started");
  await assert.rejects(fs.readFile(historyFilePath, "utf8"));

  await manager.completeTrace(id, {
    at: Date.now(),
    startedAt,
    route: "/responses",
    status: 499,
    stream: true,
    latencyMs: 25,
    model: "test-model",
    usage: {
      input_tokens: 120,
      input_tokens_details: {
        cached_tokens: 80,
        cache_write_tokens: 32,
      },
      output_tokens: 15,
      output_tokens_details: { reasoning_tokens: 6 },
      total_tokens: 135,
    },
    latencyBreakdown: {
      preparationMs: 4,
      upstreamHeadersMs: 18,
    },
    usageRefresh: {
      background: 2,
      blocking: 0,
      shared: 1,
    },
    modelCatalogRefresh: {
      background: 1,
      blocking: 0,
      shared: 1,
    },
    accountPreparation: {
      skipped: 3,
      asynchronous: 1,
    },
    inputContext: {
      compactionItemCount: 1,
      itemsBeforeLatestCompaction: 8,
    },
    error: "client disconnected before stream completion",
    clientDisconnected: true,
  });

  const traces = await manager.readTraceWindow();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, id);
  assert.equal(traces[0].lifecycleState, "interrupted");
  assert.equal(traces[0].clientDisconnected, true);
  assert.equal(traces[0].status, 499);
  assert.equal(traces[0].tokensInputCached, 80);
  assert.equal(traces[0].tokensInputCacheWrite, 32);
  assert.equal(traces[0].tokensReasoning, 6);
  assert.deepEqual(traces[0].latencyBreakdown, {
    preparationMs: 4,
    upstreamHeadersMs: 18,
  });
  assert.deepEqual(traces[0].usageRefresh, {
    background: 2,
    blocking: 0,
    shared: 1,
  });
  assert.deepEqual(traces[0].modelCatalogRefresh, {
    background: 1,
    blocking: 0,
    shared: 1,
  });
  assert.deepEqual(traces[0].accountPreparation, {
    skipped: 3,
    asynchronous: 1,
  });
  assert.deepEqual(traces[0].inputContext, {
    compactionItemCount: 1,
    itemsBeforeLatestCompaction: 8,
  });

  const historyLines = (await fs.readFile(historyFilePath, "utf8"))
    .trim()
    .split("\n");
  assert.equal(historyLines.length, 1);

  const lifecycleLines = (await fs.readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lifecycleLines.length, 2);
  assert.equal(lifecycleLines[0].lifecycleState, "started");
  assert.equal(lifecycleLines[1].lifecycleState, "interrupted");
  assert.equal(lifecycleLines[0].id, lifecycleLines[1].id);

  const reloaded = createTraceManager({ filePath, historyFilePath });
  const reloadedTraces = await reloaded.readTraceWindow();
  assert.equal(reloadedTraces.length, 1);
  assert.equal(reloadedTraces[0].id, id);
  assert.equal(reloadedTraces[0].lifecycleState, "interrupted");

  await fs.rm(directory, { recursive: true, force: true });
});

test("trace storage compacts physical lifecycle records and retains active starts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-traces-"));
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  const records = [
    {
      id: "active",
      at: 1,
      route: "/responses",
      status: 102,
      stream: true,
      latencyMs: 0,
      lifecycleState: "started",
    },
    {
      id: "old",
      at: 2,
      route: "/responses",
      status: 200,
      stream: true,
      latencyMs: 1,
      lifecycleState: "completed",
    },
    {
      id: "duplicate",
      at: 3,
      route: "/responses",
      status: 102,
      stream: true,
      latencyMs: 0,
      lifecycleState: "started",
    },
    {
      id: "duplicate",
      at: 4,
      route: "/responses",
      status: 200,
      stream: true,
      latencyMs: 1,
      lifecycleState: "completed",
    },
    ...["new-1", "new-2", "new-3"].map((id, index) => ({
      id,
      at: index + 5,
      route: "/responses",
      status: 200,
      stream: true,
      latencyMs: 1,
      lifecycleState: "completed",
    })),
  ];
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const manager = createTraceManager({
    filePath,
    historyFilePath,
    retentionMax: 3,
  });

  await manager.compactTraceStorageIfNeeded();
  const diskLines = (await fs.readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const traces = await manager.readTraceWindow();

  assert.equal(diskLines.length, 3);
  assert.equal(traces.length, 3);
  assert.equal(
    traces.some(
      (trace) =>
        trace.id === "active" && trace.lifecycleState === "started",
    ),
    true,
  );
  assert.equal(new Set(diskLines.map((trace) => trace.id)).size, 3);

  const reloaded = createTraceManager({
    filePath,
    historyFilePath,
    retentionMax: 3,
  });
  assert.deepEqual(await reloaded.readTraceWindow(), traces);

  await fs.rm(directory, { recursive: true, force: true });
});
