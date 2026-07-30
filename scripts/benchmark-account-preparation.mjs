#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { accountNeedsRequestPreparation } from "../src/account-utils.ts";

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

class BenchmarkStore {
  mutations = 0;

  constructor(accounts) {
    this.accounts = [...accounts];
  }

  markAccountModified(account) {
    const index = this.accounts.findIndex(
      (candidate) => candidate.id === account.id,
    );
    if (index < 0) this.accounts.push(account);
    else this.accounts[index] = account;
    this.mutations += 1;
  }
}

const samples = numberArgument("samples", 5000);
const accountCount = numberArgument("accounts", 64);
const accounts = Array.from({ length: accountCount }, (_, index) => ({
  id: `account-${index}`,
  enabled: true,
  accessToken: "benchmark-token",
  expiresAt: Date.now() + 60 * 60_000,
  usage: { fetchedAt: Date.now() },
}));
const baselineMs = [];
const candidateMs = [];
let baselineMutations = 0;
let candidateMutations = 0;

async function legacyPrepareAccounts(input, store) {
  return Promise.all(
    input.map(async (account) => {
      const valid = await Promise.resolve(account);
      store.markAccountModified(valid);
      const prepared = await Promise.resolve({
        account: valid,
        mode: "fresh",
      });
      if (prepared.mode !== "background") {
        store.markAccountModified(prepared.account);
      }
      return prepared.account;
    }),
  );
}

for (let sample = 0; sample < samples; sample += 1) {
  const baselineStore = new BenchmarkStore(accounts);
  const baselineStartedAt = performance.now();
  await legacyPrepareAccounts(accounts, baselineStore);
  baselineMs.push(performance.now() - baselineStartedAt);
  baselineMutations += baselineStore.mutations;

  const candidateStore = new BenchmarkStore(accounts);
  const candidateStartedAt = performance.now();
  const accountPreparations = accounts.map((account) =>
    accountNeedsRequestPreparation(account) ? Promise.resolve(account) : account,
  );
  if (accountPreparations.some((entry) => typeof entry?.then === "function")) {
    await Promise.all(accountPreparations);
  }
  candidateMs.push(performance.now() - candidateStartedAt);
  candidateMutations += candidateStore.mutations;
}

const baselineMedianMs = median(baselineMs);
const candidateMedianMs = median(candidateMs);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_fresh_account_preparation",
  samples,
  accountCount,
  baseline: {
    medianMs: baselineMedianMs,
    p95Ms: percentile(baselineMs, 0.95),
    mutationsPerRequest: baselineMutations / samples,
  },
  candidate: {
    medianMs: candidateMedianMs,
    p95Ms: percentile(candidateMs, 0.95),
    mutationsPerRequest: candidateMutations / samples,
  },
  medianPreparationImprovementRatio:
    baselineMedianMs > 0
      ? 1 - candidateMedianMs / baselineMedianMs
      : 0,
  note:
    "This isolates unchanged-account store churn; it does not include token refresh, usage refresh, account selection, or upstream latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
