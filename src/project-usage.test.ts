import assert from "node:assert/strict";
import test from "node:test";
import { aggregateProjectUsage } from "./project-usage.js";
import type { TraceEntry } from "./traces.js";

function trace(overrides: Partial<TraceEntry>): TraceEntry {
  return {
    id: crypto.randomUUID(),
    at: 1,
    route: "/responses",
    status: 200,
    isError: false,
    stream: false,
    latencyMs: 100,
    ...overrides,
  };
}

test("aggregates project cost, tokens and latency by model", () => {
  const [project] = aggregateProjectUsage([
    trace({ projectId: "project-a", projectName: "A", model: "gpt-a", tokensInput: 10, tokensInputCached: 2, tokensOutput: 5, tokensTotal: 15, costUsd: 0.01, usageStatus: "measured", latencyMs: 100 }),
    trace({ projectId: "project-a", model: "gpt-a", tokensInput: 20, tokensOutput: 8, tokensTotal: 28, costUsd: 0.02, usageStatus: "measured", latencyMs: 300 }),
    trace({ projectId: "project-a", model: "gpt-b", isError: true, status: 500, costStatus: "unpriced", latencyMs: 200 }),
  ]);

  assert.equal(project.projectId, "project-a");
  assert.equal(project.costUsd, 0.03);
  assert.equal(project.requestsWithCost, 2);
  assert.equal(project.unpricedRequests, 1);
  assert.deepEqual(project.tokens, { prompt: 30, completion: 13, input: 30, cachedInput: 2, output: 13, total: 43 });
  assert.equal(project.avgLatencyMs, 200);
  assert.equal(project.latencyP50Ms, 200);
  assert.equal(project.latencyP95Ms, 300);
  assert.equal(project.models[0].model, "gpt-a");
  assert.equal(project.models[0].costUsd, 0.03);
  assert.equal(project.models[0].avgLatencyMs, 200);
  assert.equal(project.models[1].errors, 1);
});
