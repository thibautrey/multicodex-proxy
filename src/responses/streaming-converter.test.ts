import assert from "node:assert/strict";
import test from "node:test";

import {
  convertResponsesSSEToChatCompletionSSE,
  createResponsesToChatCompletionStreamState,
  finalizeResponsesSSEToChatCompletionSSE,
} from "./converters.js";

function frame(event: any): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function payloads(sse: string | null): any[] {
  if (!sse) return [];
  return sse
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

test("Responses text deltas are forwarded immediately as chat chunks", () => {
  const state = createResponsesToChatCompletionStreamState("gpt-test");
  const converted = convertResponsesSSEToChatCompletionSSE(
    frame({ type: "response.output_text.delta", delta: "Bon" }),
    state,
  );

  const [chunk] = payloads(converted);
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.model, "gpt-test");
  assert.deepEqual(chunk.choices[0].delta, {
    role: "assistant",
    content: "Bon",
  });
  assert.equal(chunk.choices[0].finish_reason, null);
  assert.equal(state.assistantOutputSent, true);
});

test("response.completed emits only missing text, usage, stop, and DONE", () => {
  const state = createResponsesToChatCompletionStreamState("gpt-test");
  const first = convertResponsesSSEToChatCompletionSSE(
    frame({ type: "response.output_text.delta", delta: "Bonjour" }),
    state,
  );
  assert.equal(payloads(first)[0].choices[0].delta.content, "Bonjour");

  const completed = convertResponsesSSEToChatCompletionSSE(
    frame({
      type: "response.completed",
      response: {
        model: "gpt-test",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Bonjour !" }],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    }),
    state,
  );

  const chunks = payloads(completed);
  assert.equal(chunks[0].choices[0].delta.content, " !");
  assert.equal(chunks[1].choices[0].finish_reason, "stop");
  assert.deepEqual(chunks[1].usage, {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
  });
  assert.match(completed ?? "", /data: \[DONE\]/);
  assert.equal(finalizeResponsesSSEToChatCompletionSSE(state), null);
});

test("Responses function calls stream name and argument deltas", () => {
  const state = createResponsesToChatCompletionStreamState("gpt-test");
  const added = convertResponsesSSEToChatCompletionSSE(
    frame({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "calendar_list",
        arguments: "",
      },
    }),
    state,
  );
  assert.deepEqual(payloads(added)[0].choices[0].delta, {
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "calendar_list", arguments: "" },
      },
    ],
  });

  const argumentsDelta = convertResponsesSSEToChatCompletionSSE(
    frame({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: '{"date":',
    }),
    state,
  );
  assert.deepEqual(payloads(argumentsDelta)[0].choices[0].delta, {
    tool_calls: [
      { index: 0, function: { arguments: '{"date":' } },
    ],
  });

  const completed = convertResponsesSSEToChatCompletionSSE(
    frame({
      type: "response.completed",
      response: {
        output: [
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "calendar_list",
            arguments: '{"date":"today"}',
          },
        ],
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
      },
    }),
    state,
  );
  const chunks = payloads(completed);
  assert.equal(
    chunks[0].choices[0].delta.tool_calls[0].function.arguments,
    '"today"}',
  );
  assert.equal(chunks[1].choices[0].finish_reason, "tool_calls");
  assert.match(completed ?? "", /data: \[DONE\]/);
});

test("a stream without response.completed is finalized after upstream EOF", () => {
  const state = createResponsesToChatCompletionStreamState("gpt-test");
  convertResponsesSSEToChatCompletionSSE(
    frame({ type: "response.output_text.delta", delta: "partial" }),
    state,
  );

  const completed = finalizeResponsesSSEToChatCompletionSSE(state);
  const [chunk] = payloads(completed);
  assert.equal(chunk.choices[0].finish_reason, "stop");
  assert.match(completed ?? "", /data: \[DONE\]/);
});

test("reasoning-only events do not start a chat response", () => {
  const state = createResponsesToChatCompletionStreamState("gpt-test");
  const converted = convertResponsesSSEToChatCompletionSSE(
    frame({ type: "response.reasoning.delta", delta: "secret" }),
    state,
  );

  assert.equal(converted, null);
  assert.equal(finalizeResponsesSSEToChatCompletionSSE(state), null);
  assert.equal(state.assistantOutputSent, false);
});
