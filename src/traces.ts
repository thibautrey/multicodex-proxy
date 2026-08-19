import { estimateCostUsd, MODEL_PRICING_VERSION } from "./model-pricing.js";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";

export type TraceEntry = {
  id: string;
  at: number;
  route: string;
  accountId?: string;
  accountEmail?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  status: number;
  isError: boolean;
  stream: boolean;
  latencyMs: number;
  tokensInput?: number;
  tokensInputCached?: number;
  tokensInputCacheWrite?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
  tokensTotal?: number;
  costUsd?: number;
  pricingVersion?: string;
  usageStatus?: "measured" | "missing";
  costStatus?: "estimated" | "unpriced" | "unknown";
  usage?: any;
  requestBody?: any;
  error?: string;
  upstreamError?: string;
  upstreamContentType?: string;
  upstreamEmptyBody?: boolean;
  imageTrace?: any;
  latencyBreakdown?: {
    preparationMs: number;
    upstreamHeadersMs: number;
  };
  usageRefresh?: {
    background: number;
    blocking: number;
    shared: number;
  };
  modelCatalogRefresh?: {
    background: number;
    blocking: number;
    shared: number;
  };
  accountPreparation?: {
    skipped: number;
    asynchronous: number;
  };
  inputContext?: {
    compactionItemCount: number;
    itemsBeforeLatestCompaction: number;
  };
  assistantEmptyOutput?: boolean;
  assistantFinishReason?: string;
  responseStreamDiagnostics?: ResponseStreamDiagnostics;
  lifecycleState?: "started" | "completed" | "interrupted";
  startedAt?: number;
  completedAt?: number;
  clientDisconnected?: boolean;
};

export type ResponseStreamDiagnostics = {
  eventCount: number;
  eventTypes: Record<string, number>;
  customToolCalls: CustomToolCallDiagnostic[];
  invalidDataPayloadCount: number;
  outputTextDeltaCount: number;
  outputTextDoneCount: number;
  reasoningEventCount: number;
  refusalEventCount: number;
  functionCallCount: number;
  hiddenFunctionCallCount: number;
  sanitizerDroppedEventCount: number;
  sanitizerDroppedTextEventCount: number;
  sawResponseCompleted: boolean;
  sawChatCompletionChunk: boolean;
};

export type CustomToolCallDiagnostic = {
  _key?: string;
  itemIdPresent: boolean;
  callIdPresent: boolean;
  name?: string;
  status?: string;
  inputDeltaCount: number;
  inputBytes: number;
  sawInputDone: boolean;
  sawOutputItemAdded: boolean;
  sawOutputItemDone: boolean;
};

export type TraceListEntry = Omit<TraceEntry, "requestBody"> & {
  hasRequestBody: boolean;
};

export type TraceTotals = {
  requests: number;
  requestsWithUsage: number;
  requestsWithCost: number;
  unpricedRequests: number;
  errors: number;
  errorRate: number;
  tokensInput: number;
  tokensInputCached: number;
  tokensOutput: number;
  tokensTotal: number;
  inferenceTokensPerSecond: number;
  inferenceRequests: number;
  costUsd: number;
  latencyAvgMs: number;
};

export type TraceModelStats = {
  model: string;
  count: number;
  okCount: number;
  tokensInput: number;
  tokensInputCached: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
};

export type TraceTimeseriesBucket = {
  at: number;
  requests: number;
  errors: number;
  tokensInput: number;
  tokensInputCached: number;
  tokensOutput: number;
  tokensTotal: number;
  inferenceTokensPerSecond: number;
  inferenceRequests: number;
  costUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
};

export type TraceStats = {
  totals: TraceTotals;
  models: TraceModelStats[];
  timeseries: TraceTimeseriesBucket[];
};

export type UsageTokenTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageAggregate = {
  requests: number;
  ok: number;
  errors: number;
  stream: number;
  latencyMsTotal: number;
  requestsWithUsage: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  statusCounts: Record<string, number>;
  firstAt?: number;
  lastAt?: number;
};

export type TraceManagerConfig = {
  filePath: string;
  historyFilePath?: string;
  retentionMax?: number;
  pageSizeMax?: number;
  legacyLimitMax?: number;
};

type TraceBucketAggregate = {
  at: number;
  requests: number;
  requestsWithUsage: number;
  requestsWithCost: number;
  unpricedRequests: number;
  errors: number;
  tokensInput: number;
  tokensInputCached: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
  latencyMsTotal: number;
  latencies: number[];
  inferenceSpeeds: number[];
  models: Map<string, TraceModelStats>;
};

const DEFAULT_RETENTION_MAX = 1000;
const DEFAULT_PAGE_SIZE_MAX = 100;
const DEFAULT_LEGACY_LIMIT_MAX = 2000;
const HOUR_MS = 3_600_000;
const MAX_LATENCY_SAMPLES_PER_BUCKET = 2000;
const TRACE_COMPACTION_RATIO = 1.5;

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeTokenFields(
  usage: any,
  fallback?: {
    input?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
    output?: number;
    reasoning?: number;
    total?: number;
  },
) {
  const input =
    safeNumber(usage?.input_tokens) ??
    safeNumber(usage?.prompt_tokens) ??
    fallback?.input;
  const output =
    safeNumber(usage?.output_tokens) ??
    safeNumber(usage?.completion_tokens) ??
    fallback?.output;
  const total =
    safeNumber(usage?.total_tokens) ??
    fallback?.total ??
    (typeof input === "number" || typeof output === "number"
      ? (input ?? 0) + (output ?? 0)
      : undefined);
  const cachedInput =
    safeNumber(usage?.input_tokens_details?.cached_tokens) ??
    safeNumber(usage?.prompt_tokens_details?.cached_tokens) ??
    safeNumber(usage?.cached_input_tokens) ??
    safeNumber(usage?.input_cached_tokens) ??
    safeNumber(usage?.prompt_cached_tokens) ??
    safeNumber((usage as any)?.cached_tokens) ??
    fallback?.cachedInput ??
    0;
  const cacheWriteInput =
    safeNumber(usage?.input_tokens_details?.cache_write_tokens) ??
    safeNumber(usage?.prompt_tokens_details?.cache_write_tokens) ??
    safeNumber((usage as any)?.cache_write_tokens) ??
    fallback?.cacheWriteInput ??
    0;
  const reasoning =
    safeNumber(usage?.output_tokens_details?.reasoning_tokens) ??
    safeNumber(usage?.completion_tokens_details?.reasoning_tokens) ??
    safeNumber((usage as any)?.reasoning_tokens) ??
    fallback?.reasoning ??
    0;
  return {
    tokensInput: input,
    tokensInputCached: cachedInput,
    tokensInputCacheWrite: cacheWriteInput,
    tokensOutput: output,
    tokensReasoning: reasoning,
    tokensTotal: total,
  };
}

