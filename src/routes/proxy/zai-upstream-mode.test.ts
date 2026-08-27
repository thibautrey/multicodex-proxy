import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveUpstreamMode,
  shouldForwardDecodedResponseHeader,
} from "./index.js";

test("routes z.ai through chat completions for every public inference dialect", () => {
  const account = { provider: "zai" as const };

  assert.equal(resolveUpstreamMode(account, true, false), "chat/completions");
  assert.equal(resolveUpstreamMode(account, false, false), "chat/completions");
  assert.equal(resolveUpstreamMode(account, false, true), "chat/completions");
});

test("keeps an explicit z.ai upstream mode override", () => {
  assert.equal(
    resolveUpstreamMode(
      { provider: "zai", upstreamMode: "responses" },
      false,
      false,
    ),
    "responses",
  );
});

test("does not forward encoding metadata after fetch decoded the upstream body", () => {
  assert.equal(shouldForwardDecodedResponseHeader("content-encoding"), false);
  assert.equal(shouldForwardDecodedResponseHeader("Content-Length"), false);
  assert.equal(shouldForwardDecodedResponseHeader("content-type"), true);
});
