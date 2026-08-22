import { estimateCostUsd } from "./model-pricing.js";
import type { TraceEntry } from "./traces.js";

export type ProjectUsageModel = {
  model: string;
  requests: number;
  ok: number;
  errors: number;
  stream: number;
  successRate: number;
  streamingRate: number;
  requestsWithUsage: number;
  requestsWithCost: number;
  unpricedRequests: number;
  costUsd: number;
  tokens: {
    prompt: number;
    completion: number;
    input: number;
    cachedInput: number;
    output: number;
    total: number;
  };
  avgLatencyMs: number;
  latencyMsTotal: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  statusCounts: Record<string, number>;
};

export type ProjectUsage = Omit<ProjectUsageModel, "model"> & {
  projectId: string;
  projectName?: string;
  projectRemote?: string;
  firstAt?: number;
  lastAt?: number;
  models: ProjectUsageModel[];
};

type MutableUsage = {
  requests: number;
  ok: number;
  errors: number;
  stream: number;
  requestsWithUsage: number;
  requestsWithCost: number;
  unpricedRequests: number;
  costUsd: number;
  tokensInput: number;
  tokensCachedInput: number;
  tokensOutput: number;
  tokensTotal: number;
  latencyMsTotal: number;
  latencies: number[];
  statusCounts: Record<string, number>;
};

const emptyUsage = (): MutableUsage => ({
  requests: 0,
  ok: 0,
  errors: 0,
  stream: 0,
  requestsWithUsage: 0,
  requestsWithCost: 0,
  unpricedRequests: 0,
  costUsd: 0,
  tokensInput: 0,
  tokensCachedInput: 0,
  tokensOutput: 0,
  tokensTotal: 0,
  latencyMsTotal: 0,
  latencies: [],
  statusCounts: {},
});

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function traceCostUsd(trace: TraceEntry): number | undefined {
  if (typeof trace.costUsd === "number" && Number.isFinite(trace.costUsd)) {
    return trace.costUsd;
  }
  return estimateCostUsd(
    trace.model,
    trace.tokensInput ?? 0,
    trace.tokensOutput ?? 0,
    trace.tokensInputCached ?? 0,
    trace.tokensInputCacheWrite ?? 0,
  );
}

function addTrace(usage: MutableUsage, trace: TraceEntry) {
  const input = trace.tokensInput ?? 0;
  const output = trace.tokensOutput ?? 0;
  const total = trace.tokensTotal ?? input + output;
  const cost = traceCostUsd(trace);
  const latency = Number.isFinite(trace.latencyMs) ? trace.latencyMs : 0;

  usage.requests += 1;
  if (trace.isError) usage.errors += 1;
  else usage.ok += 1;
  if (trace.stream) usage.stream += 1;
  const statusKey = Number.isFinite(trace.status) ? String(trace.status) : "unknown";
  usage.statusCounts[statusKey] = (usage.statusCounts[statusKey] ?? 0) + 1;
  if (trace.usageStatus === "measured" || trace.usage) usage.requestsWithUsage += 1;
  if (typeof cost === "number") {
    usage.requestsWithCost += 1;
    usage.costUsd += cost;
  } else {
    usage.unpricedRequests += 1;
  }
  usage.tokensInput += input;
  usage.tokensCachedInput += trace.tokensInputCached ?? 0;
  usage.tokensOutput += output;
  usage.tokensTotal += total;
  usage.latencyMsTotal += latency;
  usage.latencies.push(latency);
}

function finalizeUsage(usage: MutableUsage) {
  return {
    requests: usage.requests,
    ok: usage.ok,
    errors: usage.errors,
    successRate: usage.requests ? Math.round((usage.ok / usage.requests) * 10_000) / 100 : 0,
    stream: usage.stream,
    streamingRate: usage.requests ? Math.round((usage.stream / usage.requests) * 10_000) / 100 : 0,
    requestsWithUsage: usage.requestsWithUsage,
    requestsWithCost: usage.requestsWithCost,
    unpricedRequests: usage.unpricedRequests,
    costUsd: usage.costUsd,
    tokens: {
      prompt: usage.tokensInput,
      completion: usage.tokensOutput,
      input: usage.tokensInput,
      cachedInput: usage.tokensCachedInput,
      output: usage.tokensOutput,
      total: usage.tokensTotal,
    },
    avgLatencyMs: usage.requests ? usage.latencyMsTotal / usage.requests : 0,
    latencyMsTotal: usage.latencyMsTotal,
    latencyP50Ms: percentile(usage.latencies, 50),
    latencyP95Ms: percentile(usage.latencies, 95),
    statusCounts: usage.statusCounts,
  };
}

export function aggregateProjectUsage(traces: TraceEntry[]): ProjectUsage[] {
  const projects = new Map<string, {
    projectName?: string;
    projectRemote?: string;
    firstAt?: number;
    lastAt?: number;
    usage: MutableUsage;
    models: Map<string, MutableUsage>;
  }>();

  for (const trace of traces) {
    const projectId = trace.projectId ?? "unattributed";
    const project = projects.get(projectId) ?? {
      projectName: trace.projectName,
      projectRemote: trace.projectRemote,
      usage: emptyUsage(),
      models: new Map<string, MutableUsage>(),
    };
    project.projectName ??= trace.projectName;
    project.projectRemote ??= trace.projectRemote;
    project.firstAt = project.firstAt === undefined ? trace.at : Math.min(project.firstAt, trace.at);
    project.lastAt = project.lastAt === undefined ? trace.at : Math.max(project.lastAt, trace.at);
    addTrace(project.usage, trace);

    const model = trace.model || "unknown";
    const modelUsage = project.models.get(model) ?? emptyUsage();
    addTrace(modelUsage, trace);
    project.models.set(model, modelUsage);
    projects.set(projectId, project);
  }

  return Array.from(projects.entries())
    .map(([projectId, project]) => ({
      projectId,
      projectName: project.projectName,
      projectRemote: project.projectRemote,
      firstAt: project.firstAt,
      lastAt: project.lastAt,
      ...finalizeUsage(project.usage),
      models: Array.from(project.models.entries())
        .map(([model, usage]) => ({ model, ...finalizeUsage(usage) }))
        .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}
