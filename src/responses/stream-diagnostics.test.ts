import assert from "node:assert/strict";
import test from "node:test";
import {
  createResponseStreamDiagnostics,
  extractSSEFrameUsage,
  inspectResponseStreamEvent,
  inspectResponseStreamFrame,
} from "./stream-diagnostics.js";

function frame(event: any): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}`;
}

function inspectFrameBaseline(frameText: string, diagnostics: any): any {
  let usage: any = undefined;
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

test("fast frame inspection preserves complete stream diagnostics", () => {
  const frames = [
    ...Array.from({ length: 12 }, (_, index) =>
      frame({
        type: "response.output_text.delta",
        delta: `token-${index}`,
      }),
    ),
    frame({
      type: "response.output_text.done",
      text: "complete output",
    }),
    frame({
      type: "response.reasoning_summary_text.delta",
      delta: "reasoning",
    }),
    frame({
      type: "response.refusal.delta",
      delta: "refusal",
    }),
    frame({
      type: "response.output_item.added",
      item: {
        id: "custom-item",
        call_id: "custom-call",
        type: "custom_tool_call",
        name: "custom",
        status: "in_progress",
      },
    }),
    frame({
      type: "response.custom_tool_call_input.delta",
      item_id: "custom-item",
      call_id: "custom-call",
      name: "custom",
      delta: '{"value":1}',
    }),
    frame({
      type: "response.custom_tool_call_input.done",
      item_id: "custom-item",
      call_id: "custom-call",
      name: "custom",
    }),
    frame({
      type: "response.output_item.done",
      item: {
        id: "custom-item",
        call_id: "custom-call",
        type: "custom_tool_call",
        name: "custom",
        status: "completed",
      },
    }),
    frame({
      type: "response.output_item.done",
      item: {
        id: "function-item",
        call_id: "function-call",
        type: "function_call",
        name: "functions.hidden",
      },
    }),
    frame({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
        },
      },
    }),
    'data: {"object":"chat.completion.chunk","choices":[]}',
    "event: malformed\ndata: {not-json}",
    "data: [DONE]",
  ];
  const baseline = createResponseStreamDiagnostics();
  const candidate = createResponseStreamDiagnostics();
  let baselineUsage: any = undefined;
  let candidateUsage: any = undefined;

  for (const frameText of frames) {
    baselineUsage =
      inspectFrameBaseline(frameText, baseline) ?? baselineUsage;
    candidateUsage =
      inspectResponseStreamFrame(frameText, candidate) ?? candidateUsage;
  }

  assert.deepEqual(candidate, baseline);
  assert.deepEqual(candidateUsage, baselineUsage);
  assert.equal(candidate.outputTextDeltaCount, 12);
  assert.equal(candidate.reasoningEventCount, 1);
  assert.equal(candidate.refusalEventCount, 1);
  assert.equal(candidate.functionCallCount, 1);
  assert.equal(candidate.hiddenFunctionCallCount, 1);
  assert.equal(candidate.customToolCalls.length, 1);
  assert.equal(candidate.customToolCalls[0].inputBytes, 11);
  assert.equal(candidate.sawResponseCompleted, true);
  assert.equal(candidate.sawChatCompletionChunk, true);
});

test("multiple data payloads fall back to full parsing", () => {
  const combined = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"one"}',
    'data: {"type":"response.output_text.delta","delta":"two"}',
  ].join("\n");
  const baseline = createResponseStreamDiagnostics();
  const candidate = createResponseStreamDiagnostics();

  inspectFrameBaseline(combined, baseline);
  inspectResponseStreamFrame(combined, candidate);

  assert.deepEqual(candidate, baseline);
  assert.equal(candidate.outputTextDeltaCount, 2);
});

test("usage extraction ignores ordinary chunks and reads final usage", () => {
  assert.equal(
    extractSSEFrameUsage(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"}}]}',
    ),
    undefined,
  );
  assert.deepEqual(
    extractSSEFrameUsage(
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
    ),
    {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    },
  );
  assert.deepEqual(
    extractSSEFrameUsage(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
    ),
    {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  );
});
