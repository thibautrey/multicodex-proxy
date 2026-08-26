import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ApplicationWebhook, PriorityClass } from "./types.js";
import { PRIORITY_CLASSES } from "./types.js";
import { PRIORITY_WEIGHTS, isWithinTimeWindow } from "./smart-routing.js";

export type JobStatus =
  | "queued"
  | "running"
  | "retry"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type DeferredJob = {
  id: string;
  application: string;
  route: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: JobStatus;
  priority: PriorityClass;
  model?: string;
  idempotencyKey?: string;
  webhookId?: string;
  deadlineAt?: number;
  notBefore: number;
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  consumedAt?: number;
};

export type CreateJobInput = Pick<
  DeferredJob,
  | "application"
  | "route"
  | "requestHeaders"
  | "requestBody"
  | "priority"
  | "model"
  | "idempotencyKey"
  | "webhookId"
  | "deadlineAt"
> & { method?: string; notBefore?: number };

export type SchedulingCandidate = { id: string; application: string; priority: PriorityClass };

/** Smooth weighted round-robin across priorities, then applications. */
export class WeightedFairScheduler {
  private priorityScores = new Map<PriorityClass, number>();
  private applicationScores = new Map<string, number>();

  choose(candidates: SchedulingCandidate[], applicationWeight: (application: string) => number): string | undefined {
    if (!candidates.length) return undefined;
    const priorities = PRIORITY_CLASSES.filter((priority) =>
      candidates.some((candidate) => candidate.priority === priority),
    );
    let selectedPriority = priorities[0];
    let selectedPriorityScore = Number.NEGATIVE_INFINITY;
    const priorityTotal = priorities.reduce((sum, priority) => sum + PRIORITY_WEIGHTS[priority], 0);
    for (const priority of priorities) {
      const next = (this.priorityScores.get(priority) ?? 0) + PRIORITY_WEIGHTS[priority];
      this.priorityScores.set(priority, next);
      if (next > selectedPriorityScore) {
        selectedPriority = priority;
        selectedPriorityScore = next;
      }
    }
    this.priorityScores.set(
      selectedPriority,
      (this.priorityScores.get(selectedPriority) ?? 0) - priorityTotal,
    );

    const matching = candidates.filter((candidate) => candidate.priority === selectedPriority);
    const applications = Array.from(new Set(matching.map((candidate) => candidate.application)));
    let selectedApplication = applications[0];
    let selectedApplicationScore = Number.NEGATIVE_INFINITY;
    const appTotal = applications.reduce(
      (sum, application) => sum + Math.max(0.1, applicationWeight(application)),
      0,
    );
    for (const application of applications) {
      const key = `${selectedPriority}:${application}`;
      const next =
        (this.applicationScores.get(key) ?? 0) +
        Math.max(0.1, applicationWeight(application));
      this.applicationScores.set(key, next);
      if (next > selectedApplicationScore) {
        selectedApplication = application;
        selectedApplicationScore = next;
      }
    }
    const selectedKey = `${selectedPriority}:${selectedApplication}`;
    this.applicationScores.set(
      selectedKey,
      (this.applicationScores.get(selectedKey) ?? 0) - appTotal,
    );
    return matching.find((candidate) => candidate.application === selectedApplication)?.id;
  }
}

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToJob(row: any, includeContent = true): DeferredJob {
  return {
    id: row.id,
    application: row.application,
    route: row.route,
    method: row.method,
    requestHeaders: includeContent ? jsonParse(row.request_headers_json, {}) : {},
    requestBody: includeContent ? jsonParse(row.request_json, null) : undefined,
    status: row.status,
    priority: row.priority,
    model: row.model ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    webhookId: row.webhook_id ?? undefined,
    deadlineAt: row.deadline_at ?? undefined,
    notBefore: row.not_before,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    responseStatus: row.response_status ?? undefined,
    responseHeaders: includeContent ? jsonParse(row.response_headers_json, undefined) : undefined,
    result: includeContent ? jsonParse(row.result_json, undefined) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
  };
}

