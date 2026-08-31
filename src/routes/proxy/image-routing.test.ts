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
  isModelAllowedByKeys,
  isStreamingUpstreamResponse,
  payloadHasImage,
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

test("detects images without building a detailed payload summary", () => {
  assert.equal(
    payloadHasImage({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "hello" },
            { type: "input_image", image_url: "data:image/png;base64,aaa" },
          ],
        },
      ],
    }),
    true,
  );
  assert.equal(
    payloadHasImage({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }),
    false,
  );
  assert.equal(
    payloadHasImage({
      input: [{ type: "computer_screenshot_image", data: "aaa" }],
    }),
    true,
  );
});

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

test("OpenCode requests include the selected workspace", () => {
  const headers = buildUpstreamRequestHeaders("opencode", "test-token", {
    opencodeOrgId: "org_123",
  });

  assert.equal(headers.authorization, "Bearer test-token");
  assert.equal(headers["x-org-id"], "org_123");
});

test("OpenCode requests omit an empty workspace header", () => {
  const headers = buildUpstreamRequestHeaders("opencode", "test-token");

  assert.equal(headers["x-org-id"], undefined);
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
  assert.deepEqual(
    classifyNativeStreamCompletion(
      true,
      true,
      new Error("upstream reader aborted after completion"),
    ),
    {
      interrupted: false,
      status: 200,
      clientDisconnected: undefined,
      error: undefined,
    },
  );
});

test("model validation fails open until discovery has populated the cache", () => {
  assert.equal(isModelAllowedByKeys("gpt-test", new Set()), true);
  assert.equal(
    isModelAllowedByKeys("gpt-test", new Set(["gpt-test"])),
    true,
  );
  assert.equal(
    isModelAllowedByKeys("missing-model", new Set(["gpt-test"])),
    false,
  );
});

test("model validation fails open when provider discovery is incomplete", () => {
  assert.equal(
    isModelAllowedByKeys("gpt-5.6-sol", new Set(["gpt-5.5"]), false),
    true,
  );
  assert.equal(
    isModelAllowedByKeys("gpt-5.6-sol", new Set(["gpt-5.5"]), true),
    false,
  );
});
