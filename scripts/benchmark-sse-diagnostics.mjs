#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import {
  createResponseStreamDiagnostics,
  extractSSEFrameUsage,
  inspectResponseStreamEvent,
  inspectResponseStreamFrame,
} from "../src/responses/stream-diagnostics.ts";

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

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}`;
}

function inspectBaseline(frameText, diagnostics) {
  let usage;
  for (const rawLine of frameText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      inspectResponseStreamEvent(event, diagnostics);
      if (event?.response?.usage) usage = event.response.usage;
      else if (event?.usage) usage = event.usage;
    } catch {}
  }
  return usage;
}

function run(frames, inspector) {
  const diagnostics = createResponseStreamDiagnostics();
  let usage;
  for (const frameText of frames) {
    usage = inspector(frameText, diagnostics) ?? usage;
  }
  return { diagnostics, usage };
}

function extractUsageBaseline(frameText) {
  let usage;
  for (const rawLine of frameText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event?.response?.usage) usage = event.response.usage;
      else if (event?.usage) usage = event.usage;
    } catch {}
  }
  return usage;
}

function runUsage(frames, extractor) {
  let usage;
  for (const frameText of frames) {
    usage = extractor(frameText) ?? usage;
  }
  return usage;
}

const samples = numberArgument("samples", 500);
const textDeltaFrames = numberArgument("text-deltas", 1024);
const reasoningFrames = numberArgument("reasoning-events", 256);
const frames = [
  ...Array.from({ length: textDeltaFrames }, (_, index) =>
    frame({
      type: "response.output_text.delta",
      delta: `token-${index}`,
    }),
  ),
  frame({ type: "response.output_text.done", text: "complete" }),
  ...Array.from({ length: reasoningFrames }, (_, index) =>
    frame({
      type: "response.reasoning_summary_text.delta",
      delta: `reasoning-${index}`,
    }),
  ),
  frame({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "functions.example",
      call_id: "call-example",
    },
  }),
  frame({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 100_000,
        output_tokens: 1_064,
        total_tokens: 101_064,
      },
    },
  }),
];
const chatFrames = [
  ...Array.from({ length: textDeltaFrames }, (_, index) =>
    `data: ${JSON.stringify({
      object: "chat.completion.chunk",
      choices: [{ delta: { content: `token-${index}` } }],
    })}`,
  ),
  `data: ${JSON.stringify({
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: 100_000,
      completion_tokens: 1_064,
      total_tokens: 101_064,
    },
  })}`,
  "data: [DONE]",
];
const baselineMs = [];
const candidateMs = [];
const chatBaselineMs = [];
const chatCandidateMs = [];

run(frames, inspectBaseline);
run(frames, inspectResponseStreamFrame);
runUsage(chatFrames, extractUsageBaseline);
runUsage(chatFrames, extractSSEFrameUsage);

for (let sample = 0; sample < samples; sample += 1) {
  const order =
    sample % 2 === 0
      ? [
          ["baseline", inspectBaseline],
          ["candidate", inspectResponseStreamFrame],
        ]
      : [
          ["candidate", inspectResponseStreamFrame],
          ["baseline", inspectBaseline],
        ];
  for (const [name, inspector] of order) {
    const startedAt = performance.now();
    run(frames, inspector);
    const durationMs = performance.now() - startedAt;
    if (name === "baseline") baselineMs.push(durationMs);
    else candidateMs.push(durationMs);
  }

  const chatOrder =
    sample % 2 === 0
      ? [
          ["baseline", extractUsageBaseline],
          ["candidate", extractSSEFrameUsage],
        ]
      : [
          ["candidate", extractSSEFrameUsage],
          ["baseline", extractUsageBaseline],
        ];
  for (const [name, extractor] of chatOrder) {
    const startedAt = performance.now();
    runUsage(chatFrames, extractor);
    const durationMs = performance.now() - startedAt;
    if (name === "baseline") chatBaselineMs.push(durationMs);
    else chatCandidateMs.push(durationMs);
  }
}

const baselineResult = run(frames, inspectBaseline);
const candidateResult = run(frames, inspectResponseStreamFrame);
const equivalent =
  JSON.stringify(baselineResult) === JSON.stringify(candidateResult);
if (!equivalent) {
  throw new Error("candidate diagnostics differ from baseline");
}
const baselineChatUsage = runUsage(chatFrames, extractUsageBaseline);
const candidateChatUsage = runUsage(chatFrames, extractSSEFrameUsage);
const chatUsageEquivalent =
  JSON.stringify(baselineChatUsage) === JSON.stringify(candidateChatUsage);
if (!chatUsageEquivalent) {
  throw new Error("candidate chat usage differs from baseline");
}

const baselineMedianMs = median(baselineMs);
const candidateMedianMs = median(candidateMs);
const chatBaselineMedianMs = median(chatBaselineMs);
const chatCandidateMedianMs = median(chatCandidateMs);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_native_responses_sse_diagnostics",
  samples,
  frameCount: frames.length,
  textDeltaFrames,
  reasoningFrames,
  calibration:
    "The 1,024 text-delta scale approximates the observed local /responses output p95 of 1,064 tokens; event count is a stress proxy, not a measured token-to-frame ratio.",
  responsesDiagnostics: {
    baseline: {
      medianMs: baselineMedianMs,
      p95Ms: percentile(baselineMs, 0.95),
    },
    candidate: {
      medianMs: candidateMedianMs,
      p95Ms: percentile(candidateMs, 0.95),
    },
    medianImprovementRatio:
      baselineMedianMs > 0 ? 1 - candidateMedianMs / baselineMedianMs : 0,
    equivalent: equivalent,
  },
  chatUsageExtraction: {
    frameCount: chatFrames.length,
    baseline: {
      medianMs: chatBaselineMedianMs,
      p95Ms: percentile(chatBaselineMs, 0.95),
    },
    candidate: {
      medianMs: chatCandidateMedianMs,
      p95Ms: percentile(chatCandidateMs, 0.95),
    },
    medianImprovementRatio:
      chatBaselineMedianMs > 0
        ? 1 - chatCandidateMedianMs / chatBaselineMedianMs
        : 0,
    equivalent: chatUsageEquivalent,
  },
  note:
    "This isolates local diagnostics inspection before frame forwarding. It excludes decoding, Express writes, network, provider, and model latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
