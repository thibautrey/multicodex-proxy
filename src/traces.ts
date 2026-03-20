import { estimateCostUsd } from "./model-pricing.js";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TRACE_COMPACTION_INTERVAL } from "./config.js";

export type TraceEntry = {
  id: string;
  at: number;
  route: string;
  sessionId?: string;
  accountId?: string;
  accountEmail?: string;
  model?: string;
  status: number;
  isError: boolean;
  stream: boolean;
  latencyMs: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  costUsd?: number;
  usage?: any;
  requestBody?: any;
  error?: string;
  upstreamError?: string;
  upstreamContentType?: string;
  upstreamEmptyBody?: boolean;
  assistantEmptyOutput?: boolean;
  assistantFinishReason?: string;
};

export type TraceListEntry = Omit<TraceEntry, "requestBody"> & {
  hasRequestBody: boolean;
};

export type TraceTotals = {
  requests: number;
  errors: number;
  errorRate: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
  latencyAvgMs: number;
};

export type TraceModelStats = {
  model: string;
  count: number;
  okCount: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  costUsd: number;
};

export type TraceTimeseriesBucket = {
  at: number;
  requests: number;
  errors: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
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
  costUsd: number;
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

const DEFAULT_RETENTION_MAX = 10000;
const DEFAULT_PAGE_SIZE_MAX = 100;
const DEFAULT_LEGACY_LIMIT_MAX = 2000;

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
  fallback?: { input?: number; output?: number; total?: number },
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
    (input ?? 0) + (output ?? 0);
  return {
    tokensInput: input,
    tokensOutput: output,
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
    output: safeNumber(raw.tokensOutput),
    total: safeNumber(raw.tokensTotal),
  });
  const costUsd = estimateCostUsd(
    model,
    normalizedTokens.tokensInput ?? 0,
    normalizedTokens.tokensOutput ?? 0,
  );

  return {
    id:
      typeof raw.id === "string" && raw.id
        ? raw.id
        : `${at}-${route}-${status}`,
    at,
    route,
    sessionId:
      typeof raw.sessionId === "string" && raw.sessionId.trim()
        ? raw.sessionId.trim()
        : undefined,
    accountId: typeof raw.accountId === "string" ? raw.accountId : undefined,
    accountEmail:
      typeof raw.accountEmail === "string" ? raw.accountEmail : undefined,
    model,
    status,
    isError: typeof raw.isError === "boolean" ? raw.isError : status >= 400,
    stream: Boolean(raw.stream),
    latencyMs,
    tokensInput: normalizedTokens.tokensInput,
    tokensOutput: normalizedTokens.tokensOutput,
    tokensTotal: normalizedTokens.tokensTotal,
    costUsd,
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
    assistantEmptyOutput:
      typeof raw.assistantEmptyOutput === "boolean"
        ? raw.assistantEmptyOutput
        : undefined,
    assistantFinishReason:
      typeof raw.assistantFinishReason === "string"
        ? raw.assistantFinishReason
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

function usageToTokens(usage: any): UsageTokenTotals {
  const promptTokens =
    safeNumber(usage?.prompt_tokens) ?? safeNumber(usage?.input_tokens) ?? 0;
  const completionTokens =
    safeNumber(usage?.completion_tokens) ??
    safeNumber(usage?.output_tokens) ??
    0;
  const totalTokens =
    safeNumber(usage?.total_tokens) ?? promptTokens + completionTokens;
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
    costUsd: 0,
    statusCounts: {},
  };
}

