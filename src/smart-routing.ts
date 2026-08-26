import { EventEmitter } from "node:events";
import type http from "node:http";
import type {
  Account,
  CapacityProfile,
  ExecutionLocation,
  ExecutionMode,
  LegacyModelAlias,
  ModelAlias,
  PriorityClass,
  ProviderId,
  RoutingCandidateConfig,
  RoutingObjectives,
  RoutingRule,
  RoutingRuleMatch,
  TimeWindow,
} from "./types.js";
import { PRIORITY_CLASSES } from "./types.js";

export const PRIORITY_WEIGHTS: Record<PriorityClass, number> = {
  critical: 16,
  interactive: 8,
  standard: 4,
  batch: 1,
};

const DEFAULT_OBJECTIVES: Record<PriorityClass, RoutingObjectives> = {
  critical: { latency: 100, cost: 0, quality: 0, locality: 0 },
  interactive: { latency: 20, cost: 0, quality: 10, locality: 70 },
  standard: { latency: 25, cost: 20, quality: 30, locality: 25 },
  batch: { latency: 5, cost: 35, quality: 20, locality: 40 },
};

export type RoutingRequest = {
  application: string;
  priority: PriorityClass;
  executionMode: ExecutionMode;
  optedIn: boolean;
  maxWaitMs: number;
  deadlineAt?: number;
  idempotencyKey?: string;
  webhookId?: string;
  effort?: string;
  modalities: Array<"text" | "image" | "audio" | "video">;
  requiresTools: boolean;
  estimatedInputTokens: number;
  now: number;
};

export type ResourceSnapshot = {
  accountId: string;
  model: string;
  provider: ProviderId;
  location: ExecutionLocation;
  enabled: boolean;
  inFlight: number;
  maxConcurrent: number;
  freeSlots: number;
  predictedWaitMs: number;
  averageLatencyMs: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  contextWindow?: number;
  confidence: "declared" | "observed" | "stale";
  lastObservedAt?: number;
};

export type ScoredRoutingCandidate = {
  config: RoutingCandidateConfig;
  resource: ResourceSnapshot;
  score: number;
  estimatedCostUsd?: number;
  rejectedReasons: string[];
};

export type PolicyDecision = {
  alias?: ModelAlias;
  rule?: RoutingRule;
  candidates: ScoredRoutingCandidate[];
  eligible: ScoredRoutingCandidate[];
  onNoCapacity: "next-rule" | "queue" | "reject";
};

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value.trim() : undefined;
}

function defaultExecution(priority: PriorityClass): ExecutionMode {
  if (priority === "batch") return "defer";
  if (priority === "standard") return "auto";
  return "sync";
}

function defaultWait(priority: PriorityClass): number {
  if (priority === "interactive") return 2_000;
  if (priority === "standard") return 30_000;
  return 0;
}

export function parseRoutingHeaders(
  headers: http.IncomingHttpHeaders,
  application = "default",
  now = Date.now(),
): RoutingRequest {
  const rawPriority = headerValue(headers, "x-multivibe-priority");
  const priority = PRIORITY_CLASSES.includes(rawPriority as PriorityClass)
    ? (rawPriority as PriorityClass)
    : "standard";
  const rawExecution = headerValue(headers, "x-multivibe-execution");
  const optedIn = [
    rawPriority,
    rawExecution,
    headerValue(headers, "x-multivibe-max-wait-ms"),
    headerValue(headers, "x-multivibe-deadline"),
    headerValue(headers, "x-multivibe-idempotency-key"),
    headerValue(headers, "x-multivibe-webhook"),
  ].some(Boolean);
  const executionMode: ExecutionMode =
    rawExecution === "sync" || rawExecution === "auto" || rawExecution === "defer"
      ? rawExecution
      : optedIn
        ? defaultExecution(priority)
        : "sync";
  const rawWait = Number(headerValue(headers, "x-multivibe-max-wait-ms"));
  const maxWaitMs = Number.isFinite(rawWait)
    ? Math.max(0, Math.min(rawWait, 24 * 60 * 60_000))
    : defaultWait(priority);
  const rawDeadline = headerValue(headers, "x-multivibe-deadline");
  const parsedDeadline = rawDeadline ? Date.parse(rawDeadline) : Number.NaN;

  return {
    application,
    priority,
    executionMode,
    optedIn,
    maxWaitMs,
    deadlineAt: Number.isFinite(parsedDeadline) ? parsedDeadline : undefined,
    idempotencyKey: headerValue(headers, "x-multivibe-idempotency-key"),
    webhookId: headerValue(headers, "x-multivibe-webhook"),
    modalities: ["text"],
    requiresTools: false,
    estimatedInputTokens: 0,
    now,
  };
}

