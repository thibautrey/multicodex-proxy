import assert from "node:assert/strict";
import test from "node:test";

import {
  responseHasAssistantOutput,
  responseStreamHasAssistantOutput,
} from "./sanitizers.js";
import { responsesToChatCompletionsPayload } from "./payloads.js";

const customToolCall = {
  id: "item_exec_1",
  type: "custom_tool_call",
  call_id: "call_exec_1",
  name: "exec",
  input: "ls -la",
  status: "completed",
};

test("custom tool calls count as usable Responses output", () => {
  assert.equal(
    responseHasAssistantOutput({ object: "response", output: [customToolCall] }),
    true,
  );
});

test("completed custom tool calls count as usable Responses stream output", () => {
  const stream = `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    item: customToolCall,
  })}\n\n`;

  assert.equal(
    responseStreamHasAssistantOutput(stream, {
      requireFunctionCallOutputItem: true,
    }),
    true,
  );
});

test("custom tool call output can cross a chat-completions fallback", () => {
  const payload = responsesToChatCompletionsPayload({
    model: "example",
    input: [
      customToolCall,
      {
        type: "custom_tool_call_output",
        call_id: "call_exec_1",
        output: "file.txt",
      },
    ],
  });

  assert.deepEqual(payload.messages, [
    { role: "assistant", content: "Custom tool call exec: ls -la" },
    { role: "tool", tool_call_id: "call_exec_1", content: "file.txt" },
  ]);
});
