#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import {
  createResponseStreamDiagnostics,
  inspectResponseStreamFrame,
} from "../src/responses/stream-diagnostics.ts";
import { createSSEStreamTap } from "../src/responses/sse-stream-tap.ts";

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

function takeNextSSEFrame(buffer) {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  const lfBoundary = buffer.indexOf("\n\n");
  if (crlfBoundary === -1 && lfBoundary === -1) return null;
  if (crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary)) {
    return {
      frame: buffer.slice(0, crlfBoundary),
      rest: buffer.slice(crlfBoundary + 4),
    };
  }
  return {
    frame: buffer.slice(0, lfBoundary),
    rest: buffer.slice(lfBoundary + 2),
  };
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

function runBaseline(chunks, captureOutput = false) {
  const diagnostics = createResponseStreamDiagnostics();
  const decoder = new TextDecoder();
  const output = [];
  let outputBytes = 0;
  let writeCount = 0;
  let buffer = "";
  let usage;

  const forwardFrame = (frameText) => {
    usage = inspectResponseStreamFrame(frameText, diagnostics) ?? usage;
    const forwarded = frameText.endsWith("\n\n")
      ? frameText
      : `${frameText}\n\n`;
    writeCount += 1;
    outputBytes += Buffer.byteLength(forwarded);
    if (captureOutput) output.push(Buffer.from(forwarded));
  };

  for (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const next = takeNextSSEFrame(buffer);
      if (!next) break;
      buffer = next.rest;
      forwardFrame(next.frame);
    }
  }
  buffer += decoder.decode();
  while (true) {
    const next = takeNextSSEFrame(buffer);
    if (!next) break;
    buffer = next.rest;
    forwardFrame(next.frame);
  }
  if (buffer.trim()) forwardFrame(buffer);

  return {
    diagnostics,
    usage,
    outputBytes,
    writeCount,
    output: captureOutput ? Buffer.concat(output) : undefined,
  };
}

function runCandidate(chunks, captureOutput = false) {
  const diagnostics = createResponseStreamDiagnostics();
  const output = [];
  let outputBytes = 0;
  let writeCount = 0;
  let usage;
  const tap = createSSEStreamTap((frameText) => {
    usage = inspectResponseStreamFrame(frameText, diagnostics) ?? usage;
  });

  for (const chunk of chunks) {
    writeCount += 1;
    outputBytes += chunk.byteLength;
    if (captureOutput) output.push(Buffer.from(chunk));
    tap.push(chunk);
  }
  const { unterminatedFrame } = tap.finish();
  if (unterminatedFrame) {
    writeCount += 1;
    outputBytes += 2;
    if (captureOutput) output.push(Buffer.from("\n\n"));
  }

  return {
    diagnostics,
    usage,
    outputBytes,
    writeCount,
    output: captureOutput ? Buffer.concat(output) : undefined,
  };
}

const samples = numberArgument("samples", 500);
const textDeltaFrames = numberArgument("text-deltas", 1024);
const reasoningFrames = numberArgument("reasoning-events", 256);
const chunkBytes = numberArgument("chunk-bytes", 16 * 1024);
const streamText = [
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
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 100_000,
        output_tokens: 1_064,
        total_tokens: 101_064,
      },
    },
  }),
].join("");
const chunks = splitBytes(new TextEncoder().encode(streamText), chunkBytes);
const baselineSamples = [];
const candidateSamples = [];

runBaseline(chunks);
runCandidate(chunks);

for (let sample = 0; sample < samples; sample += 1) {
  const order =
    sample % 2 === 0
      ? [
          ["baseline", runBaseline],
          ["candidate", runCandidate],
        ]
      : [
          ["candidate", runCandidate],
          ["baseline", runBaseline],
        ];
  for (const [name, runner] of order) {
    const startedAt = performance.now();
    runner(chunks);
    const elapsedMs = performance.now() - startedAt;
    if (name === "baseline") baselineSamples.push(elapsedMs);
    else candidateSamples.push(elapsedMs);
  }
}

const baseline = runBaseline(chunks, true);
const candidate = runCandidate(chunks, true);
const diagnosticsEquivalent =
  JSON.stringify(baseline.diagnostics) ===
    JSON.stringify(candidate.diagnostics) &&
  JSON.stringify(baseline.usage) === JSON.stringify(candidate.usage);
const outputEquivalent =
  baseline.outputBytes === candidate.outputBytes &&
  baseline.output.equals(candidate.output);
if (!diagnosticsEquivalent || !outputEquivalent) {
  throw new Error("candidate output or diagnostics differ from baseline");
}

const baselineMedianMs = median(baselineSamples);
const candidateMedianMs = median(candidateSamples);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "synthetic_native_responses_sse_chunk_forwarding",
  samples,
  frameCount: textDeltaFrames + reasoningFrames + 2,
  chunkCount: chunks.length,
  chunkBytes,
  streamBytes: Buffer.byteLength(streamText),
  calibration:
    "The 1,024 text-delta scale approximates the observed local /responses output p95 of 1,064 tokens. Upstream chunk size is synthetic.",
  baseline: {
    medianMs: baselineMedianMs,
    p95Ms: percentile(baselineSamples, 0.95),
    writeCount: baseline.writeCount,
  },
  candidate: {
    medianMs: candidateMedianMs,
    p95Ms: percentile(candidateSamples, 0.95),
    writeCount: candidate.writeCount,
  },
  medianImprovementRatio:
    baselineMedianMs > 0 ? 1 - candidateMedianMs / baselineMedianMs : 0,
  diagnosticsEquivalent,
  outputEquivalent,
  tokenImpact: "none",
  note:
    "This isolates decoding, frame inspection, and downstream write scheduling. It excludes Express, sockets, provider, and model latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
