#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { UsageRefreshCoordinator } from "../src/usage-refresh.ts";

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
const accountCount = numberArgument("accounts", 4);
const delayMs = numberArgument("delay-ms", 50);
const staleAt = Date.now() - 10 * 60_000;

function accounts() {
  return Array.from({ length: accountCount }, (_, index) => ({
    id: `account-${index}`,
    accessToken: "benchmark-token",
    enabled: true,
    usage: { fetchedAt: staleAt },
  }));
}

async function refresh(account) {
  await sleep(delayMs);
  account.usage = { fetchedAt: Date.now() };
  return account;
}

const baselineMs = [];
const candidateMs = [];

for (let sample = 0; sample < samples; sample += 1) {
  const baselineAccounts = accounts();
  const baselineStartedAt = performance.now();
  await Promise.all(
    baselineAccounts.map((account) =>
      refresh(structuredClone(account)),
    ),
  );
  baselineMs.push(performance.now() - baselineStartedAt);

  const candidateAccounts = accounts();
  const coordinator = new UsageRefreshCoordinator(refresh);
  let completed = 0;
  let finishBackground;
  const backgroundFinished = new Promise((resolve) => {
    finishBackground = resolve;
  });
  const candidateStartedAt = performance.now();
  await Promise.all(
    candidateAccounts.map((account) =>
      coordinator.prepare(account, "https://benchmark.invalid", {
        staleWhileRevalidate: true,
        onBackgroundUpdate: () => {
          completed += 1;
          if (completed === accountCount) finishBackground();
        },
      }),
    ),
  );
  candidateMs.push(performance.now() - candidateStartedAt);
  await backgroundFinished;
}

const baselineMedianMs = median(baselineMs);
const candidateMedianMs = median(candidateMs);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_usage_refresh_preparation",
  samples,
  accountCount,
  simulatedUsageProbeMs: delayMs,
  baseline: {
    medianMs: baselineMedianMs,
    p95Ms: percentile(baselineMs, 0.95),
  },
  candidate: {
    medianMs: candidateMedianMs,
    p95Ms: percentile(candidateMs, 0.95),
  },
  medianPreparationImprovementRatio:
    baselineMedianMs > 0
      ? 1 - candidateMedianMs / baselineMedianMs
      : 0,
  note:
    "This isolates local request preparation only; it is not an end-to-end upstream latency benchmark.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
