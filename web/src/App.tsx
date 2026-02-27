import React, { useEffect, useMemo, useState } from "react";
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
import "./styles.css";

type Account = { id: string; email?: string; enabled: boolean; usage?: any; state?: any };
type Trace = {
  id: string;
  at: number;
  route: string;
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
  usage?: any;
  error?: string;
  requestBody?: any;
};
type TraceStats = {
  totals: {
    requests: number;
    errors: number;
    errorRate: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    latencyAvgMs: number;
  };
  models: Array<{ model: string; count: number; tokensTotal: number }>;
  timeseries: Array<{
    at: number;
    requests: number;
    errors: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  }>;
};
type TracePagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};
type Tab = "overview" | "accounts" | "tracing" | "playground" | "docs";

const tokenDefault = localStorage.getItem("adminToken") ?? "change-me";
const fmt = (ts?: number) => (!ts ? "-" : new Date(ts).toLocaleString());
const clampPct = (v: number) => Math.max(0, Math.min(100, v));
const TRACE_PAGE_SIZE = 100;
const CHART_COLORS = ["#1f7a8c", "#2da4b8", "#4c956c", "#f4a259", "#e76f51", "#8a5a44", "#355070", "#43aa8b"];

const EMPTY_TRACE_STATS: TraceStats = {
  totals: {
    requests: 0,
    errors: 0,
    errorRate: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensTotal: 0,
    latencyAvgMs: 0,
  },
  models: [],
  timeseries: [],
};

const EMPTY_TRACE_PAGINATION: TracePagination = {
  page: 1,
  pageSize: TRACE_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasPrev: false,
  hasNext: false,
};

const q = new URLSearchParams(window.location.search);
const initialTab = (q.get("tab") as Tab) || "overview";
const initialSanitized = q.get("sanitized") === "1" || q.get("safe") === "1";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-admin-token": localStorage.getItem("adminToken") ?? tokenDefault, ...(init?.headers ?? {}) },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : {};
}

function maskEmail(v?: string) {
  if (!v) return "hidden@email";
  return "*";
}

function maskId(v?: string) {
  if (!v) return "acc-xxxx";
  return "*";
}

