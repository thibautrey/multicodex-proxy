#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createTraceManager } from "../src/traces.ts";

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return Math.floor(value);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * quantile)] ?? 0;
}

function traceRecord(id, at) {
  return JSON.stringify({
    id,
    at,
    route: "/responses",
    model: "gpt-5.6-sol",
    status: 200,
    stream: true,
    latencyMs: 1000,
    lifecycleState: "completed",
  });
}

async function prepareManager(root, name, traceLines, historyLines) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  const traceContent = Array.from({ length: traceLines }, (_, index) =>
    traceRecord(`trace-${index}`, index + 1),
  ).join("\n");
  const historyContent = Array.from({ length: historyLines }, (_, index) =>
    traceRecord(`history-${index}`, index + 1),
  ).join("\n");
  await Promise.all([
    fs.writeFile(filePath, `${traceContent}\n`, "utf8"),
    fs.writeFile(historyFilePath, `${historyContent}\n`, "utf8"),
  ]);
  return createTraceManager({
    filePath,
    historyFilePath,
    retentionMax: traceLines,
  });
}

async function begin(manager) {
  return manager.beginTrace({
    at: Date.now(),
    route: "/responses",
    model: "gpt-5.6-sol",
    status: 102,
    stream: true,
    latencyMs: 0,
  });
}

const runs = numberArgument("runs", 20);
const traceLines = numberArgument("trace-lines", 1000);
const historyLines = numberArgument("history-lines", 20_000);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-trace-warmup-"));
const coldRequestMs = [];
const warmupMs = [];
const warmRequestMs = [];

try {
  for (let run = 0; run < runs; run += 1) {
    const cold = await prepareManager(
      root,
      `cold-${run}`,
      traceLines,
      historyLines,
    );
    const warm = await prepareManager(
      root,
      `warm-${run}`,
      traceLines,
      historyLines,
    );

    const warmupStartedAt = performance.now();
    await warm.initialize();
    warmupMs.push(performance.now() - warmupStartedAt);

    const order =
      run % 2 === 0
        ? [
            ["cold", cold],
            ["warm", warm],
          ]
        : [
            ["warm", warm],
            ["cold", cold],
          ];
    for (const [name, manager] of order) {
      const startedAt = performance.now();
      await begin(manager);
      const elapsedMs = performance.now() - startedAt;
      if (name === "cold") coldRequestMs.push(elapsedMs);
      else warmRequestMs.push(elapsedMs);
    }
  }

  const coldMedianMs = median(coldRequestMs);
  const warmMedianMs = median(warmRequestMs);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    benchmark: "synthetic_first_stream_trace_warmup",
    runs,
    traceLines,
    historyLines,
    baseline: {
      strategy: "lazy_initialize_on_first_begin_trace",
      firstStreamMedianMs: coldMedianMs,
      firstStreamP95Ms: percentile(coldRequestMs, 0.95),
    },
    candidate: {
      strategy: "initialize_before_listen",
      startupWarmupMedianMs: median(warmupMs),
      startupWarmupP95Ms: percentile(warmupMs, 0.95),
      firstStreamMedianMs: warmMedianMs,
      firstStreamP95Ms: percentile(warmRequestMs, 0.95),
    },
    medianFirstStreamImprovementRatio:
      coldMedianMs > 0 ? 1 - warmMedianMs / coldMedianMs : 0,
    durableStartEquivalent: true,
    tokenImpact: "none",
    note:
      "This isolates trace cache initialization and the first durable stream append. It excludes account initialization, routing, fetch, network, provider, and model latency.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
