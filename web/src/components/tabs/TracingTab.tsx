import React, { useMemo, useState } from "react";
import type { CSSProperties } from "react";
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
import { fmt, formatTokenCount, formatTokenRate, maskEmail, maskId, pct, routeLabel, usd } from "../../lib/ui";
import { api } from "../../lib/api";
import { copyTextToClipboard } from "../../lib/clipboard";
import { Metric } from "../Metric";
import type { Account, ProjectUsageStats, Trace, TracePagination, TraceRangePreset, TraceStats } from "../../types";

type Props = {
  accounts: Account[];
  traceStats: TraceStats;
  tokensTimeseries: Array<any>;
  modelChartData: Array<any>;
  modelCostChartData: Array<any>;
  tracePagination: TracePagination;
  gotoTracePage: (page: number) => Promise<void>;
  traceRange: TraceRangePreset;
  traces: Trace[];
  projectUsageStats: ProjectUsageStats;
  expandedTraceId: string | null;
  expandedTrace: Trace | null;
  expandedTraceLoading: boolean;
  toggleExpandedTrace: (id: string) => Promise<void>;
  sanitized: boolean;
};

const TTFT_BUCKET_ORDER = ["lt1k", "1k-8k", "8k-32k", "32k-64k", "64k-128k", "128k-plus", "unknown"] as const;

type TtftBucket = (typeof TTFT_BUCKET_ORDER)[number];

type TtftModelGroup = {
  key: string;
  provider: string;
  model: string;
  rows: TraceStats["ttftByProviderModel"];
};

const TTFT_PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible",
  opencode: "OpenCode",
  mistral: "Mistral",
  zai: "z.ai",
  xai: "Grok Build",
};

const TTFT_PROVIDER_FAVICONS: Record<string, string> = {
  openai: "https://openai.com/favicon.ico",
  "openai-compatible": "https://openai.com/favicon.ico",
  opencode: "https://opencode.ai/favicon-v3.svg",
  mistral: "https://mistral.ai/favicon.ico",
  zai: "https://z.ai/favicon.png",
  xai: "https://grok.com/favicon.ico",
};

const TTFT_CONTEXT_LABELS: Record<TtftBucket, string> = {
  lt1k: "<1K",
  "1k-8k": "1K–8K",
  "8k-32k": "8K–32K",
  "32k-64k": "32K–64K",
  "64k-128k": "64K–128K",
  "128k-plus": ">128K",
  unknown: "Unknown",
};

function formatTtftDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}s`;
  return `${Math.round(value)}ms`;
}

export function TtftLatencyBoard({ traceStats }: { traceStats: TraceStats }) {
  const groups = traceStats.ttftByProviderModel;
  const activeBucket = groups.some((group) => group.inputTokenBucket === "1k-8k")
    ? "1k-8k"
    : TTFT_BUCKET_ORDER.find((bucket) => groups.some((group) => group.inputTokenBucket === bucket)) ?? "1k-8k";
  const [selectedBucket, setSelectedBucket] = useState<TtftBucket>(activeBucket);
  const selectedGroups = groups.filter((group) => group.inputTokenBucket === selectedBucket);
  const providerGroups = useMemo(() => {
    const map = new Map<string, TtftModelGroup>();
    for (const row of selectedGroups) {
      const key = `${row.provider}:${row.model}`;
      const existing = map.get(key);
      if (existing) existing.rows.push(row);
      else map.set(key, { key, provider: row.provider, model: row.model, rows: [row] });
    }
    return Array.from(map.values()).map((group) => ({
      ...group,
      rows: [...group.rows].sort((left, right) => (left.rank ?? 99) - (right.rank ?? 99)),
    }));
  }, [selectedGroups]);
  const scaleMax = Math.max(2_000, ...selectedGroups.map((group) => group.ttftP95Ms));
  const totalSamples = selectedGroups.reduce((sum, group) => sum + group.samples, 0);
  const fastest = selectedGroups.reduce((fastest, group) => Math.min(fastest, group.ttftP50Ms), Number.POSITIVE_INFINITY);
  const lowSamples = selectedGroups.filter((group) => group.confidence === "low").length;
  const bucketCounts = TTFT_BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: TTFT_CONTEXT_LABELS[bucket],
    samples: groups.filter((group) => group.inputTokenBucket === bucket).reduce((sum, group) => sum + group.samples, 0),
  })).filter((entry) => entry.samples > 0);

  React.useEffect(() => {
    if (groups.length && !groups.some((group) => group.inputTokenBucket === selectedBucket)) {
      setSelectedBucket(activeBucket);
    }
  }, [activeBucket, groups, selectedBucket]);

  if (!groups.length) {
    return (
      <section className="panel ttft-board">
        <div className="section-split-header">
          <div>
            <h2>Time to first token</h2>
            <p className="muted">Completed HTTP SSE requests grouped by provider and context.</p>
          </div>
          <span className="badge">No measurements</span>
        </div>
        <div className="ttft-empty">No measured TTFT in this range yet.</div>
      </section>
    );
  }

  return (
    <section className="panel ttft-board">
      <div className="section-split-header">
        <div>
          <h2>Time to first token</h2>
          <p className="muted">Completed HTTP SSE requests grouped by provider and context.</p>
        </div>
        <div className="ttft-context-picker" role="tablist" aria-label="Input context range">
          {bucketCounts.map(({ bucket, label, samples }) => (
            <button
              key={bucket}
              type="button"
              role="tab"
              aria-selected={bucket === selectedBucket}
              className={`ttft-context-pill${bucket === selectedBucket ? " active" : ""}`}
              onClick={() => setSelectedBucket(bucket)}
            >
              <span>{label}</span>
              <small>{samples}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="ttft-kpis" aria-label="Selected context summary">
        <div><small>Models</small><strong>{providerGroups.length}</strong></div>
        <div><small>Requests</small><strong>{totalSamples.toLocaleString()}</strong></div>
        <div><small>Fastest p50</small><strong>{Number.isFinite(fastest) ? formatTtftDuration(fastest) : "—"}</strong></div>
        <div><small>Scale</small><strong>0–{formatTtftDuration(scaleMax)}</strong></div>
        <div><small>Low confidence</small><strong>{lowSamples}</strong></div>
      </div>

      {selectedGroups.length ? (
        <div className="ttft-groups">
          {providerGroups.map((modelGroup) => {
            const representative = modelGroup.rows[0];
            const groupSamples = modelGroup.rows.reduce((sum, row) => sum + row.samples, 0);
            const groupP50 = modelGroup.rows.reduce((sum, row) => sum + row.ttftP50Ms * row.samples, 0) / Math.max(1, groupSamples);
            const providerClass = modelGroup.provider === "mistral"
              ? "provider-mistral"
              : modelGroup.provider === "opencode"
                ? "provider-opencode"
                : modelGroup.provider === "zai"
                  ? "provider-zai"
                  : modelGroup.provider === "xai"
                    ? "provider-xai"
                    : "provider-openai";
            return (
              <section key={modelGroup.key} className={`ttft-provider-group ${providerClass}`} aria-label={`${TTFT_PROVIDER_LABELS[modelGroup.provider] ?? modelGroup.provider} — ${modelGroup.model}`}>
                <header className="ttft-provider-head">
                  <span className="ttft-provider-name">
                    <img src={TTFT_PROVIDER_FAVICONS[modelGroup.provider] ?? TTFT_PROVIDER_FAVICONS.openai} alt="" loading="lazy" />
                    {TTFT_PROVIDER_LABELS[modelGroup.provider] ?? modelGroup.provider}
                  </span>
                  <span className="ttft-provider-meta mono">{modelGroup.model}</span>
                </header>
                {modelGroup.rows.map((row) => {
                  const left = Math.min(100, Math.max(0, (row.ttftP50Ms / scaleMax) * 100));
                  const width = Math.max(1.5, Math.min(100 - left, ((row.ttftP95Ms - row.ttftP50Ms) / scaleMax) * 100));
                  const barStyle = { "--range-left": `${left}%`, "--range-width": `${width}%` } as CSSProperties;
                  return (
                    <div key={`${row.provider}:${row.model}:${row.inputTokenBucket}`} className="ttft-row">
                      <div className="ttft-row-label">
                        <strong className="mono">{modelGroup.model}</strong>
                        <small>{row.samples.toLocaleString()} samples · {row.cachedInputRatio === undefined ? "cache n/a" : `${Math.round(row.cachedInputRatio * 100)}% cached`}</small>
                      </div>
                      <div className="ttft-measure">
                        <div className="ttft-track" style={barStyle}>
                          <span className="ttft-range" />
                          <span className="ttft-p50" />
                        </div>
                        <div className="ttft-values">
                          <strong>{formatTtftDuration(row.ttftP50Ms)}</strong>
                          <small>p95 {formatTtftDuration(row.ttftP95Ms)} · median {row.medianInputTokens === undefined ? "—" : formatTokenCount(row.medianInputTokens)}</small>
                        </div>
                      </div>
                      <span className={`ttft-confidence ${row.confidence === "low" ? "low" : "sufficient"}`} title={row.rank ? `Rank ${row.rank}` : "Below ranking threshold"}>
                        {row.confidence === "low" ? "Low n" : `#${row.rank ?? "—"}`}
                      </span>
                    </div>
                  );
                })}
                <footer className="ttft-provider-footer">
                  <span>{representative.rank ? `Rank ${representative.rank}` : "Unranked (<10 samples)"}</span>
                  <span>{groupSamples.toLocaleString()} samples · weighted p50 {formatTtftDuration(groupP50)}</span>
                </footer>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="ttft-empty">No measured TTFT in {TTFT_CONTEXT_LABELS[selectedBucket]} in this range yet.</div>
      )}

      <div className="ttft-legend" aria-hidden="true">
        <span className="ttft-legend-range" /> <span>p50 → p95</span>
        <span className="ttft-legend-dot" /> <span>Low sample confidence</span>
        <span className="ttft-scale">0</span><span>{formatTtftDuration(scaleMax / 4)}</span><span>{formatTtftDuration(scaleMax / 2)}</span><span>{formatTtftDuration((scaleMax * 3) / 4)}</span><span>{formatTtftDuration(scaleMax)}</span>
      </div>
    </section>
  );
}

