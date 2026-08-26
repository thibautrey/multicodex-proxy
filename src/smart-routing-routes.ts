import { EventEmitter } from "node:events";
import express from "express";
import type { AccountStore } from "./store.js";
import type { JobStore } from "./jobs.js";
import { WeightedFairScheduler, publicJob } from "./jobs.js";
import { accountUsable, normalizeProvider } from "./quota.js";
import type { ModelAlias, PriorityClass, RoutingCandidateConfig } from "./types.js";
import { PRIORITY_CLASSES } from "./types.js";
import {
  CapacityTracker,
  evaluateAliasPolicy,
  parseRoutingHeaders,
  type PolicyDecision,
  type RoutingRequest,
} from "./smart-routing.js";

const PUBLIC_RESPONSE_HEADERS = [
  "content-type",
  "request-id",
  "openai-request-id",
  "anthropic-request-id",
];

function applicationFor(res: express.Response): string {
  return typeof res.locals.proxyApplication === "string"
    ? res.locals.proxyApplication
    : "default";
}

function requestContext(req: express.Request, application: string): RoutingRequest {
  const routing = parseRoutingHeaders(req.headers, application);
  routing.requiresTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;
  routing.effort =
    typeof req.body?.reasoning_effort === "string"
      ? req.body.reasoning_effort
      : typeof req.body?.reasoning?.effort === "string"
        ? req.body.reasoning.effort
        : undefined;
  const serialized = JSON.stringify(req.body ?? {});
  routing.estimatedInputTokens = Math.max(1, Math.ceil(serialized.length / 4));
  routing.modalities = [
    "text",
    ...(serialized.includes("input_image") ||
    serialized.includes("image_url") ||
    serialized.includes('"type":"image"')
      ? (["image"] as const)
      : []),
    ...(serialized.includes("input_audio") ? (["audio"] as const) : []),
  ];
  return routing;
}

