import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTraceManager } from "./traces.js";

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
  assert.deepEqual(traces[0].inputContext, {
    compactionItemCount: 1,
    itemsBeforeLatestCompaction: 8,
  });

  const historyLines = (await fs.readFile(historyFilePath, "utf8"))
    .trim()
    .split("\n");
  assert.equal(historyLines.length, 1);

  await fs.rm(directory, { recursive: true, force: true });
});
