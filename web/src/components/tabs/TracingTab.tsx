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
import { CHART_COLORS, fmt, formatTokenCount, maskEmail, maskId, pct, routeLabel, usd } from "../../lib/ui";
import { Metric } from "../Metric";
import type { Trace, TracePagination, TraceRangePreset, TraceStats } from "../../types";

type Props = {
  traceStats: TraceStats;
  tokensTimeseries: Array<any>;
  modelChartData: Array<any>;
  modelCostChartData: Array<any>;
  tracePagination: TracePagination;
  gotoTracePage: (page: number) => Promise<void>;
  traceRange: TraceRangePreset;
  setTraceRange: (range: TraceRangePreset) => void;
  traces: Trace[];
  expandedTraceId: string | null;
  setExpandedTraceId: (id: string | null) => void;
  sanitized: boolean;
};

export function TracingTab(props: Props) {
  const {
    traceStats,
    tokensTimeseries,
    modelChartData,
    modelCostChartData,
    tracePagination,
    gotoTracePage,
    traceRange,
    setTraceRange,
    traces,
    expandedTraceId,
    setExpandedTraceId,
    sanitized,
  } = props;
  const formatTokenChartValue = (value: number | string | undefined) => formatTokenCount(Number(value ?? 0));

  const formatTooltipValue = (value: any) => formatTokenChartValue(value?.[0] ?? value ?? 0);

  return (
    <>
      <section className="grid cards5">
        <Metric title="Requests" value={`${traceStats.totals.requests}`} />
        <Metric title="Error rate" value={pct(traceStats.totals.errorRate)} />
        <Metric title="Total tokens" value={formatTokenCount(traceStats.totals.tokensTotal)} />
        <Metric title="Total cost" value={usd(traceStats.totals.costUsd)} />
        <Metric title="Avg latency" value={`${Math.round(traceStats.totals.latencyAvgMs)}ms`} />
      </section>

      <section className="grid cards2">
        <section className="panel">
          <h2>Tokens over time (hourly)</h2>
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
        </section>
        <section className="panel">
          <h2>Model usage</h2>
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
        </section>
      </section>

      <section className="grid cards2">
        <section className="panel">
          <h2>Model cost (USD)</h2>
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
        </section>
        <section className="panel">
          <h2>Error trend (hourly)</h2>
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
        </section>
        <section className="panel">
          <h2>Cost over time (hourly)</h2>
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
        </section>
      </section>

      <section className="panel">
        <h2>Latency p50/p95 (hourly)</h2>
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
      </section>

      <section className="panel">
        <h2>Model split by token volume</h2>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={modelChartData} dataKey="tokensTotal" nameKey="label" outerRadius={90} label>
                {modelChartData.map((entry, idx) => (
                  <Cell key={`${entry.label}-${idx}`} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
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
            <span className="mono">Page {tracePagination.page} / {tracePagination.totalPages} ({tracePagination.total} traces)</span>
            <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page + 1)} disabled={!tracePagination.hasNext}>Next</button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
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
                return (
                  <React.Fragment key={t.id}>
                    <tr onClick={() => setExpandedTraceId(isExpanded ? null : t.id)} className="trace-row">
                      <td>{fmt(t.at)}</td>
                      <td className="mono">{routeLabel(t.route)}</td>
                      <td className="mono">{t.model ?? "-"}</td>
                      <td className="mono">{sanitized ? maskEmail(t.accountEmail) || maskId(t.accountId) : t.accountEmail ?? t.accountId ?? "-"}</td>
                      <td>{t.status}</td>
                      <td>{t.latencyMs}ms</td>
                      <td>{typeof (t.tokensTotal ?? t.usage?.total_tokens) === "number" ? formatTokenCount(t.tokensTotal ?? t.usage?.total_tokens) : "-"}</td>
                      <td className="mono">{usd(rowCost)}</td>
                      <td className="mono">{t.error?.slice(0, 60) ?? "-"}</td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={9}>
                          <div className="expanded-trace">
                            <details open>
                              <summary>Request Body</summary>
                              <pre className="mono pre">{JSON.stringify(t.requestBody, null, 2)}</pre>
                            </details>
                            <details>
                              <summary>Full Trace Object</summary>
                              <pre className="mono pre">{JSON.stringify(t, null, 2)}</pre>
                            </details>
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
