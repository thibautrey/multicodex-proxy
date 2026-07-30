#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { payloadHasImage } from "../src/routes/proxy/index.ts";

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

function legacyDetailedSummary(payload) {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const parts = [];
  let hasImage = false;

  input.forEach((item, itemIndex) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part, partIndex) => {
      const type = typeof part?.type === "string" ? part.type : undefined;
      if (type?.includes("image")) hasImage = true;
      if (
        type?.includes("image") ||
        type === "text" ||
        type === "input_text" ||
        type === "output_text"
      ) {
        parts.push({
          path: `input[${itemIndex}].content[${partIndex}]`,
          type,
          keys: part && typeof part === "object" ? Object.keys(part) : [],
          textLength:
            typeof part?.text === "string" ? part.text.length : undefined,
        });
      }
    });
  });

  return { hasImage, parts };
}

const samples = numberArgument("samples", 200);
const itemCount = numberArgument("items", 10_000);
const payload = {
  model: "gpt-5.6-sol",
  input: Array.from({ length: itemCount }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: [
      {
        type: index % 2 ? "output_text" : "input_text",
        text: `text block ${index}`,
      },
    ],
  })),
};
const baselineMs = [];
const candidateMs = [];

for (let sample = 0; sample < samples; sample += 1) {
  const baselineStartedAt = performance.now();
  const first = legacyDetailedSummary(payload);
  const second = legacyDetailedSummary(payload);
  const third = legacyDetailedSummary(payload);
  baselineMs.push(performance.now() - baselineStartedAt);
  if (first.hasImage || second.hasImage || third.hasImage) {
    throw new Error("baseline incorrectly detected an image");
  }

  const candidateStartedAt = performance.now();
  const hasImage = payloadHasImage(payload);
  candidateMs.push(performance.now() - candidateStartedAt);
  if (hasImage) throw new Error("candidate incorrectly detected an image");
}

const baselineMedianMs = median(baselineMs);
const candidateMedianMs = median(candidateMs);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_text_only_image_detection",
  samples,
  inputItems: itemCount,
  baselineScansPerRequest: 3,
  candidateScansPerRequest: 1,
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
    "This isolates text-only image detection and detailed trace allocation; it is not an end-to-end proxy benchmark.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
