#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { createWebsocketSSEMessageRelay } from "../src/responses/websocket-sse-relay.ts";

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

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function splitBytes(bytes, chunkBytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, offset + chunkBytes));
  }
  return chunks;
}

function rememberFunctionCall(functionCalls, item) {
  if (item?.type !== "function_call" || !item?.call_id) return;
  functionCalls.set(item.call_id, {
    call_id: item.call_id,
    name: item.name ?? "unknown",
    arguments:
      typeof item.arguments === "string"
        ? item.arguments
        : JSON.stringify(item.arguments ?? {}),
  });
}

function rememberFunctionCallsFromEvent(functionCalls, event) {
  if (
    event?.type === "response.output_item.added" ||
    event?.type === "response.output_item.done"
  ) {
    rememberFunctionCall(functionCalls, event.item);
    return;
  }
  if (event?.type === "response.completed") {
    const output = Array.isArray(event.response?.output)
      ? event.response.output
      : [];
    for (const item of output) rememberFunctionCall(functionCalls, item);
  }
}

function takeNextSSEFrame(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const index = normalized.indexOf("\n\n");
  if (index === -1) return null;
  return {
    frame: normalized.slice(0, index),
    rest: normalized.slice(index + 2),
  };
}

function sseFrameToJson(frameText) {
  const lines = frameText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (!dataLines.length) return null;
  const payload = dataLines
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function runBaseline(chunks, capture = false) {
  const decoder = new TextDecoder();
  const functionCalls = new Map();
  const messages = [];
  let buffer = "";
  let messageBytes = 0;
  let parseCount = 0;

  const relayFrame = (frameText) => {
    const payload = sseFrameToJson(frameText);
    parseCount += 1;
    if (!payload) return;
    rememberFunctionCallsFromEvent(functionCalls, payload);
    const message = JSON.stringify(payload);
    messageBytes += Buffer.byteLength(message);
    if (capture) messages.push(message);
  };

  for (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const next = takeNextSSEFrame(buffer);
      if (!next) break;
      buffer = next.rest;
      relayFrame(next.frame);
    }
  }
  buffer += decoder.decode();
  while (true) {
    const next = takeNextSSEFrame(buffer);
    if (!next) break;
    buffer = next.rest;
    relayFrame(next.frame);
  }
  if (buffer.trim()) relayFrame(buffer);

  return {
    functionCalls: [...functionCalls.entries()],
    messageBytes,
    messages,
    parseCount,
  };
}

function runCandidate(chunks, capture = false) {
  const functionCalls = new Map();
  const messages = [];
  let messageBytes = 0;
  let inspectionCount = 0;
  const relay = createWebsocketSSEMessageRelay({
    onMessage(message) {
      messageBytes += Buffer.byteLength(message);
      if (capture) messages.push(message);
    },
    onInspectableEvent(event) {
      inspectionCount += 1;
      rememberFunctionCallsFromEvent(functionCalls, event);
    },
  });

  for (const chunk of chunks) relay.push(chunk);
  relay.finish();

  return {
    functionCalls: [...functionCalls.entries()],
    inspectionCount,
    messageBytes,
    messages,
  };
}

const samples = numberArgument("samples", 500);
const textDeltaFrames = numberArgument("text-deltas", 1024);
const reasoningFrames = numberArgument("reasoning-events", 256);
const chunkBytes = numberArgument("chunk-bytes", 16 * 1024);
const functionItem = {
  type: "function_call",
  call_id: "call_benchmark",
  name: "lookup",
  arguments: '{"query":"benchmark"}',
};
const events = [
  ...Array.from({ length: textDeltaFrames }, (_, index) => ({
    type: "response.output_text.delta",
    delta: `token-${index}`,
  })),
  { type: "response.output_text.done", text: "complete" },
  ...Array.from({ length: reasoningFrames }, (_, index) => ({
    type: "response.reasoning_summary_text.delta",
    delta: `reasoning-${index}`,
  })),
  { type: "response.output_item.added", item: functionItem },
  {
    type: "response.function_call_arguments.delta",
    item_id: "item_benchmark",
    output_index: 0,
    delta: '{"query":"benchmark"}',
  },
  { type: "response.output_item.done", item: functionItem },
  {
    type: "response.completed",
    response: {
      output: [functionItem],
      usage: {
        input_tokens: 100_000,
        output_tokens: 1_064,
        total_tokens: 101_064,
      },
    },
  },
];
const streamText = events.map(frame).join("");
const chunks = splitBytes(new TextEncoder().encode(streamText), chunkBytes);
const baselineSamples = [];
const candidateSamples = [];

runBaseline(chunks);
runCandidate(chunks);

for (let sample = 0; sample < samples; sample += 1) {
  const runners =
    sample % 2 === 0
      ? [
          ["baseline", runBaseline],
          ["candidate", runCandidate],
        ]
      : [
          ["candidate", runCandidate],
          ["baseline", runBaseline],
        ];
  for (const [name, runner] of runners) {
    const startedAt = performance.now();
    runner(chunks);
    const elapsedMs = performance.now() - startedAt;
    if (name === "baseline") baselineSamples.push(elapsedMs);
    else candidateSamples.push(elapsedMs);
  }
}

const baseline = runBaseline(chunks, true);
const candidate = runCandidate(chunks, true);
const messagesEquivalent =
  baseline.messageBytes === candidate.messageBytes &&
  JSON.stringify(baseline.messages) === JSON.stringify(candidate.messages);
const functionMemoryEquivalent =
  JSON.stringify(baseline.functionCalls) ===
  JSON.stringify(candidate.functionCalls);
if (!messagesEquivalent || !functionMemoryEquivalent) {
  throw new Error("candidate WebSocket messages or function memory differ");
}

const baselineMedianMs = median(baselineSamples);
const candidateMedianMs = median(candidateSamples);
const baselineP95Ms = percentile(baselineSamples, 0.95);
const candidateP95Ms = percentile(candidateSamples, 0.95);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_responses_sse_to_websocket_relay",
  samples,
  frameCount: events.length,
  chunkCount: chunks.length,
  chunkBytes,
  streamBytes: Buffer.byteLength(streamText),
  calibration:
    "The 1,024 text-delta scale approximates the observed local /responses output p95 of 1,064 tokens; upstream chunk size is synthetic.",
  equivalence: {
    messages: messagesEquivalent,
    functionMemory: functionMemoryEquivalent,
    messageCount: baseline.messages.length,
    messageBytes: baseline.messageBytes,
  },
  workAvoided: {
    baselineJsonParses: baseline.parseCount,
    candidateInspectableParses: candidate.inspectionCount,
    parseReductionRatio:
      1 - candidate.inspectionCount / baseline.parseCount,
  },
  baseline: {
    medianMs: baselineMedianMs,
    p95Ms: baselineP95Ms,
  },
  candidate: {
    medianMs: candidateMedianMs,
    p95Ms: candidateP95Ms,
  },
  improvement: {
    medianRatio: 1 - candidateMedianMs / baselineMedianMs,
    p95Ratio: 1 - candidateP95Ms / baselineP95Ms,
    medianSavedMs: baselineMedianMs - candidateMedianMs,
    p95SavedMs: baselineP95Ms - candidateP95Ms,
  },
  limitations: [
    "Synthetic SSE stream; no network, TLS, WebSocket framing, client processing, or model latency.",
    "The proxy still emits one WebSocket message per SSE event.",
    "Absolute timings depend on host load; equivalence and avoided work are deterministic.",
  ],
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
