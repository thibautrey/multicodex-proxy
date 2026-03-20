import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { estimateCostUsd } from "../../model-pricing";
import { CHART_COLORS, fmt, formatSessionTail, formatTokenCount, maskEmail, maskId, pct, routeLabel, usd } from "../../lib/ui";
import { Metric } from "../Metric";
import type { Account, Trace, TracePagination, TraceRangePreset, TraceStats, TraceUsageStats } from "../../types";

type Props = {
  accounts: Account[];
  traceStats: TraceStats;
  traceUsageStats: TraceUsageStats;
  tokensTimeseries: Array<any>;
  modelChartData: Array<any>;
  modelCostChartData: Array<any>;
  tracePagination: TracePagination;
  gotoTracePage: (page: number) => Promise<void>;
  traceRange: TraceRangePreset;
  setTraceRange: (range: TraceRangePreset) => void;
  traces: Trace[];
  expandedTraceId: string | null;
  expandedTrace: Trace | null;
  expandedTraceLoading: boolean;
  toggleExpandedTrace: (id: string) => Promise<void>;
  sanitized: boolean;
  exportTracesZip: () => Promise<void>;
  exportInProgress: boolean;
};

type SessionUsageEntry = TraceUsageStats["bySession"][number];
type SessionSortKey = "requests" | "tokens" | "costUsd" | "avgLatencyMs" | "lastAt";
type SessionSortDirection = "asc" | "desc";
type SessionSortState = {
  key: SessionSortKey;
  direction: SessionSortDirection;
};
type TraceCardId =
  | "tokensOverTime"
  | "modelUsage"
  | "modelCost"
  | "errorTrend"
  | "costOverTime"
  | "latency"
  | "tokenSplit"
  | "usageByAccount"
  | "usageByRoute"
  | "topSessions";

const CARD_ORDER_STORAGE_KEY = "tracing-card-order.v1";
const TOP_SESSIONS_SORT_STORAGE_KEY = "tracing-top-sessions-sort.v1";
const DEFAULT_TOP_SESSIONS_SORT: SessionSortState = { key: "requests", direction: "desc" };
const DEFAULT_CARD_ORDER: TraceCardId[] = [
  "tokensOverTime",
  "modelUsage",
  "modelCost",
  "errorTrend",
  "costOverTime",
  "latency",
  "tokenSplit",
  "usageByAccount",
  "usageByRoute",
  "topSessions",
];
const VALID_CARD_IDS = new Set<TraceCardId>(DEFAULT_CARD_ORDER);
const VALID_SORT_KEYS = new Set<SessionSortKey>(["requests", "tokens", "costUsd", "avgLatencyMs", "lastAt"]);
const VALID_SORT_DIRECTIONS = new Set<SessionSortDirection>(["asc", "desc"]);

function normalizeCardOrder(input: unknown): TraceCardId[] {
  const raw = Array.isArray(input) ? input : [];
  const ordered: TraceCardId[] = [];

  for (const entry of raw) {
    if (typeof entry !== "string" || !VALID_CARD_IDS.has(entry as TraceCardId)) continue;
    const cardId = entry as TraceCardId;
    if (!ordered.includes(cardId)) ordered.push(cardId);
  }

  for (const cardId of DEFAULT_CARD_ORDER) {
    if (!ordered.includes(cardId)) ordered.push(cardId);
  }

  return ordered;
}

