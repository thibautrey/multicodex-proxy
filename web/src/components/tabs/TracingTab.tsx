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
  setTraceRange: (range: TraceRangePreset) => void;
  traces: Trace[];
  projectUsageStats: ProjectUsageStats;
  expandedTraceId: string | null;
  expandedTrace: Trace | null;
  expandedTraceLoading: boolean;
  toggleExpandedTrace: (id: string) => Promise<void>;
  sanitized: boolean;
  exportTracesZip: () => Promise<void>;
  exportInProgress: boolean;
};

export function TracingTab(props: Props) {
  const {
    accounts,
    traceStats,
    tokensTimeseries,
    modelChartData,
    modelCostChartData,
    tracePagination,
    gotoTracePage,
    traceRange,
    setTraceRange,
    traces,
    projectUsageStats,
    expandedTraceId,
    expandedTrace,
    expandedTraceLoading,
    toggleExpandedTrace,
    sanitized,
    exportTracesZip,
    exportInProgress,
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
      : provider === "zai"
        ? "https://z.ai/favicon.ico"
        : provider === "xai"
          ? "https://grok.com/favicon.ico"
        : "https://openai.com/favicon.ico";

  const providerLabel = (provider?: string) =>
    provider === "mistral"
      ? "Mistral"
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

  return (
    <>
      <section className="panel">
        <div className="section-split-header">
          <h2>Trace range</h2>
          <div className="trace-range-controls">
            <select
              value={traceRange}
              onChange={(e) => {
                setTraceRange(e.target.value as TraceRangePreset);
              }}
            >
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7d</option>
              <option value="30d">Last 30d</option>
              <option value="all">All time</option>
            </select>
            <button className="btn secondary" onClick={() => void exportTracesZip()} disabled={exportInProgress}>
              {exportInProgress ? "Exporting..." : "Export all (.zip)"}
            </button>
          </div>
        </div>
      </section>

      <section className="grid cards7">
        <Metric title="Requests" value={`${traceStats.totals.requests}`} detail="Within the selected range" />
        <Metric title="Error rate" value={pct(traceStats.totals.errorRate)} detail="Share of traced failures" tone={traceStats.totals.errorRate > 0.05 ? "warning" : "default"} />
        <Metric title="Input tokens" value={formatTokenCount(traceStats.totals.tokensInput)} detail={`${traceStats.totals.requestsWithUsage}/${traceStats.totals.requests} requests measured`} tone={traceStats.totals.requestsWithUsage < traceStats.totals.requests ? "warning" : "default"} />
        <Metric title="Output tokens" value={formatTokenCount(traceStats.totals.tokensOutput)} detail="Generated tokens returned by providers" />
        <Metric title="Inference speed" value={formatTokenRate(traceStats.totals.inferenceTokensPerSecond)} detail={`${traceStats.totals.inferenceRequests} measurable requests`} />
        <Metric title="Total cost" value={usd(traceStats.totals.costUsd)} detail={`${traceStats.totals.requestsWithCost} priced · ${traceStats.totals.unpricedRequests} unpriced`} tone={traceStats.totals.unpricedRequests > 0 ? "warning" : "default"} />
        <Metric title="Avg latency" value={`${Math.round(traceStats.totals.latencyAvgMs)}ms`} detail="Average end-to-end latency" />
      </section>

      <section className="grid cards2">
        <section className="panel">
          <h2>Tokens over time (hourly)</h2>
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
        <section className="panel">
          <h2>Model usage</h2>
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
      </section>

      <section className="grid cards2">
        <section className="panel">
          <h2>Model cost (USD)</h2>
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
          <h2>Error trend (hourly)</h2>
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
          <h2>Cost over time (hourly)</h2>
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
      </section>

      <section className="panel">
        <div className="section-split-header">
          <h2>Inference speed (hourly)</h2>
          <span className="badge">Output tokens / full request duration</span>
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
        <h2>Latency p50/p95 (hourly)</h2>
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
        <h2>Model split by token volume</h2>
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
                  <Cell key={`${entry.label}-${idx}`} fill={chartColors[idx % chartColors.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value: any) => formatTokenChartValue(value)} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel">
        <div className="section-split-header">
          <h2>Project usage</h2>
          <div className="project-attribution-actions">
            <span className="badge">Codex session attribution</span>
            <button
              className="btn secondary install-hook-button"
              type="button"
              onClick={() => void installHook()}
              disabled={installHookBusy}
            >
              {installHookBusy ? "Preparing..." : "Install hook"}
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Requests</th>
                <th>Errors</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Total tokens</th>
                <th>Cost</th>
                <th>Avg latency</th>
                <th>p95 latency</th>
              </tr>
            </thead>
            <tbody>
              {projectUsageStats.byProject.map((project) => (
                <React.Fragment key={project.projectId}>
                  <tr>
                    <td>
                      <div className="mono">
                        {project.projectId === "unattributed"
                          ? "Unattributed"
                          : sanitized
                            ? "*"
                            : project.projectName ?? project.projectId}
                      </div>
                      {!sanitized && project.projectRemote && (
                        <div className="muted mono">{project.projectRemote}</div>
                      )}
                      <div className="muted">{project.requestsWithCost}/{project.requests} priced</div>
                    </td>
                    <td>{project.requests}</td>
                    <td>{project.errors}</td>
                    <td>{formatTokenCount(project.tokens.input)}</td>
                    <td>{formatTokenCount(project.tokens.output)}</td>
                    <td>{formatTokenCount(project.tokens.total)}</td>
                    <td>{usd(project.costUsd)}</td>
                    <td>{Math.round(project.avgLatencyMs)}ms</td>
                    <td>{Math.round(project.latencyP95Ms)}ms</td>
                  </tr>
                  <tr className="project-model-details-row">
                    <td colSpan={9}>
                      <details>
                        <summary>{project.models.length} model{project.models.length === 1 ? "" : "s"} — usage and cost details</summary>
                        <div className="table-wrap project-model-table-wrap">
                          <table className="data-table project-model-table">
                            <thead>
                              <tr>
                                <th>Model</th>
                                <th>Requests</th>
                                <th>Errors</th>
                                <th>Input</th>
                                <th>Cached input</th>
                                <th>Output</th>
                                <th>Total</th>
                                <th>Cost</th>
                                <th>Avg latency</th>
                                <th>p50</th>
                                <th>p95</th>
                              </tr>
                            </thead>
                            <tbody>
                              {project.models.map((model) => (
                                <tr key={model.model}>
                                  <td className="mono">{model.model}</td>
                                  <td>{model.requests}</td>
                                  <td>{model.errors}</td>
                                  <td>{formatTokenCount(model.tokens.input)}</td>
                                  <td>{formatTokenCount(model.tokens.cachedInput)}</td>
                                  <td>{formatTokenCount(model.tokens.output)}</td>
                                  <td>{formatTokenCount(model.tokens.total)}</td>
                                  <td>
                                    {usd(model.costUsd)}
                                    <div className="muted">{model.requestsWithCost}/{model.requests} priced</div>
                                  </td>
                                  <td>{Math.round(model.avgLatencyMs)}ms</td>
                                  <td>{Math.round(model.latencyP50Ms)}ms</td>
                                  <td>{Math.round(model.latencyP95Ms)}ms</td>
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
              {!projectUsageStats.byProject.length && (
                <tr>
                  <td colSpan={9} className="muted">No project-attributed usage in this range.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {installHookNotice && (
        <div className="hook-install-toast" role="status" aria-live="polite">
          {installHookNotice}
        </div>
      )}

      <section className="panel">
        <div className="section-split-header">
          <h2>Request tracing</h2>
          <div className="inline wrap">
            <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page - 1)} disabled={!tracePagination.hasPrev}>Previous</button>
            <span className="mono">Page {tracePagination.page} / {tracePagination.totalPages} ({tracePagination.total} traces)</span>
            <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page + 1)} disabled={!tracePagination.hasNext}>Next</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Route</th>
                <th>Application</th>
                <th>Project</th>
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
                const rowCost = typeof t.costUsd === "number" ? t.costUsd : (estimateCostUsd(t.model, t.tokensInput ?? 0, t.tokensOutput ?? 0, t.tokensInputCached ?? 0, t.tokensInputCacheWrite ?? 0) ?? 0);
                const provider = t.accountId ? accountProviderById.get(t.accountId) : undefined;
                const accountLabel = sanitized
                  ? maskEmail(t.accountEmail) || maskId(t.accountId)
                  : t.accountEmail ?? t.accountId ?? "-";
                const modelLabel =
                  t.requestedModel && t.resolvedModel
                    ? `${t.requestedModel} -> ${t.resolvedModel}`
                    : (t.model ?? "-");
                return (
                  <React.Fragment key={t.id}>
                    <tr onClick={() => void toggleExpandedTrace(t.id)} className="trace-row">
                      <td>{fmt(t.at)}</td>
                      <td className="mono">{routeLabel(t.route)}</td>
                      <td className="mono">{t.application ?? "-"}</td>
                      <td className="mono">
                        {t.projectId
                          ? sanitized
                            ? "*"
                            : t.projectName ?? t.projectId
                          : "-"}
                      </td>
                      <td className="mono">{modelLabel}</td>
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
                        <td colSpan={11}>
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
                                {expandedTrace.hasRequestHeaders && (
                                  <details open>
                                    <summary>Request Headers (sanitized)</summary>
                                    <pre className="mono pre">{JSON.stringify(expandedTrace.requestHeaders, null, 2)}</pre>
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
