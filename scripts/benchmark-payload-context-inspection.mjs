#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { inspectPayloadContext } from "../src/routes/proxy/index.ts";

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

function baselineInspect(payload) {
  let hasImage = false;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type.includes("image")) hasImage = true;
    }
  }

  const input = Array.isArray(payload?.input) ? payload.input : [];
  for (const item of input) {
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType.includes("image")) hasImage = true;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const type = typeof part?.type === "string" ? part.type : "";
      if (type.includes("image")) hasImage = true;
    }
  }

  let compactionItemCount = 0;
  let latestCompactionIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index]?.type !== "compaction") continue;
    compactionItemCount += 1;
    latestCompactionIndex = index;
  }
  return { hasImage, compactionItemCount, latestCompactionIndex };
}

const samples = numberArgument("samples", 1000);
const itemCount = numberArgument("items", 10_000);
const payload = {
  model: "gpt-5.6-sol",
  input: Array.from({ length: itemCount }, (_, index) =>
    index === Math.floor(itemCount / 2)
      ? { type: "compaction", encrypted_content: "opaque" }
      : {
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: index % 2 ? "output_text" : "input_text",
              text: `text block ${index}`,
            },
          ],
        },
  ),
};
const baselineSamples = [];
const candidateSamples = [];

baselineInspect(payload);
inspectPayloadContext(payload);

for (let sample = 0; sample < samples; sample += 1) {
  const order =
    sample % 2 === 0
      ? [
          ["baseline", baselineInspect],
          ["candidate", inspectPayloadContext],
        ]
      : [
          ["candidate", inspectPayloadContext],
          ["baseline", baselineInspect],
        ];
  for (const [name, inspect] of order) {
    const startedAt = performance.now();
    inspect(payload);
    const elapsedMs = performance.now() - startedAt;
    if (name === "baseline") baselineSamples.push(elapsedMs);
    else candidateSamples.push(elapsedMs);
  }
}

const baselineResult = baselineInspect(payload);
const candidateResult = inspectPayloadContext(payload);
const equivalent =
  JSON.stringify(baselineResult) === JSON.stringify(candidateResult);
if (!equivalent) throw new Error("candidate inspection differs from baseline");

const baselineMedianMs = median(baselineSamples);
const candidateMedianMs = median(candidateSamples);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_responses_payload_context_inspection",
  samples,
  inputItems: itemCount,
  compactionItems: 1,
  baseline: {
    traversals: 2,
    medianMs: baselineMedianMs,
    p95Ms: percentile(baselineSamples, 0.95),
  },
  candidate: {
    traversals: 1,
    medianMs: candidateMedianMs,
    p95Ms: percentile(candidateSamples, 0.95),
  },
  medianImprovementRatio:
    baselineMedianMs > 0 ? 1 - candidateMedianMs / baselineMedianMs : 0,
  equivalent,
  tokenImpact: "none",
  note:
    "This isolates image and compaction inspection for a long Responses input. It excludes serialization, routing, network, provider, and model latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
