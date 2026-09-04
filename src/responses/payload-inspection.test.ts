import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  convertChatCompletionToResponseObjectFromJsonBytes,
  convertChatCompletionToResponseObjectFromNative,
  inspectPayloadContextFromJsonBytes,
  inspectPayloadContext,
  nativePayloadInspectionAvailable,
  nativeRawProtocolConversionAvailable,
  payloadHasImage,
} from "./payload-inspection.js";

type InspectionFixture = {
  name: string;
  payload: unknown;
  expected: {
    hasImage: boolean;
    compactionItemCount: number;
    latestCompactionIndex: number;
  };
};

const fixturePath = fileURLToPath(
  new URL("../../rust/proxy-core/testdata/payload-inspection-cases.json", import.meta.url),
);
const inspectionFixtures = JSON.parse(
  fs.readFileSync(fixturePath, "utf8"),
) as InspectionFixture[];
const protocolFixturePath = fileURLToPath(
  new URL("../../rust/proxy-core/testdata/protocol-conversion-cases.json", import.meta.url),
);
const protocolFixtures = JSON.parse(
  fs.readFileSync(protocolFixturePath, "utf8"),
) as Array<{
  chat: unknown;
  fallbackModel: string;
  responseId: string;
  createdAt: number;
  expected: Record<string, unknown>;
}>;
const rawProtocolFixturePath = fileURLToPath(
  new URL("../../rust/proxy-core/testdata/raw-protocol-conversion-cases.json", import.meta.url),
);
const rawProtocolFixtures = JSON.parse(
  fs.readFileSync(rawProtocolFixturePath, "utf8"),
) as typeof protocolFixtures;

test("matches every shared Rust migration fixture", () => {
  for (const fixture of inspectionFixtures) {
    assert.deepEqual(
      inspectPayloadContext(fixture.payload),
      fixture.expected,
      fixture.name,
    );
  }
});

test("uses the optional Rust implementation on raw JSON bytes without changing the contract", () => {
  const payload = {
    input: [
      { type: "compaction" },
      { content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] },
    ],
  };
  const inspected = inspectPayloadContextFromJsonBytes(
    Buffer.from(JSON.stringify(payload)),
  );

  if (!nativePayloadInspectionAvailable) {
    assert.equal(inspected, undefined);
    return;
  }

  assert.deepEqual(inspected, {
    hasImage: true,
    compactionItemCount: 1,
    latestCompactionIndex: 0,
  });
});

test("keeps the Responses image and compaction contract stable", () => {
  const payload = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "before" }] },
      { type: "compaction", encrypted_content: "opaque-one" },
      {
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }],
      },
      { type: "compaction", encrypted_content: "opaque-two" },
    ],
  };

  assert.deepEqual(inspectPayloadContext(payload), {
    hasImage: true,
    compactionItemCount: 2,
    latestCompactionIndex: 3,
  });
  assert.equal(payloadHasImage(payload), true);
});

test("recognizes images on both item and nested content types", () => {
  assert.equal(
    payloadHasImage({
      input: [
        { type: "computer_screenshot_image", data: "opaque" },
        { content: [{ type: "custom_image_part" }] },
      ],
    }),
    true,
  );
});

test("recognizes Chat Completions images without compaction data", () => {
  assert.deepEqual(
    inspectPayloadContext({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://example/image" } },
          ],
        },
      ],
    }),
    {
      hasImage: true,
      compactionItemCount: 0,
      latestCompactionIndex: -1,
    },
  );
});

test("ignores malformed or scalar payload branches like the current router", () => {
  for (const payload of [null, undefined, "text", 42, [], { input: {}, messages: {} }]) {
    assert.deepEqual(inspectPayloadContext(payload), {
      hasImage: false,
      compactionItemCount: 0,
      latestCompactionIndex: -1,
    });
  }
});