export function inferAccountLocation(account: Pick<Account, "provider" | "baseUrl">): ExecutionLocation {
  if (account.provider !== "openai-compatible") return "cloud";
  if (!account.baseUrl) return "cloud";
  try {
    const host = new URL(account.baseUrl).hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host.startsWith("127.")) return "local";
    if (host.startsWith("10.") || host.startsWith("192.168.")) return "local";
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return "local";
  } catch {
    return "cloud";
  }
  return "cloud";
}

function candidateList(models: string[]): RoutingCandidateConfig[] {
  return Array.from(new Set(models.filter(Boolean))).map((model) => ({ model }));
}

export function migrateModelAlias(raw: ModelAlias | LegacyModelAlias | any): ModelAlias {
  if (raw?.schemaVersion === 2 && Array.isArray(raw.rules)) {
    return {
      schemaVersion: 2,
      id: String(raw.id ?? ""),
      enabled: raw.enabled !== false,
      description: typeof raw.description === "string" ? raw.description : undefined,
      defaults: raw.defaults,
      rules: raw.rules.map((rule: RoutingRule, index: number) => ({
        ...rule,
        id: String(rule?.id || `rule-${index + 1}`),
        candidates: Array.isArray(rule?.candidates) ? rule.candidates : [],
      })),
    };
  }

  const targets = Array.isArray(raw?.targets)
    ? raw.targets.filter((target: unknown): target is string => typeof target === "string")
    : [];
  const byEffort = new Map<string, string[]>();
  const unqualified: string[] = [];
  for (const target of targets) {
    const match = target.match(/^(minimal|low|medium|high|xhigh):(.+)$/);
    if (!match) {
      unqualified.push(target);
      continue;
    }
    const list = byEffort.get(match[1]) ?? [];
    list.push(match[2]);
    byEffort.set(match[1], list);
  }
  const rules: RoutingRule[] = Array.from(byEffort.entries()).map(
    ([effort, models]) => ({
      id: `effort-${effort}`,
      match: { efforts: [effort] },
      candidates: candidateList(models),
      onNoCapacity: "next-rule",
    }),
  );
  const fallbackModels = unqualified.length
    ? unqualified
    : targets.map((target: string) => target.replace(/^(minimal|low|medium|high|xhigh):/, ""));
  if (fallbackModels.length) {
    rules.push({
      id: "default",
      candidates: candidateList(fallbackModels),
      onNoCapacity: "reject",
    });
  }
  return {
    schemaVersion: 2,
    id: String(raw?.id ?? ""),
    rules,
    enabled: raw?.enabled !== false,
    description: typeof raw?.description === "string" ? raw.description : undefined,
  };
}