function addTraceToAggregate(agg: UsageAggregate, trace: TraceEntry) {
  const status = Number(trace.status);
  const statusKey = Number.isFinite(status) ? String(status) : "unknown";
  const tokens = usageToTokens(trace.usage);
  const costUsd =
    typeof trace.costUsd === "number"
      ? trace.costUsd
      : estimateCostUsd(
          trace.model,
          trace.tokensInput ?? 0,
          trace.tokensOutput ?? 0,
        ) ?? 0;

  agg.requests += 1;
  if (status >= 200 && status < 400) agg.ok += 1;
  else agg.errors += 1;
  if (trace.stream) agg.stream += 1;

  agg.latencyMsTotal += Number.isFinite(trace.latencyMs) ? trace.latencyMs : 0;
  agg.statusCounts[statusKey] = (agg.statusCounts[statusKey] ?? 0) + 1;

  if (trace.usage) {
    agg.requestsWithUsage += 1;
    agg.promptTokens += tokens.promptTokens;
    agg.completionTokens += tokens.completionTokens;
    agg.totalTokens += tokens.totalTokens;
  }
  agg.costUsd += costUsd;

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
    costUsd: Math.round(agg.costUsd * 1_000_000) / 1_000_000,
    statusCounts: agg.statusCounts,
    firstAt: agg.firstAt,
    lastAt: agg.lastAt,
  };
}

