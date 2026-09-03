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
  ModuleView,
  MarketplaceModule,
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
import { AccountsTab, type LocalWorkerProvider } from "./components/tabs/AccountsTab";
import { DocsTab } from "./components/tabs/DocsTab";
import { OverviewTab } from "./components/tabs/OverviewTab";
import { TracingTab } from "./components/tabs/TracingTab";
import { AliasesTab } from "./components/tabs/AliasesTab";
import { ApiKeysTab } from "./components/tabs/ApiKeysTab";
import { PluginsTab } from "./components/tabs/PluginsTab";
import {
  initialThemeMode,
  ThemeSwitcher,
  type ThemeMode,
} from "./components/ui/ThemeSwitcher";
import { dismissGitHubPromotion, GITHUB_NEW_ISSUE_URL, GITHUB_REPOSITORY_URL, GITHUB_STARS_URL, readGitHubPromotionState } from "./github-promotion";

const TAB_ITEMS: Array<{ id: Tab; label: string; description: string; group: "Operate" | "Build" | "Advanced" }> = [
  { id: "overview", label: "Home", description: "System status and next steps", group: "Operate" },
  { id: "accounts", label: "Providers", description: "Accounts, models and quotas", group: "Operate" },
  { id: "aliases", label: "Routing", description: "Rules and fallbacks", group: "Operate" },
  { id: "tracing", label: "Activity", description: "Requests, performance and cost", group: "Operate" },
  { id: "api-keys", label: "API access", description: "Application keys and webhooks", group: "Build" },
  { id: "docs", label: "API workspace", description: "Quick start and full reference", group: "Build" },
  { id: "plugins", label: "Extensions", description: "Optional lifecycle modules", group: "Advanced" },
];

function tabFromSearch(search: string): Tab {
  const requestedTab = new URLSearchParams(search).get("tab");
  return TAB_ITEMS.some((item) => item.id === requestedTab)
    ? (requestedTab as Tab)
    : "overview";
}

const initialTab = tabFromSearch(window.location.search);

const USAGE_REFRESH_MIN_INTERVAL_MS = 50_000;
const USAGE_REFRESH_MAX_INTERVAL_MS = 60_000;

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
  if (tab === "plugins") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v4M16 3v4M5 7h14v4a7 7 0 0 1-14 0z"/><path d="M12 18v3"/></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5M8 12h8M8 16h8"/></svg>;
}
function GitHubIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8a9.4 9.4 0 0 0-3 18.3c.5.1.6-.2.6-.4v-1.8c-2.7.6-3.3-1.1-3.3-1.1-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 0 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.7-1.3-2.2-.2-4.5-1.1-4.5-4.7 0-1 .4-1.9 1-2.5-.1-.3-.4-1.3.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.7 0c1.8-1.2 2.6-1 2.6-1 .5 1.2.2 2.2.1 2.5.6.6 1 1.5 1 2.5 0 3.6-2.3 4.5-4.5 4.7.4.3.7.9.7 1.8v2.6c0 .3.2.6.7.4A9.4 9.4 0 0 0 12 2.8Z" /></svg>;
}

function activeModelBlockCount(account: Account) {
  return Object.values(account.state?.modelBlocks ?? {}).filter(
    (block) => block.until > Date.now(),
  ).length;
}

