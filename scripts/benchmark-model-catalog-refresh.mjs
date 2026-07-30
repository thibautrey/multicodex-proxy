#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { AsyncRefreshCoordinator } from "../src/async-refresh.ts";

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return value;
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const samples = numberArgument("samples", 20);
const delayMs = numberArgument("delay-ms", 50);
const concurrentRequests = numberArgument("concurrent", 4);
const staleCatalog = [{ id: "gpt-5.6-sol" }];
const freshCatalog = [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }];
const baselineMs = [];
const candidateMs = [];
let totalCandidateRefreshes = 0;

for (let sample = 0; sample < samples; sample += 1) {
  const baselineStartedAt = performance.now();
  await sleep(delayMs);
  baselineMs.push(performance.now() - baselineStartedAt);

  const coordinator = new AsyncRefreshCoordinator();
  let finishBackground;
  const backgroundFinished = new Promise((resolve) => {
    finishBackground = resolve;
  });
  const refresh = async () => {
    totalCandidateRefreshes += 1;
    await sleep(delayMs);
    finishBackground();
    return freshCatalog;
  };
  const candidateStartedAt = performance.now();
  const prepared = await Promise.all(
    Array.from({ length: concurrentRequests }, () =>
      coordinator.prepare({
        staleValue: staleCatalog,
        staleWhileRevalidate: true,
        refresh,
      }),
    ),
  );
  candidateMs.push(performance.now() - candidateStartedAt);
  if (!prepared.every((entry) => entry.value === staleCatalog)) {
    throw new Error("candidate did not serve the stale catalog");
  }
  await backgroundFinished;
}

const baselineMedianMs = median(baselineMs);
const candidateMedianMs = median(candidateMs);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_model_catalog_refresh_preparation",
  samples,
  concurrentRequests,
  simulatedCatalogProbeMs: delayMs,
  baseline: {
    medianMs: baselineMedianMs,
    p95Ms: percentile(baselineMs, 0.95),
  },
  candidate: {
    medianMs: candidateMedianMs,
    p95Ms: percentile(candidateMs, 0.95),
    refreshes: totalCandidateRefreshes,
    expectedRefreshes: samples,
  },
  medianPreparationImprovementRatio:
    baselineMedianMs > 0
      ? 1 - candidateMedianMs / baselineMedianMs
      : 0,
  note:
    "This isolates an expired model-catalog refresh; it is not an end-to-end upstream latency benchmark.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
