import type { TracePagination, TraceStats } from "../types";

export const TRACE_PAGE_SIZE = 100;
export const CHART_COLORS = ["#1f7a8c", "#2da4b8", "#4c956c", "#f4a259", "#e76f51", "#8a5a44", "#355070", "#43aa8b"];

export const EMPTY_TRACE_STATS: TraceStats = {
  totals: {
    requests: 0,
    errors: 0,
    errorRate: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensTotal: 0,
    costUsd: 0,
    latencyAvgMs: 0,
  },
  models: [],
  timeseries: [],
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
export const usd = (v: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);

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
