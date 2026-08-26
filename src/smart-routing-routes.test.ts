import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { JobStore } from "./jobs.js";
import { CapacityTracker, parseRoutingHeaders } from "./smart-routing.js";
import {
  SmartRoutingCoordinator,
  createAdmissionMiddleware,
  createSmartRoutingRouter,
} from "./smart-routing-routes.js";
import { AccountStore } from "./store.js";

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-routing-"));
  const store = new AccountStore(path.join(directory, "accounts.json"));
  await store.init();
  await store.addOrUpdate({
    id: "local",
    provider: "openai-compatible",
    baseUrl: "http://192.168.1.10:8000/v1",
    accessToken: "secret",
    enabled: true,
    location: "local",
    capacityProfile: { maxConcurrent: 1, decodeTokensPerSecond: 20 },
  });
  const jobs = new JobStore(path.join(directory, "jobs.sqlite"));
  const coordinator = new SmartRoutingCoordinator(store, jobs, new CapacityTracker());
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.proxyApplication = req.header("x-test-application") ?? "default";
    next();
  });
  app.use("/v1", createAdmissionMiddleware(coordinator), createSmartRoutingRouter(coordinator));
  app.post("/v1/responses", (_req, res) => res.json({ id: "sync" }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jobs.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, coordinator };
}

test("deferred admission returns a durable application-isolated job", async (t) => {
  const { baseUrl } = await fixture(t);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-application": "app-a",
      "x-multivibe-priority": "batch",
      "x-multivibe-execution": "defer",
      "x-multivibe-idempotency-key": "nightly-1",
    },
    body: JSON.stringify({ model: "local-model", input: "translate" }),
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-multivibe-decision"), "queued");
  const job = await response.json() as any;
  assert.equal(job.object, "multivibe.job");

  const own = await fetch(`${baseUrl}/v1/jobs/${job.id}`, {
    headers: { "x-test-application": "app-a" },
  });
  assert.equal(own.status, 200);
  const foreign = await fetch(`${baseUrl}/v1/jobs/${job.id}`, {
    headers: { "x-test-application": "app-b" },
  });
  assert.equal(foreign.status, 404);

  const duplicate = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-application": "app-a",
      "x-multivibe-execution": "defer",
      "x-multivibe-idempotency-key": "nightly-1",
    },
    body: JSON.stringify({ model: "local-model", input: "changed" }),
  });
  assert.equal((await duplicate.json() as any).id, job.id);
});

test("legacy sync stays synchronous and streams cannot be deferred", async (t) => {
  const { baseUrl } = await fixture(t);
  const legacy = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-model", input: "hello" }),
  });
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { id: "sync" });

  const stream = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-multivibe-execution": "defer",
    },
    body: JSON.stringify({ model: "local-model", input: "hello", stream: true }),
  });
  assert.equal(stream.status, 400);
  assert.equal(stream.headers.get("x-multivibe-decision"), "rejected");
});

test("invalid routing headers and saturated auto streams are rejected", async (t) => {
  const { baseUrl, coordinator } = await fixture(t);
  const invalid = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-multivibe-priority": "urgent",
    },
    body: JSON.stringify({ model: "local-model", input: "hello" }),
  });
  assert.equal(invalid.status, 400);

  const lease = coordinator.capacity.acquire("local", "local-model");
  const saturated = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-multivibe-execution": "auto",
      "x-multivibe-max-wait-ms": "0",
    },
    body: JSON.stringify({ model: "local-model", input: "hello", stream: true }),
  });
  lease.release();
  assert.equal(saturated.status, 429);
  assert.equal(saturated.headers.get("x-multivibe-decision"), "rejected");
});

test("an alias queue fallback overrides the legacy synchronous default", async (t) => {
  const { baseUrl, coordinator } = await fixture(t);
  await coordinator.store.upsertModelAlias({
    schemaVersion: 2,
    id: "queued-alias",
    enabled: true,
    rules: [
      {
        id: "local",
        candidates: [
          {
            model: "local-model",
            provider: "openai-compatible",
            location: "local",
          },
        ],
        onNoCapacity: "queue",
      },
    ],
  });
  const lease = coordinator.capacity.acquire("local", "local-model");
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "queued-alias", input: "hello" }),
  });
  lease.release();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-multivibe-decision"), "queued");
});

test("capacity snapshot is authenticated to the calling application", async (t) => {
  const { baseUrl } = await fixture(t);
  const response = await fetch(
    `${baseUrl}/v1/capacity?model=local-model&priority=interactive`,
    { headers: { "x-test-application": "app-a" } },
  );
  assert.equal(response.status, 200);
  const capacity = await response.json() as any;
  assert.equal(capacity.application, "app-a");
  assert.equal(capacity.state, "ready");
  assert.deepEqual(capacity.admissibleLocations, ["local"]);
  assert.equal(capacity.recommendation, "sync");
  assert.ok(capacity.version > 0);
  assert.ok(Date.parse(capacity.validUntil) > Date.parse(capacity.generatedAt));
});

test("cloud budgets publish threshold and unknown-cost warnings", async (t) => {
  const { coordinator } = await fixture(t);
  await coordinator.store.addOrUpdate({
    id: "cloud",
    provider: "openai",
    accessToken: "secret",
    enabled: true,
    location: "cloud",
  });
  await coordinator.store.upsertModelAlias({
    schemaVersion: 2,
    id: "budgeted",
    enabled: true,
    rules: [
      {
        id: "cloud",
        candidates: [
          {
            model: "cloud-model",
            provider: "openai",
            location: "cloud",
            inputCostPerMillionUsd: 0,
            outputCostPerMillionUsd: 100,
          },
        ],
        cloudBudget: { amountUsd: 1, period: "day" },
      },
    ],
  });
  const routing = parseRoutingHeaders(
    { "x-multivibe-priority": "critical" },
    "app-a",
  );
  const decision = coordinator.decision("budgeted", routing);
  coordinator.recordCloudConsumption(routing, decision, "cloud");
  coordinator.recordCloudConsumption(routing, decision, "cloud");
  const thresholds = coordinator
    .eventsAfter(0)
    .filter((event) => event.type === "budget.warning")
    .map((event: any) => event.data.thresholdPercent);
  assert.deepEqual(thresholds, [80, 100, 125, 150]);

  await coordinator.store.upsertModelAlias({
    schemaVersion: 2,
    id: "unpriced",
    enabled: true,
    rules: [
      {
        id: "cloud",
        candidates: [
          { model: "cloud-model", provider: "openai", location: "cloud" },
        ],
        cloudBudget: { amountUsd: 1, period: "day" },
      },
    ],
  });
  const unknownDecision = coordinator.decision("unpriced", routing);
  coordinator.recordCloudConsumption(routing, unknownDecision, "cloud");
  assert.ok(
    coordinator.eventsAfter(0).some(
      (event: any) =>
        event.type === "budget.warning" && event.data.type === "cost_unknown",
    ),
  );
});
