import assert from "node:assert/strict";
import test from "node:test";
import {
  CapacityTracker,
  capacityTokenUsage,
  aliasCandidateModels,
  evaluateAliasPolicy,
  inferAccountLocation,
  migrateModelAlias,
  parseRoutingHeaders,
  validateSmartAlias,
} from "./smart-routing.js";
import type { Account, ModelAlias } from "./types.js";

test("legacy effort aliases migrate to ordered v2 rules", () => {
  const alias = migrateModelAlias({
    id: "code",
    enabled: true,
    targets: ["low:fast", "high:quality", "fallback"],
  });
  assert.equal(alias.schemaVersion, 2);
  assert.deepEqual(alias.rules.map((rule) => rule.id), ["effort-low", "effort-high", "default"]);
  assert.deepEqual(aliasCandidateModels(alias, "high"), ["quality", "fallback"]);
  assert.deepEqual(validateSmartAlias(alias), []);
});

test("routing headers preserve legacy sync and apply priority presets on opt-in", () => {
  const legacy = parseRoutingHeaders({}, "app", 1);
  assert.equal(legacy.executionMode, "sync");
  assert.equal(legacy.priority, "standard");
  assert.equal(legacy.optedIn, false);

  const interactive = parseRoutingHeaders(
    { "x-multivibe-priority": "interactive" },
    "app",
    1,
  );
  assert.equal(interactive.executionMode, "sync");
  assert.equal(interactive.maxWaitMs, 2_000);

  const batch = parseRoutingHeaders({ "x-multivibe-priority": "batch" }, "app", 1);
  assert.equal(batch.executionMode, "defer");
});

test("locations infer RFC1918 and public endpoints", () => {
  assert.equal(
    inferAccountLocation({ provider: "openai-compatible", baseUrl: "http://192.168.1.10:8080/v1" }),
    "local",
  );
  assert.equal(
    inferAccountLocation({ provider: "openai-compatible", baseUrl: "https://api.example.com/v1" }),
    "cloud",
  );
  assert.equal(inferAccountLocation({ provider: "openai" }), "cloud");
});

test("first matching rule filters capacity and scoring is deterministic", () => {
  const alias: ModelAlias = {
    schemaVersion: 2,
    id: "smart",
    enabled: true,
    rules: [
      {
        id: "interactive",
        match: { priorities: ["interactive"] },
        constraints: { minQuality: 70 },
        objectives: { latency: 100, cost: 0, quality: 0, locality: 0 },
        candidates: [
          { model: "local", quality: 80 },
          { model: "cloud", quality: 90 },
        ],
        onNoCapacity: "queue",
      },
      { id: "fallback", candidates: [{ model: "other" }] },
    ],
  };
  const request = parseRoutingHeaders(
    { "x-multivibe-priority": "interactive" },
    "app",
    1,
  );
  const decision = evaluateAliasPolicy(alias, request, [
    {
      accountId: "local-account",
      model: "local",
      provider: "openai-compatible",
      location: "local",
      enabled: true,
      inFlight: 1,
      maxConcurrent: 1,
      freeSlots: 0,
      predictedWaitMs: 5_000,
      averageLatencyMs: 5_000,
      confidence: "declared",
    },
    {
      accountId: "cloud-account",
      model: "cloud",
      provider: "openai",
      location: "cloud",
      enabled: true,
      inFlight: 0,
      maxConcurrent: 8,
      freeSlots: 8,
      predictedWaitMs: 0,
      averageLatencyMs: 1_000,
      confidence: "observed",
    },
  ]);
  assert.equal(decision.rule?.id, "interactive");
  assert.equal(decision.eligible[0]?.config.model, "cloud");
  assert.ok(decision.candidates.find((entry) => entry.config.model === "local")?.rejectedReasons.includes("capacity_saturated"));
});

test("candidate locations filter resources and batch defaults remain local", () => {
  const cloudResource = {
    accountId: "cloud-account",
    model: "model",
    provider: "openai" as const,
    location: "cloud" as const,
    enabled: true,
    inFlight: 0,
    maxConcurrent: 8,
    freeSlots: 8,
    predictedWaitMs: 0,
    averageLatencyMs: 500,
    confidence: "observed" as const,
  };
  const batch = parseRoutingHeaders(
    { "x-multivibe-priority": "batch" },
    "app",
    1,
  );
  const implicit = evaluateAliasPolicy(
    {
      schemaVersion: 2,
      id: "implicit",
      enabled: true,
      rules: [{ id: "default", candidates: [{ model: "model" }] }],
    },
    batch,
    [cloudResource],
  );
  assert.ok(
    implicit.candidates[0]?.rejectedReasons.includes("batch_defaults_to_local"),
  );

  const explicitCloud = evaluateAliasPolicy(
    {
      schemaVersion: 2,
      id: "cloud-batch",
      enabled: true,
      rules: [
        {
          id: "cloud",
          candidates: [{ model: "model", location: "cloud" }],
        },
      ],
    },
    batch,
    [cloudResource],
  );
  assert.equal(explicitCloud.eligible.length, 1);

  const mislabeled = evaluateAliasPolicy(
    {
      schemaVersion: 2,
      id: "local-only",
      enabled: true,
      rules: [
        {
          id: "local",
          candidates: [{ model: "model", location: "local" }],
        },
      ],
    },
    parseRoutingHeaders({ "x-multivibe-priority": "interactive" }, "app", 1),
    [cloudResource],
  );
  assert.ok(
    mislabeled.candidates[0]?.rejectedReasons.includes(
      "candidate_location_mismatch",
    ),
  );
});

test("capacity leases release once and update observed EWMA", () => {
  const tracker = new CapacityTracker();
  const account: Account = {
    id: "local",
    provider: "openai-compatible",
    baseUrl: "http://10.0.0.2:8000",
    accessToken: "test",
    enabled: true,
    capacityProfile: { maxConcurrent: 1, prefillTokensPerSecond: 10 },
  };
  const lease = tracker.acquire("local", "model");
  let snapshot = tracker.snapshots([account], [
    { accountId: "local", model: "model", provider: "openai-compatible" },
  ])[0];
  assert.equal(snapshot.freeSlots, 0);
  lease.release({ latencyMs: 1_000, inputTokens: 100, outputTokens: 20 });
  lease.release({ latencyMs: 1 });
  snapshot = tracker.snapshots([account], [
    { accountId: "local", model: "model", provider: "openai-compatible" },
  ])[0];
  assert.equal(snapshot.freeSlots, 1);
  assert.equal(snapshot.prefillTokensPerSecond, 100);
  assert.equal(snapshot.decodeTokensPerSecond, 20);
});

test("capacity usage normalizes Responses and Chat token fields", () => {
  assert.deepEqual(
    capacityTokenUsage({ input_tokens: 120, output_tokens: 30 }),
    { inputTokens: 120, outputTokens: 30 },
  );
  assert.deepEqual(
    capacityTokenUsage({ prompt_tokens: "80", completion_tokens: 12 }),
    { inputTokens: 80, outputTokens: 12 },
  );
  assert.deepEqual(capacityTokenUsage({ input_tokens: -1 }), {
    inputTokens: undefined,
    outputTokens: undefined,
  });
});
