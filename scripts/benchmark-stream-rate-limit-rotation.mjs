#!/usr/bin/env node

import { isStreamingUpstreamResponse } from "../src/routes/proxy/index.ts";
import { shouldRetryUpstreamOnSameAccount } from "../src/upstream-retry.ts";

const accounts = [
  {
    id: "account-one",
    response: {
      status: 429,
      contentType: "text/event-stream",
      body: 'event: error\ndata: {"error":{"message":"rate limit reached"}}\n\n',
    },
  },
  {
    id: "account-two",
    response: {
      status: 200,
      contentType: "application/json",
      body: '{"object":"response","status":"completed"}',
    },
  },
];

function legacyIsStreaming(response) {
  return response.contentType.includes("text/event-stream");
}

function simulate(isStreaming) {
  const attemptedAccounts = [];
  for (const account of accounts) {
    attemptedAccounts.push(account.id);
    const response = account.response;
    if (isStreaming(response)) {
      return {
        finalStatus: response.status,
        successfulAccount: response.status === 200 ? account.id : null,
        attemptedAccounts,
        outcome:
          response.status === 200
            ? "success"
            : "error_stream_forwarded_to_client",
      };
    }
    if (
      response.status === 429 ||
      !shouldRetryUpstreamOnSameAccount(response.status, response.body)
    ) {
      if (response.status === 429 || /rate.?limit/i.test(response.body)) {
        continue;
      }
    }
    return {
      finalStatus: response.status,
      successfulAccount: response.status === 200 ? account.id : null,
      attemptedAccounts,
      outcome: response.status === 200 ? "success" : "error_returned",
    };
  }
  return {
    finalStatus: 429,
    successfulAccount: null,
    attemptedAccounts,
    outcome: "accounts_exhausted",
  };
}

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "deterministic_sse_rate_limit_rotation",
  baseline: simulate(legacyIsStreaming),
  candidate: simulate((response) =>
    isStreamingUpstreamResponse(
      response.contentType,
      false,
      response.status >= 200 && response.status < 300,
      "openai",
      Boolean(response.body),
    ),
  ),
  note:
    "The scenario fixes the first account to an HTTP 429 SSE error and the second to a successful JSON response. It measures routing outcome and attempts, not network latency.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