function readCardOrder(): TraceCardId[] {
  if (typeof window === "undefined") return DEFAULT_CARD_ORDER;
  try {
    const raw = window.localStorage.getItem(CARD_ORDER_STORAGE_KEY);
    return normalizeCardOrder(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_CARD_ORDER;
  }
}

function readTopSessionsSort(): SessionSortState {
  if (typeof window === "undefined") return DEFAULT_TOP_SESSIONS_SORT;
  try {
    const raw = window.localStorage.getItem(TOP_SESSIONS_SORT_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<SessionSortState>) : null;
    if (
      parsed &&
      typeof parsed.key === "string" &&
      VALID_SORT_KEYS.has(parsed.key as SessionSortKey) &&
      typeof parsed.direction === "string" &&
      VALID_SORT_DIRECTIONS.has(parsed.direction as SessionSortDirection)
    ) {
      return {
        key: parsed.key as SessionSortKey,
        direction: parsed.direction as SessionSortDirection,
      };
    }
  } catch {
    // Fall through to default sort.
  }
  return DEFAULT_TOP_SESSIONS_SORT;
}

function compareNumbers(a: number, b: number, direction: SessionSortDirection) {
  return direction === "asc" ? a - b : b - a;
}

function compareSessionEntries(a: SessionUsageEntry, b: SessionUsageEntry, sort: SessionSortState) {
  switch (sort.key) {
    case "requests":
      return compareNumbers(a.requests, b.requests, sort.direction);
    case "tokens":
      return compareNumbers(a.tokens.total, b.tokens.total, sort.direction);
    case "costUsd":
      return compareNumbers(a.costUsd, b.costUsd, sort.direction);
    case "avgLatencyMs":
      return compareNumbers(a.avgLatencyMs, b.avgLatencyMs, sort.direction);
    case "lastAt":
      return compareNumbers(Number(a.lastAt ?? 0), Number(b.lastAt ?? 0), sort.direction);
    default:
      return 0;
  }
}

export function TracingTab(props: Props) {
  const {
    accounts,
    traceStats,
    traceUsageStats,
    tokensTimeseries,
    modelChartData,
    modelCostChartData,
    tracePagination,
    gotoTracePage,
    traceRange,
    setTraceRange,
    traces,
    expandedTraceId,
    expandedTrace,
    expandedTraceLoading,
    toggleExpandedTrace,
    sanitized,
    exportTracesZip,
    exportInProgress,
  } = props;
  const [cardOrder, setCardOrder] = React.useState<TraceCardId[]>(() => readCardOrder());
  const [layoutEditMode, setLayoutEditMode] = React.useState(false);
  const [topSessionsSort, setTopSessionsSort] = React.useState<SessionSortState>(() => readTopSessionsSort());

  React.useEffect(() => {
    window.localStorage.setItem(CARD_ORDER_STORAGE_KEY, JSON.stringify(normalizeCardOrder(cardOrder)));
  }, [cardOrder]);

  React.useEffect(() => {
    window.localStorage.setItem(TOP_SESSIONS_SORT_STORAGE_KEY, JSON.stringify(topSessionsSort));
  }, [topSessionsSort]);

  const accountProviderById = React.useMemo(
    () => new Map(accounts.map((account) => [account.id, account.provider])),
    [accounts],
  );

  const providerFavicon = (provider?: string) =>
    provider === "mistral"
      ? "https://mistral.ai/favicon.ico"
      : "https://openai.com/favicon.ico";

  const providerLabel = (provider?: string) =>
    provider === "mistral" ? "Mistral" : "OpenAI";

  const formatTokenChartValue = (value: number | string | undefined) => formatTokenCount(Number(value ?? 0));

  const formatTooltipValue = (value: any) => formatTokenChartValue(value?.[0] ?? value ?? 0);

  const formatPieTokenLabel = ({ value }: { value?: number }) => formatTokenChartValue(value);
  const usageCoverage =
    traceUsageStats.totals.requests > 0
      ? (traceUsageStats.totals.requestsWithUsage / traceUsageStats.totals.requests) * 100
      : 0;
  const statusEntries = Object.entries(traceUsageStats.totals.statusCounts).sort((a, b) => b[1] - a[1]);
  const topAccounts = traceUsageStats.byAccount.slice(0, 6);
  const topRoutes = traceUsageStats.byRoute.slice(0, 6);
  const orderedCardIds = React.useMemo(() => normalizeCardOrder(cardOrder), [cardOrder]);
  const topSessions = React.useMemo(
    () =>
      [...traceUsageStats.bySession]
        .sort((a, b) => {
          const primary = compareSessionEntries(a, b, topSessionsSort);
          if (primary !== 0) return primary;
          const lastSeen = compareNumbers(Number(a.lastAt ?? 0), Number(b.lastAt ?? 0), "desc");
          if (lastSeen !== 0) return lastSeen;
          return a.sessionId.localeCompare(b.sessionId);
        })
        .slice(0, 8),
    [topSessionsSort, traceUsageStats.bySession],
  );
  const layoutChanged = orderedCardIds.some((cardId, index) => cardId !== DEFAULT_CARD_ORDER[index]);

  const moveCard = (cardId: TraceCardId, direction: -1 | 1) => {
    setCardOrder((current) => {
      const next = [...normalizeCardOrder(current)];
      const currentIndex = next.indexOf(cardId);
      if (currentIndex < 0) return next;
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= next.length) return next;
      [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
      return next;
    });
  };

  const renderCardControls = (cardId: TraceCardId, index: number, extra?: React.ReactNode) => (
    <div className="inline wrap tracing-card-toolbar">
      {extra}
      {layoutEditMode && (
        <>
          <button
            className="btn ghost small"
            onClick={() => moveCard(cardId, -1)}
            disabled={index === 0}
            title="Move card earlier"
          >
            Earlier
          </button>
          <button
            className="btn ghost small"
            onClick={() => moveCard(cardId, 1)}
            disabled={index === orderedCardIds.length - 1}
            title="Move card later"
          >
            Later
          </button>
        </>
      )}
    </div>
  );

  const cards: Record<TraceCardId, { title: string; fullSpan?: boolean; render: () => React.ReactNode; toolbar?: React.ReactNode }> = {
    tokensOverTime: {
      title: "Tokens over time (hourly)",
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={tokensTimeseries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d6dde4" />
              <XAxis dataKey="label" minTickGap={24} />
              <YAxis tickFormatter={formatTokenChartValue} />
              <Tooltip formatter={formatTooltipValue} />
              <Legend />
              <Line type="monotone" dataKey="tokensInput" name="input" stroke="#1f7a8c" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="tokensOutput" name="output" stroke="#2da4b8" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="tokensTotal" name="total" stroke="#4c956c" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    modelUsage: {
      title: "Model usage",
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={modelChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d6dde4" />
              <XAxis dataKey="label" interval={0} angle={-15} textAnchor="end" height={56} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="count" name="requests" fill="#1f7a8c" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    modelCost: {
      title: "Model cost (USD)",
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={modelCostChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d6dde4" />
              <XAxis dataKey="label" interval={0} angle={-15} textAnchor="end" height={56} />
              <YAxis />
              <Tooltip formatter={(v: any) => usd(Number(v) || 0)} />
              <Legend />
              <Bar dataKey="costUsd" name="cost usd" fill="#4c956c" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    errorTrend: {
      title: "Error trend (hourly)",
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={tokensTimeseries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d6dde4" />
              <XAxis dataKey="label" minTickGap={24} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="errors" name="errors" stroke="#c44545" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="requests" name="requests" stroke="#355070" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    costOverTime: {
      title: "Cost over time (hourly)",
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={tokensTimeseries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d6dde4" />
              <XAxis dataKey="label" minTickGap={24} />
              <YAxis />
              <Tooltip formatter={(v: any) => usd(Number(v) || 0)} />
              <Legend />
              <Line type="monotone" dataKey="costUsd" name="cost usd" stroke="#4c956c" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    latency: {
      title: "Latency p50/p95 (hourly)",
      fullSpan: true,
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={tokensTimeseries}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d6dde4" />
              <XAxis dataKey="label" minTickGap={24} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="latencyP50Ms" name="p50" stroke="#f4a259" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="latencyP95Ms" name="p95" stroke="#e76f51" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    tokenSplit: {
      title: "Model split by token volume",
      render: () => (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={modelChartData}
                dataKey="tokensTotal"
                nameKey="label"
                outerRadius={90}
                label={formatPieTokenLabel}
              >
                {modelChartData.map((entry, idx) => (
                  <Cell key={`${entry.label}-${idx}`} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value: any) => formatTokenChartValue(value)} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ),
    },
    usageByAccount: {
      title: "Usage by account",
      render: () => (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Req</th>
                <th>Success</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {topAccounts.map((entry) => {
                const accountLabel = sanitized
                  ? maskEmail(entry.account.email) || maskId(entry.accountId)
                  : entry.account.email ?? entry.accountId;
                return (
                  <tr key={entry.accountId}>
                    <td className="mono">{accountLabel}</td>
                    <td>{entry.requests}</td>
                    <td>{entry.successRate.toFixed(1)}%</td>
                    <td>{formatTokenCount(entry.tokens.total)}</td>
                    <td className="mono">{usd(entry.costUsd)}</td>
                    <td>{Math.round(entry.avgLatencyMs)}ms</td>
                  </tr>
                );
              })}
              {!topAccounts.length && (
                <tr>
                  <td colSpan={6} className="muted">No account usage in this range.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ),
    },
    usageByRoute: {
      title: "Usage by route",
      render: () => (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>Req</th>
                <th>Errors</th>
                <th>Stream</th>
                <th>Tokens</th>
                <th>Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {topRoutes.map((entry) => (
                <tr key={entry.route}>
                  <td className="mono">{routeLabel(entry.route)}</td>
                  <td>{entry.requests}</td>
                  <td>{entry.errors}</td>
                  <td>{entry.streamingRate.toFixed(1)}%</td>
                  <td>{formatTokenCount(entry.tokens.total)}</td>
                  <td>{Math.round(entry.avgLatencyMs)}ms</td>
                </tr>
              ))}
              {!topRoutes.length && (
                <tr>
                  <td colSpan={6} className="muted">No route usage in this range.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ),
    },
    topSessions: {
      title: "Top sessions",
      toolbar: (
        <>
          <select
            value={topSessionsSort.key}
            onChange={(e) =>
              setTopSessionsSort((current) => ({
                ...current,
                key: e.target.value as SessionSortKey,
              }))
            }
          >
            <option value="requests">Sort: requests</option>
            <option value="tokens">Sort: tokens</option>
            <option value="costUsd">Sort: cost</option>
            <option value="avgLatencyMs">Sort: latency</option>
            <option value="lastAt">Sort: last seen</option>
          </select>
          <button
            className="btn ghost small"
            onClick={() =>
              setTopSessionsSort((current) => ({
                ...current,
                direction: current.direction === "desc" ? "asc" : "desc",
              }))
            }
          >
            {topSessionsSort.direction === "desc" ? "Desc" : "Asc"}
          </button>
        </>
      ),
      render: () => (
        <>
          <p className="muted">Session IDs are shown by tail only.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Req</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Avg latency</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {topSessions.map((entry) => (
                  <tr key={entry.sessionId}>
                    <td className="mono">{formatSessionTail(entry.sessionId)}</td>
                    <td>{entry.requests}</td>
                    <td>{formatTokenCount(entry.tokens.total)}</td>
                    <td className="mono">{usd(entry.costUsd)}</td>
                    <td>{Math.round(entry.avgLatencyMs)}ms</td>
                    <td>{fmt(entry.lastAt)}</td>
                  </tr>
                ))}
                {!topSessions.length && (
                  <tr>
                    <td colSpan={6} className="muted">No session-tagged traces in this range.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ),
    },
  };

  return (
    <>
      <section className="grid cards5">
        <Metric title="Requests" value={`${traceStats.totals.requests}`} />
        <Metric title="Error rate" value={pct(traceStats.totals.errorRate)} />
        <Metric title="Total tokens" value={formatTokenCount(traceStats.totals.tokensTotal)} />
        <Metric title="Total cost" value={usd(traceStats.totals.costUsd)} />
        <Metric title="Avg latency" value={`${Math.round(traceStats.totals.latencyAvgMs)}ms`} />
      </section>

      <section className="grid cards5">
        <Metric title="Success rate" value={`${traceUsageStats.totals.successRate.toFixed(1)}%`} />
        <Metric title="Stream share" value={`${traceUsageStats.totals.streamingRate.toFixed(1)}%`} />
        <Metric title="Usage captured" value={`${usageCoverage.toFixed(1)}%`} />
        <Metric title="Active sessions" value={`${traceUsageStats.bySession.length}`} />
        <Metric title="Active accounts" value={`${traceUsageStats.byAccount.length}`} />
      </section>

      <section className="tracing-layout-actions">
        <p className="muted">Analytics card order is saved in this browser.</p>
        <div className="inline wrap">
          <button className="btn ghost" onClick={() => setLayoutEditMode((current) => !current)}>
            {layoutEditMode ? "Done editing" : "Edit layout"}
          </button>
          <button className="btn secondary" onClick={() => setCardOrder(DEFAULT_CARD_ORDER)} disabled={!layoutChanged}>
            Reset layout
          </button>
        </div>
      </section>

      <section className="grid tracing-layout">
        {orderedCardIds.map((cardId, index) => {
          const card = cards[cardId];
          return (
            <section key={cardId} className={`panel tracing-card${card.fullSpan ? " full-span" : ""}`}>
              <div className="tracing-card-head">
                <h2>{card.title}</h2>
                {renderCardControls(cardId, index, card.toolbar)}
              </div>
              {card.render()}
            </section>
          );
        })}
      </section>

      <section className="panel">
        <div className="trace-head">
          <h2>Request tracing</h2>
          <div className="inline wrap">
            <select
              value={traceRange}
              onChange={(e) => {
                setTraceRange(e.target.value as TraceRangePreset);
                void gotoTracePage(1);
              }}
            >
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7d</option>
              <option value="30d">Last 30d</option>
              <option value="all">All time</option>
            </select>
            <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page - 1)} disabled={!tracePagination.hasPrev}>Previous</button>
            <span className="mono">
              Page {tracePagination.page} / {tracePagination.totalPages} ({tracePagination.total} traces, {tracePagination.pageSize} per page)
            </span>
            <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page + 1)} disabled={!tracePagination.hasNext}>Next</button>
            <button className="btn secondary" onClick={() => void exportTracesZip()} disabled={exportInProgress}>
              {exportInProgress ? "Exporting..." : "Export all (.zip)"}
            </button>
          </div>
        </div>
        <div className="trace-summary">
          <div className="chips">
            {statusEntries.map(([status, count]) => {
              const share =
                traceUsageStats.totals.requests > 0
                  ? (count / traceUsageStats.totals.requests) * 100
                  : 0;
              return (
                <span key={status} className="chip mono">
                  {status}: {count} ({share.toFixed(1)}%)
                </span>
              );
            })}
            {!statusEntries.length && <span className="chip mono">No traces</span>}
          </div>
          <p className="muted">
            Matched {traceUsageStats.tracesMatched} of {traceUsageStats.tracesEvaluated} retained traces in the selected range.
          </p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Session</th>
                <th>Route</th>
                <th>Model</th>
                <th>Account</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => {
                const isExpanded = expandedTraceId === t.id;
                const rowCost = typeof t.costUsd === "number" ? t.costUsd : (estimateCostUsd(t.model, t.tokensInput ?? 0, t.tokensOutput ?? 0) ?? 0);
                const provider = t.accountId ? accountProviderById.get(t.accountId) : undefined;
                const accountLabel = sanitized
                  ? maskEmail(t.accountEmail) || maskId(t.accountId)
                  : t.accountEmail ?? t.accountId ?? "-";
                const sessionLabel = formatSessionTail(t.sessionId);
                return (
                  <React.Fragment key={t.id}>
                    <tr onClick={() => void toggleExpandedTrace(t.id)} className="trace-row">
                      <td>{fmt(t.at)}</td>
                      <td className="mono">{sessionLabel || "-"}</td>
                      <td className="mono">{routeLabel(t.route)}</td>
                      <td className="mono">{t.model ?? "-"}</td>
                      <td>
                        <span className="inline wrap">
                          {provider && (
                            <span className="provider-badge">
                              <img
                                className="provider-icon"
                                src={providerFavicon(provider)}
                                alt={`${providerLabel(provider)} icon`}
                                loading="lazy"
                              />
                              {providerLabel(provider)}
                            </span>
                          )}
                          <span className="mono">{accountLabel}</span>
                        </span>
                      </td>
                      <td>{t.status}</td>
                      <td>{t.latencyMs}ms</td>
                      <td>{typeof (t.tokensTotal ?? t.usage?.total_tokens) === "number" ? formatTokenCount(t.tokensTotal ?? t.usage?.total_tokens) : "-"}</td>
                      <td className="mono">{usd(rowCost)}</td>
                      <td className="mono">{t.error?.slice(0, 60) ?? "-"}</td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={10}>
                          <div className="expanded-trace">
                            {expandedTraceLoading && <div className="muted">Loading trace details...</div>}
                            {!expandedTraceLoading && expandedTrace && expandedTrace.id === t.id && (
                              <>
                                {expandedTrace.hasRequestBody && (
                                  <details open>
                                    <summary>Request Body</summary>
                                    <pre className="mono pre">{JSON.stringify(expandedTrace.requestBody, null, 2)}</pre>
                                  </details>
                                )}
                                <details>
                                  <summary>Full Trace Object</summary>
                                  <pre className="mono pre">{JSON.stringify(expandedTrace, null, 2)}</pre>
                                </details>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
