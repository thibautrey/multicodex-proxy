import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativePath = path.join(repositoryRoot, "native", "multivibe-proxy-core.node");
assert.ok(fs.existsSync(nativePath), `native addon is missing: ${nativePath}`);

const require = createRequire(import.meta.url);
const native = require(nativePath);
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "rust", "proxy-core", "testdata", "payload-inspection-cases.json"),
    "utf8",
  ),
);
const sseFixtures = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "rust", "proxy-core", "testdata", "sse-fast-path-cases.json"),
    "utf8",
  ),
);
const protocolFixtures = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "rust", "proxy-core", "testdata", "protocol-conversion-cases.json"),
    "utf8",
  ),
);
const rawProtocolFixtures = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "rust", "proxy-core", "testdata", "raw-protocol-conversion-cases.json"),
    "utf8",
  ),
);

test("exports the raw-JSON payload inspection function", () => {
  assert.equal(typeof native.inspectPayloadContextJson, "function");
});

test("exports the conservative SSE fast-path classifier", () => {
  assert.equal(typeof native.classifySseFrame, "function");
});

test("exports the Chat Completions to Responses protocol projection", () => {
  assert.equal(typeof native.convertChatCompletionToResponseJson, "function");
  assert.equal(typeof native.tryConvertChatCompletionToResponseJson, "function");
  assert.equal(typeof native.tryConvertChatCompletionToResponseBytes, "function");
});

test("matches every shared TypeScript and Rust migration fixture", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(
      native.inspectPayloadContextJson(Buffer.from(JSON.stringify(fixture.payload))),
      fixture.expected,
      fixture.name,
    );
  }
});

test("rejects invalid JSON as an argument error", () => {
  assert.throws(
    () => native.inspectPayloadContextJson(Buffer.from("{")),
    /Invalid JSON payload/u,
  );
});

test("matches every shared SSE fast-path fixture", () => {
  for (const fixture of sseFixtures) {
    assert.equal(
      native.classifySseFrame(fixture.frame),
      fixture.expected ?? "",
      fixture.name,
    );
  }
});

test("matches every shared protocol conversion fixture", () => {
  for (const fixture of protocolFixtures) {
    const converted = JSON.parse(
      native.convertChatCompletionToResponseJson(
        Buffer.from(JSON.stringify(fixture.chat)),
        fixture.fallbackModel,
        fixture.responseId,
        fixture.createdAt,
      ),
    );
    assert.deepEqual(converted, fixture.expected, fixture.name);
  }
});

test("matches every shared raw-JSON protocol conversion fixture", () => {
  for (const fixture of rawProtocolFixtures) {
    const converted = JSON.parse(
      native.tryConvertChatCompletionToResponseJson(
        Buffer.from(` \n${JSON.stringify(fixture.chat)}\n `),
        fixture.fallbackModel,
        fixture.responseId,
        fixture.createdAt,
      ),
    );
    assert.deepEqual(converted, {
      hasAssistantOutput: true,
      response: fixture.expected,
    }, fixture.name);
  }
});

test("falls back for raw shapes whose nested JSON ordering is not preserved", () => {
  const fixture = protocolFixtures[1];
  assert.equal(
    native.tryConvertChatCompletionToResponseJson(
      Buffer.from(JSON.stringify(fixture.chat)),
      fixture.fallbackModel,
      fixture.responseId,
      fixture.createdAt,
    ),
    "",
  );
});

test("returns an empty raw-JSON projection for non-Chat bodies", () => {
  assert.equal(
    native.tryConvertChatCompletionToResponseJson(
      Buffer.from('{"object":"response","output":[]}'),
      "fallback-model",
      "resp_not_chat",
      1710000100,
    ),
    "",
  );
});

test("returns final JSON and SSE bodies as native Buffers", () => {
  const fixture = rawProtocolFixtures[0];
  const jsonResult = native.tryConvertChatCompletionToResponseBytes(
    Buffer.from(JSON.stringify(fixture.chat)),
    fixture.fallbackModel,
    fixture.responseId,
    fixture.createdAt,
    false,
  );
  assert.equal(jsonResult.supported, true);
  assert.equal(Buffer.isBuffer(jsonResult.body), true);
  assert.deepEqual(JSON.parse(jsonResult.body.toString("utf8")), fixture.expected);
  assert.deepEqual(jsonResult.usage, {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  });

  const sseResult = native.tryConvertChatCompletionToResponseBytes(
    Buffer.from(JSON.stringify(fixture.chat)),
    fixture.fallbackModel,
    fixture.responseId,
    fixture.createdAt,
    true,
  );
  assert.equal(sseResult.supported, true);
  assert.equal(Buffer.isBuffer(sseResult.body), true);
  assert.match(
    sseResult.body.toString("utf8"),
    /^event: response\.completed\ndata: /u,
  );
  const ssePayload = JSON.parse(
    sseResult.body.toString("utf8").split("data: ")[1].trim(),
  );
  assert.deepEqual(ssePayload, {
    type: "response.completed",
    response: fixture.expected,
  });
});

test("rejects native byte conversion when JavaScript would generate a tool id", () => {
  const result = native.tryConvertChatCompletionToResponseBytes(
    Buffer.from(JSON.stringify({
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: "calling a tool",
          tool_calls: [{
            type: "function",
            function: { name: "weather", arguments: "{}" },
          }],
        },
      }],
    })),
    "fallback-model",
    "resp_missing_tool_id",
    1710000100,
    false,
  );
  assert.equal(result.supported, false);
  assert.equal(result.body.length, 0);
});
