import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { estimateCostUsd } from "./model-pricing";
import { api, tokenDefault } from "./lib/api";
import {
  EMPTY_TRACE_PAGINATION,
  EMPTY_TRACE_STATS,
  TRACE_PAGE_SIZE,
} from "./lib/ui";
import type {
  Account,
  ExposedModel,
  ModelAlias,
  Tab,
  Trace,
  TracePagination,
  TraceRangePreset,
  TraceStats,
} from "./types";
import { AccountsTab } from "./components/tabs/AccountsTab";
import { DocsTab } from "./components/tabs/DocsTab";
import { OverviewTab } from "./components/tabs/OverviewTab";
import { PlaygroundTab } from "./components/tabs/PlaygroundTab";
import { TracingTab } from "./components/tabs/TracingTab";
import { AliasesTab } from "./components/tabs/AliasesTab";

const q = new URLSearchParams(window.location.search);
const initialTab = (q.get("tab") as Tab) || "overview";
const TAB_ITEMS: Array<{ id: Tab; label: string; description: string }> = [
  {
    id: "overview",
    label: "Overview",
    description: "Global health, capacity, model exposure, and persistence status.",
  },
  {
    id: "accounts",
    label: "Accounts",
    description: "Onboard providers, monitor quotas, and manage account state.",
  },
  {
    id: "aliases",
    label: "Aliases",
    description: "Define stable routing names backed by ordered fallback targets.",
  },
  {
    id: "tracing",
    label: "Tracing",
    description: "Inspect request volume, cost, latency, failures, and full traces.",
  },
  {
    id: "playground",
    label: "Playground",
    description: "Run quick live requests against the exposed OpenAI-compatible API.",
  },
  {
    id: "docs",
    label: "Docs",
    description: "Review the supported routes, admin endpoints, and operator notes.",
  },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [traceStats, setTraceStats] = useState<TraceStats>(EMPTY_TRACE_STATS);
  const [tracePagination, setTracePagination] = useState<TracePagination>(EMPTY_TRACE_PAGINATION);
  const [models, setModels] = useState<ExposedModel[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [adminToken, setAdminToken] = useState(localStorage.getItem("adminToken") ?? tokenDefault);
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [oauthRedirectUri, setOauthRedirectUri] = useState("");
  const [chatPrompt, setChatPrompt] = useState("Give me a one-line hello");
  const [chatOut, setChatOut] = useState("");
  const [error, setError] = useState("");
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [expandedTrace, setExpandedTrace] = useState<Trace | null>(null);
  const [expandedTraceLoading, setExpandedTraceLoading] = useState(false);
  const [traceRange, setTraceRange] = useState<TraceRangePreset>("7d");
  const [traceExportInProgress, setTraceExportInProgress] = useState(false);
  const tracePageRef = useRef(tracePagination.page);
  const traceRangeRef = useRef(traceRange);
  const sanitized = useMemo(() => {
    const params = new URLSearchParams(locationSearch);
    return params.get("sanitized") === "1" || params.get("safe") === "1";
  }, [locationSearch]);

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

  const filteredTraceStats = useMemo(() => {
    if (!traceStats.models.length) return traceStats;
    if (!models.length) return { ...traceStats, models: [] };
    const allowed = new Set(models.map((m) => m.id));
    const filteredModels = traceStats.models.filter((m) => allowed.has(m.model) && m.okCount > 0);
    return { ...traceStats, models: filteredModels };
  }, [models, traceStats]);

  const modelChartData = useMemo(
    () => filteredTraceStats.models.slice(0, 8).map((m) => ({ ...m, label: m.model })),
    [filteredTraceStats.models],
  );
  const modelCostChartData = useMemo(
    () => [...filteredTraceStats.models].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8).map((m) => ({ ...m, label: m.model })),
    [filteredTraceStats.models],
  );

  const tokensTimeseries = useMemo(
    () => traceStats.timeseries.map((b) => ({
      ...b,
      label: new Date(b.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    })),
    [traceStats.timeseries],
  );
  const totalTraceCostFromRows = useMemo(
    () =>
      traces.reduce(
        (sum, t) => sum + (typeof t.costUsd === "number" ? t.costUsd : (estimateCostUsd(t.model, t.tokensInput ?? 0, t.tokensOutput ?? 0) ?? 0)),
        0,
      ),
    [traces],
  );
  const currentTab = useMemo(
    () => TAB_ITEMS.find((item) => item.id === tab) ?? TAB_ITEMS[0],
    [tab],
  );
  const activeAccountCount = useMemo(
    () => accounts.filter((account) => account.enabled).length,
    [accounts],
  );

  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("tab", tab);
    window.history.replaceState({}, "", u.toString());
    setLocationSearch(u.search);
  }, [tab]);

  useEffect(() => {
    const onPopstate = () => setLocationSearch(window.location.search);
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, []);

  const loadBase = async () => {
    const [acc, cfg, mdl, aliasRes] = await Promise.all([
      api("/admin/accounts"),
      api("/admin/config"),
      fetch("/v1/models").then((r) => r.json()),
      api("/admin/model-aliases"),
    ]);
    setAccounts((acc.accounts ?? []) as Account[]);
    setStorageInfo(cfg.storage ?? null);
    setOauthRedirectUri(String(cfg.oauthRedirectUri ?? ""));
    setModels((mdl.data ?? []) as ExposedModel[]);
    setAliases((aliasRes.modelAliases ?? []) as ModelAlias[]);
  };

  const refreshModels = async () => {
    const mdl = await fetch("/v1/models").then((r) => r.json());
    setModels((mdl.data ?? []) as ExposedModel[]);
  };

  const getRangeBounds = (range: TraceRangePreset): { sinceMs?: number; untilMs?: number } => {
    const now = Date.now();
    if (range === "24h") return { sinceMs: now - 24 * 60 * 60 * 1000, untilMs: now };
    if (range === "7d") return { sinceMs: now - 7 * 24 * 60 * 60 * 1000, untilMs: now };
    if (range === "30d") return { sinceMs: now - 30 * 24 * 60 * 60 * 1000, untilMs: now };
    return {};
  };

  const loadTracing = async (page: number, range: TraceRangePreset = traceRange) => {
    const safePage = Math.max(1, page || 1);
    const { sinceMs, untilMs } = getRangeBounds(range);
    const params = new URLSearchParams();
    params.set("page", String(safePage));
    params.set("pageSize", String(TRACE_PAGE_SIZE));
    if (typeof sinceMs === "number") params.set("sinceMs", String(sinceMs));
    if (typeof untilMs === "number") params.set("untilMs", String(untilMs));

    const [tr, statsRes] = await Promise.all([
      api(`/admin/traces?${params.toString()}`),
      api(`/admin/stats/traces?${params.toString()}`),
    ]);
    setTraces((tr.traces ?? []) as Trace[]);
    setTraceStats((statsRes.stats ?? tr.stats ?? EMPTY_TRACE_STATS) as TraceStats);
    setTracePagination((tr.pagination ?? { ...EMPTY_TRACE_PAGINATION, page: safePage }) as TracePagination);
    setExpandedTraceId(null);
    setExpandedTrace(null);
  };

  useEffect(() => {
    tracePageRef.current = tracePagination.page;
  }, [tracePagination.page]);

  useEffect(() => {
    traceRangeRef.current = traceRange;
  }, [traceRange]);

  const refreshData = async () => {
    try {
      setError("");
      await loadBase();
      if (tab === "tracing") {
        await loadTracing(tracePageRef.current, traceRangeRef.current);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;

    const complete = async () => {
      try {
        if (window.opener) {
          window.opener.postMessage(
            { type: "multivibe-oauth-callback", callbackUrl: window.location.href },
            window.location.origin
          );
          window.close();
          return;
        }

        const pendingRaw = sessionStorage.getItem("multivibe-oauth-pending");
        const pending = pendingRaw ? JSON.parse(pendingRaw) : null;

        const result = await api("/admin/oauth/complete", {
          method: "POST",
          body: JSON.stringify({ flowId: state, input: window.location.href }),
        });
        const accountId = String(result?.account?.id ?? "").trim();

        if (pending?.mode === "create" && accountId && (pending.pendingPriority !== 0 || pending.pendingEnabled === false)) {
          await api(`/admin/accounts/${accountId}`, {
            method: "PATCH",
            body: JSON.stringify({
              priority: pending.pendingPriority ?? 0,
              enabled: pending.pendingEnabled ?? true,
            }),
          });
        }

        const u = new URL(window.location.href);
        u.searchParams.delete("code");
        u.searchParams.delete("state");
        window.history.replaceState({}, "", u.toString());
        setLocationSearch(u.search);
        sessionStorage.removeItem("multivibe-oauth-pending");
        await loadBase();
        setTab("accounts");
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    };

    void complete();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("code") && params.get("state")) return;

    const load = async () => {
      try {
        setError("");
        await loadBase();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (tab !== "tracing") return;
    const load = async () => {
      try {
        setError("");
        await loadTracing(tracePageRef.current, traceRangeRef.current);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    };
    void load();
  }, [tab]);

  useEffect(() => {
    if (tab !== "tracing") return;
    const timer = window.setInterval(() => {
      void loadTracing(tracePagination.page, traceRange).catch((e: any) => setError(e?.message ?? String(e)));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [tab, tracePagination.page, traceRange]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshModels().catch((e: any) => setError(e?.message ?? String(e)));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

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

  const unblock = async (id: string) => {
    await api(`/admin/accounts/${id}/unblock`, { method: "POST" });
    await loadBase();
  };

  const refreshUsage = async (id: string) => {
    await api(`/admin/accounts/${id}/refresh-usage`, { method: "POST" });
    await loadBase();
  };

  const createAccount = async (body: any) => {
    await api("/admin/accounts", { method: "POST", body: JSON.stringify(body) });
    await loadBase();
  };

  const startOAuth = async (email: string, accountId?: string) => {
    return api("/admin/oauth/start", {
      method: "POST",
      body: JSON.stringify({ email, accountId }),
    });
  };

  const completeOAuth = async (flowId: string, input: string) => {
    const result = await api("/admin/oauth/complete", {
      method: "POST",
      body: JSON.stringify({ flowId, input }),
    });
    await loadBase();
    return result;
  };

  const saveAlias = async (body: {
    id: string;
    targets: string[];
    enabled?: boolean;
    description?: string;
  }) => {
    await api("/admin/model-aliases", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await loadBase();
  };

  const patchAlias = async (id: string, body: Partial<ModelAlias>) => {
    await api(`/admin/model-aliases/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    await loadBase();
  };

  const deleteAlias = async (id: string) => {
    if (confirm("Delete model alias?")) {
      await api(`/admin/model-aliases/${id}`, { method: "DELETE" });
      await loadBase();
    }
  };

  const runChatTest = async () => {
    setChatOut("Running...");
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: models[0]?.id || "gpt-5.3-codex", messages: [{ role: "user", content: chatPrompt }] }),
    });
    const j = await r.json();
    setChatOut((j?.choices?.[0]?.message?.content as string) || JSON.stringify(j, null, 2));
  };

  const gotoTracePage = async (page: number) => {
    try {
      setError("");
      await loadTracing(page, traceRange);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const toggleExpandedTrace = async (id: string) => {
    if (expandedTraceId === id) {
      setExpandedTraceId(null);
      setExpandedTrace(null);
      setExpandedTraceLoading(false);
      return;
    }

    setExpandedTraceId(id);
    setExpandedTrace(null);
    setExpandedTraceLoading(true);
    try {
      setError("");
      const res = await api(`/admin/traces/${encodeURIComponent(id)}`);
      setExpandedTrace((res.trace ?? null) as Trace | null);
    } catch (e: any) {
      setExpandedTraceId(null);
      setError(e?.message ?? String(e));
    } finally {
      setExpandedTraceLoading(false);
    }
  };

  const exportTracesZip = async () => {
    const { sinceMs, untilMs } = getRangeBounds(traceRange);
    const params = new URLSearchParams();
    if (typeof sinceMs === "number") params.set("sinceMs", String(sinceMs));
    if (typeof untilMs === "number") params.set("untilMs", String(untilMs));
    const query = params.toString();
    const path = `/admin/traces/export.zip${query ? `?${query}` : ""}`;

    setTraceExportInProgress(true);
    try {
      setError("");
      const res = await fetch(path, {
        headers: {
          "x-admin-token": localStorage.getItem("adminToken") ?? tokenDefault,
        },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      const contentDisposition = res.headers.get("content-disposition") ?? "";
      const match = contentDisposition.match(/filename="([^"]+)"/);
      link.href = url;
      link.download = match?.[1] ?? "traces-export.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setTraceExportInProgress(false);
    }
  };

  return (
    <div className="page">
      <div className="shell app-shell">
        <aside className="panel sidebar">
          <div className="brand-lockup">
            <div className="eyebrow">Multi-provider gateway</div>
            <h1>MultiVibe</h1>
            <p className="muted">
              One OpenAI-compatible `/v1` surface for quota-aware routing, aliases,
              OAuth onboarding, and request tracing.
            </p>
          </div>

          <div className="sidebar-summary">
            <div className="sidebar-summary-card">
              <span className="sidebar-summary-label">Active accounts</span>
              <strong>{activeAccountCount}</strong>
            </div>
            <div className="sidebar-summary-card">
              <span className="sidebar-summary-label">Exposed models</span>
              <strong>{models.length}</strong>
            </div>
            <div className="sidebar-summary-card">
              <span className="sidebar-summary-label">Trace requests</span>
              <strong>{traceStats.totals.requests}</strong>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Primary">
            {TAB_ITEMS.map((item) => (
              <button
                key={item.id}
                className={tab === item.id ? "nav-tab active" : "nav-tab"}
                onClick={() => setTab(item.id)}
              >
                <span className="nav-tab-label">{item.label}</span>
                <span className="nav-tab-description">{item.description}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-meta">
            <span className={sanitized ? "badge badge-live" : "badge"}>
              {sanitized ? "Sanitized mode on" : "Live values visible"}
            </span>
            <span className="badge">{stats.blocked} blocked</span>
          </div>
        </aside>

        <main className="workspace">
          <header className="panel hero">
            <div className="hero-copy">
              <div className="eyebrow">{currentTab.label}</div>
              <h2 className="hero-title">{currentTab.description}</h2>
              <p className="muted hero-text">
                Use this dashboard to balance provider capacity, keep aliases stable,
                and trace request health from one control surface.
              </p>
              <div className="hero-badges">
                <span className="badge">{stats.total} accounts</span>
                <span className="badge">{models.length} models</span>
                <span className="badge">{aliases.length} aliases</span>
                <span className="badge">{filteredTraceStats.totals.requests} requests in range</span>
              </div>
            </div>

            <div className="hero-controls">
              <label className="control-field">
                <span className="control-label">Admin token</span>
                <input
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  onBlur={() => localStorage.setItem("adminToken", adminToken)}
                  placeholder="Admin token"
                />
              </label>
              <button className="btn secondary" onClick={() => void refreshData()}>
                Refresh data
              </button>
            </div>
          </header>

          {error && <div className="panel error">{error}</div>}

          <div className="content-stack">
            {tab === "overview" && (
              <OverviewTab
                stats={stats}
                usageStats={usageStats}
                traceStats={filteredTraceStats}
                storageInfo={storageInfo}
                models={models}
              />
            )}

            {tab === "accounts" && (
              <AccountsTab
                traceStats={filteredTraceStats}
                accounts={accounts}
                sanitized={sanitized}
                patch={patch}
                del={del}
                unblock={unblock}
                refreshUsage={refreshUsage}
                createAccount={createAccount}
                startOAuth={startOAuth}
                completeOAuth={completeOAuth}
                oauthRedirectUri={oauthRedirectUri}
              />
            )}

            {tab === "aliases" && (
              <AliasesTab
                aliases={aliases}
                saveAlias={saveAlias}
                patchAlias={patchAlias}
                deleteAlias={deleteAlias}
              />
            )}

            {tab === "tracing" && (
              <TracingTab
                accounts={accounts}
                traceStats={filteredTraceStats}
                tokensTimeseries={tokensTimeseries}
                modelChartData={modelChartData}
                modelCostChartData={modelCostChartData}
                tracePagination={tracePagination}
                gotoTracePage={gotoTracePage}
                traceRange={traceRange}
                setTraceRange={setTraceRange}
                traces={traces}
                expandedTraceId={expandedTraceId}
                expandedTrace={expandedTrace}
                expandedTraceLoading={expandedTraceLoading}
                toggleExpandedTrace={toggleExpandedTrace}
                sanitized={sanitized}
                exportTracesZip={exportTracesZip}
                exportInProgress={traceExportInProgress}
              />
            )}

            {tab === "playground" && (
              <PlaygroundTab
                chatPrompt={chatPrompt}
                setChatPrompt={setChatPrompt}
                runChatTest={runChatTest}
                chatOut={chatOut}
              />
            )}

            {tab === "docs" && (
              <DocsTab totalTraceCostFromRows={totalTraceCostFromRows} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
