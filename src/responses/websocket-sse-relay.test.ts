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
  const completion = relay.finish();

  return { messages, inspected, ...completion };
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
  assert.equal(result.terminalEvent, null);
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
  assert.equal(result.terminalEvent, "response.completed");
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
  assert.equal(result.terminalEvent, null);
});

test("flushes an unterminated final SSE frame", () => {
  const event = { type: "response.output_text.done", text: "complete" };
  const result = relayChunks(`data: ${JSON.stringify(event)}`, [5, 29]);

  assert.deepEqual(result.messages, [JSON.stringify(event)]);
  assert.deepEqual(result.inspected, []);
  assert.equal(result.terminalEvent, null);
  assert.equal(result.unterminatedFrame, true);
});

test("recognizes explicit failed, incomplete, and error terminal events", () => {
  const failed = {
    type: "response.failed",
    response: { error: { message: "provider rejected the request" } },
  };
  const upstreamError = {
    type: "error",
    error: { message: "provider stream failed" },
  };
  const incomplete = {
    type: "response.incomplete",
    response: { incomplete_details: { reason: "max_output_tokens" } },
  };

  const failedResult = relayChunks(
    `data: ${JSON.stringify(failed)}\n\n`,
    [9, 31],
  );
  const errorResult = relayChunks(
    `data: ${JSON.stringify(upstreamError)}\n\n`,
    [4, 27],
  );
  const incompleteResult = relayChunks(
    `data: ${JSON.stringify(incomplete)}\n\n`,
    [11, 42],
  );

  assert.equal(failedResult.terminalEvent, "response.failed");
  assert.deepEqual(failedResult.messages, [JSON.stringify(failed)]);
  assert.equal(errorResult.terminalEvent, "error");
  assert.deepEqual(errorResult.messages, [JSON.stringify(upstreamError)]);
  assert.equal(incompleteResult.terminalEvent, "response.incomplete");
  assert.deepEqual(incompleteResult.messages, [JSON.stringify(incomplete)]);
});

test("does not swallow delivery failures on canonical fallback frames", () => {
  const relay = createWebsocketSSEMessageRelay({
    onMessage: () => {
      throw new Error("websocket send failed");
    },
    onInspectableEvent: () => undefined,
  });
  const event = '{"type": "response.output_text.delta", "delta":"x"}';

  assert.throws(
    () => relay.push(encoder.encode(`data: ${event}\n\n`)),
    /websocket send failed/,
  );
});