export default function App() {
  const [githubPromotion] = useState(() => readGitHubPromotionState(localStorage));
  const [tab, setTab] = useState<Tab>(initialTab);
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [localWorker, setLocalWorker] = useState<LocalWorkerProvider | null>(null);
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
  const [modules, setModules] = useState<ModuleView[]>([]);
  const [marketplaceModules, setMarketplaceModules] = useState<MarketplaceModule[]>([]);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginToken, setLoginToken] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialThemeMode);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [githubPromotionOpen, setGitHubPromotionOpen] = useState(!githubPromotion.dismissed && Date.now() >= githubPromotion.showAt);
  const [githubPromotionDismissed, setGitHubPromotionDismissed] = useState(githubPromotion.dismissed);
  const [usageCacheTtlMs, setUsageCacheTtlMs] = useState(300_000);
  const [oauthRedirectUri, setOauthRedirectUri] = useState("");
  const [error, setError] = useState("");
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [expandedTrace, setExpandedTrace] = useState<Trace | null>(null);
  const [expandedTraceLoading, setExpandedTraceLoading] = useState(false);
  const [traceRange, setTraceRange] = useState<TraceRangePreset>("7d");
  const [traceExportInProgress, setTraceExportInProgress] = useState(false);
  const tracePageRef = useRef(tracePagination.page);
  const traceRangeRef = useRef(traceRange);
  const mobileNavigationRef = useRef<HTMLDialogElement>(null);
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement>(null);
  const activeTabItem = TAB_ITEMS.find((item) => item.id === tab) ?? TAB_ITEMS[0];
  const sanitized = useMemo(() => {
    const params = new URLSearchParams(locationSearch);
    return params.get("sanitized") === "1" || params.get("safe") === "1";
  }, [locationSearch]);
  const docsLink = useMemo(() => {
    const params = new URLSearchParams(locationSearch);
    return {
      endpointId: params.get("endpoint") ?? undefined,
      model: params.get("model") ?? undefined,
    };
  }, [locationSearch]);

  useEffect(() => {
    localStorage.removeItem("adminToken");
  }, []);

  const closeGitHubPromotion = () => {
    dismissGitHubPromotion(localStorage);
    setGitHubPromotionOpen(false);
    setGitHubPromotionDismissed(true);
  };

  useEffect(() => {
    if (githubPromotionDismissed || githubPromotionOpen) return;
    const remaining = githubPromotion.showAt - Date.now();
    if (remaining <= 0) {
      setGitHubPromotionOpen(true);
      return;
    }
    const timeout = window.setTimeout(() => setGitHubPromotionOpen(true), remaining);
    return () => window.clearTimeout(timeout);
  }, [githubPromotion.showAt, githubPromotionDismissed, githubPromotionOpen]);

  useEffect(() => {
    if (!githubPromotionOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeGitHubPromotion();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [githubPromotionOpen]);

  useEffect(() => {
    const dialog = mobileNavigationRef.current;
    if (!dialog) return;
    if (mobileNavigationOpen && !dialog.open) {
      dialog.showModal();
    } else if (!mobileNavigationOpen && dialog.open) {
      dialog.close();
    }
  }, [mobileNavigationOpen]);

  useEffect(() => {
    const desktopNavigation = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavigationOpen(false);
    };
    desktopNavigation.addEventListener("change", closeOnDesktop);
    return () => desktopNavigation.removeEventListener("change", closeOnDesktop);
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
    const onPopstate = () => {
      const search = window.location.search;
      setLocationSearch(search);
      setTab(tabFromSearch(search));
    };
    window.addEventListener("popstate", onPopstate);
    return () => window.removeEventListener("popstate", onPopstate);
  }, []);

  const openModelInDocs = (modelId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "docs");
    url.searchParams.set("endpoint", "create-response");
    url.searchParams.set("model", modelId);
    window.history.pushState({}, "", url.toString());
    setLocationSearch(url.search);
    setTab("docs");
  };

  const loadBase = async () => {
    const [acc, localWorkerRes, cfg, mdl, aliasRes, settingsRes, apiKeysRes, policiesRes, modulesRes] = await Promise.all([
      api("/admin/accounts"),
      api("/admin/provider-agent/local-worker").catch(() => ({ localWorker: null })),
      api("/admin/config"),
      fetch("/v1/models").then((r) => r.json()),
      api("/admin/model-aliases"),
      api("/admin/settings"),
      api("/admin/proxy-api-keys"),
      api("/admin/application-policies"),
      api("/admin/modules"),
    ]);
    setAccounts((acc.accounts ?? []) as Account[]);
    setLocalWorker((localWorkerRes.localWorker ?? null) as LocalWorkerProvider | null);
    if (Number.isFinite(Number(cfg.usageCacheTtlMs)) && Number(cfg.usageCacheTtlMs) > 0) {
      setUsageCacheTtlMs(Number(cfg.usageCacheTtlMs));
    }
    setOauthRedirectUri(String(cfg.oauthRedirectUri ?? ""));
    setModels((mdl.data ?? []) as ExposedModel[]);
    setAliases((aliasRes.modelAliases ?? []) as ModelAlias[]);
    setSettings((settingsRes.settings ?? {}) as StoreSettings);
    setProxyApiKeys((apiKeysRes.proxyApiKeys ?? []) as ProxyApiKey[]);
    setApplicationPolicies((policiesRes.applicationPolicies ?? []) as ApplicationPolicy[]);
    setModules((modulesRes.modules ?? []) as ModuleView[]);
    setMarketplaceModules((modulesRes.marketplace ?? []) as MarketplaceModule[]);
  };

  const refreshModels = async () => {
    const mdl = await fetch("/v1/models").then((r) => r.json());
    setModels((mdl.data ?? []) as ExposedModel[]);
  };

  const refreshStaleUsage = async () => {
    const result = await api("/admin/usage/refresh-stale", { method: "POST" });
    setAccounts((result.accounts ?? []) as Account[]);
  };

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
    setLocalWorker(null);
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

  useEffect(() => {
    if (authenticated !== true) return;
    let timer: number | undefined;
    let cancelled = false;

    const scheduleRefresh = () => {
      const range =
        USAGE_REFRESH_MAX_INTERVAL_MS - USAGE_REFRESH_MIN_INTERVAL_MS;
      const delay =
        USAGE_REFRESH_MIN_INTERVAL_MS + Math.floor(Math.random() * (range + 1));
      timer = window.setTimeout(async () => {
        try {
          await refreshStaleUsage();
        } catch (error) {
          if (!cancelled) handleError(error);
        } finally {
          if (!cancelled) scheduleRefresh();
        }
      }, delay);
    };

    scheduleRefresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authenticated]);

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
    provider: "openai" | "opencode" | "xai" = "openai",
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
          <div className="auth-wordmark" aria-hidden="true" />
          <div>
            <h1 className="sr-only">MultiVibe</h1>
            <span className="eyebrow">Multi-provider routing</span>
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
          <div className="auth-wordmark" aria-hidden="true" />
          <div>
            <h1 className="sr-only">MultiVibe</h1>
            <span className="eyebrow">Admin workspace</span>
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
            <img className="brand-mark" src="/assets/brand/multivibe-app-icon.svg" alt="" />
            <div className="brand-copy">
              <strong>MultiVibe</strong>
              <span>Proxy control plane</span>
            </div>
          </div>

          <button
            ref={mobileNavigationTriggerRef}
            type="button"
            className="mobile-navigation-trigger"
            aria-haspopup="dialog"
            aria-expanded={mobileNavigationOpen}
            aria-controls="mobile-navigation-dialog"
            aria-label={`Open navigation. Current section: ${activeTabItem.label}`}
            onClick={() => setMobileNavigationOpen(true)}
          >
            <span className="mobile-navigation-current-icon"><TabIcon tab={tab} /></span>
            <span className="mobile-navigation-current-copy">
              <small>Workspace</small>
              <strong>{activeTabItem.label}</strong>
            </span>
            <span className="mobile-navigation-trigger-label">
              Menu
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            </span>
          </button>

          <nav className="sidebar-nav" aria-label="Primary navigation">
            {TAB_ITEMS.map((item, index) => (
              <React.Fragment key={item.id}>
              {(index === 0 || TAB_ITEMS[index - 1].group !== item.group) && <span className="sidebar-nav-label">{item.group}</span>}
              <button
                type="button"
                className={tab === item.id ? "nav-tab active" : "nav-tab"}
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? "page" : undefined}
                aria-label={`${item.label}: ${item.description}`}
              >
                <span className="nav-tab-icon"><TabIcon tab={item.id} /></span>
                <span className="nav-tab-copy">
                  <span className="nav-tab-label">{item.label}</span>
                  <span className="nav-tab-description">{item.description}</span>
                </span>
              </button>
              </React.Fragment>
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
            {githubPromotionDismissed && (
              <a className="github-repository-link" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">
                <GitHubIcon /><span>View on GitHub</span>
              </a>
            )}
          </div>
        </aside>

        <dialog
          ref={mobileNavigationRef}
          id="mobile-navigation-dialog"
          className="mobile-navigation-dialog"
          aria-labelledby="mobile-navigation-title"
          onCancel={(event) => {
            event.preventDefault();
            setMobileNavigationOpen(false);
          }}
          onClose={() => {
            setMobileNavigationOpen(false);
            const trigger = mobileNavigationTriggerRef.current;
            if (trigger?.getClientRects().length) trigger.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setMobileNavigationOpen(false);
            }
          }}
        >
          <div className="mobile-navigation-drawer">
            <header className="mobile-navigation-header">
              <div className="mobile-navigation-brand">
                <img className="brand-mark" src="/assets/brand/multivibe-app-icon.svg" alt="" />
                <div>
                  <small>MultiVibe</small>
                  <strong id="mobile-navigation-title">Navigate workspace</strong>
                </div>
              </div>
              <button
                type="button"
                className="mobile-navigation-close"
                aria-label="Close navigation"
                onClick={() => setMobileNavigationOpen(false)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </header>

            <nav className="mobile-navigation-list" aria-label="Mobile primary navigation">
              {TAB_ITEMS.map((item, index) => (
                <React.Fragment key={item.id}>
                {(index === 0 || TAB_ITEMS[index - 1].group !== item.group) && <span className="mobile-navigation-group">{item.group}</span>}
                <button
                  type="button"
                  className={tab === item.id ? "mobile-navigation-item active" : "mobile-navigation-item"}
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => {
                    setTab(item.id);
                    setMobileNavigationOpen(false);
                  }}
                >
                  <span className="mobile-navigation-item-icon"><TabIcon tab={item.id} /></span>
                  <span className="mobile-navigation-item-copy">
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  {tab === item.id && <span className="mobile-navigation-active-label">Current</span>}
                </button>
                </React.Fragment>
              ))}
            </nav>

            <footer className="mobile-navigation-footer">
              <div className="mobile-navigation-status">
                <span className="status-dot" />
                <span>
                  <strong>{sanitized ? "Sanitized view" : "System online"}</strong>
                  <small>{accounts.length} accounts · {models.length} models</small>
                </span>
              </div>
              <ThemeSwitcher value={themeMode} onChange={setThemeMode} />
              {githubPromotionDismissed && (
                <a className="github-repository-link" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">
                  <GitHubIcon /><span>View on GitHub</span>
                </a>
              )}
            </footer>
          </div>
        </dialog>

        {githubPromotionOpen && authenticated && (
          <div className="modal-backdrop github-promotion-backdrop" role="presentation" onClick={(event) => {
            if (event.target === event.currentTarget) closeGitHubPromotion();
          }}>
            <section className="modal panel github-promotion-modal" role="dialog" aria-modal="true" aria-labelledby="github-promotion-title">
              <button className="modal-close-button github-promotion-close" type="button" onClick={closeGitHubPromotion} aria-label="Close">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
              <div className="github-promotion-icon" aria-hidden="true">★</div>
              <span className="eyebrow">Enjoying MultiVibe?</span>
              <h2 id="github-promotion-title">Help the project grow</h2>
              <p>If MultiVibe is useful to you, a GitHub star helps more people discover it. Feedback and bug reports are just as valuable.</p>
              <div className="github-promotion-actions">
                <a className="btn" href={GITHUB_STARS_URL} target="_blank" rel="noreferrer" onClick={closeGitHubPromotion}>Star on GitHub</a>
                <a className="btn secondary" href={GITHUB_NEW_ISSUE_URL} target="_blank" rel="noreferrer">Submit an issue</a>
              </div>
              <button className="github-promotion-later" type="button" onClick={closeGitHubPromotion}>Maybe later</button>
            </section>
          </div>
        )}

        <div className="workspace">
          <header className="topbar">
            <div className="topbar-title">
              <h1>{activeTabItem.label}</h1>
              <p className="muted">{activeTabItem.description}</p>
            </div>
            <div className="topbar-actions">
              <span className="badge badge-live topbar-status">
                <span className="status-dot" />
                {sanitized ? "Sanitized" : "Live"}
              </span>
              {tab === "tracing" && (
                <div className="trace-range-controls topbar-trace-controls">
                  <label className="trace-range-field">
                    <span>Time range</span>
                    <select
                      value={traceRange}
                      onChange={(e) => {
                        setTraceRange(e.target.value as TraceRangePreset);
                      }}
                      aria-label="Trace time range"
                    >
                      <option value="24h">Last 24h</option>
                      <option value="7d">Last 7d</option>
                      <option value="30d">Last 30d</option>
                      <option value="all">All time</option>
                    </select>
                  </label>
                  <button className="btn secondary" onClick={() => void exportTracesZip()} disabled={traceExportInProgress}>
                    {traceExportInProgress ? "Exporting..." : "Export all (.zip)"}
                  </button>
                </div>
              )}
              <button className="btn ghost icon-button" onClick={() => void refreshData()} title="Refresh data" aria-label="Refresh data">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7h-5V2"/><path d="M20 7a9 9 0 1 0 2 7"/></svg>
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
            models={models}
            openModelInDocs={openModelInDocs}
            navigate={setTab}
          />
        )}

        {tab === "accounts" && (
          <AccountsTab
            traceStats={filteredTraceStats}
            accounts={accounts}
            localWorker={localWorker}
            usageCacheTtlMs={usageCacheTtlMs}
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
            onHarnessesChanged={loadBase}
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
            traces={traces}
            projectUsageStats={projectUsageStats}
            expandedTraceId={expandedTraceId}
            expandedTrace={expandedTrace}
            expandedTraceLoading={expandedTraceLoading}
            toggleExpandedTrace={toggleExpandedTrace}
            sanitized={sanitized}
            settings={settings}
            patchSettings={patchSettings}
          />
        )}

        {tab === "plugins" && (
          <PluginsTab modules={modules} marketplace={marketplaceModules} reload={loadBase} />
        )}

        {tab === "docs" && (
          <DocsTab
            models={models}
            initialEndpointId={docsLink.endpointId}
            initialModel={docsLink.model}
          />
        )}
          </main>
        </div>
      </div>
    </div>
  );
}
