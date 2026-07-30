#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
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

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * quantile)] ?? 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function traceRecord(id, at, lifecycleState, payload) {
  return {
    id,
    at,
    startedAt: at,
    completedAt: lifecycleState === "started" ? undefined : at + 1,
    route: "/responses",
    model: "gpt-5.6-sol",
    status: lifecycleState === "started" ? 102 : 200,
    isError: false,
    stream: true,
    latencyMs: lifecycleState === "started" ? 0 : 25,
    lifecycleState,
    error: lifecycleState === "started" ? undefined : payload,
  };
}

async function seedTraceFile(filePath, retention, payload) {
  const records = Array.from({ length: retention }, (_, index) =>
    traceRecord(`retained-${index}`, index + 1, "completed", payload),
  );
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return records;
}

async function runLegacyScenario({ retention, completions, payload }) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "multivibe-trace-baseline-"),
  );
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  const cache = await seedTraceFile(filePath, retention, payload);
  let traceQueue = Promise.resolve();
  let historyQueue = Promise.resolve();
  const active = [];

  try {
    for (let index = 0; index < completions; index += 1) {
      const started = traceRecord(
        `active-${index}`,
        retention + index + 1,
        "started",
        payload,
      );
      active.push(started);
      const run = traceQueue.then(async () => {
        cache.push(started);
        if (cache.length > retention) {
          cache.splice(0, cache.length - retention);
        }
        await fs.appendFile(filePath, `${JSON.stringify(started)}\n`, "utf8");
      });
      traceQueue = run.catch(() => undefined);
      await run;
    }

    const startedAt = performance.now();
    await Promise.all(
      active.map(async (started) => {
        const finalRecord = traceRecord(
          started.id,
          started.at + 1,
          "completed",
          payload,
        );
        const traceRun = traceQueue.then(async () => {
          const index = cache.findIndex((trace) => trace.id === started.id);
          if (index >= 0) cache[index] = finalRecord;
          else cache.push(finalRecord);
          const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
          await fs.writeFile(
            temporaryPath,
            `${cache.map((trace) => JSON.stringify(trace)).join("\n")}\n`,
            "utf8",
          );
          await fs.rename(temporaryPath, filePath);
        });
        traceQueue = traceRun.catch(() => undefined);
        await traceRun;

        const historyRun = historyQueue.then(() =>
          fs.appendFile(
            historyFilePath,
            `${JSON.stringify({
              ...finalRecord,
              error: undefined,
            })}\n`,
            "utf8",
          ),
        );
        historyQueue = historyRun.catch(() => undefined);
        await historyRun;
      }),
    );
    const durationMs = performance.now() - startedAt;
    const stat = await fs.stat(filePath);
    return { durationMs, traceFileBytes: stat.size };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runCandidateScenario({ retention, completions, payload }) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "multivibe-trace-candidate-"),
  );
  const filePath = path.join(directory, "traces.jsonl");
  const historyFilePath = path.join(directory, "history.jsonl");
  await seedTraceFile(filePath, retention, payload);
  const manager = createTraceManager({
    filePath,
    historyFilePath,
    retentionMax: retention,
  });
  const active = [];

  try {
    for (let index = 0; index < completions; index += 1) {
      const at = retention + index + 1;
      active.push({
        id: await manager.beginTrace({
          at,
          startedAt: at,
          route: "/responses",
          model: "gpt-5.6-sol",
          status: 102,
          stream: true,
          latencyMs: 0,
        }),
        at,
      });
    }

    const startedAt = performance.now();
    await Promise.all(
      active.map(({ id, at }) =>
        manager.completeTrace(id, {
          at: at + 1,
          startedAt: at,
          route: "/responses",
          model: "gpt-5.6-sol",
          status: 200,
          stream: true,
          latencyMs: 25,
          error: payload,
        }),
      ),
    );
    const durationMs = performance.now() - startedAt;
    const stat = await fs.stat(filePath);
    return { durationMs, traceFileBytes: stat.size };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const retention = numberArgument("retention", 1000);
const completions = numberArgument("completions", 64);
const runs = numberArgument("runs", 7);
const payloadBytes = numberArgument("payload-bytes", 512);
const payload = "x".repeat(payloadBytes);
const baselineSamples = [];
const candidateSamples = [];
const baselineFileBytes = [];
const candidateFileBytes = [];

// One unreported warm-up reduces one-time module and filesystem effects.
await runCandidateScenario({ retention, completions: 1, payload });
await runLegacyScenario({ retention, completions: 1, payload });

for (let run = 0; run < runs; run += 1) {
  const order =
    run % 2 === 0
      ? [
          ["baseline", runLegacyScenario],
          ["candidate", runCandidateScenario],
        ]
      : [
          ["candidate", runCandidateScenario],
          ["baseline", runLegacyScenario],
        ];
  for (const [name, scenario] of order) {
    const result = await scenario({ retention, completions, payload });
    if (name === "baseline") {
      baselineSamples.push(result.durationMs);
      baselineFileBytes.push(result.traceFileBytes);
    } else {
      candidateSamples.push(result.durationMs);
      candidateFileBytes.push(result.traceFileBytes);
    }
  }
}

const baselineMedianMs = median(baselineSamples);
const candidateMedianMs = median(candidateSamples);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_concurrent_trace_completion",
  retention,
  concurrentCompletions: completions,
  payloadBytes,
  runs,
  baseline: {
    strategy: "rewrite_retained_window_per_completion",
    medianBatchMs: baselineMedianMs,
    p95BatchMs: percentile(baselineSamples, 0.95),
    medianPerCompletionMs: baselineMedianMs / completions,
    medianTraceFileBytes: median(baselineFileBytes),
  },
  candidate: {
    strategy: "append_final_record_and_compact_by_physical_line_count",
    medianBatchMs: candidateMedianMs,
    p95BatchMs: percentile(candidateSamples, 0.95),
    medianPerCompletionMs: candidateMedianMs / completions,
    medianTraceFileBytes: median(candidateFileBytes),
  },
  medianCompletionImprovementRatio:
    baselineMedianMs > 0 ? 1 - candidateMedianMs / baselineMedianMs : 0,
  note:
    "This isolates local trace and stats-history persistence with concurrent completions; it does not include proxy routing, network, provider, or model latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
