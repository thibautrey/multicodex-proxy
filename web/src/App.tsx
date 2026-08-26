import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import { estimateCostUsd } from "./model-pricing";
import { ApiError, api } from "./lib/api";
import {
  EMPTY_TRACE_PAGINATION,
  EMPTY_TRACE_STATS,
  TRACE_PAGE_SIZE,
} from "./lib/ui";
import type {
  Account,
  ApplicationPolicy,
  ApplicationWebhook,
  ExposedModel,
  ModelAlias,
  PriorityClass,
  ProxyApiKey,
  CreatedProxyApiKey,
  ProjectUsageStats,
  StoreSettings,
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
import { ApiKeysTab } from "./components/tabs/ApiKeysTab";
import {
  initialThemeMode,
  ThemeSwitcher,
  type ThemeMode,
} from "./components/ui/ThemeSwitcher";

const q = new URLSearchParams(window.location.search);
const initialTab = (q.get("tab") as Tab) || "overview";
const TAB_ITEMS: Array<{ id: Tab; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Health and usage at a glance" },
  { id: "accounts", label: "Accounts", description: "Providers, quotas and routing" },
  { id: "aliases", label: "Aliases", description: "Model routing and fallbacks" },
  { id: "api-keys", label: "API keys", description: "Application access and credentials" },
  { id: "tracing", label: "Tracing", description: "Requests, cost and latency" },
  { id: "playground", label: "Playground", description: "Test the proxy interactively" },
  { id: "docs", label: "API reference", description: "Endpoints and integration notes" },
];

function TabIcon({ tab }: { tab: Tab }) {
  if (tab === "overview") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>;
  }
  if (tab === "accounts") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="4"/><path d="M3 20c.6-4 2.6-6 6-6s5.4 2 6 6"/><path d="M16 7h5M18.5 4.5v5"/></svg>;
  }
  if (tab === "aliases") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v5a3 3 0 0 0 3 3h9"/><path d="m15 9 3 3-3 3"/><path d="M6 20v-3a5 5 0 0 1 5-5"/></svg>;
  }
  if (tab === "api-keys") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M15 8l3 3M17 6l2 2"/></svg>;
  }
  if (tab === "tracing") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17h3l2-7 4 10 3-13 2 10h2"/></svg>;
  }
  if (tab === "playground") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-6 9 6 9M15 3l6 9-6 9"/><path d="m14 8-4 8"/></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h8"/></svg>;
}
function activeModelBlockCount(account: Account) {
  return Object.values(account.state?.modelBlocks ?? {}).filter(
    (block) => block.until > Date.now(),
  ).length;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [traceStats, setTraceStats] = useState<TraceStats>(EMPTY_TRACE_STATS);
  const [projectUsageStats, setProjectUsageStats] = useState<ProjectUsageStats>({
    byProject: [],
  });
  const [tracePagination, setTracePagination] = useState<TracePagination>(EMPTY_TRACE_PAGINATION);
  const [models, setModels] = useState<ExposedModel[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [proxyApiKeys, setProxyApiKeys] = useState<ProxyApiKey[]>([]);
  const [applicationPolicies, setApplicationPolicies] = useState<ApplicationPolicy[]>([]);
  const [settings, setSettings] = useState<StoreSettings>({});
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginToken, setLoginToken] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [storageInfo, setStorageInfo] = useState<any>(null);
  const [oauthRedirectUri, setOauthRedirectUri] = useState("");
  const [chatPrompt, setChatPrompt] = useState("Give me a one-line hello");
  const [chatModel, setChatModel] = useState("");
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

  useEffect(() => {
    localStorage.removeItem("adminToken");
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    localStorage.setItem("themeMode", themeMode);
  }, [themeMode]);

  const handleError = (e: any) => {
    if (e instanceof ApiError && e.status === 401) {
      setAuthenticated(false);
      setError("");
      return;
    }
    setError(e?.message ?? String(e));
  };

  const stats = useMemo(
    () => ({
      total: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      blocked: accounts.filter((a) => activeModelBlockCount(a) > 0).length,
    }),
    [accounts],
  );

  const usageStats = useMemo(() => {
    const primary = accounts
      .filter((a) => {
        const weeklyUsed = a.usage?.secondary?.usedPercent;
        return typeof weeklyUsed !== "number" || weeklyUsed < 100;
      })
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
      inferenceTokensPerSecond:
        b.inferenceRequests > 0 ? b.inferenceTokensPerSecond : null,
      label: new Date(b.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    })),
    [traceStats.timeseries],
  );
  const totalTraceCostFromRows = useMemo(
    () =>
      traces.reduce(
        (sum, t) => sum + (typeof t.costUsd === "number" ? t.costUsd : (estimateCostUsd(t.model, t.tokensInput ?? 0, t.tokensOutput ?? 0, t.tokensInputCached ?? 0, t.tokensInputCacheWrite ?? 0) ?? 0)),
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
    const [acc, cfg, mdl, aliasRes, settingsRes, apiKeysRes, policiesRes] = await Promise.all([
      api("/admin/accounts"),
      api("/admin/config"),
      fetch("/v1/models").then((r) => r.json()),
      api("/admin/model-aliases"),
      api("/admin/settings"),
      api("/admin/proxy-api-keys"),
      api("/admin/application-policies"),
    ]);
    setAccounts((acc.accounts ?? []) as Account[]);
    setStorageInfo(cfg.storage ?? null);
    setOauthRedirectUri(String(cfg.oauthRedirectUri ?? ""));
    setModels((mdl.data ?? []) as ExposedModel[]);
    setAliases((aliasRes.modelAliases ?? []) as ModelAlias[]);
    setSettings((settingsRes.settings ?? {}) as StoreSettings);
    setProxyApiKeys((apiKeysRes.proxyApiKeys ?? []) as ProxyApiKey[]);
    setApplicationPolicies((policiesRes.applicationPolicies ?? []) as ApplicationPolicy[]);
  };

  const refreshModels = async () => {
    const mdl = await fetch("/v1/models").then((r) => r.json());
    setModels((mdl.data ?? []) as ExposedModel[]);
  };

  useEffect(() => {
    if (!models.length) {
      if (chatModel) setChatModel("");
      return;
    }
    if (!chatModel || !models.some((model) => model.id === chatModel)) {
      setChatModel(models[0]?.id ?? "");
    }
  }, [chatModel, models]);

  const getRangeBounds = (range: TraceRangePreset): { sinceMs?: number; untilMs?: number } => {
    const now = Date.now();
    const since = (durationMs: number) =>
      Math.floor((now - durationMs) / 3_600_000) * 3_600_000;
    if (range === "24h") return { sinceMs: since(24 * 60 * 60 * 1000), untilMs: now };
    if (range === "7d") return { sinceMs: since(7 * 24 * 60 * 60 * 1000), untilMs: now };
    if (range === "30d") return { sinceMs: since(30 * 24 * 60 * 60 * 1000), untilMs: now };
    return {};
  };

  const traceRangeParams = (range: TraceRangePreset) => {
    const { sinceMs, untilMs } = getRangeBounds(range);
    const params = new URLSearchParams();
    if (typeof sinceMs === "number") params.set("sinceMs", String(sinceMs));
    if (typeof untilMs === "number") params.set("untilMs", String(untilMs));
    return params;
  };

  const loadTraceStats = async (range: TraceRangePreset = traceRange) => {
    const params = traceRangeParams(range).toString();
    const [statsRes, usageRes] = await Promise.all([
      api(`/admin/stats/traces?${params}`),
      api(`/admin/stats/usage?${params}`),
    ]);
    setTraceStats((statsRes.stats ?? EMPTY_TRACE_STATS) as TraceStats);
    setProjectUsageStats({ byProject: usageRes.byProject ?? [] });
  };

  const loadTracing = async (page: number, range: TraceRangePreset = traceRange) => {
    const safePage = Math.max(1, page || 1);
    const params = traceRangeParams(range);
    params.set("page", String(safePage));
    params.set("pageSize", String(TRACE_PAGE_SIZE));

    const [tr, statsRes, usageRes] = await Promise.all([
      api(`/admin/traces?${params.toString()}`),
      api(`/admin/stats/traces?${params.toString()}`),
      api(`/admin/stats/usage?${traceRangeParams(range).toString()}`),
    ]);
    setTraces((tr.traces ?? []) as Trace[]);
    setTraceStats((statsRes.stats ?? tr.stats ?? EMPTY_TRACE_STATS) as TraceStats);
    setProjectUsageStats({ byProject: usageRes.byProject ?? [] });
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
      setAuthenticated(true);
      if (tab === "tracing") {
        await loadTracing(tracePageRef.current, traceRangeRef.current);
      } else {
        await loadTraceStats(traceRangeRef.current);
      }
    } catch (e: any) {
      handleError(e);
    }
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    try {
      setError("");
      await api("/admin/session", {
        method: "POST",
        body: JSON.stringify({ token: loginToken }),
      });
      setLoginToken("");
      setAuthenticated(true);
      await Promise.all([loadBase(), loadTraceStats(traceRangeRef.current)]);
    } catch (err: any) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid admin token." : err?.message ?? String(err));
      setAuthenticated(false);
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api("/admin/session", { method: "DELETE" });
    } catch {
      // Treat logout as local even if the session is already gone.
    }
    setAuthenticated(false);
    setAccounts([]);
    setTraces([]);
    setAliases([]);
    setError("");
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
        await Promise.all([loadBase(), loadTraceStats(traceRangeRef.current)]);
        setAuthenticated(true);
        setTab("accounts");
      } catch (e: any) {
        handleError(e);
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
        const session = await api("/admin/session");
        if (!session?.authenticated) {
          setAuthenticated(false);
          return;
        }
        setAuthenticated(true);
        await Promise.all([loadBase(), loadTraceStats(traceRangeRef.current)]);
      } catch (e: any) {
        handleError(e);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (tab !== "tracing") return;
    const load = async () => {
      try {
        setError("");
        await loadTracing(1, traceRange);
      } catch (e: any) {
        handleError(e);
      }
    };
    void load();
  }, [tab, traceRange]);

  useEffect(() => {
    if (tab !== "tracing") return;
    const timer = window.setInterval(() => {
      void loadTracing(tracePagination.page, traceRange).catch(handleError);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [tab, tracePagination.page, traceRange]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshModels().catch(handleError);
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

  const consumeRateLimitResetCredit = async (id: string) => {
    try {
      const availability = await api(
        `/admin/accounts/${id}/rate-limit-reset-credit`,
      );
      const credit = availability?.credit;
      const findAvailableCount = (value: unknown): number | undefined => {
        if (!value || typeof value !== "object") return undefined;
        const record = value as Record<string, unknown>;
        for (const key of [
          "availableCount",
          "available_count",
          "available",
          "amount",
          "remaining",
          "balance",
        ]) {
          const candidate = record[key];
          if (typeof candidate === "number" && Number.isFinite(candidate)) {
            return candidate;
          }
        }
        for (const child of Object.values(record)) {
          const count = findAvailableCount(child);
          if (count !== undefined) return count;
        }
        return undefined;
      };
      const amount = findAvailableCount(credit);
      if (amount === undefined) {
        throw new Error("OpenAI did not report an available reset-credit count.");
      }
      if (amount < 1) {
        throw new Error("No rate-limit reset credits are available for this account.");
      }
      const description = `${amount} reset credit${amount === 1 ? "" : "s"} available`;
      if (!confirm(`${description}. Consume one now?`)) return;
      await api(`/admin/accounts/${id}/rate-limit-reset-credit/consume`, {
        method: "POST",
      });
      await loadBase();
    } catch (error) {
      handleError(error);
    }
  };

  const scheduleRateLimitResetCredit = async (id: string) => {
    try {
      await api(`/admin/accounts/${id}/rate-limit-reset-credit/schedule`, {
        method: "POST",
      });
      await loadBase();
    } catch (error) {
      handleError(error);
    }
  };

  const cancelScheduledRateLimitResetCredit = async (id: string) => {
    try {
      await api(`/admin/accounts/${id}/rate-limit-reset-credit/schedule`, {
        method: "DELETE",
      });
      await loadBase();
    } catch (error) {
      handleError(error);
    }
  };

  const createAccount = async (body: any) => {
    await api("/admin/accounts", { method: "POST", body: JSON.stringify(body) });
    await loadBase();
  };

  const importGrokAuth = async () => {
    const result = await api("/admin/grok/import", { method: "POST" });
    await loadBase();
    return result;
  };

  const patchSettings = async (body: Partial<StoreSettings>) => {
    await api("/admin/settings", { method: "PATCH", body: JSON.stringify(body) });
    await loadBase();
  };

  const startOAuth = async (
    email: string,
    accountId?: string,
    method: "browser" | "device" = "browser",
    provider: "openai" | "xai" = "openai",
  ) => {
    return api("/admin/oauth/start", {
      method: "POST",
      body: JSON.stringify({ email, accountId, method, provider }),
    });
  };

  const pollDeviceOAuth = async (flowId: string) => {
    const result = await api("/admin/oauth/device/poll", {
      method: "POST",
      body: JSON.stringify({ flowId }),
    });
    if (result?.status === "success") await loadBase();
    return result;
  };

  const completeOAuth = async (flowId: string, input: string) => {
    const result = await api("/admin/oauth/complete", {
      method: "POST",
      body: JSON.stringify({ flowId, input }),
    });
    await loadBase();
    return result;
  };

  const saveAlias = async (body: ModelAlias) => {
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

  const simulateAlias = async (
    alias: ModelAlias,
    request: Record<string, unknown>,
  ) => api("/admin/model-aliases/simulate", {
    method: "POST",
    body: JSON.stringify({ alias, request }),
  });

  const loadCapacity = async (model: string, priority: PriorityClass) =>
    api(`/v1/capacity?model=${encodeURIComponent(model)}&priority=${priority}`);

  const createProxyApiKey = async (application: string): Promise<CreatedProxyApiKey> => {
    const result = await api("/admin/proxy-api-keys", {
      method: "POST",
      body: JSON.stringify({ application }),
    });
    await loadBase();
    return result.proxyApiKey as CreatedProxyApiKey;
  };

  const deleteProxyApiKey = async (id: string) => {
    await api(`/admin/proxy-api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadBase();
  };

  const setApplicationWeight = async (application: string, fairnessWeight: number) => {
    await api(`/admin/application-policies/${encodeURIComponent(application)}`, {
      method: "PATCH",
      body: JSON.stringify({ fairnessWeight }),
    });
    await loadBase();
  };

  const createApplicationWebhook = async (
    application: string,
    url: string,
  ): Promise<ApplicationWebhook> => {
    const result = await api(
      `/admin/application-policies/${encodeURIComponent(application)}/webhooks`,
      { method: "POST", body: JSON.stringify({ url }) },
    );
    await loadBase();
    return result.webhook as ApplicationWebhook;
  };

  const deleteApplicationWebhook = async (application: string, id: string) => {
    await api(
      `/admin/application-policies/${encodeURIComponent(application)}/webhooks/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    await loadBase();
  };

  const runChatTest = async () => {
    setChatOut("Running...");
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chatModel || models[0]?.id || "gpt-5.3-codex",
        messages: [{ role: "user", content: chatPrompt }],
      }),
    });
    const j = await r.json();
    setChatOut((j?.choices?.[0]?.message?.content as string) || JSON.stringify(j, null, 2));
  };

  const gotoTracePage = async (page: number) => {
    try {
      setError("");
      await loadTracing(page, traceRange);
    } catch (e: any) {
      handleError(e);
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
      handleError(e);
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
        credentials: "same-origin",
      });
      if (!res.ok) {
        const txt = await res.text();
        if (res.status === 401) throw new ApiError(401, txt || "unauthorized");
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
      handleError(e);
    } finally {
      setTraceExportInProgress(false);
    }
  };

  if (authenticated === null) {
    return (
      <div className="auth-page">
        <div className="auth-shell panel">
          <div className="auth-brand-mark" aria-hidden="true">MV</div>
          <div>
            <span className="eyebrow">Multi-provider routing</span>
            <h1>MultiVibe</h1>
            <p className="muted">Checking your admin session...</p>
          </div>
          <div className="auth-loading" aria-label="Loading" />
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="auth-page">
        <form className="auth-shell panel" onSubmit={login}>
          <div className="auth-brand-mark" aria-hidden="true">MV</div>
          <div>
            <span className="eyebrow">Admin workspace</span>
            <h1>MultiVibe</h1>
            <p className="muted">Sign in to manage routing, providers and request activity.</p>
          </div>
          <label className="control-field">
            <span className="control-label">Admin token</span>
            <input
              autoFocus
              type="password"
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              placeholder="Enter your token"
              autoComplete="current-password"
            />
          </label>
          {error && <div className="error auth-error">{error}</div>}
          <button className="btn" type="submit" disabled={loginBusy || !loginToken.trim()}>
            {loginBusy ? "Unlocking..." : "Unlock dashboard"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="shell app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark" aria-hidden="true">MV</div>
            <div className="brand-copy">
              <strong>MultiVibe</strong>
              <span>Proxy control plane</span>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Primary navigation">
            <span className="sidebar-nav-label">Workspace</span>
            {TAB_ITEMS.map((item) => (
              <button
                key={item.id}
                className={tab === item.id ? "nav-tab active" : "nav-tab"}
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? "page" : undefined}
              >
                <span className="nav-tab-icon"><TabIcon tab={item.id} /></span>
                <span className="nav-tab-copy">
                  <span className="nav-tab-label">{item.label}</span>
                  <span className="nav-tab-description">{item.description}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-status">
              <span className="status-dot" />
              <span>
                <strong>{sanitized ? "Sanitized view" : "System online"}</strong>
                <small>{accounts.length} accounts · {models.length} models</small>
              </span>
            </div>
            <ThemeSwitcher value={themeMode} onChange={setThemeMode} />
          </div>
        </aside>

        <div className="workspace">
          <header className="topbar">
            <div className="topbar-title">
              <span className="eyebrow">Control plane</span>
              <h1>{TAB_ITEMS.find((item) => item.id === tab)?.label}</h1>
              <p className="muted">{TAB_ITEMS.find((item) => item.id === tab)?.description}</p>
            </div>
            <div className="topbar-actions">
              <span className="badge badge-live">
                <span className="status-dot" />
                {sanitized ? "Sanitized" : "Live"}
              </span>
              <button className="btn secondary topbar-button" onClick={() => void refreshData()}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7h-5V2"/><path d="M20 7a9 9 0 1 0 2 7"/></svg>
                Refresh
              </button>
              <button className="btn ghost icon-button" onClick={() => void logout()} title="Lock dashboard" aria-label="Lock dashboard">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
              </button>
            </div>
          </header>

          {error && <div className="panel error workspace-error">{error}</div>}

          <main className={`workspace-content workspace-${tab}`}>

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
            settings={settings}
            sanitized={sanitized}
            patch={patch}
            del={del}
            unblock={unblock}
            refreshUsage={refreshUsage}
            consumeRateLimitResetCredit={consumeRateLimitResetCredit}
            scheduleRateLimitResetCredit={scheduleRateLimitResetCredit}
            cancelScheduledRateLimitResetCredit={
              cancelScheduledRateLimitResetCredit
            }
            createAccount={createAccount}
            importGrokAuth={importGrokAuth}
            patchSettings={patchSettings}
            startOAuth={startOAuth}
            pollDeviceOAuth={pollDeviceOAuth}
            completeOAuth={completeOAuth}
            oauthRedirectUri={oauthRedirectUri}
          />
        )}

        {tab === "aliases" && (
          <AliasesTab
            aliases={aliases}
            models={models}
            settings={settings}
            saveAlias={saveAlias}
            patchAlias={patchAlias}
            deleteAlias={deleteAlias}
            patchSettings={patchSettings}
            simulateAlias={simulateAlias}
            loadCapacity={loadCapacity}
          />
        )}

        {tab === "api-keys" && (
          <ApiKeysTab
            apiKeys={proxyApiKeys}
            policies={applicationPolicies}
            createApiKey={createProxyApiKey}
            deleteApiKey={deleteProxyApiKey}
            setApplicationWeight={setApplicationWeight}
            createWebhook={createApplicationWebhook}
            deleteWebhook={deleteApplicationWebhook}
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
            projectUsageStats={projectUsageStats}
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
            chatModel={chatModel}
            setChatModel={setChatModel}
            models={models}
            runChatTest={runChatTest}
            chatOut={chatOut}
          />
        )}

        {tab === "docs" && (
          <DocsTab totalTraceCostFromRows={totalTraceCostFromRows} />
        )}
          </main>
        </div>
      </div>
    </div>
  );
}