export function validateSmartAlias(alias: ModelAlias): string[] {
  const errors: string[] = [];
  if (alias.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!alias.id.trim()) errors.push("id required");
  if (!alias.rules.length) errors.push("at least one routing rule is required");
  if (
    alias.defaults?.priority &&
    !PRIORITY_CLASSES.includes(alias.defaults.priority)
  ) errors.push("invalid default priority");
  if (
    alias.defaults?.executionMode &&
    !["sync", "auto", "defer"].includes(alias.defaults.executionMode)
  ) errors.push("invalid default execution mode");
  const ids = new Set<string>();
  for (const rule of alias.rules) {
    if (!rule.id.trim()) errors.push("routing rule id required");
    if (ids.has(rule.id)) errors.push(`duplicate routing rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.candidates.length) errors.push(`rule ${rule.id} requires candidates`);
    if (
      rule.onNoCapacity &&
      !["next-rule", "queue", "reject"].includes(rule.onNoCapacity)
    ) errors.push(`rule ${rule.id} has an invalid no-capacity behavior`);
    if (rule.match?.priorities?.some((value) => !PRIORITY_CLASSES.includes(value))) {
      errors.push(`rule ${rule.id} has an invalid priority`);
    }
    if (
      rule.match?.executionModes?.some(
        (value) => !["sync", "auto", "defer"].includes(value),
      )
    ) errors.push(`rule ${rule.id} has an invalid execution mode`);
    if (
      rule.match?.modalities?.some(
        (value) => !["text", "image", "audio", "video"].includes(value),
      )
    ) errors.push(`rule ${rule.id} has an invalid modality`);
    for (const window of rule.match?.timeWindows ?? []) {
      if (parseClock(window.start) === undefined || parseClock(window.end) === undefined) {
        errors.push(`rule ${rule.id} has an invalid time window`);
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: window.timezone ?? "Europe/Paris" });
      } catch {
        errors.push(`rule ${rule.id} has an invalid timezone`);
      }
    }
    for (const candidate of rule.candidates) {
      if (!candidate.model?.trim()) errors.push(`rule ${rule.id} has an empty model`);
      if (candidate.quality !== undefined && (candidate.quality < 0 || candidate.quality > 100)) {
        errors.push(`rule ${rule.id} quality must be between 0 and 100`);
      }
      if (candidate.location && candidate.location !== "local" && candidate.location !== "cloud") {
        errors.push(`rule ${rule.id} has an invalid candidate location`);
      }
      for (const value of [
        candidate.inputCostPerMillionUsd,
        candidate.outputCostPerMillionUsd,
      ]) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          errors.push(`rule ${rule.id} candidate costs must be non-negative`);
        }
      }
      if (candidate.capacityProfile) {
        for (const [name, value] of Object.entries(candidate.capacityProfile)) {
          if (
            !name.endsWith("Url") &&
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
          ) errors.push(`rule ${rule.id} has an invalid candidate capacity profile`);
        }
      }
    }
    if (rule.objectives) {
      const values = [
        rule.objectives.latency,
        rule.objectives.cost,
        rule.objectives.quality,
        rule.objectives.locality,
      ];
      if (values.some((value) => !Number.isFinite(value) || value < 0)) {
        errors.push(`rule ${rule.id} objective weights must be non-negative`);
      }
      if (values.every((value) => value === 0)) {
        errors.push(`rule ${rule.id} requires at least one objective weight`);
      }
    }
    if (
      rule.constraints?.allowedLocations?.some(
        (location) => location !== "local" && location !== "cloud",
      )
    ) errors.push(`rule ${rule.id} has an invalid allowed location`);
    if (
      rule.cloudBudget &&
      (!Number.isFinite(rule.cloudBudget.amountUsd) ||
        rule.cloudBudget.amountUsd <= 0 ||
        !["hour", "day", "month"].includes(rule.cloudBudget.period))
    ) errors.push(`rule ${rule.id} has an invalid cloud budget`);
  }
  return errors;
}

export function aliasCandidateModels(alias: ModelAlias, effort?: string): string[] {
  const normalized = Array.isArray(alias.rules)
    ? alias
    : migrateModelAlias(alias as unknown as LegacyModelAlias);
  const matching = normalized.rules.filter((rule) => {
    if (rule.enabled === false) return false;
    const efforts = rule.match?.efforts;
    return !efforts?.length || Boolean(effort && efforts.includes(effort));
  });
  const effortSpecific = effort
    ? matching.filter((rule) => rule.match?.efforts?.includes(effort))
    : [];
  const selected = effortSpecific.length
    ? [...effortSpecific, ...matching.filter((rule) => !rule.match?.efforts?.length)]
    : matching.filter((rule) => !rule.match?.efforts?.length);
  const rules = selected.length ? selected : matching;
  return Array.from(
    new Set(rules.flatMap((rule) => rule.candidates.map((candidate) => candidate.model))),
  );
}

export function allAliasCandidateModels(alias: ModelAlias): string[] {
  const normalized = Array.isArray(alias.rules)
    ? alias
    : migrateModelAlias(alias as unknown as LegacyModelAlias);
  return Array.from(
    new Set(
      normalized.rules
        .filter((rule) => rule.enabled !== false)
        .flatMap((rule) => rule.candidates.map((candidate) => candidate.model)),
    ),
  );
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: weekdays.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function parseClock(value: string): number | undefined {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

export function isWithinTimeWindow(window: TimeWindow, at: number): boolean {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === undefined || end === undefined) return false;
  const parts = zonedParts(new Date(at), window.timezone || "Europe/Paris");
  if (window.days?.length && !window.days.includes(parts.day)) return false;
  return start <= end
    ? parts.minutes >= start && parts.minutes < end
    : parts.minutes >= start || parts.minutes < end;
}

function matchesList<T>(configured: T[] | undefined, actual: T): boolean {
  return !configured?.length || configured.includes(actual);
}

export function routingRuleMatches(match: RoutingRuleMatch | undefined, request: RoutingRequest): boolean {
  if (!match) return true;
  if (!matchesList(match.applications, request.application)) return false;
  if (!matchesList(match.priorities, request.priority)) return false;
  if (match.efforts?.length && (!request.effort || !match.efforts.includes(request.effort))) return false;
  if (!matchesList(match.executionModes, request.executionMode)) return false;
  if (match.requiresTools !== undefined && match.requiresTools !== request.requiresTools) return false;
  if (match.modalities?.length && !request.modalities.some((modality) => match.modalities!.includes(modality))) {
    return false;
  }
  if (match.minInputTokens !== undefined && request.estimatedInputTokens < match.minInputTokens) return false;
  if (match.maxInputTokens !== undefined && request.estimatedInputTokens > match.maxInputTokens) return false;
  if (match.timeWindows?.length && !match.timeWindows.some((window) => isWithinTimeWindow(window, request.now))) {
    return false;
  }
  return true;
}

function estimateCandidateCost(
  config: RoutingCandidateConfig,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (config.inputCostPerMillionUsd === undefined || config.outputCostPerMillionUsd === undefined) {
    return undefined;
  }
  return (
    (inputTokens / 1_000_000) * config.inputCostPerMillionUsd +
    (outputTokens / 1_000_000) * config.outputCostPerMillionUsd
  );
}

function score(
  config: RoutingCandidateConfig,
  resource: ResourceSnapshot,
  objectives: RoutingObjectives,
  estimatedCostUsd: number | undefined,
): number {
  const total = Object.values(objectives).reduce((sum, value) => sum + value, 0) || 1;
  const latency =
    1 /
    (1 + (resource.predictedWaitMs + resource.averageLatencyMs) / 1_000);
  const cost = estimatedCostUsd === undefined ? 0.5 : 1 / (1 + estimatedCostUsd * 10);
  const quality = Math.max(0, Math.min(1, (config.quality ?? 50) / 100));
  const locality = resource.location === "local" ? 1 : 0;
  return (
    latency * objectives.latency +
    cost * objectives.cost +
    quality * objectives.quality +
    locality * objectives.locality
  ) / total;
}

export function evaluateAliasPolicy(
  alias: ModelAlias | undefined,
  request: RoutingRequest,
  resources: ResourceSnapshot[],
  outputTokens = 8_192,
): PolicyDecision {
  if (!alias) return { candidates: [], eligible: [], onNoCapacity: "reject" };
  for (const rule of alias.rules) {
    if (rule.enabled === false || !routingRuleMatches(rule.match, request)) continue;
    const objectives = rule.objectives ?? DEFAULT_OBJECTIVES[request.priority];
    const candidates: ScoredRoutingCandidate[] = [];
    for (const config of rule.candidates) {
      const matching = resources.filter((resource) => {
        if (resource.model.toLowerCase() !== config.model.toLowerCase()) return false;
        if (config.provider && config.provider !== resource.provider) return false;
        if (config.accountIds?.length && !config.accountIds.includes(resource.accountId)) return false;
        return true;
      });
      for (const resource of matching) {
        const rejectedReasons: string[] = [];
        const location = resource.location;
        const constraints = rule.constraints;
        if (!resource.enabled) rejectedReasons.push("resource_unavailable");
        if (config.location && config.location !== resource.location) {
          rejectedReasons.push("candidate_location_mismatch");
        }
        if (
          request.priority === "batch" &&
          !constraints?.allowedLocations?.length &&
          !config.location &&
          resource.location !== "local"
        ) {
          rejectedReasons.push("batch_defaults_to_local");
        }
        if (constraints?.allowedLocations?.length && !constraints.allowedLocations.includes(location)) {
          rejectedReasons.push("location_not_allowed");
        }
        if (constraints?.maxPredictedWaitMs !== undefined && resource.predictedWaitMs > constraints.maxPredictedWaitMs) {
          rejectedReasons.push("predicted_wait_exceeded");
        }
        if (constraints?.minContextWindow !== undefined && (resource.contextWindow ?? 0) < constraints.minContextWindow) {
          rejectedReasons.push("context_too_small");
        }
        if (constraints?.minQuality !== undefined && (config.quality ?? 0) < constraints.minQuality) {
          rejectedReasons.push("quality_too_low");
        }
        if (resource.freeSlots <= 0) rejectedReasons.push("capacity_saturated");
        const estimatedCostUsd = estimateCandidateCost(
          config,
          request.estimatedInputTokens,
          outputTokens,
        );
        candidates.push({
          config,
          resource: { ...resource, location },
          score: score(config, { ...resource, location }, objectives, estimatedCostUsd),
          estimatedCostUsd,
          rejectedReasons,
        });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    const eligible = candidates.filter((candidate) => !candidate.rejectedReasons.length);
    if (eligible.length || rule.onNoCapacity !== "next-rule") {
      return {
        alias,
        rule,
        candidates,
        eligible,
        onNoCapacity: rule.onNoCapacity ?? "reject",
      };
    }
  }
  return { alias, candidates: [], eligible: [], onNoCapacity: "reject" };
}

type Observation = {
  inFlight: number;
  latencyMs?: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  samples: number;
  lastObservedAt?: number;
};

export type CapacityLease = {
  accountId: string;
  model: string;
  startedAt: number;
  release: (observation?: {
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  }) => void;
};

export function capacityTokenUsage(usage: any): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const finiteNonNegative = (value: unknown): number | undefined => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return {
    inputTokens:
      finiteNonNegative(usage?.input_tokens) ??
      finiteNonNegative(usage?.prompt_tokens),
    outputTokens:
      finiteNonNegative(usage?.output_tokens) ??
      finiteNonNegative(usage?.completion_tokens),
  };
}

function ewma(current: number | undefined, next: number, alpha = 0.25): number {
  return current === undefined ? next : current * (1 - alpha) + next * alpha;
}

export class CapacityTracker extends EventEmitter {
  private observations = new Map<string, Observation>();
  private accountHealth = new Map<string, { healthy: boolean; observedAt: number }>();
  private accountMetrics = new Map<string, CapacityProfile>();
  private revision = 1;

  private key(accountId: string, model: string) {
    return `${accountId}::${model.toLowerCase()}`;
  }

  getVersion() {
    return this.revision;
  }

  setAccountHealth(accountId: string, healthy: boolean) {
    const previous = this.accountHealth.get(accountId);
    this.accountHealth.set(accountId, { healthy, observedAt: Date.now() });
    if (!previous || previous.healthy !== healthy) {
      this.bump("capacity.changed", { accountId, healthy });
    }
  }

  clearAccountHealth(accountId: string) {
    if (this.accountHealth.delete(accountId)) {
      this.bump("capacity.changed", { accountId, healthCleared: true });
    }
  }

  setAccountMetrics(accountId: string, profile: CapacityProfile) {
    const next = { ...profile };
    const previous = this.accountMetrics.get(accountId);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.accountMetrics.set(accountId, next);
    this.bump("capacity.changed", { accountId, metrics: true });
  }

  clearAccountMetrics(accountId: string) {
    if (this.accountMetrics.delete(accountId)) {
      this.bump("capacity.changed", { accountId, metricsCleared: true });
    }
  }

  acquire(accountId: string, model: string): CapacityLease {
    const key = this.key(accountId, model);
    const observation = this.observations.get(key) ?? { inFlight: 0, samples: 0 };
    observation.inFlight += 1;
    this.observations.set(key, observation);
    this.bump("capacity.changed", { accountId, model });
    const startedAt = Date.now();
    let released = false;
    return {
      accountId,
      model,
      startedAt,
      release: (result) => {
        if (released) return;
        released = true;
        const current = this.observations.get(key) ?? observation;
        current.inFlight = Math.max(0, current.inFlight - 1);
        const latencyMs = result?.latencyMs ?? Date.now() - startedAt;
        current.latencyMs = ewma(current.latencyMs, latencyMs);
        if (result?.inputTokens && latencyMs > 0) {
          current.prefillTokensPerSecond = ewma(
            current.prefillTokensPerSecond,
            result.inputTokens / (latencyMs / 1_000),
          );
        }
        if (result?.outputTokens && latencyMs > 0) {
          current.decodeTokensPerSecond = ewma(
            current.decodeTokensPerSecond,
            result.outputTokens / (latencyMs / 1_000),
          );
        }
        current.samples += 1;
        current.lastObservedAt = Date.now();
        this.observations.set(key, current);
        this.bump("capacity.changed", { accountId, model });
      },
    };
  }

  snapshots(
    accounts: Account[],
    models: Array<{ accountId: string; model: string; provider: ProviderId; enabled?: boolean }>,
    overrides = new Map<string, CapacityProfile>(),
  ): ResourceSnapshot[] {
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    return models.flatMap((entry) => {
      const account = accountMap.get(entry.accountId);
      if (!account) return [];
      const key = this.key(entry.accountId, entry.model);
      const observed = this.observations.get(key) ?? { inFlight: 0, samples: 0 };
      const profile = {
        ...account.capacityProfile,
        ...this.accountMetrics.get(account.id),
        ...overrides.get(key),
      };
      const location = account.location ?? inferAccountLocation(account);
      const maxConcurrent = Math.max(
        1,
        Math.floor(profile.maxConcurrent ?? (location === "local" ? 1 : 8)),
      );
      const averageLatencyMs = observed.latencyMs ?? 10_000;
      const freeSlots = Math.max(0, maxConcurrent - observed.inFlight);
      const queuedWaves = Math.max(0, observed.inFlight - maxConcurrent + 1);
      const age = observed.lastObservedAt ? Date.now() - observed.lastObservedAt : Number.POSITIVE_INFINITY;
      return [{
        accountId: account.id,
        model: entry.model,
        provider: entry.provider,
        location,
        enabled:
          account.enabled &&
          entry.enabled !== false &&
          (this.accountHealth.get(account.id)?.healthy ?? true),
        inFlight: observed.inFlight,
        maxConcurrent,
        freeSlots,
        predictedWaitMs: freeSlots > 0 ? 0 : queuedWaves * averageLatencyMs,
        averageLatencyMs,
        prefillTokensPerSecond: observed.prefillTokensPerSecond ?? profile.prefillTokensPerSecond,
        decodeTokensPerSecond: observed.decodeTokensPerSecond ?? profile.decodeTokensPerSecond,
        contextWindow: profile.contextWindow,
        confidence: observed.samples >= 5 && age <= 30 * 60_000
          ? "observed"
          : observed.samples > 0 && age > 30 * 60_000
            ? "stale"
            : "declared",
        lastObservedAt: observed.lastObservedAt,
      }];
    });
  }

  private bump(type: string, data: unknown) {
    this.revision += 1;
    this.emit(type, { id: this.revision, type, at: Date.now(), data });
  }
}

export function estimateInputTokens(payload: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4));
  } catch {
    return 1;
  }
}
