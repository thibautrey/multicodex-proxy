import type { TracePagination, TraceStats } from "../types";

export const TRACE_PAGE_SIZE = 100;
export const CHART_COLORS = ["#147d72", "#45a99c", "#dda15e", "#8d79d6", "#d96270", "#55c7b8", "#efb26f", "#6b7d77"];

export const EMPTY_TRACE_STATS: TraceStats = {
  totals: {
    requests: 0,
    upstreamAttempts: 0,
    retriedRequests: 0,
    recoveredRequests: 0,
    requestsWithUsage: 0,
    requestsWithCost: 0,
    unpricedRequests: 0,
    errors: 0,
    errorRate: 0,
    tokensInput: 0,
    tokensInputCached: 0,
    tokensOutput: 0,
    tokensTotal: 0,
    inferenceTokensPerSecond: 0,
    inferenceRequests: 0,
    costUsd: 0,
    costUsdWithoutCache: 0,
    latencyAvgMs: 0,
  },
  models: [],
  timeseries: [],
  ttftByProviderModel: [],
  accountSelection: {
    attempts: 0,
    rotations: 0,
    maxNearLimit: 0,
    averageHeadroom: undefined,
    reasonCounts: {
      sticky: 0,
      "policy-preferred": 0,
      "quota-headroom": 0,
    },
  },
};

export const EMPTY_TRACE_PAGINATION: TracePagination = {
  page: 1,
  pageSize: TRACE_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasPrev: false,
  hasNext: false,
};

export const fmt = (ts?: number) => (!ts ? "-" : new Date(ts).toLocaleString());
export const clampPct = (v: number) => Math.max(0, Math.min(100, v));
export const compactNumber = (v: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const usdFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const compactUsdFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});
const costUnits = [
  { value: 1_000_000_000, suffix: "B" },
  { value: 1_000_000, suffix: "M" },
  { value: 1_000, suffix: "K" },
];

export const usd = (v: number) => {
  const absoluteValue = Math.abs(v);
  const unitIndex = costUnits.findIndex((unit) => absoluteValue >= unit.value);
  if (unitIndex === -1) return usdFormatter.format(v);

  let unit = costUnits[unitIndex];
  let scaledValue = v / unit.value;
  if (Math.abs(Math.round(scaledValue * 10) / 10) >= 1_000 && unitIndex > 0) {
    unit = costUnits[unitIndex - 1];
    scaledValue = v / unit.value;
  }

  return `${compactUsdFormatter.format(scaledValue)}${unit.suffix}`;
};

export function formatTokenCount(v: number): string {
  const n = Number.isFinite(v) ? Math.max(0, v) : 0;
  if (n < 1_000) return `${Math.round(n)}`;

  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" },
  ];
  const unit = units.find((u) => n >= u.value) ?? units[units.length - 1];
  const scaled = n / unit.value;
  const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(1)}`;
  return `${text.replace(/\.0$/, "")}${unit.suffix}`;
}

export function formatTokenRate(v: number): string {
  const n = Number.isFinite(v) ? Math.max(0, v) : 0;
  if (n > 0 && n < 10) return `${n.toFixed(1)} tok/s`;
  return `${formatTokenCount(n)} tok/s`;
}

export function routeLabel(v: string) {
  if (v.includes("chat/completions")) return "chat/completions";
  if (v.includes("responses")) return "responses";
  return v;
}

export function maskEmail(v?: string) {
  if (!v) return "hidden@email";
  return "*";
}

export function maskId(v?: string) {
  if (!v) return "acc-xxxx";
  return "*";
}
