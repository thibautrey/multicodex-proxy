#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { createUpstreamPayloadSerializer } from "../src/responses/upstream-payload-serializer.ts";

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

const samples = numberArgument("samples", 500);
const itemCount = numberArgument("items", 10_000);
const attempts = numberArgument("attempts", 3);
const input = Array.from({ length: itemCount }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: [
    {
      type: index % 2 ? "output_text" : "input_text",
      text: `long context block ${index} with stable synthetic content`,
    },
  ],
}));
const payload = {
  model: "gpt-5.6-sol",
  input,
  tools: [
    {
      type: "function",
      name: "example",
      description: "Synthetic benchmark tool",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  ],
  reasoning: { effort: "low", summary: "auto" },
  text: { verbosity: "medium" },
  include: ["reasoning.encrypted_content"],
  stream: true,
  store: false,
};
const expected = JSON.stringify(payload);
const baselineSamples = [];
const candidateSamples = [];

for (let sample = 0; sample < samples; sample += 1) {
  const order =
    sample % 2 === 0
      ? ["baseline", "candidate"]
      : ["candidate", "baseline"];
  for (const name of order) {
    const startedAt = performance.now();
    let serialized = "";
    if (name === "baseline") {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        serialized = JSON.stringify({ ...payload });
      }
    } else {
      const serialize = createUpstreamPayloadSerializer();
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        serialized = serialize({ ...payload });
      }
    }
    const elapsedMs = performance.now() - startedAt;
    if (serialized !== expected) {
      throw new Error(`${name} serialization differs from source payload`);
    }
    if (name === "baseline") baselineSamples.push(elapsedMs);
    else candidateSamples.push(elapsedMs);
  }
}

const baselineMedianMs = median(baselineSamples);
const candidateMedianMs = median(candidateSamples);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_long_responses_account_rotation_serialization",
  samples,
  inputItems: itemCount,
  attempts,
  serializedBytes: Buffer.byteLength(expected),
  baseline: {
    fullSerializations: attempts,
    medianMs: baselineMedianMs,
    p95Ms: percentile(baselineSamples, 0.95),
  },
  candidate: {
    fullSerializations: 1,
    variantSerializations: attempts,
    medianMs: candidateMedianMs,
    p95Ms: percentile(candidateSamples, 0.95),
  },
  medianImprovementRatio:
    baselineMedianMs > 0 ? 1 - candidateMedianMs / baselineMedianMs : 0,
  equivalent: true,
  tokenImpact: "none",
  note:
    "This isolates request-local JSON serialization across compatible account attempts. It excludes parsing, routing, fetch, network, provider, and model latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
