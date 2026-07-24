import assert from "node:assert/strict";
import test from "node:test";
import {
  chatCompletionsToResponsesPayload,
  responsesToChatCompletionsPayload,
} from "../../responses/payloads.js";
import {
  buildImageAwareRoutingCandidates,
  buildUpstreamRequestHeaders,
  classifyNativeStreamCompletion,
  isStreamingUpstreamResponse,
} from "./index.js";

const discoveredModels: any[] = [
  {
    id: "text-model",
    object: "model",
    created: 0,
    owned_by: "openai",
    metadata: { provider: "openai" },
  },
  {
    id: "vision-model",
    object: "model",
    created: 0,
    owned_by: "openai",
    metadata: { provider: "openai" },
  },
  {
    id: "alias-model",
    object: "model",
    created: 0,
    owned_by: "openai",
    metadata: { provider: "openai" },
  },
];

const aliases: any[] = [
  {
    id: "normal-alias",
    enabled: true,
    targets: ["alias-model"],
  },
];

test("responses image request uses configured override", () => {
  const candidates = buildImageAwareRoutingCandidates(
    {
      model: "text-model",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,aaa" },
          ],
        },
      ],
    },
    discoveredModels,
    aliases,
    "vision-model",
  );

  assert.equal(candidates[0]?.requestedModel, "text-model");
  assert.equal(candidates[0]?.resolvedModel, "vision-model");
});

test("responses text-only request keeps normal alias routing", () => {
  const candidates = buildImageAwareRoutingCandidates(
    {
      model: "normal-alias",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    },
    discoveredModels,
    aliases,
    "vision-model",
  );

  assert.equal(candidates[0]?.requestedModel, "normal-alias");
  assert.equal(candidates[0]?.resolvedModel, "alias-model");
});

test("chat completions image request is detected before conversion", () => {
  const candidates = buildImageAwareRoutingCandidates(
    {
      model: "text-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
          ],
        },
      ],
    },
    discoveredModels,
    aliases,
    "vision-model",
  );

  assert.equal(candidates[0]?.requestedModel, "text-model");
  assert.equal(candidates[0]?.resolvedModel, "vision-model");
});

test("stream flag does not affect image routing", () => {
  const nonStream = buildImageAwareRoutingCandidates(
    {
      model: "text-model",
      stream: false,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aaa" }] }],
    },
    discoveredModels,
    aliases,
    "vision-model",
  );
  const stream = buildImageAwareRoutingCandidates(
    {
      model: "text-model",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aaa" }] }],
    },
    discoveredModels,
    aliases,
    "vision-model",
  );

  assert.equal(nonStream[0]?.resolvedModel, "vision-model");
  assert.equal(stream[0]?.resolvedModel, "vision-model");
});

test("cleared override restores normal routing", () => {
  const candidates = buildImageAwareRoutingCandidates(
    {
      model: "text-model",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aaa" }] }],
    },
    discoveredModels,
    aliases,
    undefined,
  );

  assert.equal(candidates[0]?.requestedModel, "text-model");
  assert.equal(candidates[0]?.resolvedModel, "text-model");
});

test("chat completions image parts are preserved when converted to responses", () => {
  const converted = chatCompletionsToResponsesPayload({
    model: "vision-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aaa" },
            detail: "high",
          },
        ],
      },
    ],
  });

  assert.deepEqual(converted.input[0].content, [
    { type: "input_text", text: "What is this?" },
    { type: "input_image", image_url: "data:image/png;base64,aaa", detail: "high" },
  ]);
});

test("responses image parts are preserved when converted to chat completions", () => {
  const converted = responsesToChatCompletionsPayload({
    model: "vision-model",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is this?" },
          { type: "input_image", image_url: "data:image/png;base64,aaa", detail: "high" },
        ],
      },
    ],
    stream: false,
  });

  assert.deepEqual(converted.messages[0].content, [
    { type: "text", text: "What is this?" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,aaa", detail: "high" },
    },
  ]);
});

test("responses top-level image inputs are converted to chat image messages", () => {
  const converted = responsesToChatCompletionsPayload({
    model: "vision-model",
    input: [
      {
        type: "input_image",
        data: "aaa",
        mime_type: "image/png",
        detail: "low",
      },
    ],
  });

  assert.deepEqual(converted.messages[0].content, [
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,aaa", detail: "low" },
    },
  ]);
});

test("OpenAI requests identify as Codex CLI for Luna compatibility", () => {
  const headers = buildUpstreamRequestHeaders("openai", "test-token");

  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["User-Agent"], "codex_cli_rs/0.144.1");
  assert.equal(headers.version, "0.144.1");
});

test("non-OpenAI requests retain the Pi identity", () => {
  const headers = buildUpstreamRequestHeaders("mistral", "test-token");

  assert.equal(headers.originator, "pi");
  assert.match(headers["User-Agent"]!, /^pi \(/);
  assert.equal(headers.version, undefined);
});

test("OpenAI Responses streams without a content-type header are relayed live", () => {
  assert.equal(
    isStreamingUpstreamResponse("", true, true, "openai", true),
    true,
  );
  assert.equal(
    isStreamingUpstreamResponse("application/json", true, false, "openai", true),
    false,
  );
  assert.equal(
    isStreamingUpstreamResponse("application/json", true, true, "mistral", true),
    false,
  );
});

test("client close after response.completed is classified as success", () => {
  assert.deepEqual(classifyNativeStreamCompletion(true, true), {
    interrupted: false,
    status: 200,
    clientDisconnected: undefined,
    error: undefined,
  });
  assert.deepEqual(classifyNativeStreamCompletion(true, false), {
    interrupted: true,
    status: 499,
    clientDisconnected: true,
    error: "client disconnected before stream completion",
  });
});