function normalizeTrace(raw: any): TraceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const at = safeNumber(raw.at);
  const route = typeof raw.route === "string" ? raw.route : "";
  const status = safeNumber(raw.status);
  const latencyMs = safeNumber(raw.latencyMs);
  if (
    !at ||
    !route ||
    typeof status === "undefined" ||
    typeof latencyMs === "undefined"
  )
    return null;

  const fallbackModel =
    typeof raw.requestBody?.model === "string"
      ? raw.requestBody.model
      : undefined;
  const model =
    typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim()
      : fallbackModel;
  const normalizedTokens = normalizeTokenFields(raw.usage, {
    input: safeNumber(raw.tokensInput),
    cachedInput: safeNumber(raw.tokensInputCached),
    cacheWriteInput: safeNumber(raw.tokensInputCacheWrite),
    output: safeNumber(raw.tokensOutput),
    reasoning: safeNumber(raw.tokensReasoning),
    total: safeNumber(raw.tokensTotal),
  });
  const storedCostUsd = safeNumber(raw.costUsd);
  const legacySyntheticZero =
    typeof raw.usageStatus !== "string" &&
    !raw.usage &&
    safeNumber(raw.tokensTotal) === 0 &&
    (safeNumber(raw.tokensInput) ?? 0) === 0 &&
    (safeNumber(raw.tokensOutput) ?? 0) === 0 &&
    (storedCostUsd === undefined || storedCostUsd === 0);
  const hasMeasuredTokens = [
    normalizedTokens.tokensInput,
    normalizedTokens.tokensOutput,
    normalizedTokens.tokensTotal,
  ].some((value) => typeof value === "number");
  const usageStatus =
    raw.usageStatus === "measured" || raw.usageStatus === "missing"
      ? raw.usageStatus
      : !legacySyntheticZero && (Boolean(raw.usage) || hasMeasuredTokens)
        ? "measured"
        : "missing";
  const preservedCostUsd = legacySyntheticZero ? undefined : storedCostUsd;
  const estimatedCostUsd =
    usageStatus === "measured"
      ? estimateCostUsd(
          model,
          normalizedTokens.tokensInput ?? 0,
          normalizedTokens.tokensOutput ?? 0,
          normalizedTokens.tokensInputCached ?? 0,
          normalizedTokens.tokensInputCacheWrite ?? 0,
        )
      : undefined;
  const costUsd = preservedCostUsd ?? estimatedCostUsd;

  return {
    id:
      typeof raw.id === "string" && raw.id
        ? raw.id
        : `${at}-${route}-${status}`,
    at,
    route,
    accountId: typeof raw.accountId === "string" ? raw.accountId : undefined,
    accountEmail:
      typeof raw.accountEmail === "string" ? raw.accountEmail : undefined,
    model,
    requestedModel:
      typeof raw.requestedModel === "string" ? raw.requestedModel : undefined,
    resolvedModel:
      typeof raw.resolvedModel === "string" ? raw.resolvedModel : undefined,
    status,
    isError: typeof raw.isError === "boolean" ? raw.isError : status >= 400,
    stream: Boolean(raw.stream),
    latencyMs,
    tokensInput: normalizedTokens.tokensInput,
    tokensInputCached: normalizedTokens.tokensInputCached,
    tokensInputCacheWrite: normalizedTokens.tokensInputCacheWrite,
    tokensOutput: normalizedTokens.tokensOutput,
    tokensReasoning: normalizedTokens.tokensReasoning,
    tokensTotal: normalizedTokens.tokensTotal,
    costUsd,
    pricingVersion:
      typeof raw.pricingVersion === "string"
        ? raw.pricingVersion
        : preservedCostUsd !== undefined
          ? "legacy-recorded"
          : estimatedCostUsd !== undefined
            ? MODEL_PRICING_VERSION
            : undefined,
    usageStatus,
    costStatus:
      raw.costStatus === "estimated" ||
      raw.costStatus === "unpriced" ||
      raw.costStatus === "unknown"
        ? raw.costStatus
        : costUsd !== undefined
          ? "estimated"
          : usageStatus === "measured" && model
            ? "unpriced"
            : "unknown",
    usage: raw.usage,
    requestBody: raw.requestBody,
    error: typeof raw.error === "string" ? raw.error : undefined,
    upstreamError:
      typeof raw.upstreamError === "string" ? raw.upstreamError : undefined,
    upstreamContentType:
      typeof raw.upstreamContentType === "string"
        ? raw.upstreamContentType
        : undefined,
    upstreamEmptyBody:
      typeof raw.upstreamEmptyBody === "boolean"
        ? raw.upstreamEmptyBody
        : undefined,
    imageTrace: raw.imageTrace,
    latencyBreakdown:
      raw.latencyBreakdown &&
      typeof raw.latencyBreakdown === "object"
        ? {
            preparationMs:
              safeNumber(raw.latencyBreakdown.preparationMs) ?? 0,
            upstreamHeadersMs:
              safeNumber(raw.latencyBreakdown.upstreamHeadersMs) ?? 0,
          }
        : undefined,
    usageRefresh:
      raw.usageRefresh &&
      typeof raw.usageRefresh === "object"
        ? {
            background: safeNumber(raw.usageRefresh.background) ?? 0,
            blocking: safeNumber(raw.usageRefresh.blocking) ?? 0,
            shared: safeNumber(raw.usageRefresh.shared) ?? 0,
          }
        : undefined,
    modelCatalogRefresh:
      raw.modelCatalogRefresh &&
      typeof raw.modelCatalogRefresh === "object"
        ? {
            background: safeNumber(raw.modelCatalogRefresh.background) ?? 0,
            blocking: safeNumber(raw.modelCatalogRefresh.blocking) ?? 0,
            shared: safeNumber(raw.modelCatalogRefresh.shared) ?? 0,
          }
        : undefined,
    accountPreparation:
      raw.accountPreparation &&
      typeof raw.accountPreparation === "object"
        ? {
            skipped: safeNumber(raw.accountPreparation.skipped) ?? 0,
            asynchronous:
              safeNumber(raw.accountPreparation.asynchronous) ?? 0,
          }
        : undefined,
    inputContext:
      raw.inputContext &&
      typeof raw.inputContext === "object"
        ? {
            compactionItemCount:
              safeNumber(raw.inputContext.compactionItemCount) ?? 0,
            itemsBeforeLatestCompaction:
              safeNumber(raw.inputContext.itemsBeforeLatestCompaction) ?? 0,
          }
        : undefined,
    assistantEmptyOutput:
      typeof raw.assistantEmptyOutput === "boolean"
        ? raw.assistantEmptyOutput
        : undefined,
    assistantFinishReason:
      typeof raw.assistantFinishReason === "string"
        ? raw.assistantFinishReason
        : undefined,
    responseStreamDiagnostics:
      raw.responseStreamDiagnostics &&
      typeof raw.responseStreamDiagnostics === "object"
        ? raw.responseStreamDiagnostics
        : undefined,
    lifecycleState:
      raw.lifecycleState === "started" ||
      raw.lifecycleState === "completed" ||
      raw.lifecycleState === "interrupted"
        ? raw.lifecycleState
        : undefined,
    startedAt: safeNumber(raw.startedAt),
    completedAt: safeNumber(raw.completedAt),
    clientDisconnected:
      typeof raw.clientDisconnected === "boolean"
        ? raw.clientDisconnected
        : undefined,
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function traceDurationMs(
  trace: Pick<TraceEntry, "at" | "startedAt" | "completedAt" | "latencyMs">,
): number | undefined {
  const startedAt = safeNumber(trace.startedAt);
  const completedAt = safeNumber(trace.completedAt) ?? safeNumber(trace.at);
  if (
    typeof startedAt === "number" &&
    typeof completedAt === "number" &&
    completedAt > startedAt
  ) {
    return completedAt - startedAt;
  }

  const latencyMs = safeNumber(trace.latencyMs);
  return typeof latencyMs === "number" && latencyMs > 0 ? latencyMs : undefined;
}

function traceInferenceTokensPerSecond(
  trace: Pick<
    TraceEntry,
    | "at"
    | "startedAt"
    | "completedAt"
    | "latencyMs"
    | "tokensOutput"
    | "lifecycleState"
  >,
): number | undefined {
  if (trace.lifecycleState === "started") return undefined;
  const outputTokens = safeNumber(trace.tokensOutput);
  const durationMs = traceDurationMs(trace);
  if (
    typeof outputTokens !== "number" ||
    outputTokens <= 0 ||
    typeof durationMs !== "number" ||
    durationMs <= 0
  ) {
    return undefined;
  }
  return (outputTokens * 1000) / durationMs;
}

function usageToTokens(
  usage: any,
  fallback?: Pick<TraceEntry, "tokensInput" | "tokensOutput" | "tokensTotal">,
): UsageTokenTotals {
  const promptTokens =
    safeNumber(usage?.prompt_tokens) ??
    safeNumber(usage?.input_tokens) ??
    fallback?.tokensInput ??
    0;
  const completionTokens =
    safeNumber(usage?.completion_tokens) ??
    safeNumber(usage?.output_tokens) ??
    fallback?.tokensOutput ??
    0;
  const totalTokens =
    safeNumber(usage?.total_tokens) ??
    fallback?.tokensTotal ??
    promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function createUsageAggregate(): UsageAggregate {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    stream: 0,
    latencyMsTotal: 0,
    requestsWithUsage: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    statusCounts: {},
  };
}

function addTraceToAggregate(agg: UsageAggregate, trace: TraceEntry) {
  const status = Number(trace.status);
  const statusKey = Number.isFinite(status) ? String(status) : "unknown";
  const tokens = usageToTokens(trace.usage, trace);

  agg.requests += 1;
  if (status >= 200 && status < 400) agg.ok += 1;
  else agg.errors += 1;
  if (trace.stream) agg.stream += 1;

  agg.latencyMsTotal += Number.isFinite(trace.latencyMs) ? trace.latencyMs : 0;
  agg.statusCounts[statusKey] = (agg.statusCounts[statusKey] ?? 0) + 1;

  if (trace.usageStatus === "measured" || trace.usage) {
    agg.requestsWithUsage += 1;
    agg.promptTokens += tokens.promptTokens;
    agg.completionTokens += tokens.completionTokens;
    agg.totalTokens += tokens.totalTokens;
  }

  if (typeof trace.at === "number") {
    agg.firstAt =
      typeof agg.firstAt === "number"
        ? Math.min(agg.firstAt, trace.at)
        : trace.at;
    agg.lastAt =
      typeof agg.lastAt === "number"
        ? Math.max(agg.lastAt, trace.at)
        : trace.at;
  }
}

function finalizeAggregate(agg: UsageAggregate) {
  const avgLatencyMs = agg.requests
    ? Math.round((agg.latencyMsTotal / agg.requests) * 100) / 100
    : 0;
  const successRate = agg.requests
    ? Math.round((agg.ok / agg.requests) * 10000) / 100
    : 0;
  const streamingRate = agg.requests
    ? Math.round((agg.stream / agg.requests) * 10000) / 100
    : 0;

  return {
    requests: agg.requests,
    ok: agg.ok,
    errors: agg.errors,
    successRate,
    stream: agg.stream,
    streamingRate,
    latencyMsTotal: agg.latencyMsTotal,
    avgLatencyMs,
    requestsWithUsage: agg.requestsWithUsage,
    tokens: {
      prompt: agg.promptTokens,
      completion: agg.completionTokens,
      total: agg.totalTokens,
    },
    statusCounts: agg.statusCounts,
    firstAt: agg.firstAt,
    lastAt: agg.lastAt,
  };
}

function buildTraceStats(traces: TraceEntry[]): TraceStats {
  const requests = traces.length;
  const requestsWithUsage = traces.filter(
    (trace) => trace.usageStatus === "measured" || Boolean(trace.usage),
  ).length;
  const requestsWithCost = traces.filter(
    (trace) => typeof trace.costUsd === "number",
  ).length;
  const unpricedRequests = traces.filter(
    (trace) => trace.costStatus === "unpriced",
  ).length;
  const errors = traces.filter((t) => t.isError).length;
  const tokensInput = traces.reduce((sum, t) => sum + (t.tokensInput ?? 0), 0);
  const tokensInputCached = traces.reduce(
    (sum, t) => sum + (t.tokensInputCached ?? 0),
    0,
  );
  const tokensOutput = traces.reduce(
    (sum, t) => sum + (t.tokensOutput ?? 0),
    0,
  );
  const tokensTotal = traces.reduce(
    (sum, t) =>
      sum + (t.tokensTotal ?? (t.tokensInput ?? 0) + (t.tokensOutput ?? 0)),
    0,
  );
  const inferenceSpeeds = traces
    .map(traceInferenceTokensPerSecond)
    .filter((speed): speed is number => typeof speed === "number");
  const costUsd = traces.reduce((sum, t) => {
    if (typeof t.costUsd === "number") return sum + t.costUsd;
    return (
      sum +
      (estimateCostUsd(
        t.model,
        t.tokensInput ?? 0,
        t.tokensOutput ?? 0,
        t.tokensInputCached ?? 0,
        t.tokensInputCacheWrite ?? 0,
      ) ?? 0)
    );
  }, 0);
  const latencyAvgMs = requests
    ? traces.reduce((sum, t) => sum + t.latencyMs, 0) / requests
    : 0;
  const errorRate = requests ? errors / requests : 0;

  const modelMap = new Map<string, TraceModelStats>();
  for (const trace of traces) {
    const key = trace.model || "unknown";
    const existing = modelMap.get(key);
    const traceCost =
      typeof trace.costUsd === "number"
        ? trace.costUsd
        : (estimateCostUsd(
            trace.model,
            trace.tokensInput ?? 0,
            trace.tokensOutput ?? 0,
            trace.tokensInputCached ?? 0,
            trace.tokensInputCacheWrite ?? 0,
          ) ?? 0);
    if (!existing) {
      modelMap.set(key, {
        model: key,
        count: 1,
        okCount: trace.isError ? 0 : 1,
        tokensInput: trace.tokensInput ?? 0,
        tokensInputCached: trace.tokensInputCached ?? 0,
        tokensOutput: trace.tokensOutput ?? 0,
        tokensTotal: trace.tokensTotal ?? 0,
        costUsd: traceCost,
      });
    } else {
      existing.count += 1;
      if (!trace.isError) existing.okCount += 1;
      existing.tokensInput += trace.tokensInput ?? 0;
      existing.tokensInputCached += trace.tokensInputCached ?? 0;
      existing.tokensOutput += trace.tokensOutput ?? 0;
      existing.tokensTotal += trace.tokensTotal ?? 0;
      existing.costUsd += traceCost;
    }
  }
  const models = Array.from(modelMap.values()).sort(
    (a, b) => b.count - a.count,
  );

  const bucketMap = new Map<
    number,
    {
      requests: number;
      errors: number;
      tokensInput: number;
      tokensInputCached: number;
      tokensOutput: number;
      tokensTotal: number;
      costUsd: number;
      latencies: number[];
      inferenceSpeeds: number[];
    }
  >();
  for (const trace of traces) {
    const bucketAt = Math.floor(trace.at / 3_600_000) * 3_600_000;
    const bucket = bucketMap.get(bucketAt) ?? {
      requests: 0,
      errors: 0,
      tokensInput: 0,
      tokensInputCached: 0,
      tokensOutput: 0,
      tokensTotal: 0,
      costUsd: 0,
      latencies: [],
      inferenceSpeeds: [],
    };
    bucket.requests += 1;
    if (trace.isError) bucket.errors += 1;
    bucket.tokensInput += trace.tokensInput ?? 0;
    bucket.tokensInputCached += trace.tokensInputCached ?? 0;
    bucket.tokensOutput += trace.tokensOutput ?? 0;
    bucket.tokensTotal += trace.tokensTotal ?? 0;
    const inferenceSpeed = traceInferenceTokensPerSecond(trace);
    if (typeof inferenceSpeed === "number") {
      bucket.inferenceSpeeds.push(inferenceSpeed);
    }
    bucket.costUsd +=
      typeof trace.costUsd === "number"
        ? trace.costUsd
        : (estimateCostUsd(
            trace.model,
            trace.tokensInput ?? 0,
            trace.tokensOutput ?? 0,
            trace.tokensInputCached ?? 0,
            trace.tokensInputCacheWrite ?? 0,
          ) ?? 0);
    bucket.latencies.push(trace.latencyMs);
    bucketMap.set(bucketAt, bucket);
  }
  const timeseries = Array.from(bucketMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([at, bucket]) => ({
      at,
      requests: bucket.requests,
      errors: bucket.errors,
      tokensInput: bucket.tokensInput,
      tokensInputCached: bucket.tokensInputCached,
      tokensOutput: bucket.tokensOutput,
      tokensTotal: bucket.tokensTotal,
      inferenceTokensPerSecond: average(bucket.inferenceSpeeds),
      inferenceRequests: bucket.inferenceSpeeds.length,
      costUsd: bucket.costUsd,
      latencyP50Ms: percentile(bucket.latencies, 50),
      latencyP95Ms: percentile(bucket.latencies, 95),
    }));

  return {
    totals: {
      requests,
      requestsWithUsage,
      requestsWithCost,
      unpricedRequests,
      errors,
      errorRate,
      tokensInput,
      tokensInputCached,
      tokensOutput,
      tokensTotal,
      inferenceTokensPerSecond: average(inferenceSpeeds),
      inferenceRequests: inferenceSpeeds.length,
      costUsd,
      latencyAvgMs,
    },
    models,
    timeseries,
  };
}

function createEmptyBucket(at: number): TraceBucketAggregate {
  return {
    at,
    requests: 0,
    requestsWithUsage: 0,
    requestsWithCost: 0,
    unpricedRequests: 0,
    errors: 0,
    tokensInput: 0,
    tokensInputCached: 0,
    tokensOutput: 0,
    tokensTotal: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    latencies: [],
    inferenceSpeeds: [],
    models: new Map(),
  };
}

function addLatencySample(bucket: TraceBucketAggregate, latencyMs: number) {
  if (!Number.isFinite(latencyMs)) return;
  const sampleCount = bucket.latencies.length;
  if (sampleCount < MAX_LATENCY_SAMPLES_PER_BUCKET) {
    bucket.latencies.push(latencyMs);
    return;
  }

  // Deterministic down-sampling keeps hourly percentile estimates bounded
  // while preserving coverage across the whole bucket window.
  const replaceAt = bucket.requests % MAX_LATENCY_SAMPLES_PER_BUCKET;
  bucket.latencies[replaceAt] = latencyMs;
}

function addTraceToBucket(bucket: TraceBucketAggregate, trace: TraceEntry) {
  const model = trace.model || "unknown";
  const traceCost =
    typeof trace.costUsd === "number"
      ? trace.costUsd
      : (estimateCostUsd(
          trace.model,
          trace.tokensInput ?? 0,
          trace.tokensOutput ?? 0,
          trace.tokensInputCached ?? 0,
          trace.tokensInputCacheWrite ?? 0,
        ) ?? 0);
  const traceTokensTotal =
    trace.tokensTotal ?? (trace.tokensInput ?? 0) + (trace.tokensOutput ?? 0);

  bucket.requests += 1;
  if (trace.usageStatus === "measured" || trace.usage) {
    bucket.requestsWithUsage += 1;
  }
  if (typeof trace.costUsd === "number") bucket.requestsWithCost += 1;
  if (trace.costStatus === "unpriced") bucket.unpricedRequests += 1;
  if (trace.isError) bucket.errors += 1;
  bucket.tokensInput += trace.tokensInput ?? 0;
  bucket.tokensInputCached += trace.tokensInputCached ?? 0;
  bucket.tokensOutput += trace.tokensOutput ?? 0;
  bucket.tokensTotal += traceTokensTotal;
  const inferenceSpeed = traceInferenceTokensPerSecond(trace);
  if (typeof inferenceSpeed === "number") {
    bucket.inferenceSpeeds.push(inferenceSpeed);
  }
  bucket.costUsd += traceCost;
  bucket.latencyMsTotal += Number.isFinite(trace.latencyMs) ? trace.latencyMs : 0;
  addLatencySample(bucket, trace.latencyMs);

  const existing = bucket.models.get(model);
  if (existing) {
    existing.count += 1;
    if (!trace.isError) existing.okCount += 1;
    existing.tokensInput += trace.tokensInput ?? 0;
    existing.tokensInputCached += trace.tokensInputCached ?? 0;
    existing.tokensOutput += trace.tokensOutput ?? 0;
    existing.tokensTotal += traceTokensTotal;
    existing.costUsd += traceCost;
    return;
  }

  bucket.models.set(model, {
    model,
    count: 1,
    okCount: trace.isError ? 0 : 1,
    tokensInput: trace.tokensInput ?? 0,
    tokensInputCached: trace.tokensInputCached ?? 0,
    tokensOutput: trace.tokensOutput ?? 0,
    tokensTotal: traceTokensTotal,
    costUsd: traceCost,
  });
}

export type TraceManager = ReturnType<typeof createTraceManager>;

export function isHiddenTraceRoute(route: string | undefined): boolean {
  const normalized = String(route ?? "").trim();
  if (!normalized) return false;
  const routeWithoutMethod = normalized.replace(/^[A-Z]+\s+/, "");
  const [pathOnly] = routeWithoutMethod.split("?");
  return (
    pathOnly === "/" ||
    pathOnly === "/favicon.ico" ||
    pathOnly.startsWith("/admin/") ||
    pathOnly.startsWith("/assets/") ||
    pathOnly === "/v1/models" ||
    /^\/v1\/models\/[^/]+$/.test(pathOnly)
  );
}

export function createTraceManager(config: TraceManagerConfig) {
  const {
    filePath,
    historyFilePath = `${filePath}.stats-history`,
    retentionMax = DEFAULT_RETENTION_MAX,
    pageSizeMax = DEFAULT_PAGE_SIZE_MAX,
    legacyLimitMax = DEFAULT_LEGACY_LIMIT_MAX,
  } = config;

  let traceWriteQueue: Promise<void> = Promise.resolve();
  let historyWriteQueue: Promise<void> = Promise.resolve();
  const traceCache: TraceEntry[] = [];
  const statsBuckets = new Map<number, TraceBucketAggregate>();
  const statsHistoryIds = new Set<string>();
  let totalStored = 0;
  let physicalTraceLineCount = 0;
  let traceCompactionQueued = false;
  let cacheInit: Promise<void> | null = null;
  let lastWriteError: { at: number; message: string } | undefined;
  const traceCompactionThreshold = Math.max(
    retentionMax + 1,
    Math.ceil(retentionMax * TRACE_COMPACTION_RATIO),
  );
  const trackedHistoryIdLimit = Math.max(retentionMax * 2, 2_000);

  function rememberStatsHistoryId(id: string) {
    statsHistoryIds.delete(id);
    statsHistoryIds.add(id);
    while (statsHistoryIds.size > trackedHistoryIdLimit) {
      const oldest = statsHistoryIds.values().next().value;
      if (typeof oldest !== "string") break;
      statsHistoryIds.delete(oldest);
    }
  }

  function setLastWriteError(error: unknown) {
    lastWriteError = {
      at: Date.now(),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  async function ensureParentDir(file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }

  function trimTraceCache() {
    if (traceCache.length <= retentionMax) return;

    const completedSlots = Math.max(
      0,
      retentionMax -
        traceCache.reduce(
          (count, trace) =>
            count + (trace.lifecycleState === "started" ? 1 : 0),
          0,
        ),
    );
    let completedToKeep = completedSlots;
    const keep = new Array<boolean>(traceCache.length).fill(false);
    for (let i = traceCache.length - 1; i >= 0; i -= 1) {
      if (traceCache[i].lifecycleState === "started") {
        keep[i] = true;
      } else if (completedToKeep > 0) {
        keep[i] = true;
        completedToKeep -= 1;
      }
    }
    const trimmed = traceCache.filter((_trace, index) => keep[index]);
    traceCache.splice(0, traceCache.length, ...trimmed);
  }

  async function readTraceFileFromDisk(): Promise<{
    traces: TraceEntry[];
    physicalLineCount: number;
  }> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const latestById = new Map<string, TraceEntry>();
      let physicalLineCount = 0;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        physicalLineCount += 1;
        try {
          const normalized = normalizeTrace(JSON.parse(line));
          if (!normalized) continue;
          // A completed lifecycle trace is appended with the same id as its
          // durable "started" record. Delete first so Map iteration reflects
          // the position of the latest physical record.
          latestById.delete(normalized.id);
          latestById.set(normalized.id, normalized);
        } catch {}
      }
      return {
        traces: Array.from(latestById.values()),
        physicalLineCount,
      };
    } catch {
      return { traces: [], physicalLineCount: 0 };
    }
  }

  async function scanStatsHistory<T>(
    onTrace: (trace: TraceEntry) => void,
    shouldCollect?: (trace: TraceEntry) => boolean,
  ): Promise<T extends true ? TraceEntry[] : void>;
  async function scanStatsHistory(
    onTrace: (trace: TraceEntry) => void,
    shouldCollect?: (trace: TraceEntry) => boolean,
  ): Promise<TraceEntry[] | void> {
    try {
      const collected: TraceEntry[] = [];
      const input = createReadStream(historyFilePath, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const normalized = normalizeTrace(JSON.parse(line));
          if (!normalized) continue;
          onTrace(normalized);
          if (shouldCollect?.(normalized)) collected.push(normalized);
        } catch {}
      }
      return shouldCollect ? collected : undefined;
    } catch {
      return shouldCollect ? [] : undefined;
    }
  }

  function ingestStatsTrace(trace: TraceEntry) {
    if (isHiddenTraceRoute(trace.route)) return;
    totalStored += 1;
    const bucketAt = Math.floor(trace.at / HOUR_MS) * HOUR_MS;
    const bucket = statsBuckets.get(bucketAt) ?? createEmptyBucket(bucketAt);
    addTraceToBucket(bucket, trace);
    statsBuckets.set(bucketAt, bucket);
  }

  function ingestPersistedStatsTrace(trace: TraceEntry) {
    if (statsHistoryIds.has(trace.id)) return;
    rememberStatsHistoryId(trace.id);
    ingestStatsTrace(trace);
  }

  async function ensureCacheReady() {
    if (cacheInit) {
      await cacheInit;
      return;
    }
    cacheInit = (async () => {
      await Promise.all([ensureParentDir(filePath), ensureParentDir(historyFilePath)]);
      const [{ traces, physicalLineCount }] = await Promise.all([
        readTraceFileFromDisk(),
        scanStatsHistory(ingestPersistedStatsTrace),
      ]);
      traceCache.splice(0, traceCache.length, ...traces);
      trimTraceCache();
      physicalTraceLineCount = physicalLineCount;
    })();
    await cacheInit;
  }

  async function initialize(): Promise<void> {
    await ensureCacheReady();
  }

  async function writeTraceWindow(entries: TraceEntry[]): Promise<void> {
    const tmp = `${filePath}.tmp-${randomUUID()}`;
    const BATCH_SIZE = 1000;
    const MAX_ENTRY_SIZE = 1024 * 1024; // 1MB per entry max
    const fileHandle = await fs.open(tmp, 'w');
    let writtenEntries = 0;
    try {
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const batchLines = [];
        for (const entry of batch) {
          const json = JSON.stringify(entry);
          if (json.length > MAX_ENTRY_SIZE) {
            console.warn(`Skipping oversized trace entry (${json.length} bytes)`);
            continue;
          }
          batchLines.push(json);
          writtenEntries += 1;
        }
        if (batchLines.length > 0) {
          const batchContent = batchLines.join('\n') + '\n';
          await fileHandle.writeFile(batchContent);
        }
      }
    } finally {
      await fileHandle.close();
    }
    await fs.rename(tmp, filePath);
    physicalTraceLineCount = writtenEntries;
  }

  function queueTraceWrite(operation: () => Promise<void>): Promise<void> {
    const run = traceWriteQueue.then(operation);
    traceWriteQueue = run.catch(() => undefined);
    return run;
  }

  async function appendTraceRecord(entry: TraceEntry): Promise<void> {
    const index = traceCache.findIndex((trace) => trace.id === entry.id);
    if (index >= 0) traceCache.splice(index, 1);
    traceCache.push(entry);
    trimTraceCache();
    await ensureParentDir(filePath);
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    physicalTraceLineCount += 1;
  }

  function queueTraceCompactionIfNeeded() {
    if (
      traceCompactionQueued ||
      physicalTraceLineCount <= traceCompactionThreshold
    ) {
      return;
    }

    traceCompactionQueued = true;
    const run = queueTraceWrite(async () => {
      try {
        if (physicalTraceLineCount > traceCompactionThreshold) {
          await writeTraceWindow(traceCache);
        }
      } finally {
        traceCompactionQueued = false;
      }
    });
    void run.catch((err) => {
      setLastWriteError(err);
      console.error("trace compaction failed", err);
    });
  }

  function toStatsHistoryEntry(entry: TraceEntry): TraceEntry {
    const {
      requestBody: _requestBody,
      usage: _usage,
      error: _error,
      upstreamError: _upstreamError,
      upstreamContentType: _upstreamContentType,
      upstreamEmptyBody: _upstreamEmptyBody,
      imageTrace: _imageTrace,
      assistantEmptyOutput: _assistantEmptyOutput,
      assistantFinishReason: _assistantFinishReason,
      responseStreamDiagnostics: _responseStreamDiagnostics,
      ...rest
    } = entry;
    return rest;
  }

  function toNormalizedHistoryEntry(entry: TraceEntry): TraceEntry | null {
    return normalizeTrace(toStatsHistoryEntry(entry));
  }

  async function appendStatsHistory(entry: TraceEntry): Promise<void> {
    await ensureCacheReady();
    const normalized = toNormalizedHistoryEntry(entry);
    const line = `${JSON.stringify(toStatsHistoryEntry(entry))}\n`;
    const run = historyWriteQueue.then(async () => {
      if (normalized && statsHistoryIds.has(normalized.id)) return;
      await ensureParentDir(historyFilePath);
      await fs.appendFile(historyFilePath, line, "utf8");
      if (normalized) {
        rememberStatsHistoryId(normalized.id);
        ingestStatsTrace(normalized);
      }
    });
    historyWriteQueue = run.catch(() => undefined);
    await run;
  }

  async function readTraceWindow(): Promise<TraceEntry[]> {
    await ensureCacheReady();
    return traceCache.slice();
  }

  async function readTraceById(id: string): Promise<TraceEntry | null> {
    await ensureCacheReady();
    return traceCache.find((trace) => trace.id === id) ?? null;
  }

  function toTraceListEntry(entry: TraceEntry): TraceListEntry {
    const { requestBody: _requestBody, ...rest } = entry;
    return {
      ...rest,
      hasRequestBody: typeof entry.requestBody !== "undefined",
    };
  }

  async function readTraceListWindow(): Promise<TraceListEntry[]> {
    await ensureCacheReady();
    return traceCache.map(toTraceListEntry);
  }

  async function readStatsHistory(): Promise<TraceEntry[]> {
    await ensureCacheReady();
    const traces = await scanStatsHistory<true>(() => undefined, () => true);
    return traces ?? [];
  }

  async function readStatsHistoryRange(
    sinceMs?: number,
    untilMs?: number,
  ): Promise<TraceEntry[]> {
    await ensureCacheReady();
    const traces = await scanStatsHistory<true>(
      () => undefined,
      (t) => {
        if (
          typeof sinceMs === "number" &&
          Number.isFinite(sinceMs) &&
          t.at < sinceMs
        ) {
          return false;
        }
        if (
          typeof untilMs === "number" &&
          Number.isFinite(untilMs) &&
          t.at > untilMs
        ) {
          return false;
        }
        return true;
      },
    );
    return traces ?? [];
  }

  async function seedStatsHistoryIfMissing() {
    await ensureCacheReady();
    for (const entry of traceCache) {
      if (entry.lifecycleState === "started" || statsHistoryIds.has(entry.id)) {
        continue;
      }
      await appendStatsHistory(entry);
    }
  }

  async function compactTraceStorageIfNeeded() {
    await ensureCacheReady();
    if (physicalTraceLineCount <= traceCompactionThreshold) return;
    await queueTraceWrite(async () => {
      if (physicalTraceLineCount > traceCompactionThreshold) {
        trimTraceCache();
        await writeTraceWindow(traceCache);
      }
    });
  }

  async function getTraceStats(
    sinceMs?: number,
    untilMs?: number,
  ): Promise<{ totalStored: number; matched: number; stats: TraceStats }> {
    await ensureCacheReady();
    const selectedBuckets = Array.from(statsBuckets.values())
      .filter((bucket) => {
        if (
          typeof sinceMs === "number" &&
          Number.isFinite(sinceMs) &&
          bucket.at + HOUR_MS <= sinceMs
        ) {
          return false;
        }
        if (
          typeof untilMs === "number" &&
          Number.isFinite(untilMs) &&
          bucket.at > untilMs
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.at - b.at);

    const modelMap = new Map<string, TraceModelStats>();
    let requests = 0;
    let requestsWithUsage = 0;
    let requestsWithCost = 0;
    let unpricedRequests = 0;
    let errors = 0;
    let tokensInput = 0;
    let tokensInputCached = 0;
    let tokensOutput = 0;
    let tokensTotal = 0;
    let inferenceSpeedTotal = 0;
    let inferenceRequests = 0;
    let costUsd = 0;
    let latencyWeightedTotal = 0;

    const timeseries = selectedBuckets.map((bucket) => {
      requests += bucket.requests;
      requestsWithUsage += bucket.requestsWithUsage;
      requestsWithCost += bucket.requestsWithCost;
      unpricedRequests += bucket.unpricedRequests;
      errors += bucket.errors;
      tokensInput += bucket.tokensInput;
      tokensInputCached += bucket.tokensInputCached;
      tokensOutput += bucket.tokensOutput;
      tokensTotal += bucket.tokensTotal;
      inferenceSpeedTotal += bucket.inferenceSpeeds.reduce(
        (sum, speed) => sum + speed,
        0,
      );
      inferenceRequests += bucket.inferenceSpeeds.length;
      costUsd += bucket.costUsd;
      latencyWeightedTotal += bucket.latencyMsTotal;

      for (const model of bucket.models.values()) {
        const existing = modelMap.get(model.model);
        if (existing) {
          existing.count += model.count;
          existing.okCount += model.okCount;
          existing.tokensInput += model.tokensInput;
          existing.tokensInputCached += model.tokensInputCached;
          existing.tokensOutput += model.tokensOutput;
          existing.tokensTotal += model.tokensTotal;
          existing.costUsd += model.costUsd;
        } else {
          modelMap.set(model.model, { ...model });
        }
      }

      return {
        at: bucket.at,
        requests: bucket.requests,
        errors: bucket.errors,
        tokensInput: bucket.tokensInput,
        tokensInputCached: bucket.tokensInputCached,
        tokensOutput: bucket.tokensOutput,
        tokensTotal: bucket.tokensTotal,
        inferenceTokensPerSecond: average(bucket.inferenceSpeeds),
        inferenceRequests: bucket.inferenceSpeeds.length,
        costUsd: bucket.costUsd,
        latencyP50Ms: percentile(bucket.latencies, 50),
        latencyP95Ms: percentile(bucket.latencies, 95),
      };
    });

    return {
      totalStored,
      matched: requests,
      stats: {
        totals: {
          requests,
          requestsWithUsage,
          requestsWithCost,
          unpricedRequests,
          errors,
          errorRate: requests ? errors / requests : 0,
          tokensInput,
          tokensInputCached,
          tokensOutput,
          tokensTotal,
          inferenceTokensPerSecond: inferenceRequests
            ? inferenceSpeedTotal / inferenceRequests
            : 0,
          inferenceRequests,
          costUsd,
          latencyAvgMs: requests ? latencyWeightedTotal / requests : 0,
        },
        models: Array.from(modelMap.values()).sort((a, b) => b.count - a.count),
        timeseries,
      },
    };
  }

  async function appendTrace(
    entry: Omit<
      TraceEntry,
      | "id"
      | "isError"
      | "tokensInput"
      | "tokensInputCached"
      | "tokensInputCacheWrite"
      | "tokensOutput"
      | "tokensReasoning"
      | "tokensTotal"
    >,
  ) {
    const finalEntry = materializeTrace(entry);

    // Fire trace file write asynchronously - don't block on this
    const run = queueTraceWrite(async () => {
      await ensureCacheReady();
      await appendTraceRecord(finalEntry);
    });
    const traceWrite = run.then(queueTraceCompactionIfNeeded);

    try {
      await Promise.all([traceWrite, appendStatsHistory(finalEntry)]);
      lastWriteError = undefined;
    } catch (error) {
      setLastWriteError(error);
      throw error;
    }
  }

  type TraceInput = Omit<
    TraceEntry,
    | "id"
    | "isError"
    | "tokensInput"
    | "tokensInputCached"
    | "tokensInputCacheWrite"
    | "tokensOutput"
    | "tokensReasoning"
    | "tokensTotal"
  >;

  function materializeTrace(entry: TraceInput, id: string = randomUUID()): TraceEntry {
    const normalizedTokens = normalizeTokenFields(entry.usage);
    const hasMeasuredTokens = [
      normalizedTokens.tokensInput,
      normalizedTokens.tokensOutput,
      normalizedTokens.tokensTotal,
    ].some((value) => typeof value === "number");
    const usageStatus =
      entry.usageStatus === "measured" || hasMeasuredTokens
        ? "measured"
        : "missing";
    const costUsd =
      usageStatus === "measured"
        ? estimateCostUsd(
            entry.model,
            normalizedTokens.tokensInput ?? 0,
            normalizedTokens.tokensOutput ?? 0,
            normalizedTokens.tokensInputCached ?? 0,
            normalizedTokens.tokensInputCacheWrite ?? 0,
          )
        : undefined;
    const completedAt =
      entry.completedAt ??
      (entry.lifecycleState === "started" ? undefined : entry.at);
    const startedAt =
      entry.startedAt ??
      (typeof completedAt === "number"
        ? completedAt - Math.max(0, entry.latencyMs)
        : undefined);
    return {
      ...entry,
      id,
      isError: entry.status >= 400,
      startedAt,
      completedAt,
      tokensInput: normalizedTokens.tokensInput,
      tokensInputCached: normalizedTokens.tokensInputCached,
      tokensInputCacheWrite: normalizedTokens.tokensInputCacheWrite,
      tokensOutput: normalizedTokens.tokensOutput,
      tokensReasoning: normalizedTokens.tokensReasoning,
      tokensTotal: normalizedTokens.tokensTotal,
      costUsd,
      pricingVersion: costUsd !== undefined ? MODEL_PRICING_VERSION : undefined,
      usageStatus,
      costStatus:
        costUsd !== undefined
          ? "estimated"
          : usageStatus === "measured" && entry.model
            ? "unpriced"
            : "unknown",
    };
  }

  async function beginTrace(entry: TraceInput): Promise<string> {
    const initial = materializeTrace({
      ...entry,
      lifecycleState: "started",
      startedAt: entry.startedAt ?? entry.at,
    });
    const run = queueTraceWrite(async () => {
      await ensureCacheReady();
      await appendTraceRecord(initial);
    });
    try {
      await run;
      lastWriteError = undefined;
      queueTraceCompactionIfNeeded();
      return initial.id;
    } catch (error) {
      setLastWriteError(error);
      throw error;
    }
  }

  async function completeTrace(id: string, entry: TraceInput): Promise<void> {
    const finalEntry = materializeTrace(
      {
        ...entry,
        lifecycleState:
          entry.lifecycleState ?? (entry.clientDisconnected ? "interrupted" : "completed"),
        completedAt: entry.completedAt ?? entry.at,
      },
      id,
    );
    const run = queueTraceWrite(async () => {
      await ensureCacheReady();
      await appendTraceRecord(finalEntry);
    });
    try {
      await run;
      queueTraceCompactionIfNeeded();
      await appendStatsHistory(finalEntry);
      lastWriteError = undefined;
    } catch (error) {
      setLastWriteError(error);
      throw error;
    }
  }

  function recordTrace(
    entry: Omit<
      TraceEntry,
      | "id"
      | "isError"
      | "tokensInput"
      | "tokensInputCached"
      | "tokensInputCacheWrite"
      | "tokensOutput"
      | "tokensReasoning"
      | "tokensTotal"
    >,
  ) {
    void appendTrace(entry).catch((err) => {
      console.error("trace append failed", err);
    });
  }

  async function flushPendingWrites(): Promise<void> {
    await Promise.all([traceWriteQueue, historyWriteQueue]);
    if (lastWriteError) {
      throw new Error(`trace persistence failed: ${lastWriteError.message}`);
    }
  }

  function getPersistenceStatus() {
    return {
      lastError: lastWriteError,
    };
  }

  async function readTracesLegacy(limit = 200): Promise<TraceEntry[]> {
    await ensureCacheReady();
    const sliced = traceCache.slice(
      -Math.max(1, Math.min(limit, legacyLimitMax)),
    );
    return sliced;
  }

  return {
    initialize,
    readTraceWindow,
    readTraceById,
    readTraceListWindow,
    writeTraceWindow,
    readStatsHistory,
    readStatsHistoryRange,
    seedStatsHistoryIfMissing,
    compactTraceStorageIfNeeded,
    getTraceStats,
    appendTrace,
    recordTrace,
    beginTrace,
    completeTrace,
    flushPendingWrites,
    getPersistenceStatus,
    readTracesLegacy,
    buildTraceStats,
    createUsageAggregate,
    addTraceToAggregate,
    finalizeAggregate,
    usageToTokens,
    pageSizeMax,
    retentionMax,
    legacyLimitMax,
  };
}