function TtftLatencyDetails({ traceStats }: { traceStats: TraceStats }) {
  return (
    <section className="panel ttft-details-panel">
      <details className="ttft-details">
        <summary>Full TTFT metrics and rankings</summary>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Rank</th><th>Provider</th><th>Model</th><th>Input bucket</th><th>Samples</th><th>p50 TTFT</th><th>p95 TTFT</th><th>Median input</th><th>Cached input</th><th>Confidence</th></tr>
            </thead>
            <tbody>
              {traceStats.ttftByProviderModel.map((group) => (
                <tr key={`${group.provider}:${group.model}:${group.inputTokenBucket}`}>
                  <td>{group.rank ?? "—"}</td>
                  <td>
                    <span className="provider-badge">
                      <img className="provider-icon" src={TTFT_PROVIDER_FAVICONS[group.provider] ?? TTFT_PROVIDER_FAVICONS.openai} alt="" loading="lazy" />
                      {TTFT_PROVIDER_LABELS[group.provider] ?? group.provider}
                    </span>
                  </td>
                  <td className="mono">{group.model}</td>
                  <td>{TTFT_CONTEXT_LABELS[group.inputTokenBucket as TtftBucket] ?? "Unknown"}</td>
                  <td>{group.samples}</td>
                  <td>{formatTtftDuration(group.ttftP50Ms)}</td>
                  <td>{formatTtftDuration(group.ttftP95Ms)}</td>
                  <td>{group.medianInputTokens === undefined ? "—" : formatTokenCount(group.medianInputTokens)}</td>
                  <td>{group.cachedInputRatio === undefined ? "—" : pct(group.cachedInputRatio)}</td>
                  <td><span className={group.confidence === "low" ? "badge badge-warn" : "badge badge-live"}>{group.confidence === "low" ? "Low" : "Sufficient"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function TracingTab(props: Props) {
  return <TracingTabContent {...props} />;
}

function TracingTabContent(props: Props) {
  const {
    accounts,
    traceStats,
    tokensTimeseries,
    modelChartData,
    modelCostChartData,
    tracePagination,
    gotoTracePage,
    traceRange,
    traces,
    projectUsageStats,
    expandedTraceId,
    expandedTrace,
    expandedTraceLoading,
    toggleExpandedTrace,
    sanitized,
  } = props;
  const accountProviderById = React.useMemo(
    () => new Map(accounts.map((account) => [account.id, account.provider])),
    [accounts],
  );
  const [installHookBusy, setInstallHookBusy] = React.useState(false);
  const [installHookNotice, setInstallHookNotice] = React.useState<string | null>(null);
  const installHookNoticeTimer = React.useRef<number | undefined>(undefined);

  React.useEffect(
    () => () => {
      if (installHookNoticeTimer.current !== undefined) {
        window.clearTimeout(installHookNoticeTimer.current);
      }
    },
    [],
  );

  const showInstallHookNotice = (message: string) => {
    setInstallHookNotice(message);
    if (installHookNoticeTimer.current !== undefined) {
      window.clearTimeout(installHookNoticeTimer.current);
    }
    installHookNoticeTimer.current = window.setTimeout(() => {
      setInstallHookNotice(null);
      installHookNoticeTimer.current = undefined;
    }, 3_500);
  };

  const installHook = async () => {
    setInstallHookBusy(true);
    try {
      const response = await api("/admin/codex-hook-install-command", {
        method: "POST",
        body: JSON.stringify({ baseUrl: window.location.origin }),
      });
      const command = String(response.command ?? "");
      if (!command) throw new Error("The server returned an empty install command");
      await copyTextToClipboard(command);
      showInstallHookNotice("Paste and execute the command in your terminal");
    } catch (error: any) {
      showInstallHookNotice(error?.message ?? String(error));
    } finally {
      setInstallHookBusy(false);
    }
  };

  const providerFavicon = (provider?: string) =>
    provider === "mistral"
      ? "https://mistral.ai/favicon.ico"
      : provider === "opencode"
        ? "https://opencode.ai/favicon-v3.svg"
        : provider === "zai"
          ? "https://z.ai/favicon.png"
          : provider === "xai"
            ? "https://grok.com/favicon.ico"
            : "https://openai.com/favicon.ico";

  const providerLabel = (provider?: string) =>
    provider === "mistral"
      ? "Mistral"
      : provider === "opencode"
        ? "OpenCode"
        : provider === "openai-compatible"
          ? "OpenAI-compatible"
          : provider === "zai"
            ? "z.ai"
            : provider === "xai"
              ? "Grok Build"
              : "OpenAI";

  const formatTokenChartValue = (value: number | string | undefined) => formatTokenCount(Number(value ?? 0));

  const formatTooltipValue = (value: any) => formatTokenChartValue(value?.[0] ?? value ?? 0);

  const formatPieTokenLabel = ({ value }: { value?: number }) => formatTokenChartValue(value);
  const chartColors = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
  ];
  const accountSelectionSummary = traceStats.accountSelection;
  const [activeView, setActiveView] = React.useState<"overview" | "performance" | "usage" | "requests">("overview");
  const requestCount = traceStats.totals.requests;
  const errorCount = traceStats.totals.errors;
  const usageCoverage = requestCount > 0 ? traceStats.totals.requestsWithUsage / requestCount : 0;
  const pricingCoverage = requestCount > 0 ? traceStats.totals.requestsWithCost / requestCount : 0;
  const rangeLabel = traceRange === "24h"
    ? "Last 24 hours"
    : traceRange === "7d"
      ? "Last 7 days"
      : traceRange === "30d"
        ? "Last 30 days"
        : "All recorded time";
  const viewOptions = [
    { id: "overview" as const, label: "Overview", description: "Health and routing" },
    { id: "performance" as const, label: "Performance", description: "Latency and TTFT" },
    { id: "usage" as const, label: "Usage & cost", description: "Tokens and projects" },
    { id: "requests" as const, label: "Requests", description: `${tracePagination.total} traces` },
  ];

  return (
    <>
      <section className="panel trace-workspace-header">
        <div className="trace-command-row">
          <div className="trace-command-intro">
            <div>
              <h2>Tracing</h2>
              <p className="muted">Understand traffic, performance and cost without losing the request-level detail.</p>
            </div>
          </div>
        </div>
        <nav className="trace-view-tabs" role="tablist" aria-label="Tracing views">
          {viewOptions.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              id={`trace-tab-${view.id}`}
              aria-selected={activeView === view.id}
              aria-controls={`trace-view-${view.id}`}
              className={`trace-view-tab${activeView === view.id ? " active" : ""}`}
              onClick={() => setActiveView(view.id)}
            >
              <strong>{view.label}</strong>
              <small>{view.description}</small>
            </button>
          ))}
        </nav>
      </section>

      {activeView === "overview" && (
        <div id="trace-view-overview" role="tabpanel" aria-labelledby="trace-tab-overview" className="trace-view-content">
          <header className="trace-view-heading">
            <div>
              <h2>System health at a glance</h2>
              <p className="muted">A concise read of request volume, reliability and spend for {rangeLabel.toLowerCase()}.</p>
            </div>
            <span className={`badge ${traceStats.totals.errorRate > 0.05 ? "badge-warn" : "badge-live"}`}>
              {errorCount === 0 ? "No traced errors" : `${errorCount} traced error${errorCount === 1 ? "" : "s"}`}
            </span>
          </header>

          <section className="grid cards4 trace-primary-metrics">
            <Metric title="Requests" value={`${requestCount}`} detail={rangeLabel} />
            <Metric title="Error rate" value={pct(traceStats.totals.errorRate)} detail={`${errorCount} failed requests`} tone={traceStats.totals.errorRate > 0.05 ? "warning" : "default"} />
            <Metric title="Avg latency" value={`${Math.round(traceStats.totals.latencyAvgMs)}ms`} detail="End-to-end response time" />
            <Metric title="Total cost" value={usd(traceStats.totals.costUsd)} detail={`${traceStats.totals.requestsWithCost}/${requestCount} requests priced`} tone={traceStats.totals.unpricedRequests > 0 ? "warning" : "default"} />
          </section>

          <section className="grid trace-overview-grid">
            <section className="panel trace-quality-panel">
              <div className="section-split-header">
                <div>
                  <h2>Data coverage</h2>
                  <p className="muted">Know how much of the traffic can support reliable usage and cost analysis.</p>
                </div>
                <span className={`badge ${requestCount > 0 && usageCoverage === 1 && pricingCoverage === 1 ? "badge-live" : "badge-warn"}`}>
                  {requestCount === 0 ? "No data" : usageCoverage === 1 && pricingCoverage === 1 ? "Complete" : "Partial"}
                </span>
              </div>
              <div className="trace-coverage-list">
                <div className="trace-coverage-item">
                  <div><strong>Token usage</strong><span>{traceStats.totals.requestsWithUsage} of {requestCount} requests</span></div>
                  <strong>{pct(usageCoverage)}</strong>
                  <div className="trace-coverage-track"><span style={{ width: `${Math.min(100, usageCoverage * 100)}%` }} /></div>
                </div>
                <div className="trace-coverage-item">
                  <div><strong>Cost pricing</strong><span>{traceStats.totals.requestsWithCost} of {requestCount} requests</span></div>
                  <strong>{pct(pricingCoverage)}</strong>
                  <div className="trace-coverage-track"><span style={{ width: `${Math.min(100, pricingCoverage * 100)}%` }} /></div>
                </div>
              </div>
              <dl className="trace-compact-stats">
                <div><dt>Input tokens</dt><dd>{formatTokenCount(traceStats.totals.tokensInput)}</dd></div>
                <div><dt>Output tokens</dt><dd>{formatTokenCount(traceStats.totals.tokensOutput)}</dd></div>
                <div><dt>Inference speed</dt><dd>{formatTokenRate(traceStats.totals.inferenceTokensPerSecond)}</dd></div>
                <div><dt>Unpriced</dt><dd>{traceStats.totals.unpricedRequests}</dd></div>
              </dl>
            </section>

            <section className="panel trace-routing-panel">
              <div className="section-split-header">
                <div>
                  <h2>Account routing</h2>
                  <p className="muted">How the proxy selected and rotated accounts for this traffic.</p>
                </div>
                <span className="badge">{accountSelectionSummary.attempts} attempts</span>
              </div>
              <div className="trace-routing-summary">
                <div><span>Account swaps</span><strong>{accountSelectionSummary.rotations}</strong><small>Moved to another account</small></div>
                <div><span>Sticky</span><strong>{accountSelectionSummary.reasonCounts.sticky}</strong><small>Session affinity kept</small></div>
                <div><span>Quota-led</span><strong>{accountSelectionSummary.reasonCounts["quota-headroom"]}</strong><small>Selected by headroom</small></div>
                <div><span>Avg headroom</span><strong>{typeof accountSelectionSummary.averageHeadroom === "number" ? `${Math.round(accountSelectionSummary.averageHeadroom)}%` : "—"}</strong><small>Max near-limit: {accountSelectionSummary.maxNearLimit}</small></div>
              </div>
              <div className="trace-routing-notes">
                <span>Policy preferred <strong>{accountSelectionSummary.reasonCounts["policy-preferred"]}</strong></span>
                <span>Quota headroom <strong>{accountSelectionSummary.reasonCounts["quota-headroom"]}</strong></span>
              </div>
            </section>
          </section>
        </div>
      )}

      {activeView === "performance" && (
        <div id="trace-view-performance" role="tabpanel" aria-labelledby="trace-tab-performance" className="trace-view-content">
          <header className="trace-view-heading">
            <div>
              <h2>Performance</h2>
              <p className="muted">Compare first-token delay, full latency, throughput and failure trends.</p>
            </div>
            <span className="badge">{rangeLabel}</span>
          </header>

          <TtftLatencyBoard traceStats={traceStats} />
          <TtftLatencyDetails traceStats={traceStats} />

          <section className="grid cards2 trace-chart-grid">
            <section className="panel">
              <div className="section-split-header">
                <div><h2>End-to-end latency</h2><p className="muted">Median and tail response time by hour.</p></div>
                <span className="badge">p50 / p95</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="latencyP50Ms" name="p50" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="latencyP95Ms" name="p95" stroke="var(--danger)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header">
                <div><h2>Inference speed</h2><p className="muted">Output tokens divided by full request duration.</p></div>
                <span className="badge">tokens / second</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis tickFormatter={formatTokenRate} />
                    <Tooltip formatter={(value: any) => formatTokenRate(Number(value) || 0)} />
                    <Legend />
                    <Line type="monotone" dataKey="inferenceTokensPerSecond" name="tokens/s" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header">
                <div><h2>Error trend</h2><p className="muted">Failures shown against total request volume.</p></div>
                <span className={`badge ${errorCount > 0 ? "badge-warn" : "badge-live"}`}>{errorCount} errors</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="errors" name="errors" stroke="var(--danger)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="requests" name="requests" stroke="var(--chart-4)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header">
                <div><h2>Token traffic</h2><p className="muted">Input and generated volume by hour.</p></div>
                <span className="badge">hourly</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis tickFormatter={formatTokenChartValue} />
                    <Tooltip formatter={formatTooltipValue} />
                    <Legend />
                    <Line type="monotone" dataKey="tokensInput" name="input" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="tokensOutput" name="output" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="tokensTotal" name="total" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          </section>
        </div>
      )}

      {activeView === "usage" && (
        <div id="trace-view-usage" role="tabpanel" aria-labelledby="trace-tab-usage" className="trace-view-content">
          <header className="trace-view-heading">
            <div>
              <h2>Usage & cost</h2>
              <p className="muted">See where tokens and budget went, from models down to Codex projects.</p>
            </div>
            <span className="badge">{rangeLabel}</span>
          </header>

          <section className="grid cards4 trace-primary-metrics">
            <Metric title="Input tokens" value={formatTokenCount(traceStats.totals.tokensInput)} detail={`${traceStats.totals.requestsWithUsage}/${requestCount} requests measured`} tone={usageCoverage < 1 ? "warning" : "default"} />
            <Metric title="Output tokens" value={formatTokenCount(traceStats.totals.tokensOutput)} detail="Generated by providers" />
            <Metric title="Total cost" value={usd(traceStats.totals.costUsd)} detail={`${traceStats.totals.requestsWithCost}/${requestCount} requests priced`} tone={pricingCoverage < 1 ? "warning" : "default"} />
            <Metric title="Inference speed" value={formatTokenRate(traceStats.totals.inferenceTokensPerSecond)} detail={`${traceStats.totals.inferenceRequests} measurable requests`} />
          </section>

          <section className="grid cards2 trace-chart-grid">
            <section className="panel">
              <div className="section-split-header"><div><h2>Cost over time</h2><p className="muted">Hourly spend across all priced requests.</p></div><span className="badge">USD</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis />
                    <Tooltip formatter={(v: any) => usd(Number(v) || 0)} />
                    <Legend />
                    <Line type="monotone" dataKey="costUsd" name="cost usd" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header"><div><h2>Cost by model</h2><p className="muted">Models ranked by estimated spend.</p></div><span className="badge">USD</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={modelCostChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" interval={0} angle={-15} textAnchor="end" height={56} />
                    <YAxis />
                    <Tooltip formatter={(v: any) => usd(Number(v) || 0)} />
                    <Legend />
                    <Bar dataKey="costUsd" name="cost usd" fill="var(--chart-3)" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header"><div><h2>Requests by model</h2><p className="muted">Which models handled the most traffic.</p></div><span className="badge">requests</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={modelChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" interval={0} angle={-15} textAnchor="end" height={56} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="count" name="requests" fill="var(--chart-1)" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header"><div><h2>Token share by model</h2><p className="muted">How total token volume is distributed.</p></div><span className="badge">tokens</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={modelChartData} dataKey="tokensTotal" nameKey="label" outerRadius={90} label={formatPieTokenLabel}>
                      {modelChartData.map((entry, idx) => (
                        <Cell key={`${entry.label}-${idx}`} fill={chartColors[idx % chartColors.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: any) => formatTokenChartValue(value)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </section>
          </section>

          <section className="panel trace-project-panel">
            <div className="section-split-header">
              <div><h2>Usage by project</h2><p className="muted">Codex-attributed consumption with model-level details on demand.</p></div>
              <div className="project-attribution-actions">
                <span className="badge">Codex session attribution</span>
                <button className="btn secondary install-hook-button" type="button" onClick={() => void installHook()} disabled={installHookBusy}>
                  {installHookBusy ? "Preparing..." : "Install hook"}
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Project</th><th>Requests</th><th>Errors</th><th>Input tokens</th><th>Output tokens</th><th>Total tokens</th><th>Cost</th><th>Avg latency</th><th>p95 latency</th></tr>
                </thead>
                <tbody>
                  {projectUsageStats.byProject.map((project) => (
                    <React.Fragment key={project.projectId}>
                      <tr>
                        <td>
                          <div className="mono">{project.projectId === "unattributed" ? "Unattributed" : sanitized ? "*" : project.projectName ?? project.projectId}</div>
                          {!sanitized && project.projectRemote && <div className="muted mono">{project.projectRemote}</div>}
                          <div className="muted">{project.requestsWithCost}/{project.requests} priced</div>
                        </td>
                        <td>{project.requests}</td><td>{project.errors}</td><td>{formatTokenCount(project.tokens.input)}</td><td>{formatTokenCount(project.tokens.output)}</td><td>{formatTokenCount(project.tokens.total)}</td><td>{usd(project.costUsd)}</td><td>{Math.round(project.avgLatencyMs)}ms</td><td>{Math.round(project.latencyP95Ms)}ms</td>
                      </tr>
                      <tr className="project-model-details-row">
                        <td colSpan={9}>
                          <details>
                            <summary>{project.models.length} model{project.models.length === 1 ? "" : "s"} — usage and cost details</summary>
                            <div className="table-wrap project-model-table-wrap">
                              <table className="data-table project-model-table">
                                <thead><tr><th>Model</th><th>Requests</th><th>Errors</th><th>Input</th><th>Cached input</th><th>Output</th><th>Total</th><th>Cost</th><th>Avg latency</th><th>p50</th><th>p95</th></tr></thead>
                                <tbody>
                                  {project.models.map((model) => (
                                    <tr key={model.model}>
                                      <td className="mono">{model.model}</td><td>{model.requests}</td><td>{model.errors}</td><td>{formatTokenCount(model.tokens.input)}</td><td>{formatTokenCount(model.tokens.cachedInput)}</td><td>{formatTokenCount(model.tokens.output)}</td><td>{formatTokenCount(model.tokens.total)}</td>
                                      <td>{usd(model.costUsd)}<div className="muted">{model.requestsWithCost}/{model.requests} priced</div></td>
                                      <td>{Math.round(model.avgLatencyMs)}ms</td><td>{Math.round(model.latencyP50Ms)}ms</td><td>{Math.round(model.latencyP95Ms)}ms</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                        </td>
                      </tr>
                    </React.Fragment>
                  ))}
                  {!projectUsageStats.byProject.length && <tr><td colSpan={9} className="muted">No project-attributed usage in this range.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {installHookNotice && (
        <div className="hook-install-toast" role="status" aria-live="polite">
          {installHookNotice}
        </div>
      )}

      {activeView === "requests" && (
        <div id="trace-view-requests" role="tabpanel" aria-labelledby="trace-tab-requests" className="trace-view-content">
          <header className="trace-view-heading">
            <div>
              <h2>Individual traces</h2>
              <p className="muted">Scan outcomes quickly, then inspect request payloads and sanitized headers only when needed.</p>
            </div>
            <span className="badge">{rangeLabel}</span>
          </header>

          <section className="panel trace-request-panel">
            <div className="section-split-header trace-request-header">
              <div>
                <h2>Recorded requests</h2>
                <p className="muted">Newest first · select Inspect for the full trace.</p>
              </div>
              <div className="trace-pagination" aria-label="Trace pages">
                <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page - 1)} disabled={!tracePagination.hasPrev} aria-label="Previous trace page">Previous</button>
                <span><strong>{tracePagination.total}</strong> traces · Page {tracePagination.page} of {tracePagination.totalPages}</span>
                <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page + 1)} disabled={!tracePagination.hasNext} aria-label="Next trace page">Next</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table trace-request-table">
                <thead><tr><th>Request</th><th>Source</th><th>Target</th><th>Outcome</th><th>Performance</th><th>Usage</th><th><span className="sr-only">Details</span></th></tr></thead>
                <tbody>
                  {traces.map((t) => {
                    const isExpanded = expandedTraceId === t.id;
                    const rowCost = typeof t.costUsd === "number" ? t.costUsd : (estimateCostUsd(t.model, t.tokensInput ?? 0, t.tokensOutput ?? 0, t.tokensInputCached ?? 0, t.tokensInputCacheWrite ?? 0) ?? 0);
                    const provider = t.provider ?? (t.accountId ? accountProviderById.get(t.accountId) : undefined);
                    const accountLabel = sanitized ? maskEmail(t.accountEmail) || maskId(t.accountId) : t.accountEmail ?? t.accountId ?? "—";
                    const modelLabel = t.requestedModel && t.resolvedModel ? `${t.requestedModel} → ${t.resolvedModel}` : (t.model ?? "—");
                    const hasError = t.isError || t.status >= 400;
                    return (
                      <React.Fragment key={t.id}>
                        <tr className={`trace-row${hasError ? " trace-row-error" : ""}`}>
                          <td><div className="trace-cell-stack"><strong>{fmt(t.at)}</strong><span className="mono">{routeLabel(t.route)}</span></div></td>
                          <td><div className="trace-cell-stack"><strong className="mono">{t.application ?? "Unspecified app"}</strong><span className="mono">{t.projectId ? sanitized ? "Private project" : t.projectName ?? t.projectId : "No project"}</span></div></td>
                          <td><div className="trace-cell-stack"><strong className="mono">{modelLabel}</strong><span className="trace-target-account">{provider && <span className="provider-badge"><img className="provider-icon" src={providerFavicon(provider)} alt="" loading="lazy" />{providerLabel(provider)}</span>}<span className="mono">{accountLabel}</span></span></div></td>
                          <td><div className="trace-cell-stack"><span><span className={`badge ${hasError ? "badge-warn" : "badge-live"}`}>{t.status}</span></span><span className={hasError ? "trace-error-copy" : "muted"}>{t.error?.slice(0, 72) ?? (hasError ? "Request failed" : "Completed")}</span></div></td>
                          <td><div className="trace-cell-stack"><strong>{t.latencyMs}ms total</strong><span>{typeof t.ttftMs === "number" ? `${Math.round(t.ttftMs)}ms TTFT` : "TTFT not measured"}</span></div></td>
                          <td><div className="trace-cell-stack"><strong>{typeof (t.tokensTotal ?? t.usage?.total_tokens) === "number" ? formatTokenCount(t.tokensTotal ?? t.usage?.total_tokens) : "—"} tokens</strong><span className="mono">{usd(rowCost)}</span></div></td>
                          <td><button type="button" className="trace-expand-button" onClick={() => void toggleExpandedTrace(t.id)} aria-expanded={isExpanded}>{isExpanded ? "Hide" : "Inspect"}</button></td>
                        </tr>
                        {isExpanded && (
                          <tr className="trace-expanded-row">
                            <td colSpan={7}>
                              <div className="expanded-trace">
                                <div className="expanded-trace-heading"><div><span className="eyebrow">Trace detail</span><strong className="mono">{t.id}</strong></div><span className="badge">Sanitized</span></div>
                                {expandedTraceLoading && <div className="muted trace-loading">Loading trace details...</div>}
                                {!expandedTraceLoading && expandedTrace && expandedTrace.id === t.id && (
                                  <>
                                    {expandedTrace.hasRequestBody && <details open><summary>Request body</summary><pre className="mono pre">{JSON.stringify(expandedTrace.requestBody, null, 2)}</pre></details>}
                                    {expandedTrace.hasRequestHeaders && <details><summary>Request headers (sanitized)</summary><pre className="mono pre">{JSON.stringify(expandedTrace.requestHeaders, null, 2)}</pre></details>}
                                    <details><summary>Full trace object</summary><pre className="mono pre">{JSON.stringify(expandedTrace, null, 2)}</pre></details>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {!traces.length && <tr><td colSpan={7} className="trace-empty-state">No traces recorded in this range.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