function safeRequestHeaders(req: express.Request): Record<string, string> {
  const result: Record<string, string> = {};
  const excluded = new Set([
    "authorization",
    "x-api-key",
    "api-key",
    "cookie",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, value] of Object.entries(req.headers)) {
    if (
      excluded.has(name) ||
      name.startsWith("x-multivibe-") ||
      value === undefined
    ) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function aliasFor(store: AccountStore, model: string | undefined): ModelAlias | undefined {
  const key = String(model ?? "").toLowerCase();
  return store
    .getCachedModelAliases()
    .find((alias) => alias.enabled && alias.id.toLowerCase() === key);
}

function candidatesFor(alias: ModelAlias | undefined, model: string): RoutingCandidateConfig[] {
  if (!alias) return [{ model }];
  return alias.rules.flatMap((rule) => rule.candidates);
}

export class SmartRoutingCoordinator extends EventEmitter {
  private events: Array<{ id: number; type: string; at: number; data: unknown }> = [];
  private healthTimer?: NodeJS.Timeout;
  private admissionScheduler = new WeightedFairScheduler();
  private admissionWaiters: Array<{
    id: string;
    request: RoutingRequest;
    model: string;
    accepts: (decision: PolicyDecision) => boolean;
    resolve: (decision: PolicyDecision | undefined) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private dispatchingAdmissions = false;

  constructor(
    readonly store: AccountStore,
    readonly jobs: JobStore,
    readonly capacity: CapacityTracker,
  ) {
    super();
    this.capacity.on("capacity.changed", (event) => {
      this.publish(event.type, event.data, event.id);
      this.dispatchAdmissions();
    });
  }

  private publish(type: string, data: unknown, preferredId?: number) {
    const last = this.events.at(-1)?.id ?? 0;
    const event = { id: Math.max(last + 1, preferredId ?? 0), type, at: Date.now(), data };
    this.events.push(event);
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
    this.emit("event", event);
  }

  publishBudgetWarning(data: unknown) {
    this.publish("budget.warning", data);
  }

  recordCloudConsumption(request: RoutingRequest, decision: PolicyDecision, accountId: string) {
    const alias = decision.alias;
    const rule = decision.rule;
    const candidate = decision.candidates.find(
      (entry) =>
        entry.resource.accountId === accountId && entry.resource.location === "cloud",
    );
    if (!alias || !rule?.cloudBudget || !candidate) return;
    const periodStart = budgetPeriodStart(rule.cloudBudget.period, Date.now());
    const before = this.jobs.budgetUsage(request.application, alias.id, periodStart);
    this.jobs.recordBudgetUsage(
      request.application,
      alias.id,
      periodStart,
      candidate.estimatedCostUsd,
    );
    if (candidate.estimatedCostUsd === undefined) {
      this.publishBudgetWarning({
        application: request.application,
        alias: alias.id,
        rule: rule.id,
        type: "cost_unknown",
      });
      return;
    }
    const afterUsd = before.costUsd + candidate.estimatedCostUsd;
    const beforePercent = (before.costUsd / rule.cloudBudget.amountUsd) * 100;
    const afterPercent = (afterUsd / rule.cloudBudget.amountUsd) * 100;
    const thresholds = [80, 100];
    for (let threshold = 125; threshold <= afterPercent; threshold += 25) thresholds.push(threshold);
    for (const threshold of thresholds) {
      if (beforePercent < threshold && afterPercent >= threshold) {
        this.publishBudgetWarning({
          application: request.application,
          alias: alias.id,
          rule: rule.id,
          thresholdPercent: threshold,
          spentUsd: afterUsd,
          limitUsd: rule.cloudBudget.amountUsd,
        });
      }
    }
  }

  eventsAfter(id: number) {
    return this.events.filter((event) => event.id > id);
  }

  waitForAdmission(
    model: string,
    request: RoutingRequest,
    timeoutMs: number,
    accepts: (decision: PolicyDecision) => boolean,
  ) {
    return new Promise<PolicyDecision | undefined>((resolve) => {
      const id = `${request.application}:${Date.now()}:${Math.random()}`;
      const finish = (decision: PolicyDecision | undefined) => {
        const index = this.admissionWaiters.findIndex((waiter) => waiter.id === id);
        if (index >= 0) this.admissionWaiters.splice(index, 1);
        resolve(decision);
      };
      const timer = setTimeout(() => finish(undefined), Math.max(1, timeoutMs));
      timer.unref?.();
      this.admissionWaiters.push({ id, request, model, accepts, resolve: finish, timer });
      queueMicrotask(() => this.dispatchAdmissions());
    });
  }

  private dispatchAdmissions() {
    if (this.dispatchingAdmissions || !this.admissionWaiters.length) return;
    this.dispatchingAdmissions = true;
    try {
      const eligible = this.admissionWaiters.flatMap((waiter) => {
        const decision = this.decision(waiter.model, waiter.request);
        return waiter.accepts(decision) ? [{ waiter, decision }] : [];
      });
      const selectedId = this.admissionScheduler.choose(
        eligible.map(({ waiter }) => ({
          id: waiter.id,
          application: waiter.request.application,
          priority: waiter.request.priority,
        })),
        (application) => this.store.getApplicationPolicy(application).fairnessWeight,
      );
      const selected = eligible.find(({ waiter }) => waiter.id === selectedId);
      if (selected) {
        clearTimeout(selected.waiter.timer);
        selected.waiter.resolve(selected.decision);
      }
    } finally {
      this.dispatchingAdmissions = false;
    }
  }

  startHealthMonitoring(intervalMs = 15_000) {
    if (this.healthTimer) return;
    const poll = () => void this.pollHealthEndpoints();
    this.healthTimer = setInterval(poll, intervalMs);
    this.healthTimer.unref?.();
    poll();
  }

  stopHealthMonitoring() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  private async pollHealthEndpoints() {
    await Promise.all(
      this.store.getCachedAccounts().map(async (account) => {
        const healthUrl = account.capacityProfile?.healthUrl;
        if (healthUrl) {
          try {
            const response = await fetch(healthUrl, {
              redirect: "error",
              signal: AbortSignal.timeout(3_000),
            });
            this.capacity.setAccountHealth(account.id, response.ok);
          } catch {
            this.capacity.setAccountHealth(account.id, false);
          }
        } else this.capacity.clearAccountHealth(account.id);
        const metricsUrl = account.capacityProfile?.metricsUrl;
        if (metricsUrl) {
          try {
            const response = await fetch(metricsUrl, {
              redirect: "error",
              signal: AbortSignal.timeout(3_000),
            });
            if (!response.ok) return;
            const metrics = await response.json() as Record<string, unknown>;
            const number = (key: string) =>
              typeof metrics[key] === "number" && Number.isFinite(metrics[key])
                ? Number(metrics[key])
                : undefined;
            this.capacity.setAccountMetrics(account.id, {
              maxConcurrent: number("maxConcurrent") ?? number("max_concurrent"),
              prefillTokensPerSecond:
                number("prefillTokensPerSecond") ?? number("prefill_tokens_per_second"),
              decodeTokensPerSecond:
                number("decodeTokensPerSecond") ?? number("decode_tokens_per_second"),
              contextWindow: number("contextWindow") ?? number("context_window"),
            });
          } catch {
            // Metrics are optional; health remains authoritative.
          }
        } else this.capacity.clearAccountMetrics(account.id);
      }),
    );
  }

  resources(model: string, alias = aliasFor(this.store, model)) {
    const accounts = this.store.getCachedAccounts();
    const overrides = new Map<string, NonNullable<RoutingCandidateConfig["capacityProfile"]>>();
    const entries = candidatesFor(alias, model).flatMap((candidate) =>
      accounts
        .filter((account) => {
          if (candidate.provider && normalizeProvider(account) !== candidate.provider) return false;
          if (candidate.accountIds?.length && !candidate.accountIds.includes(account.id)) return false;
          return true;
        })
        .map((account) => {
          if (candidate.capacityProfile) {
            overrides.set(
              `${account.id}::${candidate.model.toLowerCase()}`,
              candidate.capacityProfile,
            );
          }
          return {
            accountId: account.id,
            model: candidate.model,
            provider: normalizeProvider(account),
            enabled: accountUsable(account, candidate.model),
          };
        }),
    );
    const unique = Array.from(
      new Map(entries.map((entry) => [`${entry.accountId}:${entry.model}`, entry])).values(),
    );
    return this.capacity.snapshots(accounts, unique, overrides);
  }

  decision(model: string, request: RoutingRequest): PolicyDecision {
    const alias = aliasFor(this.store, model);
    const effectiveAlias: ModelAlias = alias ?? {
      schemaVersion: 2,
      id: model,
      enabled: true,
      rules: [{ id: "direct-model", candidates: [{ model }], onNoCapacity: "reject" }],
    };
    return evaluateAliasPolicy(
      effectiveAlias,
      request,
      this.resources(model, alias),
      8_192,
    );
  }

  snapshot(model: string, request: RoutingRequest) {
    const generatedAt = Date.now();
    const decision = this.decision(model, request);
    const all = decision.candidates;
    const enabled = all.filter((candidate) =>
      !candidate.rejectedReasons.some((reason) => reason !== "capacity_saturated"),
    );
    const freeSlots = decision.eligible.reduce(
      (sum, candidate) => sum + candidate.resource.freeSlots,
      0,
    );
    const state = decision.eligible.length
      ? freeSlots > 0
        ? "ready"
        : "degraded"
      : enabled.length
        ? decision.onNoCapacity === "queue"
          ? "queue_only"
          : "degraded"
        : "unavailable";
    const predictedWaitMs = enabled.length
      ? Math.min(...enabled.map((candidate) => candidate.resource.predictedWaitMs))
      : undefined;
    const confidence = all.some((candidate) => candidate.resource.confidence === "observed")
      ? "observed"
      : all.some((candidate) => candidate.resource.confidence === "stale")
        ? "stale"
        : "declared";
    const alias = aliasFor(this.store, model);
    const budget = decision.rule?.cloudBudget && alias
      ? {
          limitUsd: decision.rule.cloudBudget.amountUsd,
          period: decision.rule.cloudBudget.period,
          ...this.jobs.budgetUsage(request.application, alias.id, budgetPeriodStart(decision.rule.cloudBudget.period, generatedAt)),
        }
      : undefined;
    return {
      object: "multivibe.capacity",
      model,
      application: request.application,
      priority: request.priority,
      state,
      decision: decision.eligible[0]?.resource.location,
      admissibleLocations: Array.from(new Set(enabled.map((candidate) => candidate.resource.location))),
      freeSlots,
      estimatedPrefillTokensPerSecond: maximum(enabled.map((candidate) => candidate.resource.prefillTokensPerSecond)),
      estimatedDecodeTokensPerSecond: maximum(enabled.map((candidate) => candidate.resource.decodeTokensPerSecond)),
      estimatedWaitMs: predictedWaitMs,
      queueDepth: this.jobs.queueDepth(request.application, model),
      budget,
      recommendation: decision.eligible.length ? "sync" : "defer",
      version: this.capacity.getVersion(),
      generatedAt: new Date(generatedAt).toISOString(),
      validUntil: new Date(generatedAt + 5_000).toISOString(),
      confidence,
      rule: decision.rule?.id,
    };
  }
}

function maximum(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? Math.max(...finite) : undefined;
}

function budgetPeriodStart(period: "hour" | "day" | "month", at: number) {
  const date = new Date(at);
  if (period === "hour") date.setUTCMinutes(0, 0, 0);
  else if (period === "day") date.setUTCHours(0, 0, 0, 0);
  else date.setUTCDate(1), date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function setDecisionHeaders(
  res: express.Response,
  data: {
    decision: "local" | "cloud" | "queued" | "rejected";
    priority: PriorityClass;
    resolvedModel?: string;
    waitMs?: number;
    capacityVersion: number;
  },
) {
  res.setHeader("X-MultiVibe-Decision", data.decision);
  res.setHeader("X-MultiVibe-Priority", data.priority);
  if (data.resolvedModel) res.setHeader("X-MultiVibe-Resolved-Model", data.resolvedModel);
  res.setHeader("X-MultiVibe-Estimated-Wait-Ms", String(Math.max(0, Math.round(data.waitMs ?? 0))));
  res.setHeader("X-MultiVibe-Capacity-Version", String(data.capacityVersion));
}

function sendSse(res: express.Response, event: { id: number; type: string; data: unknown }) {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

export function createSmartRoutingRouter(coordinator: SmartRoutingCoordinator) {
  const router = express.Router();

  router.get("/capacity", (req, res) => {
    const model = String(req.query.model ?? "").trim();
    if (!model) return res.status(400).json({ error: "model query parameter is required" });
    const rawPriority = String(req.query.priority ?? "standard");
    if (!PRIORITY_CLASSES.includes(rawPriority as PriorityClass)) {
      return res.status(400).json({ error: "invalid priority" });
    }
    const routing = parseRoutingHeaders(
      { "x-multivibe-priority": rawPriority },
      applicationFor(res),
    );
    res.json(coordinator.snapshot(model, routing));
  });

  router.get("/capacity/events", (req, res) => {
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    const application = applicationFor(res);
    const after = Number(req.header("last-event-id") ?? req.query.after ?? 0) || 0;
    const visibleEvent = (event: any) => {
      if (
        event.type === "budget.warning" &&
        event.data?.application &&
        event.data.application !== application
      ) return;
      sendSse(
        res,
        event.type === "capacity.changed"
          ? { ...event, data: { version: coordinator.capacity.getVersion() } }
          : event,
      );
    };
    for (const event of coordinator.eventsAfter(after)) visibleEvent(event);
    const listener = (event: any) => visibleEvent(event);
    coordinator.on("event", listener);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref?.();
    res.on("close", () => {
      clearInterval(heartbeat);
      coordinator.off("event", listener);
    });
  });

  router.get("/jobs", (req, res) => {
    res.json({ object: "list", data: coordinator.jobs.list(applicationFor(res), Number(req.query.limit) || 100).map(publicJob) });
  });

  router.get("/jobs/:id", (req, res) => {
    const job = coordinator.jobs.get(applicationFor(res), req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    res.json(publicJob(job));
  });

  router.get("/jobs/:id/result", (req, res) => {
    const job = coordinator.jobs.get(applicationFor(res), req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (job.status !== "succeeded") {
      if (["failed", "cancelled", "expired"].includes(job.status)) {
        return res.status(410).json({ error: job.error ?? `job ${job.status}` });
      }
      return res.status(409).json({ error: "result is not ready", job: publicJob(job) });
    }
    const consumed = coordinator.jobs.consume(applicationFor(res), req.params.id)!;
    for (const name of PUBLIC_RESPONSE_HEADERS) {
      const value = consumed.responseHeaders?.[name];
      if (value) res.setHeader(name, value);
    }
    res.json(consumed.result);
  });

  router.get("/jobs/:id/events", (req, res) => {
    const application = applicationFor(res);
    const after = Number(req.header("last-event-id") ?? req.query.after ?? 0) || 0;
    const initial = coordinator.jobs.events(application, req.params.id, after);
    if (!initial) return res.status(404).json({ error: "not found" });
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders();
    for (const event of initial) sendSse(res, event);
    const listener = (event: any) => {
      if (event.jobId === req.params.id && event.application === application) sendSse(res, event);
    };
    coordinator.jobs.on("job.event", listener);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref?.();
    res.on("close", () => {
      clearInterval(heartbeat);
      coordinator.jobs.off("job.event", listener);
    });
  });

  router.delete("/jobs/:id", (req, res) => {
    const application = applicationFor(res);
    if (!coordinator.jobs.get(application, req.params.id)) return res.status(404).json({ error: "not found" });
    if (!coordinator.jobs.cancel(application, req.params.id)) {
      return res.status(409).json({ error: "job can no longer be cancelled" });
    }
    res.status(204).end();
  });

  return router;
}

export function createAdmissionMiddleware(coordinator: SmartRoutingCoordinator): express.RequestHandler {
  return async (req, res, next) => {
    const inferenceRoute = /\/(?:responses|chat\/completions|messages)$/.test(req.path);
    if (req.method !== "POST" || !inferenceRoute) {
      if (
        req.method === "POST" &&
        req.path.includes("realtime") &&
        req.header("x-multivibe-execution") === "defer"
      ) {
        return res.status(400).json({
          error: {
            message: "Realtime requests cannot be deferred.",
            type: "invalid_request_error",
            code: "realtime_cannot_be_deferred",
          },
        });
      }
      return next();
    }
    const application = applicationFor(res);
    const rawPriority = req.header("x-multivibe-priority");
    if (rawPriority && !PRIORITY_CLASSES.includes(rawPriority as PriorityClass)) {
      return res.status(400).json({ error: "invalid X-MultiVibe-Priority" });
    }
    const rawExecution = req.header("x-multivibe-execution");
    if (rawExecution && !["sync", "auto", "defer"].includes(rawExecution)) {
      return res.status(400).json({ error: "invalid X-MultiVibe-Execution" });
    }
    const rawMaxWait = req.header("x-multivibe-max-wait-ms");
    if (rawMaxWait && !/^\d+$/.test(rawMaxWait.trim())) {
      return res.status(400).json({ error: "X-MultiVibe-Max-Wait-Ms must be a non-negative integer" });
    }
    const routing = requestContext(req, application);
    const rawDeadline = req.header("x-multivibe-deadline");
    if (
      rawDeadline &&
      (!routing.deadlineAt ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(rawDeadline))
    ) {
      return res.status(400).json({ error: "X-MultiVibe-Deadline must be RFC 3339" });
    }
    if ((routing.idempotencyKey?.length ?? 0) > 200) {
      return res.status(400).json({ error: "X-MultiVibe-Idempotency-Key is too long" });
    }
    if ((routing.webhookId?.length ?? 0) > 100) {
      return res.status(400).json({ error: "X-MultiVibe-Webhook is too long" });
    }
    const requestedModel =
      typeof req.body?.model === "string" ? req.body.model.trim() : "";
    const imageOverride = routing.modalities.includes("image")
      ? coordinator.store.getCachedSettings().imageRequestModelOverride
      : undefined;
    const model = imageOverride || requestedModel;
    const alias = aliasFor(coordinator.store, model);
    if (!routing.optedIn && alias?.defaults) {
      if (alias.defaults.priority) routing.priority = alias.defaults.priority;
      if (alias.defaults.executionMode) routing.executionMode = alias.defaults.executionMode;
    }
    const streaming = Boolean(req.body?.stream);
    const internalJob = req.header("x-multivibe-internal-job") === "1";
    if (streaming && routing.executionMode === "defer" && !internalJob) {
      res.locals.multivibeTrace = {
        priority: routing.priority,
        routingDecision: "rejected",
        capacityVersion: coordinator.capacity.getVersion(),
      };
      setDecisionHeaders(res, {
        decision: "rejected",
        priority: routing.priority,
        resolvedModel: model,
        capacityVersion: coordinator.capacity.getVersion(),
      });
      return res.status(400).json({
        error: {
          message: "Streaming, WebSocket and Realtime requests cannot be deferred.",
          type: "invalid_request_error",
          code: "stream_cannot_be_deferred",
        },
      });
    }
    if (internalJob) routing.executionMode = "sync";
    let decision = model ? coordinator.decision(model, routing) : undefined;
    const waitUntil = Math.min(
      Date.now() + routing.maxWaitMs,
      routing.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const interactiveNeedsLocalWait =
      !internalJob &&
      !streaming &&
      routing.optedIn &&
      routing.priority === "interactive" &&
      !decision?.eligible.some((entry) => entry.resource.location === "local") &&
      decision?.candidates.some(
        (entry) =>
          entry.resource.location === "local" &&
          entry.rejectedReasons.length === 1 &&
          entry.rejectedReasons[0] === "capacity_saturated",
      );
    const autoNeedsCapacityWait =
      !internalJob &&
      !streaming &&
      routing.executionMode === "auto" &&
      !decision?.eligible.length;
    if ((interactiveNeedsLocalWait || autoNeedsCapacityWait) && waitUntil > Date.now()) {
      const admitted = await coordinator.waitForAdmission(
        model,
        routing,
        waitUntil - Date.now(),
        (candidateDecision) =>
          interactiveNeedsLocalWait
            ? candidateDecision.eligible.some(
                (entry) => entry.resource.location === "local",
              )
            : candidateDecision.eligible.length > 0,
      );
      decision = admitted ?? (model ? coordinator.decision(model, routing) : undefined);
    }
    const shouldQueue =
      !internalJob &&
      !streaming &&
      (routing.executionMode === "defer" ||
        (!decision?.eligible.length &&
          (routing.executionMode === "auto" || decision?.onNoCapacity === "queue")));
    if (shouldQueue) {
      if (routing.deadlineAt && routing.deadlineAt <= Date.now()) {
        res.locals.multivibeTrace = {
          priority: routing.priority,
          routingDecision: "rejected",
          capacityVersion: coordinator.capacity.getVersion(),
        };
        setDecisionHeaders(res, {
          decision: "rejected",
          priority: routing.priority,
          resolvedModel: model,
          capacityVersion: coordinator.capacity.getVersion(),
        });
        return res.status(408).json({ error: "deadline already expired" });
      }
      if (routing.webhookId) {
        const webhook = coordinator.store
          .getApplicationPolicy(application)
          .webhooks.find((entry) => entry.id === routing.webhookId && entry.enabled);
        if (!webhook) return res.status(400).json({ error: "webhook is not registered for this application" });
      }
      const { job } = coordinator.jobs.create({
        application,
        route: req.originalUrl.split("?")[0],
        requestHeaders: safeRequestHeaders(req),
        requestBody: req.body,
        priority: routing.priority,
        model: model || undefined,
        idempotencyKey: routing.idempotencyKey,
        webhookId: routing.webhookId,
        deadlineAt: routing.deadlineAt,
      });
      res.locals.multivibeTrace = {
        priority: routing.priority,
        routingDecision: "queued",
        routingRule: decision?.rule?.id,
        routingScores: decision?.candidates.map((entry) => ({
          model: entry.config.model,
          accountId: entry.resource.accountId,
          score: entry.score,
          rejectedReasons: entry.rejectedReasons,
        })),
        admissionWaitMs: Date.now() - routing.now,
        jobId: job.id,
        capacityVersion: coordinator.capacity.getVersion(),
      };
      setDecisionHeaders(res, {
        decision: "queued",
        priority: routing.priority,
        resolvedModel: model,
        waitMs: Math.max(0, job.notBefore - Date.now()),
        capacityVersion: coordinator.capacity.getVersion(),
      });
      res.setHeader("location", `/v1/jobs/${job.id}`);
      return res.status(202).json(publicJob(job));
    }
    if (
      decision &&
      !decision.eligible.length &&
      (internalJob || routing.optedIn || Boolean(alias))
    ) {
      const waitMs = Math.min(
        ...decision.candidates.map((entry) => entry.resource.predictedWaitMs),
        1_000,
      );
      setDecisionHeaders(res, {
        decision: "rejected",
        priority: routing.priority,
        resolvedModel: model,
        waitMs,
        capacityVersion: coordinator.capacity.getVersion(),
      });
      res.locals.multivibeTrace = {
        priority: routing.priority,
        routingDecision: "rejected",
        routingRule: decision.rule?.id,
        admissionWaitMs: Date.now() - routing.now,
        capacityVersion: coordinator.capacity.getVersion(),
      };
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(waitMs / 1_000))));
      return res.status(429).json({
        error: {
          message: "No admissible capacity is currently available.",
          type: "rate_limit_error",
          code: "capacity_unavailable",
        },
      });
    }
    res.locals.multivibeRouting = routing;
    res.locals.multivibePolicyDecision = decision;
    if (
      decision?.eligible[0] &&
      !req.path.endsWith("/messages")
    ) {
      const selected = decision.eligible[0];
      const lease = coordinator.capacity.acquire(
        selected.resource.accountId,
        selected.config.model,
      );
      res.locals.multivibeCapacityLease = lease;
      res.locals.multivibeCapacityLeaseClaimed = false;
      const release = () => {
        if (!res.locals.multivibeCapacityLeaseClaimed) lease.release();
      };
      res.once("finish", release);
      res.once("close", release);
    }
    setDecisionHeaders(res, {
      decision: decision?.eligible[0]?.resource.location ?? "cloud",
      priority: routing.priority,
      resolvedModel: decision?.eligible[0]?.config.model ?? model,
      waitMs: decision?.eligible[0]?.resource.predictedWaitMs,
      capacityVersion: coordinator.capacity.getVersion(),
    });
    next();
  };
}
