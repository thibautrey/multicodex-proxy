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
  return Math.floor(value);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function simulateBaseline(probeMs) {
  const startedAt = performance.now();
  await sleep(probeMs);
  return performance.now() - startedAt;
}

async function simulateCandidate(probeMs, requestAfterMs) {
  const coordinator = new AsyncRefreshCoordinator();
  let cached;
  let refreshCount = 0;
  const refresh = async () => {
    refreshCount += 1;
    await sleep(probeMs);
    cached = ["gpt-5.6-sol"];
    return cached;
  };
  const initialRefresh = coordinator.prepare({
    staleWhileRevalidate: false,
    refresh,
  });
  await sleep(requestAfterMs);

  const startedAt = performance.now();
  if (!cached) {
    await coordinator.prepare({
      staleWhileRevalidate: false,
      refresh,
    });
  }
  const requestMs = performance.now() - startedAt;
  await initialRefresh;
  return { requestMs, refreshCount };
}

const samples = numberArgument("samples", 50);
const probeMs = numberArgument("probe-ms", 20);
const requestAfterMs = numberArgument("request-after-ms", 30);
const baselineMs = [];
const candidateMs = [];
const candidateRefreshCounts = [];

for (let sample = 0; sample < samples; sample += 1) {
  const order =
    sample % 2 === 0
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"];
  for (const name of order) {
    if (name === "baseline") {
      baselineMs.push(await simulateBaseline(probeMs));
    } else {
      const candidate = await simulateCandidate(probeMs, requestAfterMs);
      candidateMs.push(candidate.requestMs);
      candidateRefreshCounts.push(candidate.refreshCount);
    }
  }
}

if (!candidateRefreshCounts.every((count) => count === 1)) {
  throw new Error("candidate started duplicate catalog refreshes");
}

const baselineMedianMs = median(baselineMs);
const candidateMedianMs = median(candidateMs);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_initial_model_catalog_warmup",
  samples,
  simulatedCatalogProbeMs: probeMs,
  firstRequestAfterStartupMs: requestAfterMs,
  previousInitialRefreshDelayMs: 1000,
  baseline: {
    strategy: "first_request_starts_discovery_during_delay_window",
    firstRequestMedianMs: baselineMedianMs,
    firstRequestP95Ms: percentile(baselineMs, 0.95),
  },
  candidate: {
    strategy: "router_starts_discovery_immediately",
    firstRequestMedianMs: candidateMedianMs,
    firstRequestP95Ms: percentile(candidateMs, 0.95),
  },
  medianFirstRequestImprovementRatio:
    baselineMedianMs > 0 ? 1 - candidateMedianMs / baselineMedianMs : 0,
  refreshesPerStartup: candidateRefreshCounts[0] ?? 0,
  tokenImpact: "none",
  note:
    "This isolates the initial catalog scheduling window. It excludes account loading, routing, request serialization, network variability, provider, and model latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
