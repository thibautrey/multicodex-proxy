import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { estimateCostUsd } from "./model-pricing";
import { api, tokenDefault } from "./lib/api";
import {
  EMPTY_TRACE_PAGINATION,
  EMPTY_TRACE_STATS,
  TRACE_PAGE_SIZE,
} from "./lib/ui";
import type { Account, Tab, Trace, TracePagination, TraceRangePreset, TraceStats } from "./types";
import { AccountsTab } from "./components/tabs/AccountsTab";
import { DocsTab } from "./components/tabs/DocsTab";
import { OverviewTab } from "./components/tabs/OverviewTab";
import { PlaygroundTab } from "./components/tabs/PlaygroundTab";
import { TracingTab } from "./components/tabs/TracingTab";

const q = new URLSearchParams(window.location.search);
const initialTab = (q.get("tab") as Tab) || "overview";

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [locationSearch, setLocationSearch] = useState(window.location.search);
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
  const [traceRange, setTraceRange] = useState<TraceRangePreset>("7d");
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

  const modelChartData = useMemo(
    () => traceStats.models.slice(0, 8).map((m) => ({ ...m, label: m.model })),
    [traceStats.models],
  );
  const modelCostChartData = useMemo(
    () => [...traceStats.models].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8).map((m) => ({ ...m, label: m.model })),
    [traceStats.models],
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
    const [acc, cfg, mdl] = await Promise.all([
      api("/admin/accounts"),
      api("/admin/config"),
      fetch("/v1/models").then((r) => r.json()),
    ]);
    setAccounts((acc.accounts ?? []) as Account[]);
    setExpectedRedirect(cfg.oauthRedirectUri ?? expectedRedirect);
    setStorageInfo(cfg.storage ?? null);
    setModels((mdl.data ?? []).map((x: any) => x.id));
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

  const startOAuth = async () => {
    const d = await api("/admin/oauth/start", { method: "POST", body: JSON.stringify({ email }) });
    setFlowId(d.flowId as string);
    setExpectedRedirect((d.expectedRedirectUri as string) ?? expectedRedirect);
    window.open(d.authorizeUrl as string, "_blank", "noopener,noreferrer");
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

  const unblock = async (id: string) => {
    await api(`/admin/accounts/${id}/unblock`, { method: "POST" });
    await loadBase();
  };

  const refreshUsage = async (id: string) => {
    await api(`/admin/accounts/${id}/refresh-usage`, { method: "POST" });
    await loadBase();
  };

  const runChatTest = async () => {
    setChatOut("Running...");
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: models[0] || "gpt-5.3-codex", messages: [{ role: "user", content: chatPrompt }] }),
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
            <button className="btn secondary" onClick={() => void refreshData()}>Refresh data</button>
          </div>
        </header>

        <nav className="tabs panel">
          {(["overview", "accounts", "tracing", "playground", "docs"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>

        {tab === "overview" && (
          <OverviewTab
            stats={stats}
            usageStats={usageStats}
            traceStats={traceStats}
            storageInfo={storageInfo}
            models={models}
          />
        )}

        {tab === "accounts" && (
          <AccountsTab
            traceStats={traceStats}
            email={email}
            setEmail={setEmail}
            startOAuth={startOAuth}
            expectedRedirect={expectedRedirect}
            flowId={flowId}
            setFlowId={setFlowId}
            redirectInput={redirectInput}
            setRedirectInput={setRedirectInput}
            completeOAuth={completeOAuth}
            accounts={accounts}
            sanitized={sanitized}
            patch={patch}
            del={del}
            unblock={unblock}
            refreshUsage={refreshUsage}
          />
        )}

        {tab === "tracing" && (
          <TracingTab
            traceStats={traceStats}
            tokensTimeseries={tokensTimeseries}
            modelChartData={modelChartData}
            modelCostChartData={modelCostChartData}
            tracePagination={tracePagination}
            gotoTracePage={gotoTracePage}
            traceRange={traceRange}
            setTraceRange={setTraceRange}
            traces={traces}
            expandedTraceId={expandedTraceId}
            setExpandedTraceId={setExpandedTraceId}
            sanitized={sanitized}
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

        {error && <div className="panel error">{error}</div>}
      </div>
    </div>
  );
}