function buildTraceStats(traces: TraceEntry[]): TraceStats {
  const requests = traces.length;
  const errors = traces.filter((t) => t.isError).length;
  const tokensInput = traces.reduce((sum, t) => sum + (t.tokensInput ?? 0), 0);
  const tokensOutput = traces.reduce(
    (sum, t) => sum + (t.tokensOutput ?? 0),
    0,
  );
  const tokensTotal = traces.reduce(
    (sum, t) =>
      sum + (t.tokensTotal ?? (t.tokensInput ?? 0) + (t.tokensOutput ?? 0)),
    0,
  );
  const costUsd = traces.reduce((sum, t) => {
    if (typeof t.costUsd === "number") return sum + t.costUsd;
    return (
      sum +
      (estimateCostUsd(t.model, t.tokensInput ?? 0, t.tokensOutput ?? 0) ?? 0)
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
          ) ?? 0);
    if (!existing) {
      modelMap.set(key, {
        model: key,
        count: 1,
        okCount: trace.isError ? 0 : 1,
        tokensInput: trace.tokensInput ?? 0,
        tokensOutput: trace.tokensOutput ?? 0,
        tokensTotal: trace.tokensTotal ?? 0,
        costUsd: traceCost,
      });
    } else {
      existing.count += 1;
      if (!trace.isError) existing.okCount += 1;
      existing.tokensInput += trace.tokensInput ?? 0;
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
      tokensOutput: number;
      tokensTotal: number;
      costUsd: number;
      latencies: number[];
    }
  >();
  for (const trace of traces) {
    const bucketAt = Math.floor(trace.at / 3_600_000) * 3_600_000;
    const bucket = bucketMap.get(bucketAt) ?? {
      requests: 0,
      errors: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensTotal: 0,
      costUsd: 0,
      latencies: [],
    };
    bucket.requests += 1;
    if (trace.isError) bucket.errors += 1;
    bucket.tokensInput += trace.tokensInput ?? 0;
    bucket.tokensOutput += trace.tokensOutput ?? 0;
    bucket.tokensTotal += trace.tokensTotal ?? 0;
    bucket.costUsd +=
      typeof trace.costUsd === "number"
        ? trace.costUsd
        : (estimateCostUsd(
            trace.model,
            trace.tokensInput ?? 0,
            trace.tokensOutput ?? 0,
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
      tokensOutput: bucket.tokensOutput,
      tokensTotal: bucket.tokensTotal,
      costUsd: bucket.costUsd,
      latencyP50Ms: percentile(bucket.latencies, 50),
      latencyP95Ms: percentile(bucket.latencies, 95),
    }));

  return {
    totals: {
      requests,
      errors,
      errorRate,
      tokensInput,
      tokensOutput,
      tokensTotal,
      costUsd,
      latencyAvgMs,
    },
    models,
    timeseries,
  };
}

export type TraceManager = ReturnType<typeof createTraceManager>;

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
  const statsCache: TraceEntry[] = [];
  let cacheInit: Promise<void> | null = null;
  let appendSinceCompaction = 0;
  let compactionQueued = false;

  async function readTraceFileFromDisk(): Promise<TraceEntry[]> {
    try {
      const fileHandle = await fs.open(filePath, 'r');
      const parsed: TraceEntry[] = [];
      let position = 0;
      let buffer = Buffer.alloc(65536); // 64KB buffer
      let remaining = '';
      
      try {
        while (true) {
          const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          
          position += bytesRead;
          const chunk = remaining + buffer.toString('utf8', 0, bytesRead);
          const lines = chunk.split('\n');
          remaining = lines.pop() || '';
          
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const normalized = normalizeTrace(JSON.parse(line));
              if (normalized) parsed.push(normalized);
            } catch {}
          }
        }
        
        // Process any remaining data
        if (remaining.trim()) {
          try {
            const normalized = normalizeTrace(JSON.parse(remaining));
            if (normalized) parsed.push(normalized);
          } catch {}
        }
        
      } finally {
        await fileHandle.close();
      }
      
      return parsed.slice(-retentionMax); // Ensure we don't exceed retention
    } catch {
      return [];
    }
  }

  async function readStatsHistoryFileFromDisk(): Promise<TraceEntry[]> {
    try {
      const fileHandle = await fs.open(historyFilePath, 'r');
      const parsed: TraceEntry[] = [];
      let position = 0;
      let buffer = Buffer.alloc(65536); // 64KB buffer
      let remaining = '';
      
      try {
        while (true) {
          const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          
          position += bytesRead;
          const chunk = remaining + buffer.toString('utf8', 0, bytesRead);
          const lines = chunk.split('\n');
          remaining = lines.pop() || '';
          
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const normalized = normalizeTrace(JSON.parse(line));
              if (normalized) parsed.push(normalized);
            } catch {}
          }
        }
        
        // Process any remaining data
        if (remaining.trim()) {
          try {
            const normalized = normalizeTrace(JSON.parse(remaining));
            if (normalized) parsed.push(normalized);
          } catch {}
        }
        
      } finally {
        await fileHandle.close();
      }
      
      return parsed;
    } catch {
      return [];
    }
  }

  async function ensureCacheReady() {
    if (cacheInit) {
      await cacheInit;
      return;
    }
    cacheInit = (async () => {
      const traces = await readTraceFileFromDisk();
      traceCache.splice(0, traceCache.length, ...traces.slice(-retentionMax));
      const stats = await readStatsHistoryFileFromDisk();
      statsCache.splice(0, statsCache.length, ...stats);
    })();
    await cacheInit;
  }

  async function writeTraceWindow(entries: TraceEntry[]): Promise<void> {
    const tmp = `${filePath}.tmp-${randomUUID()}`;
    const BATCH_SIZE = 1000;
    const MAX_ENTRY_SIZE = 1024 * 1024; // 1MB per entry max
    const fileHandle = await fs.open(tmp, 'w');
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
  }

  async function appendTraceLine(entry: TraceEntry): Promise<void> {
    const json = JSON.stringify(entry);
    if (json.length > 1024 * 1024) return;
    await fs.appendFile(filePath, `${json}\n`, "utf8");
  }

  function toStatsHistoryEntry(entry: TraceEntry): TraceEntry {
    const {
      requestBody: _requestBody,
      usage: _usage,
      error: _error,
      upstreamError: _upstreamError,
      upstreamContentType: _upstreamContentType,
      upstreamEmptyBody: _upstreamEmptyBody,
      assistantEmptyOutput: _assistantEmptyOutput,
      assistantFinishReason: _assistantFinishReason,
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
    if (normalized) {
      statsCache.push(normalized);
    }
    const line = `${JSON.stringify(toStatsHistoryEntry(entry))}\n`;
    const run = historyWriteQueue.then(async () => {
      await fs.appendFile(historyFilePath, line, "utf8");
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
    return statsCache.slice();
  }

  async function readStatsHistoryRange(
    sinceMs?: number,
    untilMs?: number,
  ): Promise<TraceEntry[]> {
    await ensureCacheReady();
    return statsCache.filter((t) => {
      if (
        typeof sinceMs === "number" &&
        Number.isFinite(sinceMs) &&
        t.at < sinceMs
      )
        return false;
      if (
        typeof untilMs === "number" &&
        Number.isFinite(untilMs) &&
        t.at > untilMs
      )
        return false;
      return true;
    });
  }

  async function seedStatsHistoryIfMissing() {
    await ensureCacheReady();
    try {
      const existing = await fs.readFile(historyFilePath, "utf8");
      if (existing.trim()) return;
    } catch {}
    if (!traceCache.length) return;
    
    const BATCH_SIZE = 1000;
    const MAX_ENTRY_SIZE = 1024 * 1024; // 1MB per entry max
    const fileHandle = await fs.open(historyFilePath, 'w');
    const historyEntries: TraceEntry[] = [];
    
    try {
      for (let i = 0; i < traceCache.length; i += BATCH_SIZE) {
        const batch = traceCache.slice(i, i + BATCH_SIZE);
        const batchLines = [];
        for (const entry of batch) {
          const statsEntry = toStatsHistoryEntry(entry);
          const json = JSON.stringify(statsEntry);
          if (json.length > MAX_ENTRY_SIZE) {
            console.warn(`Skipping oversized history entry (${json.length} bytes)`);
            continue;
          }
          batchLines.push(json);
          const normalized = toNormalizedHistoryEntry(entry);
          if (normalized) {
            historyEntries.push(normalized);
          }
        }
        if (batchLines.length > 0) {
          const batchContent = batchLines.join('\n') + '\n';
          await fileHandle.writeFile(batchContent);
        }
      }
    } finally {
      await fileHandle.close();
    }
    
    statsCache.splice(0, statsCache.length, ...historyEntries);
  }

  async function compactTraceStorageIfNeeded() {
    await ensureCacheReady();
    try {
      await writeTraceWindow(traceCache.slice(-retentionMax));
    } catch {}
  }

  function queueCompactionIfNeeded() {
    if (compactionQueued) return;
    if (traceCache.length <= retentionMax && appendSinceCompaction < TRACE_COMPACTION_INTERVAL) {
      return;
    }
    compactionQueued = true;
    traceWriteQueue = traceWriteQueue.then(async () => {
      try {
        await writeTraceWindow(traceCache.slice(-retentionMax));
        appendSinceCompaction = 0;
      } finally {
        compactionQueued = false;
      }
    });
  }

  async function appendTrace(
    entry: Omit<
      TraceEntry,
      "id" | "tokensInput" | "tokensOutput" | "tokensTotal" | "isError"
    > & { isError?: boolean },
  ) {
    const normalizedTokens = normalizeTokenFields(entry.usage);
    const finalEntry: TraceEntry = {
      ...entry,
      id: randomUUID(),
      isError: entry.isError ?? entry.status >= 400,
      tokensInput: normalizedTokens.tokensInput,
      tokensOutput: normalizedTokens.tokensOutput,
      tokensTotal: normalizedTokens.tokensTotal,
      costUsd: estimateCostUsd(
        entry.model,
        normalizedTokens.tokensInput ?? 0,
        normalizedTokens.tokensOutput ?? 0,
      ),
    };

    const run = traceWriteQueue.then(async () => {
      await ensureCacheReady();
      traceCache.push(finalEntry);
      if (traceCache.length > retentionMax) {
        traceCache.splice(0, traceCache.length - retentionMax);
      }
      appendSinceCompaction += 1;
      await appendTraceLine(finalEntry);
      queueCompactionIfNeeded();
    });
    traceWriteQueue = run.catch(() => undefined);
    await Promise.all([run, appendStatsHistory(finalEntry)]);
  }

  async function readTracesLegacy(limit = 200): Promise<TraceEntry[]> {
    await ensureCacheReady();
    const sliced = traceCache.slice(
      -Math.max(1, Math.min(limit, legacyLimitMax)),
    );
    return sliced;
  }

  return {
    readTraceWindow,
    readTraceById,
    readTraceListWindow,
    writeTraceWindow,
    readStatsHistory,
    readStatsHistoryRange,
    seedStatsHistoryIfMissing,
    compactTraceStorageIfNeeded,
    appendTrace,
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