test("counts every compaction item and reports the last array index", () => {
  assert.deepEqual(
    inspectPayloadContext({
      input: [
        { type: "compaction" },
        { type: "input_text", content: [{ type: "text" }] },
        { type: "compaction" },
        { type: "compaction" },
      ],
    }),
    {
      hasImage: false,
      compactionItemCount: 3,
      latestCompactionIndex: 3,
    },
  );
});

test("uses the optional Rust protocol projection without changing the JSON contract", () => {
  const fixture = {
    chat: {
      object: "chat.completion",
      created: 1710000001,
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "<think>private</think> Visible " },
              { type: "text", text: "text" },
            ],
            tool_calls: [
              {
                id: "call-weather",
                type: "function",
                function: {
                  name: "weather",
                  arguments: { city: "Paris" },
                },
              },
              {
                id: "call-hidden",
                type: "function",
                function: { name: "functions.shell", arguments: "{}" },
              },
            ],
          },
        },
      ],
    },
    fallbackModel: "fallback-model",
    responseId: "resp_fixed_tools",
    createdAt: 1710000099,
  };

  const converted = convertChatCompletionToResponseObjectFromNative(
    fixture.chat,
    fixture.fallbackModel,
    fixture.responseId,
    fixture.createdAt,
  );
  if (!nativePayloadInspectionAvailable) {
    assert.equal(converted, undefined);
    return;
  }

  assert.deepEqual(JSON.parse(JSON.stringify(converted)), {
    id: "resp_fixed_tools",
    object: "response",
    created_at: 1710000001,
    model: "fallback-model",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Visible text" }],
      },
      {
        id: "call-weather",
        call_id: "call-weather",
        type: "function_call",
        name: "weather",
        arguments: "{\"city\":\"Paris\"}",
      },
    ],
  });
});

test("converts raw Chat Completions JSON before JavaScript parsing", () => {
  const fixture = rawProtocolFixtures[0];
  const converted = convertChatCompletionToResponseObjectFromJsonBytes(
    Buffer.from(` \n${JSON.stringify(fixture.chat)}\n `),
    fixture.fallbackModel,
    fixture.responseId,
    fixture.createdAt,
  );

  if (!nativeRawProtocolConversionAvailable) {
    assert.equal(converted, undefined);
    return;
  }

  assert.deepEqual(JSON.parse(JSON.stringify(converted)), {
    response: fixture.expected,
    hasAssistantOutput: true,
  });
});

test("converts raw tool-call JSON while preserving its argument string", () => {
  const fixture = rawProtocolFixtures[1];
  const converted = convertChatCompletionToResponseObjectFromJsonBytes(
    Buffer.from(JSON.stringify(fixture.chat)),
    fixture.fallbackModel,
    fixture.responseId,
    fixture.createdAt,
  );

  if (!nativeRawProtocolConversionAvailable) {
    assert.equal(converted, undefined);
    return;
  }

  assert.deepEqual(JSON.parse(JSON.stringify(converted)), {
    response: fixture.expected,
    hasAssistantOutput: true,
  });
});

test("falls back to the reference parser for unsupported raw shapes", () => {
  const fixture = protocolFixtures[1];
  assert.equal(
    convertChatCompletionToResponseObjectFromJsonBytes(
      Buffer.from(JSON.stringify(fixture.chat)),
      fixture.fallbackModel,
      fixture.responseId,
      fixture.createdAt,
    ),
    undefined,
  );
});

test("keeps raw conversion opt-in at the native boundary for non-Chat bodies", () => {
  assert.equal(
    convertChatCompletionToResponseObjectFromJsonBytes(
      Buffer.from('{"object":"response","output":[]}'),
      "fallback-model",
      "resp_not_chat",
      1710000100,
    ),
    undefined,
  );
  assert.equal(
    convertChatCompletionToResponseObjectFromJsonBytes(
      Buffer.from("{"),
      "fallback-model",
      "resp_invalid",
      1710000100,
    ),
    undefined,
  );
});