function compactNumber(v: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function routeLabel(v: string) {
  if (v.includes("chat/completions")) return "chat/completions";
  if (v.includes("responses")) return "responses";
  return v;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sanitized, setSanitized] = useState(initialSanitized);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [traceStats, setTraceStats] = useState<TraceStats>(EMPTY_TRACE_STATS);
  const [tracePagination, setTracePagination] = useState<TracePagination>(EMPTY_TRACE_PAGINATION);
  const [models, setModels] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState("");
  const [redirectInput, setRedirectInput] = useState("");
  const [expectedRedirect, setExpectedRedirect] = useState("http://localhost:1455/auth/callback");
  const [adminToken, setAdminToken] = useState(localStorage.getItem("adminToken") ?? tokenDefault);
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [chatPrompt, setChatPrompt] = useState("Give me a one-line hello");
  const [chatOut, setChatOut] = useState("");
  const [error, setError] = useState("");
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      blocked: accounts.filter((a) => a.state?.blockedUntil && a.state.blockedUntil > Date.now()).length,
    }),
    [accounts],
  );

  const usageStats = useMemo(() => {
    const primary = accounts
      .map((a) => a.usage?.primary?.usedPercent)
      .filter((v): v is number => typeof v === "number");
    const secondary = accounts
      .map((a) => a.usage?.secondary?.usedPercent)
      .filter((v): v is number => typeof v === "number");
    const avg = (arr: number[]) => (arr.length ? arr.reduce((sum, n) => sum + n, 0) / arr.length : 0);
    return {
      primaryAvg: avg(primary),
      secondaryAvg: avg(secondary),
      primaryCount: primary.length,
      secondaryCount: secondary.length,
    };
  }, [accounts]);

  const modelChartData = useMemo(
    () => traceStats.models.slice(0, 8).map((m) => ({ ...m, label: m.model })),
    [traceStats.models],
  );

  const tokensTimeseries = useMemo(
    () => traceStats.timeseries.map((b) => ({
      ...b,
      label: new Date(b.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    })),
    [traceStats.timeseries],
  );

  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("tab", tab);
    if (sanitized) u.searchParams.set("sanitized", "1");
    else u.searchParams.delete("sanitized");
    window.history.replaceState({}, "", u.toString());
  }, [tab, sanitized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSanitized((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadBase = async () => {
    const [acc, cfg, mdl] = await Promise.all([
      api("/admin/accounts"),
      api("/admin/config"),
      fetch("/v1/models").then((r) => r.json()),
    ]);
    setAccounts(acc.accounts ?? []);
    setExpectedRedirect(cfg.oauthRedirectUri ?? expectedRedirect);
    setStorageInfo(cfg.storage ?? null);
    setModels((mdl.data ?? []).map((x: any) => x.id));
  };

  const loadTracing = async (page: number) => {
    const safePage = Math.max(1, page || 1);
    const tr = await api(`/admin/traces?page=${safePage}&pageSize=${TRACE_PAGE_SIZE}`);
    setTraces(tr.traces ?? []);
    setTraceStats(tr.stats ?? EMPTY_TRACE_STATS);
    setTracePagination(tr.pagination ?? { ...EMPTY_TRACE_PAGINATION, page: safePage });
    setExpandedTraceId(null);
  };

  const refreshData = async () => {
    try {
      setError("");
      if (tab === "tracing") {
        await Promise.all([loadBase(), loadTracing(tracePagination.page)]);
      } else {
        await loadBase();
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        setError("");
        await Promise.all([loadBase(), loadTracing(1)]);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (tab !== "tracing") return;
    const timer = window.setInterval(() => {
      loadTracing(tracePagination.page).catch((e: any) => setError(e?.message ?? String(e)));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [tab, tracePagination.page]);

  const startOAuth = async () => {
    const d = await api("/admin/oauth/start", { method: "POST", body: JSON.stringify({ email }) });
    setFlowId(d.flowId);
    setExpectedRedirect(d.expectedRedirectUri ?? expectedRedirect);
    window.open(d.authorizeUrl, "_blank", "noopener,noreferrer");
  };

  const completeOAuth = async () => {
    await api("/admin/oauth/complete", { method: "POST", body: JSON.stringify({ flowId, input: redirectInput }) });
    setRedirectInput("");
    await loadBase();
  };

  const patch = async (id: string, body: any) => {
    await api(`/admin/accounts/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    await loadBase();
  };

  const del = async (id: string) => {
    if (confirm("Delete account?")) {
      await api(`/admin/accounts/${id}`, { method: "DELETE" });
      await loadBase();
    }
  };

  const runChatTest = async () => {
    setChatOut("Running...");
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: models[0] || "gpt-5.3-codex", messages: [{ role: "user", content: chatPrompt }] }),
    });
    const j = await r.json();
    setChatOut(j?.choices?.[0]?.message?.content || JSON.stringify(j, null, 2));
  };

  const gotoTracePage = async (page: number) => {
    try {
      setError("");
      await loadTracing(page);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  return (
    <div className="page">
      <div className="shell">
        <header className="topbar panel">
          <div>
            <h1>MultiCodex Proxy</h1>
            <p className="muted">Quota-aware multi-account proxy with OAuth and request tracing.</p>
          </div>
          <div className="inline wrap">
            <input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} onBlur={() => localStorage.setItem("adminToken", adminToken)} placeholder="Admin token" />
            <button className="btn secondary" onClick={refreshData}>Refresh data</button>
          </div>
        </header>

        <nav className="tabs panel">
          {(["overview", "accounts", "tracing", "playground", "docs"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
          <button className={sanitized ? "tab active" : "tab"} onClick={() => setSanitized((v) => !v)}>
            {sanitized ? "sanitized on" : "sanitized off"}
          </button>
        </nav>

        {tab === "overview" && (
          <>
            <section className="grid cards3">
              <Metric title="Accounts" value={`${stats.total}`} />
              <Metric title="Enabled" value={`${stats.enabled}`} />
              <Metric title="Blocked" value={`${stats.blocked}`} />
            </section>

            <section className="panel">
              <h2>Aggregated usage</h2>
              <ProgressStat label="5h average" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
              <ProgressStat label="Weekly average" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
            </section>

            <section className="grid cards2">
              <section className="panel">
                <h2>Persistence</h2>
                {storageInfo && (
                  <ul className="clean-list">
                    <li className="mono">accounts: {storageInfo.accountsPath}</li>
                    <li className="mono">oauth: {storageInfo.oauthStatePath}</li>
                    <li className="mono">trace: {storageInfo.tracePath}</li>
                    <li>{storageInfo.persistenceLikelyEnabled ? "Persistence mount detected" : "Persistence not guaranteed"}</li>
                  </ul>
                )}
              </section>
              <section className="panel">
                <h2>Models exposed</h2>
                <div className="chips">{models.map((m) => <span key={m} className="chip mono">{m}</span>)}</div>
              </section>
            </section>
          </>
        )}

        {tab === "accounts" && (
          <>
            <section className="panel">
              <h2>OAuth onboarding</h2>
              <div className="inline wrap">
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="account@email.com" />
                <button className="btn" onClick={startOAuth}>Start OAuth</button>
              </div>
              <p className="muted">Expected redirect: <span className="mono">{expectedRedirect}</span></p>
              <div className="inline wrap">
                <input value={flowId} onChange={(e) => setFlowId(e.target.value)} placeholder="flowId" />
                <input value={redirectInput} onChange={(e) => setRedirectInput(e.target.value)} placeholder="Paste full redirect URL/code" />
                <button className="btn" onClick={completeOAuth}>Complete OAuth</button>
              </div>
            </section>

            <section className="panel">
              <h2>Accounts</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>ID</th>
                      <th>5h</th>
                      <th>Week</th>
                      <th>Blocked</th>
                      <th>Error</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td>{sanitized ? maskEmail(a.email) : a.email ?? "-"}</td>
                        <td className="mono">{sanitized ? maskId(a.id) : a.id}</td>
                        <td>{typeof a.usage?.primary?.usedPercent === "number" ? `${Math.round(a.usage.primary.usedPercent)}%` : "?"}<small>{fmt(a.usage?.primary?.resetAt)}</small></td>
                        <td>{typeof a.usage?.secondary?.usedPercent === "number" ? `${Math.round(a.usage.secondary.usedPercent)}%` : "?"}<small>{fmt(a.usage?.secondary?.resetAt)}</small></td>
                        <td>{fmt(a.state?.blockedUntil)}</td>
                        <td className="mono">{a.state?.lastError?.slice(0, 80) ?? "-"}</td>
                        <td className="inline wrap">
                          <button className="btn ghost" onClick={() => patch(a.id, { enabled: !a.enabled })}>{a.enabled ? "Disable" : "Enable"}</button>
                          <button className="btn ghost" onClick={() => api(`/admin/accounts/${a.id}/unblock`, { method: "POST" }).then(loadBase)}>Unblock</button>
                          <button className="btn ghost" onClick={() => api(`/admin/accounts/${a.id}/refresh-usage`, { method: "POST" }).then(loadBase)}>Refresh</button>
                          <button className="btn danger" onClick={() => del(a.id)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {tab === "tracing" && (
          <>
            <section className="grid cards4">
              <Metric title="Requests" value={`${traceStats.totals.requests}`} />
              <Metric title="Error rate" value={pct(traceStats.totals.errorRate)} />
              <Metric title="Total tokens" value={compactNumber(traceStats.totals.tokensTotal)} />
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
                      <YAxis />
                      <Tooltip />
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
                  <button className="btn ghost" onClick={() => gotoTracePage(tracePagination.page - 1)} disabled={!tracePagination.hasPrev}>Previous</button>
                  <span className="mono">Page {tracePagination.page} / {tracePagination.totalPages} ({tracePagination.total} traces)</span>
                  <button className="btn ghost" onClick={() => gotoTracePage(tracePagination.page + 1)} disabled={!tracePagination.hasNext}>Next</button>
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
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traces.map((t) => {
                      const isExpanded = expandedTraceId === t.id;
                      return (
                        <React.Fragment key={t.id}>
                          <tr onClick={() => setExpandedTraceId(isExpanded ? null : t.id)} className="trace-row">
                            <td>{fmt(t.at)}</td>
                            <td className="mono">{routeLabel(t.route)}</td>
                            <td className="mono">{t.model ?? "-"}</td>
                            <td className="mono">{sanitized ? maskEmail(t.accountEmail) || maskId(t.accountId) : t.accountEmail ?? t.accountId ?? "-"}</td>
                            <td>{t.status}</td>
                            <td>{t.latencyMs}ms</td>
                            <td>{t.tokensTotal ?? t.usage?.total_tokens ?? "-"}</td>
                            <td className="mono">{t.error?.slice(0, 60) ?? "-"}</td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={8}>
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
        )}

        {tab === "playground" && (
          <section className="panel">
            <h2>Chat test</h2>
            <div className="inline wrap">
              <input value={chatPrompt} onChange={(e) => setChatPrompt(e.target.value)} placeholder="Type a prompt" />
              <button className="btn" onClick={runChatTest}>Run</button>
            </div>
            <pre className="mono pre">{chatOut || "No output yet."}</pre>
          </section>
        )}

        {tab === "docs" && (
          <section className="panel">
            <h2>API reference</h2>
            <ul className="clean-list">
              <li className="mono">GET /v1/models</li>
              <li className="mono">GET /v1/models/:id</li>
              <li className="mono">POST /v1/chat/completions</li>
              <li className="mono">POST /v1/responses</li>
              <li className="mono">GET /admin/accounts</li>
              <li className="mono">GET /admin/traces?page=1&amp;pageSize=100</li>
              <li className="mono">GET /admin/traces?limit=50 (legacy compatibility)</li>
              <li className="mono">POST /admin/oauth/start</li>
              <li className="mono">POST /admin/oauth/complete</li>
            </ul>
            <p className="muted">Admin endpoints require <span className="mono">x-admin-token</span>.</p>
            <p className="muted">Sanitized mode: use URL flag <span className="mono">?sanitized=1</span> or shortcut <span className="mono">Ctrl/Cmd + Shift + S</span>.</p>
          </section>
        )}

        {error && <div className="panel error">{error}</div>}
      </div>
    </div>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="panel metric">
      <div className="muted metric-title">{title}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function ProgressStat({ label, value, count }: { label: string; value: number; count: number }) {
  const rounded = Math.round(value);
  return (
    <div className="progress-stat">
      <div className="progress-head">
        <span>{label}</span>
        <span>{rounded}%</span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rounded} aria-label={label}>
        <div className="progress-fill" style={{ width: `${clampPct(value)}%` }} />
      </div>
      <small>{count} account(s) included</small>
    </div>
  );
}
