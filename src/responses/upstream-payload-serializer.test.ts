import assert from "node:assert/strict";
import test from "node:test";
import { createUpstreamPayloadSerializer } from "./upstream-payload-serializer.js";

test("reuses serialization for the same input and payload variant", () => {
  const calls: unknown[] = [];
  const serialize = createUpstreamPayloadSerializer({
    minCacheCharacters: 0,
    stringify(value) {
      calls.push(value);
      return JSON.stringify(value);
    },
  });
  const input = [{ role: "user", content: "hello" }];
  const first = { model: "gpt-5.6-sol", input, stream: true };
  const second = { model: "gpt-5.6-sol", input, stream: true };

  assert.equal(serialize(first), JSON.stringify(first));
  assert.equal(serialize(second), JSON.stringify(first));
  assert.equal(calls.length, 3);
  assert.equal(calls[0], first);
  assert.deepEqual(calls[1], { model: "gpt-5.6-sol", stream: true });
  assert.deepEqual(calls[2], { model: "gpt-5.6-sol", stream: true });
});

test("misses when any non-input payload field changes", () => {
  let calls = 0;
  const serialize = createUpstreamPayloadSerializer({
    minCacheCharacters: 0,
    stringify(value) {
      calls += 1;
      return JSON.stringify(value);
    },
  });
  const input = [{ role: "user", content: "hello" }];
  const low = { model: "gpt-5.6-sol", input, reasoning: { effort: "low" } };
  const high = { model: "gpt-5.6-sol", input, reasoning: { effort: "high" } };

  assert.equal(serialize(low), JSON.stringify(low));
  assert.equal(serialize(high), JSON.stringify(high));
  assert.equal(calls, 4);
});

test("misses for a different input identity even when content matches", () => {
  let calls = 0;
  const serialize = createUpstreamPayloadSerializer({
    minCacheCharacters: 0,
    stringify(value) {
      calls += 1;
      return JSON.stringify(value);
    },
  });
  const first = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "hello" }],
  };
  const second = {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "hello" }],
  };

  serialize(first);
  serialize(second);
  assert.equal(calls, 4);
});

test("serializes payloads without an input array directly", () => {
  let calls = 0;
  const serialize = createUpstreamPayloadSerializer({
    stringify(value) {
      calls += 1;
      return JSON.stringify(value);
    },
  });
  const payload = { model: "chat-model", messages: [{ role: "user" }] };

  assert.equal(serialize(payload), JSON.stringify(payload));
  assert.equal(serialize(payload), JSON.stringify(payload));
  assert.equal(calls, 2);
});

test("does not build cache keys for small input arrays", () => {
  let calls = 0;
  const serialize = createUpstreamPayloadSerializer({
    stringify(value) {
      calls += 1;
      return JSON.stringify(value);
    },
  });
  const input = [{ role: "user", content: "short" }];
  const payload = { model: "gpt-5.6-sol", input };

  assert.equal(serialize(payload), JSON.stringify(payload));
  assert.equal(serialize({ ...payload }), JSON.stringify(payload));
  assert.equal(calls, 2);
});
