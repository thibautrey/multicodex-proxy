#!/usr/bin/env node

import { shouldRetryUpstreamOnSameAccount } from "../src/upstream-retry.ts";

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return Math.floor(value);
}

function legacyShouldRetry(status, errorText) {
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function simulateResponsePolicy({
  responses,
  shouldRetry,
  maxRetries,
  baseDelayMs,
}) {
  let attempts = 0;
  let minimumBackoffMs = 0;
  let responseIndex = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response =
      responses[Math.min(responseIndex, responses.length - 1)];
    responseIndex += 1;
    attempts += 1;
    if (response.status >= 200 && response.status < 300) {
      return {
        finalStatus: response.status,
        attempts,
        minimumBackoffMs,
      };
    }
    if (
      attempt < maxRetries &&
      shouldRetry(response.status, response.body)
    ) {
      minimumBackoffMs += Math.max(
        response.retryAfterMs ?? 0,
        baseDelayMs * 2 ** attempt,
      );
      continue;
    }
    return {
      finalStatus: response.status,
      attempts,
      minimumBackoffMs,
    };
  }

  throw new Error("unreachable retry simulation state");
}

const maxRetries = numberArgument("max-retries", 5);
const baseDelayMs = numberArgument("base-delay-ms", 2_000);
const scenarios = [
  {
    name: "http_429",
    responses: [{ status: 429, body: "too many requests" }],
  },
  {
    name: "rate_limit_business_error",
    responses: [{ status: 400, body: "rate limit reached" }],
  },
  {
    name: "transient_503_then_success",
    responses: [
      { status: 503, body: "service unavailable" },
      { status: 200, body: "ok" },
    ],
  },
  {
    name: "persistent_503",
    responses: [{ status: 503, body: "service unavailable" }],
  },
];

const results = scenarios.map((scenario) => ({
  scenario: scenario.name,
  baseline: simulateResponsePolicy({
    responses: scenario.responses,
    shouldRetry: legacyShouldRetry,
    maxRetries,
    baseDelayMs,
  }),
  candidate: simulateResponsePolicy({
    responses: scenario.responses,
    shouldRetry: shouldRetryUpstreamOnSameAccount,
    maxRetries,
    baseDelayMs,
  }),
}));

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "deterministic_upstream_retry_policy",
  maxRetries,
  baseDelayMs,
  jitterMs: 0,
  results,
  quotaFailoverMinimumDelaySavedMs: results
    .filter((entry) =>
      entry.scenario === "http_429" ||
      entry.scenario === "rate_limit_business_error",
    )
    .map(
      (entry) =>
        entry.baseline.minimumBackoffMs -
        entry.candidate.minimumBackoffMs,
    ),
  note:
    "The benchmark computes the minimum configured backoff before account rotation. It performs no network calls and excludes random jitter; transient 5xx retries remain unchanged.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
