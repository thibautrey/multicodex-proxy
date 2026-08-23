import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import {
  anthropicErrorEnvelope,
  anthropicRequestToResponses,
  buildClaudeCodeModelsResponse,
  formatAnthropicSseFrame,
  handleAnthropicMessages,
  isClaudeCodeRequest,
  mapClaudeCodeModel,
  responsesObjectToAnthropicMessage,
  ResponsesToAnthropicSse,
} from "./anthropic-compat.js";
import { TRACE_HEADERS_FORWARD_HEADER } from "./trace-headers.js";

test("detects Claude Code only when both identifying headers match", () => {
  assert.equal(
    isClaudeCodeRequest({ "user-agent": "claude-cli/2.1.241 (external, sdk-cli)", "x-app": "cli" }),
    true,
  );
  assert.equal(
    isClaudeCodeRequest({ "user-agent": "claude-cli/2.1.241", "x-app": "desktop" }),
    false,
  );
  assert.equal(
    isClaudeCodeRequest({ "user-agent": "anthropic-sdk-typescript/1.0", "x-app": "cli" }),
    false,
  );
});

test("maps Claude aliases for Claude Code and builds an Anthropic catalog", () => {
  const configured = { main: "gpt-main", fast: "gpt-fast" };
  assert.equal(mapClaudeCodeModel("claude-sonnet-4-5", true, configured), "gpt-main");
  assert.equal(mapClaudeCodeModel("claude-haiku-4-5", true, configured), "gpt-fast");
  assert.equal(mapClaudeCodeModel("anthropic/claude-3-haiku", true, configured), "gpt-fast");
  assert.equal(mapClaudeCodeModel("claude-opus-4-1", false, configured), "claude-opus-4-1");
  assert.equal(mapClaudeCodeModel("gpt-custom", true, configured), "gpt-custom");

  const catalog = buildClaudeCodeModelsResponse();
  assert.equal(catalog.object, "list");
  assert.deepEqual(
    catalog.data.map((model) => model.id),
    ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"],
  );
  assert.ok(catalog.data.every((model) => model.owned_by === "anthropic"));
});