export function nextBatchWindowAt(now = Date.now()): number {
  const window = { start: "22:00", end: "07:00", timezone: "Europe/Paris" };
  if (isWithinTimeWindow(window, now)) return now;
  for (let offset = 1; offset <= 24 * 60; offset += 1) {
    const candidate = now + offset * 60_000;
    if (isWithinTimeWindow(window, candidate)) return candidate;
  }
  return now + 24 * 60 * 60_000;
}

export class JobStore extends EventEmitter {
  readonly db: Database.Database;
  private scheduler = new WeightedFairScheduler();

  constructor(
    databasePath: string,
    private applicationWeight: (application: string) => number = () => 1,
  ) {
    super();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    if (databasePath !== ":memory:") fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    if (databasePath !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.chmodSync(`${databasePath}${suffix}`, 0o600);
        } catch {
          // WAL/SHM files are created lazily.
        }
      }
    }
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    const migrate = this.db.transaction(() => {
      const version = Number(this.db.pragma("user_version", { simple: true }));
      if (version < 1) {
        this.db.exec(`
          CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            application TEXT NOT NULL,
            route TEXT NOT NULL,
            method TEXT NOT NULL DEFAULT 'POST',
            request_headers_json TEXT NOT NULL DEFAULT '{}',
            request_json TEXT,
            status TEXT NOT NULL,
            priority TEXT NOT NULL,
            model TEXT,
            idempotency_key TEXT,
            webhook_id TEXT,
            deadline_at INTEGER,
            not_before INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            lease_owner TEXT,
            lease_expires_at INTEGER,
            response_status INTEGER,
            response_headers_json TEXT,
            result_json TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            consumed_at INTEGER,
            purge_after INTEGER
          );
          CREATE UNIQUE INDEX jobs_application_idempotency
            ON jobs(application, idempotency_key) WHERE idempotency_key IS NOT NULL;
          CREATE INDEX jobs_dispatch ON jobs(status, not_before, priority, created_at);
          CREATE TABLE job_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            application TEXT NOT NULL,
            type TEXT NOT NULL,
            data_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
          );
          CREATE INDEX job_events_replay ON job_events(job_id, id);
          CREATE TABLE webhook_deliveries (
            event_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            application TEXT NOT NULL,
            webhook_id TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            delivered_at INTEGER,
            last_error TEXT
          );
          CREATE TABLE budget_usage (
            application TEXT NOT NULL,
            alias_id TEXT NOT NULL,
            period_start INTEGER NOT NULL,
            cost_usd REAL,
            cost_unknown INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(application, alias_id, period_start)
          );
          PRAGMA user_version = 1;
        `);
      }
    });
    migrate();
  }

  close() {
    this.db.close();
  }

  private addEvent(jobId: string, application: string, type: string, data: unknown = {}) {
    const at = Date.now();
    const info = this.db
      .prepare(
        "INSERT INTO job_events(job_id, application, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(jobId, application, type, JSON.stringify(data), at);
    const event = { id: Number(info.lastInsertRowid), jobId, application, type, data, at };
    this.emit("job.event", event);
    return event;
  }

  create(input: CreateJobInput): { job: DeferredJob; created: boolean } {
    const existing = input.idempotencyKey
      ? this.db
          .prepare("SELECT * FROM jobs WHERE application = ? AND idempotency_key = ?")
          .get(input.application, input.idempotencyKey)
      : undefined;
    if (existing) return { job: rowToJob(existing), created: false };
    const now = Date.now();
    const id = randomUUID();
    const notBefore = input.notBefore ?? (input.priority === "batch" ? nextBatchWindowAt(now) : now);
    const insert = this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO jobs(
          id, application, route, method, request_headers_json, request_json,
          status, priority, model, idempotency_key, webhook_id, deadline_at,
          not_before, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`) 
        .run(
          id,
          input.application,
          input.route,
          input.method ?? "POST",
          JSON.stringify(input.requestHeaders),
          JSON.stringify(input.requestBody) ?? "null",
          input.priority,
          input.model ?? null,
          input.idempotencyKey ?? null,
          input.webhookId ?? null,
          input.deadlineAt ?? null,
          notBefore,
          now,
          now,
        );
      this.addEvent(id, input.application, "job.queued", { notBefore });
    });
    try {
      insert();
    } catch (error: any) {
      if (input.idempotencyKey && String(error?.code).includes("SQLITE_CONSTRAINT")) {
        const row = this.db
          .prepare("SELECT * FROM jobs WHERE application = ? AND idempotency_key = ?")
          .get(input.application, input.idempotencyKey);
        if (row) return { job: rowToJob(row), created: false };
      }
      throw error;
    }
    return { job: this.get(input.application, id)!, created: true };
  }

  list(application: string, limit = 100): DeferredJob[] {
    return (this.db
      .prepare("SELECT * FROM jobs WHERE application = ? ORDER BY created_at DESC LIMIT ?")
      .all(application, Math.max(1, Math.min(500, limit))) as any[]).map((row) =>
      rowToJob(row, false),
    );
  }

  get(application: string, id: string): DeferredJob | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE application = ? AND id = ?")
      .get(application, id);
    return row ? rowToJob(row) : undefined;
  }

  getAny(id: string): DeferredJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? rowToJob(row) : undefined;
  }

  queueDepth(application?: string, model?: string): number {
    const clauses = ["status IN ('queued', 'retry', 'running')"];
    const values: unknown[] = [];
    if (application) {
      clauses.push("application = ?");
      values.push(application);
    }
    if (model) {
      clauses.push("model = ?");
      values.push(model);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE ${clauses.join(" AND ")}`)
      .get(...values) as { count: number };
    return Number(row.count);
  }

  budgetUsage(application: string, aliasId: string, periodStart: number) {
    const row = this.db
      .prepare("SELECT cost_usd, cost_unknown FROM budget_usage WHERE application = ? AND alias_id = ? AND period_start = ?")
      .get(application, aliasId, periodStart) as any;
    return {
      costUsd: row?.cost_usd == null ? 0 : Number(row.cost_usd),
      costUnknown: Number(row?.cost_unknown ?? 0),
    };
  }

  recordBudgetUsage(
    application: string,
    aliasId: string,
    periodStart: number,
    costUsd: number | undefined,
  ) {
    this.db
      .prepare(`INSERT INTO budget_usage(application, alias_id, period_start, cost_usd, cost_unknown)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(application, alias_id, period_start) DO UPDATE SET
          cost_usd = COALESCE(budget_usage.cost_usd, 0) + COALESCE(excluded.cost_usd, 0),
          cost_unknown = budget_usage.cost_unknown + excluded.cost_unknown`)
      .run(application, aliasId, periodStart, costUsd ?? null, costUsd === undefined ? 1 : 0);
  }

  events(application: string, id: string, afterId = 0) {
    if (!this.get(application, id)) return undefined;
    return (this.db
      .prepare(
        "SELECT id, job_id, application, type, data_json, created_at FROM job_events WHERE job_id = ? AND application = ? AND id > ? ORDER BY id LIMIT 1000",
      )
      .all(id, application, afterId) as any[]).map((row) => ({
      id: row.id,
      jobId: row.job_id,
      application: row.application,
      type: row.type,
      data: jsonParse(row.data_json, {}),
      at: row.created_at,
    }));
  }

  acquire(owner: string, leaseMs = 60_000): DeferredJob | undefined {
    const now = Date.now();
    this.expireDeadlines(now);
    const exhausted = this.db
      .prepare(`SELECT id, application FROM jobs
        WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts`)
      .all(now) as Array<{ id: string; application: string }>;
    this.db
      .prepare(`UPDATE jobs SET status = 'failed', error = 'worker lease expired after maximum attempts',
        completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts`)
      .run(now, now, now);
    for (const job of exhausted) {
      this.addEvent(job.id, job.application, "job.failed", {
        error: "worker lease expired after maximum attempts",
      });
    }
    const rows = this.db
      .prepare(`SELECT id, application, priority FROM jobs
        WHERE (status IN ('queued', 'retry') OR (status = 'running' AND lease_expires_at <= ?))
          AND attempts < max_attempts
          AND not_before <= ? AND (deadline_at IS NULL OR deadline_at > ?)
        ORDER BY created_at LIMIT 1000`)
      .all(now, now, now) as SchedulingCandidate[];
    const selectedId = this.scheduler.choose(rows, this.applicationWeight);
    if (!selectedId) return undefined;
    const expires = now + leaseMs;
    const claim = this.db.transaction(() => {
      const info = this.db
        .prepare(`UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?,
          attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND (status IN ('queued', 'retry') OR (status = 'running' AND lease_expires_at <= ?))`)
        .run(owner, expires, now, selectedId, now);
      if (!info.changes) return undefined;
      const job = this.getAny(selectedId);
      if (job) this.addEvent(job.id, job.application, "job.started", { attempt: job.attempts, owner });
      return job;
    });
    return claim();
  }

  renew(id: string, owner: string, leaseMs = 60_000): boolean {
    return Boolean(
      this.db
        .prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'")
        .run(Date.now() + leaseMs, Date.now(), id, owner).changes,
    );
  }

  succeed(
    id: string,
    owner: string,
    response: { status: number; headers?: Record<string, string>; body: unknown },
  ): boolean {
    const now = Date.now();
    const job = this.getAny(id);
    if (!job || job.leaseOwner !== owner || job.status !== "running") return false;
    if (job.deadlineAt && job.deadlineAt <= now) {
      this.db
        .prepare(`UPDATE jobs SET status = 'expired', completed_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`)
        .run(now, now, id, owner);
      this.addEvent(id, job.application, "job.expired");
      return true;
    }
    this.db
      .prepare(`UPDATE jobs SET status = 'succeeded', response_status = ?, response_headers_json = ?,
        result_json = ?, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_owner = ?`)
      .run(
        response.status,
        JSON.stringify(response.headers ?? {}),
        JSON.stringify(response.body) ?? "null",
        now,
        now,
        id,
        owner,
      );
    this.addEvent(id, job.application, "job.succeeded", { status: response.status });
    if (job.webhookId) this.scheduleWebhook(job);
    return true;
  }

  fail(id: string, owner: string, error: string, transient = true): boolean {
    const job = this.getAny(id);
    if (!job || job.leaseOwner !== owner || job.status !== "running") return false;
    const now = Date.now();
    if (job.deadlineAt && job.deadlineAt <= now) {
      this.db
        .prepare(`UPDATE jobs SET status = 'expired', error = ?, completed_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`)
        .run(error, now, now, id, owner);
      this.addEvent(id, job.application, "job.expired", { error });
      return true;
    }
    const retry = transient && job.attempts < job.maxAttempts && (!job.deadlineAt || job.deadlineAt > now);
    const delay = retry ? Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)) : 0;
    this.db
      .prepare(`UPDATE jobs SET status = ?, error = ?, not_before = ?, updated_at = ?,
        completed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`)
      .run(retry ? "retry" : "failed", error, now + delay, now, retry ? null : now, id, owner);
    this.addEvent(id, job.application, retry ? "job.retry" : "job.failed", {
      error,
      attempt: job.attempts,
      nextAttemptAt: retry ? now + delay : undefined,
    });
    return true;
  }

  rescheduleForCapacity(id: string, owner: string, delayMs = 1_000): boolean {
    const job = this.getAny(id);
    if (!job || job.leaseOwner !== owner || job.status !== "running") return false;
    const now = Date.now();
    this.db
      .prepare(`UPDATE jobs SET status = 'queued', attempts = MAX(0, attempts - 1),
        not_before = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_owner = ?`)
      .run(now + Math.max(100, delayMs), now, id, owner);
    this.addEvent(id, job.application, "job.capacity_wait", {
      nextAttemptAt: now + Math.max(100, delayMs),
    });
    return true;
  }

  cancel(application: string, id: string): boolean {
    const now = Date.now();
    const info = this.db
      .prepare(`UPDATE jobs SET status = 'cancelled', completed_at = ?, updated_at = ?,
        lease_owner = NULL, lease_expires_at = NULL
        WHERE application = ? AND id = ? AND status IN ('queued', 'retry', 'running')`)
      .run(now, now, application, id);
    if (info.changes) this.addEvent(id, application, "job.cancelled");
    return Boolean(info.changes);
  }

  consume(application: string, id: string): DeferredJob | undefined {
    const job = this.get(application, id);
    if (!job || job.status !== "succeeded") return undefined;
    const now = Date.now();
    this.db
      .prepare("UPDATE jobs SET consumed_at = COALESCE(consumed_at, ?), purge_after = ?, updated_at = ? WHERE id = ?")
      .run(now, now + 60 * 60_000, now, id);
    this.addEvent(id, application, "job.consumed");
    return job;
  }

  private expireDeadlines(now = Date.now()) {
    const expired = this.db
      .prepare(`SELECT id, application FROM jobs WHERE status IN ('queued', 'retry') AND deadline_at <= ?`)
      .all(now) as Array<{ id: string; application: string }>;
    this.db
      .prepare(`UPDATE jobs SET status = 'expired', completed_at = ?, updated_at = ?
        WHERE status IN ('queued', 'retry') AND deadline_at <= ?`)
      .run(now, now, now);
    for (const job of expired) this.addEvent(job.id, job.application, "job.expired");
  }

  purge(now = Date.now()) {
    this.db
      .prepare(`UPDATE jobs SET request_json = NULL, request_headers_json = '{}', result_json = NULL,
        response_headers_json = NULL, status = 'expired', updated_at = ? WHERE
        (request_json IS NOT NULL OR result_json IS NOT NULL) AND (
          (purge_after IS NOT NULL AND purge_after <= ?)
          OR created_at <= ?
        )`)
      .run(now, now, now - 30 * 24 * 60 * 60_000);
    this.db.prepare("DELETE FROM job_events WHERE created_at <= ?").run(now - 30 * 24 * 60 * 60_000);
  }

  private scheduleWebhook(job: DeferredJob) {
    const now = Date.now();
    const eventId = randomUUID();
    this.db
      .prepare(`INSERT INTO webhook_deliveries(
        event_id, job_id, application, webhook_id, next_attempt_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(eventId, job.id, job.application, job.webhookId, now, now + 24 * 60 * 60_000);
  }

  pendingWebhookDeliveries(now = Date.now()) {
    return this.db
      .prepare(`SELECT * FROM webhook_deliveries
        WHERE delivered_at IS NULL AND next_attempt_at <= ? AND expires_at > ?
        ORDER BY next_attempt_at LIMIT 100`)
      .all(now, now) as any[];
  }

  finishWebhook(eventId: string, ok: boolean, error?: string) {
    const delivery = this.db
      .prepare("SELECT * FROM webhook_deliveries WHERE event_id = ?")
      .get(eventId) as any;
    if (!delivery) return;
    const now = Date.now();
    if (ok) {
      this.db
        .prepare("UPDATE webhook_deliveries SET attempts = attempts + 1, delivered_at = ?, last_error = NULL WHERE event_id = ?")
        .run(now, eventId);
      this.db
        .prepare("UPDATE jobs SET purge_after = ?, updated_at = ? WHERE id = ?")
        .run(now + 60 * 60_000, now, delivery.job_id);
      this.addEvent(delivery.job_id, delivery.application, "webhook.delivered", { eventId });
      return;
    }
    const attempts = Number(delivery.attempts) + 1;
    const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(12, attempts));
    this.db
      .prepare(`UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ?
        WHERE event_id = ?`)
      .run(attempts, now + delay, error ?? "delivery failed", eventId);
    this.addEvent(delivery.job_id, delivery.application, "webhook.retry", { eventId, attempts });
  }
}

export type JobExecutionResult = {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  transient?: boolean;
  capacityUnavailable?: boolean;
};

export class JobRunner {
  private timer?: NodeJS.Timeout;
  private active = new Set<string>();
  private deliveringWebhooks = false;
  private lastPurgeAt = 0;
  private owner = `worker-${randomUUID()}`;

  constructor(
    private jobs: JobStore,
    private execute: (job: DeferredJob) => Promise<JobExecutionResult>,
    private webhookFor: (application: string, id: string) => ApplicationWebhook | undefined,
    private maxConcurrency = 16,
  ) {}

  start(intervalMs = 250) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    while (this.active.size < this.maxConcurrency) {
      const job = this.jobs.acquire(this.owner);
      if (!job) break;
      this.active.add(job.id);
      void this.runJob(job);
    }
    if (!this.deliveringWebhooks) {
      this.deliveringWebhooks = true;
      await this.deliverWebhooks().finally(() => {
        this.deliveringWebhooks = false;
      });
    }
    if (Date.now() - this.lastPurgeAt >= 60 * 60_000) {
      this.jobs.purge();
      this.lastPurgeAt = Date.now();
    }
  }

  private async runJob(job: DeferredJob) {
    const renewal = setInterval(() => this.jobs.renew(job.id, this.owner), 20_000);
    renewal.unref?.();
    try {
      const result = await this.execute(job);
      if (result.capacityUnavailable) {
        this.jobs.rescheduleForCapacity(job.id, this.owner);
      } else if (result.status >= 200 && result.status < 300) {
        this.jobs.succeed(job.id, this.owner, result);
      } else {
        this.jobs.fail(
          job.id,
          this.owner,
          `upstream returned ${result.status}`,
          result.transient ?? (result.status >= 500 || result.status === 429),
        );
      }
    } catch (error: any) {
      this.jobs.fail(job.id, this.owner, error?.message ?? String(error), true);
    } finally {
      clearInterval(renewal);
      this.active.delete(job.id);
      queueMicrotask(() => void this.tick());
    }
  }

  private async deliverWebhooks() {
    for (const delivery of this.jobs.pendingWebhookDeliveries()) {
      const webhook = this.webhookFor(delivery.application, delivery.webhook_id);
      const job = this.jobs.getAny(delivery.job_id);
      if (!webhook?.enabled || !job) {
        this.jobs.finishWebhook(delivery.event_id, false, "webhook is not registered or enabled");
        continue;
      }
      const payload = JSON.stringify({
        id: delivery.event_id,
        type: "job.completed",
        createdAt: new Date().toISOString(),
        data: { job: publicJob(job), result: job.result },
      });
      const signature = createHmac("sha256", webhook.secret).update(payload).digest("hex");
      try {
        const response = await fetch(webhook.url, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-multivibe-event-id": delivery.event_id,
            "x-multivibe-signature": `sha256=${signature}`,
          },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });
        this.jobs.finishWebhook(
          delivery.event_id,
          response.status >= 200 && response.status < 300,
          `webhook returned ${response.status}`,
        );
      } catch (error: any) {
        this.jobs.finishWebhook(delivery.event_id, false, error?.message ?? String(error));
      }
    }
  }
}

export function publicJob(job: DeferredJob) {
  return {
    object: "multivibe.job",
    id: job.id,
    status: job.status,
    priority: job.priority,
    model: job.model,
    attempts: job.attempts,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString(),
    not_before: new Date(job.notBefore).toISOString(),
    deadline: job.deadlineAt ? new Date(job.deadlineAt).toISOString() : undefined,
    result_url: `/v1/jobs/${job.id}/result`,
    events_url: `/v1/jobs/${job.id}/events`,
    error: job.error,
  };
}
