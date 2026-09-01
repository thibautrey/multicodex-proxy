import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd, estimateCostUsdWithoutCache, getModelPricing } from "./model-pricing.js";

const expected: Record<string, [number, number, number, number?]> = {
  "gpt-5.6-sol": [5, 0.5, 30, 6.25],
  "gpt-5.6-terra": [2, 0.2, 12, 2.5],
  "gpt-5.6-luna": [0.2, 0.02, 1.2, 0.25],
  "daybreak-blue-latest": [4, 0.4, 20, 5],
  "gpt-daybreak-blue-latest": [4, 0.4, 20, 5],
  "gpt-5.5": [5, 0.5, 30],
  "gpt-5.4": [2.5, 0.25, 15],
  "gpt-5.4-mini": [0.75, 0.075, 4.5],
  "gpt-5.3-codex": [1.75, 0.175, 14],
  "gpt-5.2": [1.75, 0.175, 14],
};

test("uses current standard API prices for the requested metered models", () => {
  for (const [model, [inputPer1M, cachedInputPer1M, outputPer1M, cacheWriteInputPer1M]] of Object.entries(expected)) {
    assert.deepEqual(getModelPricing(model), {
      inputPer1M,
      cachedInputPer1M,
      ...(cacheWriteInputPer1M
        ? { cacheWriteInputPer1M }
        : {}),
      outputPer1M,
      ...(model === "gpt-5.4"
        ? { longContext: { thresholdTokens: 272_000, inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 22.5 } }
        : model === "gpt-5.5"
          ? { longContext: { thresholdTokens: 272_000, inputPer1M: 10, cachedInputPer1M: 1, outputPer1M: 45 } }
          : {}),
    });
  }
});

test("keeps plan-only and unpublished service models unpriced", () => {
  assert.equal(getModelPricing("gpt-5.3-codex-spark"), undefined);
  assert.equal(getModelPricing("codex-auto-review"), undefined);
});

test("applies long-context prices after 272K input tokens", () => {
  assert.ok(Math.abs((estimateCostUsd("gpt-5.4", 272_001, 1_000) ?? 0) - 1.382505) < 1e-12);
  assert.ok(Math.abs((estimateCostUsd("gpt-5.5", 272_001, 1_000) ?? 0) - 2.76501) < 1e-12);
});

test("charges GPT-5.6 cache writes at 1.25x without double-counting input", () => {
  const cost = estimateCostUsd(
    "gpt-5.6-sol",
    1_000_000,
    0,
    200_000,
    300_000,
  );
  assert.equal(cost, 4.475);
});

test("prices cached input at the standard rate for the no-cache equivalent", () => {
  assert.equal(
    estimateCostUsdWithoutCache(
      "gpt-5.6-sol",
      1_000_000,
      0,
      300_000,
    ),
    5.375,
  );
});