test("converts Anthropic messages, images, tools, and tool results to Responses", () => {
  const converted = anthropicRequestToResponses(
    {
      model: "claude-haiku-4-5",
      system: [{ type: "text", text: "Use tools carefully." }],
      max_tokens: 4096,
      stream: true,
      metadata: { user_id: "user-1" },
      thinking: { type: "enabled", budget_tokens: 12_000 },
      tools: [{
        name: "weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      }],
      tool_choice: { type: "tool", name: "weather" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is here?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
            { type: "image", source: { type: "url", url: "https://example.test/map.png" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will check." },
            { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Sunny" }],
        },
      ],
    },
    { claudeCode: true, mainModel: "gpt-main", fastModel: "gpt-fast" },
  );

  assert.equal(converted.model, "gpt-fast");
  assert.equal(converted.instructions, "Use tools carefully.");
  assert.equal(converted.max_output_tokens, 4096);
  assert.equal(converted.stream, true);
  assert.deepEqual(converted.reasoning, { effort: "high" });
  assert.deepEqual(converted.metadata, { user_id: "user-1" });
  assert.deepEqual(converted.tool_choice, { type: "function", name: "weather" });
  assert.deepEqual(converted.tools[0], {
    type: "function",
    name: "weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  });
  assert.deepEqual(converted.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What is here?" },
        { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        { type: "input_image", image_url: "https://example.test/map.png" },
      ],
    },
    { role: "assistant", content: [{ type: "output_text", text: "I will check." }] },
    { type: "function_call", call_id: "toolu_1", name: "weather", arguments: '{"city":"Paris"}' },
    { type: "function_call_output", call_id: "toolu_1", output: "Sunny" },
  ]);
});

test("converts a Responses object to an Anthropic message identity and usage", () => {
  const message = responsesObjectToAnthropicMessage(
    {
      id: "resp_123",
      status: "completed",
      model: "gpt-main",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
        { type: "function_call", call_id: "toolu_9", name: "lookup", arguments: '{"id":9}' },
      ],
      usage: {
        input_tokens: 21,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 5 },
      },
    },
    "claude-sonnet-4-5",
  );

  assert.equal(message.id, "msg_resp_123");
  assert.equal(message.model, "claude-sonnet-4-5");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content, [
    { type: "text", text: "Checking" },
    { type: "tool_use", id: "toolu_9", name: "lookup", input: { id: 9 } },
  ]);
  assert.deepEqual(message.usage, {
    input_tokens: 21,
    output_tokens: 7,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  });
});

test("converts Responses text and tool streams into ordered Anthropic SSE", () => {
  const converter = new ResponsesToAnthropicSse("claude-opus-4-1");
  const frames = [
    ...converter.consume({ type: "response.created", response: { id: "resp_stream", usage: { input_tokens: 10 } } }),
    ...converter.consume({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
    ...converter.consume({ type: "response.output_item.done", item: { id: "msg_1", type: "message" } }),
    ...converter.consume({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "fc_1", type: "function_call", call_id: "toolu_1", name: "weather", arguments: "" },
    }),
    ...converter.consume({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' }),
    ...converter.consume({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"Paris"}' }),
    ...converter.consume({ type: "response.output_item.done", item: { id: "fc_1", type: "function_call" } }),
    ...converter.consume({
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ type: "function_call" }],
        usage: { input_tokens: 10, output_tokens: 6 },
      },
    }),
  ];

  assert.deepEqual(frames.map((frame) => frame.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(frames[0].data.message.model, "claude-opus-4-1");
  assert.deepEqual(frames[2].data.delta, { type: "text_delta", text: "Hi" });
  assert.deepEqual(frames[5].data.delta, { type: "input_json_delta", partial_json: '{"city":' });
  assert.equal(frames[8].data.delta.stop_reason, "tool_use");
  assert.match(formatAnthropicSseFrame(frames[0]), /^event: message_start\ndata: /);
});

test("hydrates text and tools when response.completed is the only output event", () => {
  const converter = new ResponsesToAnthropicSse("claude-sonnet-4-5");
  const frames = converter.consume({
    type: "response.completed",
    response: {
      id: "resp_completed_only",
      status: "completed",
      output: [
        {
          id: "msg_completed",
          type: "message",
          content: [{ type: "output_text", text: "Completed text" }],
        },
        {
          id: "fc_completed",
          type: "function_call",
          call_id: "toolu_completed",
          name: "lookup",
          arguments: '{"id":42}',
        },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    },
  });

  assert.deepEqual(frames.map((frame) => frame.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(frames[2].data.delta.text, "Completed text");
  assert.deepEqual(frames[4].data.content_block, {
    type: "tool_use",
    id: "toolu_completed",
    name: "lookup",
    input: {},
  });
  assert.equal(frames[5].data.delta.partial_json, '{"id":42}');
  assert.equal(frames[7].data.delta.stop_reason, "tool_use");
});

test("keeps tool identity when argument delta events omit metadata", () => {
  const converter = new ResponsesToAnthropicSse("claude-sonnet-4-5");
  const frames = [
    ...converter.consume({
      type: "response.output_item.added",
      item: {
        id: "fc_identity",
        type: "function_call",
        call_id: "toolu_identity",
        name: "lookup",
      },
    }),
    ...converter.consume({
      type: "response.function_call_arguments.delta",
      item_id: "fc_identity",
      delta: '{"query":"x"}',
    }),
  ];

  assert.deepEqual(frames[1].data.content_block, {
    type: "tool_use",
    id: "toolu_identity",
    name: "lookup",
    input: {},
  });
  assert.equal(frames[2].data.delta.partial_json, '{"query":"x"}');
});

test("maps JSON and failed-stream errors to Anthropic envelopes", () => {
  assert.deepEqual(anthropicErrorEnvelope(429, { error: { message: "slow down" } }), {
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  });
  const converter = new ResponsesToAnthropicSse("claude-sonnet-4-5");
  const frames = converter.consume({
    type: "response.failed",
    response: { error: { message: "provider failed" } },
  });
  assert.deepEqual(frames, [{
    event: "error",
    data: { type: "error", error: { type: "api_error", message: "provider failed" } },
  }]);
});

test("messages route loopback maps models, preserves identity, and forwards safe attribution", async (t) => {
  const app = express();
  app.use(express.json());
  let forwardedBody: any;
  let forwardedHeaders: http.IncomingHttpHeaders | undefined;
  app.post("/v1/responses", (req, res) => {
    forwardedBody = req.body;
    forwardedHeaders = req.headers;
    res.json({
      id: "resp_loopback",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  });
  app.post("/v1/messages", (req, res, next) => {
    handleAnthropicMessages(req, res).catch(next);
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  ));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.241 (external, sdk-cli)",
      "x-app": "cli",
      "x-api-key": "super-secret-proxy-key",
      "x-project-id": "project-one",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }], max_tokens: 32 }),
  });
  assert.equal(response.status, 200);
  const result: any = await response.json();
  assert.equal(result.model, "claude-sonnet-4-5");
  assert.equal(result.content[0].text, "ok");
  assert.equal(forwardedBody.model, "gpt-5.6-luna");
  assert.equal(forwardedHeaders?.["x-api-key"], "super-secret-proxy-key");
  assert.equal(forwardedHeaders?.["x-multivibe-client"], "claude-code");

  const attribution = JSON.parse(String(forwardedHeaders?.[TRACE_HEADERS_FORWARD_HEADER]));
  assert.equal(attribution["user-agent"], "claude-cli/2.1.241 (external, sdk-cli)");
  assert.equal(attribution["x-app"], "cli");
  assert.equal(attribution["x-project-id"], "project-one");
  assert.equal(attribution["x-multivibe-client"], "claude-code");
  assert.equal(attribution["x-api-key"], "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(attribution), /super-secret-proxy-key/);
});
