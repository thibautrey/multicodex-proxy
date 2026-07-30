import assert from "node:assert/strict";
import test from "node:test";
import { createWebsocketSSEMessageRelay } from "./websocket-sse-relay.js";

const encoder = new TextEncoder();

function relayChunks(stream: string, boundaries: number[]) {
  const messages: string[] = [];
  const inspected: unknown[] = [];
  const relay = createWebsocketSSEMessageRelay({
    onMessage: (message) => messages.push(message),
    onInspectableEvent: (event) => inspected.push(event),
  });
  const bytes = encoder.encode(stream);
  let offset = 0;

  for (const boundary of boundaries) {
    relay.push(bytes.slice(offset, boundary));
    offset = boundary;
  }
  relay.push(bytes.slice(offset));
  relay.finish();

  return { messages, inspected };
}

test("relays ordinary text and reasoning events without inspection", () => {
  const textEvent = {
    type: "response.output_text.delta",
    delta: "café",
  };
  const reasoningEvent = {
    type: "response.reasoning_summary_text.delta",
    delta: "résumé",
  };
  const stream =
    `event: ${textEvent.type}\ndata: ${JSON.stringify(textEvent)}\n\n` +
    `event: ${reasoningEvent.type}\r\ndata: ${JSON.stringify(reasoningEvent)}\r\n\r\n`;

  const result = relayChunks(stream, [7, 34, 58, 93]);

  assert.deepEqual(result.messages, [
    JSON.stringify(textEvent),
    JSON.stringify(reasoningEvent),
  ]);
  assert.deepEqual(result.inspected, []);
});

test("inspects function items and completed responses before relaying", () => {
  const added = {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
    },
  };
  const done = {
    type: "response.output_item.done",
    item: {
      ...added.item,
      arguments: '{"query":"final"}',
    },
  };
  const completed = {
    type: "response.completed",
    response: {
      output: [
        {
          type: "function_call",
          call_id: "call_2",
          name: "search",
          arguments: '{"query":"x"}',
        },
      ],
    },
  };
  const stream =
    `data: ${JSON.stringify(added)}\n\n` +
    `data: ${JSON.stringify(done)}\n\n` +
    `data: ${JSON.stringify(completed)}\n\n`;

  const result = relayChunks(stream, [1, 19, 77, 131, 209]);

  assert.deepEqual(result.messages, [
    JSON.stringify(added),
    JSON.stringify(done),
    JSON.stringify(completed),
  ]);
  assert.deepEqual(result.inspected, [added, done, completed]);
});

test("preserves canonical fallback behavior for multiline and invalid data", () => {
  const multiline =
    'event: response.output_text.delta\n' +
    'data: {"type":"response.output_text.delta",\n' +
    'data: "delta":"ok"}\n\n';
  const invalid = 'data: {"not":"valid",}\n\n';
  const done = "data: [DONE]\n\n";

  const result = relayChunks(multiline + invalid + done, [12, 53, 101]);

  assert.deepEqual(result.messages, [
    '{"type":"response.output_text.delta","delta":"ok"}',
  ]);
  assert.deepEqual(result.inspected, [
    { type: "response.output_text.delta", delta: "ok" },
  ]);
});

test("flushes an unterminated final SSE frame", () => {
  const event = { type: "response.output_text.done", text: "complete" };
  const result = relayChunks(`data: ${JSON.stringify(event)}`, [5, 29]);

  assert.deepEqual(result.messages, [JSON.stringify(event)]);
  assert.deepEqual(result.inspected, []);
});
