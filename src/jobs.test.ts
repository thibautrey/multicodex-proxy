import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { JobRunner, JobStore, WeightedFairScheduler, nextBatchWindowAt } from "./jobs.js";
import type { PriorityClass } from "./types.js";

test("priority scheduling follows 16/8/4/1 weights without starvation", () => {
  const scheduler = new WeightedFairScheduler();
  const priorities: PriorityClass[] = ["critical", "interactive", "standard", "batch"];
  const counts = Object.fromEntries(priorities.map((priority) => [priority, 0])) as Record<PriorityClass, number>;
  const candidates = priorities.map((priority) => ({ id: priority, application: priority, priority }));
  for (let index = 0; index < 2_900; index += 1) {
    const selected = scheduler.choose(candidates, () => 1)! as PriorityClass;
    counts[selected] += 1;
  }
  assert.deepEqual(counts, { critical: 1600, interactive: 800, standard: 400, batch: 100 });
});

test("application scheduling honors fairness weights", () => {
  const scheduler = new WeightedFairScheduler();
  const counts = { heavy: 0, light: 0 };
  const candidates = [
    { id: "heavy", application: "heavy", priority: "standard" as const },
    { id: "light", application: "light", priority: "standard" as const },
  ];
  for (let index = 0; index < 400; index += 1) {
    const selected = scheduler.choose(candidates, (application) => (application === "heavy" ? 3 : 1))!;
    counts[selected as keyof typeof counts] += 1;
  }
  assert.deepEqual(counts, { heavy: 300, light: 100 });
});

test("SQLite jobs survive restart, recover leases and remain isolated", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-jobs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "jobs.sqlite");
  let jobs = new JobStore(databasePath);
  const created = jobs.create({
    application: "app-a",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: { model: "test", input: "hello" },
    priority: "standard",
    model: "test",
    idempotencyKey: "same",
  });
  const duplicate = jobs.create({
    application: "app-a",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: { model: "other" },
    priority: "standard",
    idempotencyKey: "same",
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, created.job.id);
  assert.equal(jobs.get("app-b", created.job.id), undefined);
  const leased = jobs.acquire("worker", 1)!;
  assert.equal(leased.id, created.job.id);
  jobs.close();

  await new Promise((resolve) => setTimeout(resolve, 5));
  jobs = new JobStore(databasePath);
  const recovered = jobs.acquire("worker-2", 1_000)!;
  assert.equal(recovered.id, created.job.id);
  assert.equal(recovered.attempts, 2);
  jobs.succeed(recovered.id, "worker-2", { status: 200, body: { ok: true } });
  const result = jobs.consume("app-a", recovered.id)!;
  assert.deepEqual(result.result, { ok: true });
  assert.ok(jobs.events("app-a", recovered.id, 0)!.length >= 4);
  jobs.close();
});

test("cancellation, transient retry and deadlines are enforced", async () => {
  const jobs = new JobStore(":memory:");
  const cancelled = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "standard",
  }).job;
  assert.equal(jobs.cancel("app", cancelled.id), true);
  assert.equal(jobs.cancel("other", cancelled.id), false);

  const retried = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "critical",
  }).job;
  const lease = jobs.acquire("worker")!;
  assert.equal(lease.id, retried.id);
  assert.equal(jobs.fail(lease.id, "worker", "temporary", true), true);
  assert.equal(jobs.get("app", lease.id)?.status, "retry");

  const running = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "critical",
  }).job;
  const runningLease = jobs.acquire("worker")!;
  assert.equal(runningLease.id, running.id);
  assert.equal(jobs.cancel("app", running.id), true);
  assert.equal(jobs.get("app", running.id)?.status, "cancelled");

  const expiresWhileRunning = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "critical",
    deadlineAt: Date.now() + 5,
  }).job;
  const expiringLease = jobs.acquire("worker")!;
  assert.equal(expiringLease.id, expiresWhileRunning.id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    jobs.succeed(expiringLease.id, "worker", { status: 200, body: {} }),
    true,
  );
  assert.equal(jobs.get("app", expiringLease.id)?.status, "expired");

  const expired = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "batch",
    deadlineAt: Date.now() - 1,
    notBefore: Date.now(),
  }).job;
  jobs.acquire("worker");
  assert.equal(jobs.get("app", expired.id)?.status, "expired");
  jobs.close();
});

test("batch default is scheduled inside the Paris night window", () => {
  const midday = Date.parse("2026-08-26T12:00:00+02:00");
  assert.equal(nextBatchWindowAt(midday), Date.parse("2026-08-26T22:00:00+02:00"));
  const night = Date.parse("2026-08-26T23:00:00+02:00");
  assert.equal(nextBatchWindowAt(night), night);
});

test("expired worker leases stop after three attempts", async () => {
  const jobs = new JobStore(":memory:");
  const job = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "critical",
  }).job;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const leased = jobs.acquire(`worker-${attempt}`, 1)!;
    assert.equal(leased.id, job.id);
    assert.equal(leased.attempts, attempt);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  assert.equal(jobs.acquire("worker-4"), undefined);
  assert.equal(jobs.get("app", job.id)?.status, "failed");
  jobs.close();
});

test("webhooks are signed, carry an idempotent event id, and purge after 2xx", async (t) => {
  let received:
    | { body: string; signature?: string; eventId?: string }
    | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      received = {
        body: Buffer.concat(chunks).toString("utf8"),
        signature: req.headers["x-multivibe-signature"] as string,
        eventId: req.headers["x-multivibe-event-id"] as string,
      };
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const secret = "webhook-secret";
  const jobs = new JobStore(":memory:");
  t.after(() => jobs.close());
  const job = jobs.create({
    application: "app",
    route: "/v1/responses",
    requestHeaders: {},
    requestBody: {},
    priority: "standard",
    webhookId: "hook",
  }).job;
  const lease = jobs.acquire("seed")!;
  jobs.succeed(lease.id, "seed", { status: 200, body: { ok: true } });
  const runner = new JobRunner(
    jobs,
    async () => ({ status: 200, body: {} }),
    () => ({
      id: "hook",
      url: `http://127.0.0.1:${address.port}/result`,
      secret,
      enabled: true,
      createdAt: Date.now(),
    }),
  );
  await runner.tick();
  for (let index = 0; index < 20 && !received; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(received);
  assert.equal(
    received.signature,
    `sha256=${createHmac("sha256", secret).update(received.body).digest("hex")}`,
  );
  assert.equal(JSON.parse(received.body).id, received.eventId);
  assert.equal(jobs.pendingWebhookDeliveries().length, 0);
  assert.equal(jobs.get("app", job.id)?.status, "succeeded");
});
