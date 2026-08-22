import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTraceHeaders,
  sanitizeRequestHeaders,
  serializeTraceHeaders,
  traceHeadersForRequest,
  TRACE_HEADERS_FORWARD_HEADER,
} from "./trace-headers.js";

test("sanitizes sensitive headers while preserving diagnostic headers", () => {
  const headers = sanitizeRequestHeaders({
    Authorization: "Bearer secret",
    "x-api-key": "proxy-secret",
    Cookie: "session=secret",
    "x-project-id": "project-alpha",
    "user-agent": "Codex Desktop/1.0",
    "x-repeat": ["one", "two"],
  });

  assert.deepEqual(headers, {
    authorization: "[REDACTED]",
    cookie: "[REDACTED]",
    "user-agent": "Codex Desktop/1.0",
    "x-api-key": "[REDACTED]",
    "x-project-id": "project-alpha",
    "x-repeat": "one, two",
  });
});

test("limits non-sensitive header values", () => {
  const headers = sanitizeRequestHeaders({
    "x-diagnostic": "x".repeat(600),
  });

  assert.equal(headers["x-diagnostic"], `${"x".repeat(512)}...[truncated]`);
});

test("recovers original headers forwarded through the websocket bridge", () => {
  const original = {
    authorization: "[REDACTED]",
    "x-project-id": "project-alpha",
  };
  const headers = traceHeadersForRequest({
    [TRACE_HEADERS_FORWARD_HEADER]: JSON.stringify(original),
    "x-project-id": "wrong-value",
  });

  assert.deepEqual(headers, original);
});

test("normalizes persisted trace headers and keeps them sanitized", () => {
  assert.deepEqual(
    normalizeTraceHeaders({
      Authorization: "should-not-survive",
      "x-project-id": "project-alpha",
    }),
    {
      authorization: "[REDACTED]",
      "x-project-id": "project-alpha",
    },
  );
  assert.equal(
    serializeTraceHeaders({ "x-project-id": "project-alpha" }),
    JSON.stringify({ "x-project-id": "project-alpha" }),
  );
});
