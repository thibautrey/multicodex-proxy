import express from "express";
import { randomUUID } from "node:crypto";
import { AccountStore, OAuthStateStore } from "../../store.js";
import type { Account } from "../../types.js";
import { refreshUsageIfNeeded } from "../../quota.js";
import {
  accountFromOAuth,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForToken,
  parseAuthorizationInput,
  type OAuthConfig,
} from "../../oauth.js";
import { ensureValidToken } from "../../account-utils.js";
import type { TraceManager } from "../../traces.js";

type StoragePaths = {
  accountsPath: string;
  oauthStatePath: string;
  tracePath: string;
  traceStatsHistoryPath: string;
};

export type AdminRoutesOptions = {
  store: AccountStore;
  oauthStore: OAuthStateStore;
  traceManager: TraceManager;
  oauthConfig: OAuthConfig;
  chatgptBaseUrl: string;
  storagePaths: StoragePaths;
};

function parseQueryNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function redact(account: Account) {
  return {
    ...account,
    accessToken: account.accessToken ? `${account.accessToken.slice(0, 8)}...` : "",
    refreshToken: account.refreshToken
      ? `${account.refreshToken.slice(0, 8)}...`
      : undefined,
  };
}

export function createAdminRouter(options: AdminRoutesOptions) {
  const {
    store,
    oauthStore,
    traceManager,
    oauthConfig,
    chatgptBaseUrl,
    storagePaths,
  } = options;

  const {
    readTraceWindow,
    readTracesLegacy,
    readStatsHistory,
    readStatsHistoryRange,
    buildTraceStats,
    createUsageAggregate,
    addTraceToAggregate,
    finalizeAggregate,
    pageSizeMax,
  } = traceManager;

  const router = express.Router();

  router.get("/config", (_req, res) => {
    res.json({
      ok: true,
      oauthRedirectUri: oauthConfig.redirectUri,
      storage: {
        accountsPath: storagePaths.accountsPath,
        oauthStatePath: storagePaths.oauthStatePath,
        tracePath: storagePaths.tracePath,
        traceStatsHistoryPath: storagePaths.traceStatsHistoryPath,
        persistenceLikelyEnabled:
          storagePaths.accountsPath.startsWith("/data/") ||
          storagePaths.accountsPath.startsWith("/data"),
      },
    });
  });

  router.get("/accounts", async (_req, res) =>
    res.json({ accounts: (await store.listAccounts()).map(redact) }),
  );

  router.get("/traces", async (req, res) => {
    const hasPaginationQuery =
      typeof req.query.page !== "undefined" ||
      typeof req.query.pageSize !== "undefined";
    const hasLegacyLimit = typeof req.query.limit !== "undefined";

    if (hasLegacyLimit && !hasPaginationQuery) {
      const limit = Number(req.query.limit ?? 100);
      return res.json({ traces: await readTracesLegacy(limit) });
    }

    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.max(
      1,
      Math.min(
        pageSizeMax,
        Number(req.query.pageSize ?? pageSizeMax) || pageSizeMax,
      ),
    );
    const traces = await readTraceWindow();
    const sorted = [...traces].sort((a, b) => b.at - a.at);
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const paged = start >= total ? [] : sorted.slice(start, start + pageSize);
    const stats = buildTraceStats(sorted);

    return res.json({
      traces: paged,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
      stats,
    });
  });

  router.get("/stats/usage", async (req, res) => {
    const accountIdFilter =
      typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
    const routeFilter =
      typeof req.query.route === "string" ? req.query.route.trim() : "";
    const sinceMs = parseQueryNumber(req.query.sinceMs);
    const untilMs = parseQueryNumber(req.query.untilMs);

    const traces = await readStatsHistoryRange(sinceMs, untilMs);
    const filtered = traces.filter((t) => {
      if (accountIdFilter && t.accountId !== accountIdFilter) return false;
      if (routeFilter && t.route !== routeFilter) return false;
      return true;
    });

    const globalAgg = createUsageAggregate();
    const byAccount = new Map<string, ReturnType<typeof createUsageAggregate>>();
    const byRoute = new Map<string, ReturnType<typeof createUsageAggregate>>();

    for (const trace of filtered) {
      addTraceToAggregate(globalAgg, trace);

      const accountKey = trace.accountId ?? "unknown";
      if (!byAccount.has(accountKey))
        byAccount.set(accountKey, createUsageAggregate());
      addTraceToAggregate(byAccount.get(accountKey)!, trace);

      const routeKey = trace.route ?? "unknown";
      if (!byRoute.has(routeKey)) byRoute.set(routeKey, createUsageAggregate());
      addTraceToAggregate(byRoute.get(routeKey)!, trace);
    }

    const accounts = await store.listAccounts();
    const accountMeta = new Map(
      accounts.map((a) => [
        a.id,
        { id: a.id, email: a.email, enabled: a.enabled },
      ]),
    );

    const byAccountOut = Array.from(byAccount.entries())
      .map(([accountId, agg]) => ({
        accountId,
        account: accountMeta.get(accountId) ?? {
          id: accountId,
          email: undefined,
          enabled: undefined,
        },
        ...finalizeAggregate(agg),
      }))
      .sort((a, b) => b.requests - a.requests);

    const byRouteOut = Array.from(byRoute.entries())
      .map(([route, agg]) => ({ route, ...finalizeAggregate(agg) }))
      .sort((a, b) => b.requests - a.requests);

    res.json({
      ok: true,
      filters: {
        accountId: accountIdFilter || undefined,
        route: routeFilter || undefined,
        sinceMs,
        untilMs,
      },
      totals: finalizeAggregate(globalAgg),
      byAccount: byAccountOut,
      byRoute: byRouteOut,
      tracesEvaluated: traces.length,
      tracesMatched: filtered.length,
    });
  });

  router.get("/stats/traces", async (req, res) => {
    const sinceMs = parseQueryNumber(req.query.sinceMs);
    const untilMs = parseQueryNumber(req.query.untilMs);
    const traces = await readStatsHistoryRange(sinceMs, untilMs);
    const sorted = [...traces].sort((a, b) => b.at - a.at);
    const stats = buildTraceStats(sorted);
    const totalStored = (await readStatsHistory()).length;

    res.json({
      ok: true,
      filters: { sinceMs, untilMs },
      totalStored,
      matched: sorted.length,
      stats,
    });
  });

  router.post("/accounts", async (req, res) => {
    const body = req.body ?? {};
    if (!body.accessToken)
      return res.status(400).json({ error: "accessToken required" });
    const account: Account = {
      id: body.id ?? randomUUID(),
      email: body.email,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt,
      chatgptAccountId: body.chatgptAccountId,
      enabled: body.enabled ?? true,
      priority: body.priority ?? 0,
      usage: body.usage,
      state: body.state,
    };
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.patch("/accounts/:id", async (req, res) => {
    const updated = await store.patchAccount(req.params.id, req.body ?? {});
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, account: redact(updated) });
  });

  router.delete("/accounts/:id", async (req, res) => {
    const ok = await store.deleteAccount(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  router.post("/accounts/:id/unblock", async (req, res) => {
    const account = (await store.listAccounts()).find(
      (a) => a.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    account.state = {
      ...account.state,
      blockedUntil: undefined,
      blockedReason: undefined,
    };
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.post("/accounts/:id/refresh-usage", async (req, res) => {
    let account = (await store.listAccounts()).find(
      (a) => a.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    account = await ensureValidToken(account, oauthConfig);
    await refreshUsageIfNeeded(account, chatgptBaseUrl, true);
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.post("/usage/refresh", async (_req, res) => {
    const refreshed = await Promise.all(
      (await store.listAccounts()).map(async (account) => {
        const valid = await ensureValidToken(account, oauthConfig);
        await refreshUsageIfNeeded(valid, chatgptBaseUrl, true);
        return valid;
      }),
    );
    await Promise.all(refreshed.map((account) => store.upsertAccount(account)));
    res.json({ ok: true, accounts: refreshed.map(redact) });
  });

  router.post("/oauth/start", async (req, res) => {
    const email = String(req.body?.email ?? "").trim();
    if (!email) return res.status(400).json({ error: "email required" });
    const flow = createOAuthState(email);
    await oauthStore.create(flow);
    const authorizeUrl = buildAuthorizationUrl(oauthConfig, flow);
    res.json({
      ok: true,
      flowId: flow.id,
      authorizeUrl,
      expectedRedirectUri: oauthConfig.redirectUri,
    });
  });

  router.get("/oauth/status/:flowId", async (req, res) => {
    const flow = await oauthStore.get(req.params.flowId);
    if (!flow) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, flow: { ...flow, codeVerifier: undefined } });
  });

  router.post("/oauth/complete", async (req, res) => {
    const flowId = String(req.body?.flowId ?? "").trim();
    const input = String(req.body?.input ?? "").trim();
    if (!flowId || !input)
      return res
        .status(400)
        .json({ error: "flowId and input are required" });

    const flow = await oauthStore.get(flowId);
    if (!flow) return res.status(404).json({ error: "flow not found" });

    const parsed = parseAuthorizationInput(input);
    if (!parsed.code)
      return res.status(400).json({ error: "missing code in pasted input" });
    if (parsed.state && parsed.state !== flow.id)
      return res.status(400).json({ error: "state mismatch" });

    try {
      const tokenData = await exchangeCodeForToken(
        oauthConfig,
        parsed.code,
        flow.codeVerifier,
      );
      let account = accountFromOAuth(flow, tokenData);
      account = await refreshUsageIfNeeded(account, chatgptBaseUrl, true);
      await store.upsertAccount(account);
      await oauthStore.update(flow.id, {
        status: "success",
        completedAt: Date.now(),
        accountId: account.id,
      });
      return res.json({ ok: true, account: redact(account) });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      await oauthStore.update(flow.id, {
        status: "error",
        error: message,
        completedAt: Date.now(),
      });
      return res
        .status(500)
        .json({ error: `OAuth exchange failed: ${message}` });
    }
  });

  return router;
}
