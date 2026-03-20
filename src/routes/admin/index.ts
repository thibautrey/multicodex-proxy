import express from "express";
import { randomUUID } from "node:crypto";
import { AccountStore, OAuthStateStore } from "../../store.js";
import type { Account, ModelAlias } from "../../types.js";
import {
  clearAuthFailureState,
  normalizeProvider,
  refreshUsageIfNeeded,
} from "../../quota.js";
import {
  accountFromOAuth,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForToken,
  mergeTokenIntoAccount,
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
  openaiBaseUrl: string;
  mistralBaseUrl: string;
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

function sanitizeAliasId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ACCOUNT_MUTABLE_KEYS = new Set([
  "id",
  "provider",
  "email",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "chatgptAccountId",
  "enabled",
  "priority",
]);

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: Set<string>,
): string | undefined {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (!unknown.length) return undefined;
  return `unknown fields: ${unknown.join(", ")}`;
}

function parseAccountPatch(
  body: Record<string, unknown>,
  allowId: boolean,
): { patch?: Partial<Account>; error?: string } {
  const error = rejectUnknownKeys(body, ACCOUNT_MUTABLE_KEYS);
  if (error) return { error };

  const patch: Partial<Account> = {};
  if (allowId && typeof body.id !== "undefined") {
    if (typeof body.id !== "string" || !body.id.trim()) {
      return { error: "id must be a non-empty string" };
    }
    patch.id = body.id.trim();
  }
  if (typeof body.provider !== "undefined") {
    if (body.provider !== "openai" && body.provider !== "mistral") {
      return { error: "provider must be openai or mistral" };
    }
    patch.provider = body.provider;
  }
  if (typeof body.email !== "undefined") {
    if (typeof body.email !== "string") return { error: "email must be a string" };
    patch.email = body.email.trim() || undefined;
  }
  if (typeof body.accessToken !== "undefined") {
    if (typeof body.accessToken !== "string" || !body.accessToken.trim()) {
      return { error: "accessToken must be a non-empty string" };
    }
    patch.accessToken = body.accessToken.trim();
  }
  if (typeof body.refreshToken !== "undefined") {
    if (body.refreshToken !== null && typeof body.refreshToken !== "string") {
      return { error: "refreshToken must be a string" };
    }
    patch.refreshToken =
      typeof body.refreshToken === "string" && body.refreshToken.trim()
        ? body.refreshToken.trim()
        : undefined;
  }
  if (typeof body.expiresAt !== "undefined") {
    if (
      body.expiresAt !== null &&
      (!Number.isFinite(Number(body.expiresAt)) || Number(body.expiresAt) < 0)
    ) {
      return { error: "expiresAt must be a positive number" };
    }
    patch.expiresAt =
      body.expiresAt === null ? undefined : Number(body.expiresAt);
  }
  if (typeof body.chatgptAccountId !== "undefined") {
    if (
      body.chatgptAccountId !== null &&
      typeof body.chatgptAccountId !== "string"
    ) {
      return { error: "chatgptAccountId must be a string" };
    }
    patch.chatgptAccountId =
      typeof body.chatgptAccountId === "string" &&
      body.chatgptAccountId.trim()
        ? body.chatgptAccountId.trim()
        : undefined;
  }
  if (typeof body.enabled !== "undefined") {
    if (typeof body.enabled !== "boolean") return { error: "enabled must be a boolean" };
    patch.enabled = body.enabled;
  }
  if (typeof body.priority !== "undefined") {
    if (!Number.isFinite(Number(body.priority))) {
      return { error: "priority must be a finite number" };
    }
    patch.priority = Number(body.priority);
  }
  return { patch };
}

function normalizeAliasTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter((x) => x.length > 0),
    ),
  );
}

function parseTraceWindowBounds(query: Record<string, unknown>) {
  return {
    sinceMs: parseQueryNumber(query.sinceMs),
    untilMs: parseQueryNumber(query.untilMs),
  };
}

function filterTracesByWindow<T extends { at: number }>(
  traces: T[],
  sinceMs?: number,
  untilMs?: number,
): T[] {
  return traces.filter((t) => {
    if (typeof sinceMs === "number" && Number.isFinite(sinceMs) && t.at < sinceMs) return false;
    if (typeof untilMs === "number" && Number.isFinite(untilMs) && t.at > untilMs) return false;
    return true;
  });
}

function formatZipDosTime(date: Date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  return {
    dosTime: (hours << 11) | (minutes << 5) | seconds,
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBuffer(files: Array<{ name: string; data: Buffer }>): Buffer {
  const now = formatZipDosTime(new Date());
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = file.data;
    const crc = crc32(data);
    const compressedSize = data.length;
    const uncompressedSize = data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(now.dosTime, 10);
    localHeader.writeUInt16LE(now.dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(now.dosTime, 12);
    centralHeader.writeUInt16LE(now.dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function createAdminRouter(options: AdminRoutesOptions) {
  const {
    store,
    oauthStore,
    traceManager,
    oauthConfig,
    openaiBaseUrl,
    mistralBaseUrl,
    storagePaths,
  } = options;

  const {
    readTraceWindow,
    readTraceById,
    readTraceListWindow,
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

  router.get("/model-aliases", async (_req, res) =>
    res.json({ modelAliases: await store.listModelAliases() }),
  );

  router.post("/model-aliases", async (req, res) => {
    const body = req.body ?? {};
    const id = sanitizeAliasId(body.id);
    if (!id) return res.status(400).json({ error: "id required" });

    const targets = normalizeAliasTargets(body.targets);
    if (!targets.length)
      return res.status(400).json({ error: "at least one target is required" });

    const alias: ModelAlias = {
      id,
      targets,
      enabled: body.enabled ?? true,
      description:
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : undefined,
    };
    await store.upsertModelAlias(alias);
    res.json({ ok: true, modelAlias: alias });
  });

  router.patch("/model-aliases/:id", async (req, res) => {
    const body = req.body ?? {};
    const patch: Partial<ModelAlias> = {};

    if (typeof body.enabled !== "undefined") patch.enabled = Boolean(body.enabled);
    if (typeof body.description !== "undefined") {
      patch.description =
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : undefined;
    }
    if (typeof body.targets !== "undefined") {
      const targets = normalizeAliasTargets(body.targets);
      if (!targets.length) {
        return res
          .status(400)
          .json({ error: "at least one target is required" });
      }
      patch.targets = targets;
    }

    const updated = await store.patchModelAlias(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, modelAlias: updated });
  });

  router.delete("/model-aliases/:id", async (req, res) => {
    const ok = await store.deleteModelAlias(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

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
    const { sinceMs, untilMs } = parseTraceWindowBounds(
      req.query as Record<string, unknown>,
    );
    const traces = await readTraceListWindow();
    const filtered = filterTracesByWindow(traces, sinceMs, untilMs);
    const sorted = [...filtered].sort((a, b) => b.at - a.at);
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

  router.get("/traces/:id", async (req, res) => {
    const trace = await readTraceById(req.params.id);
    if (!trace) return res.status(404).json({ error: "not found" });
    res.json({ trace });
  });

  router.get("/traces/export.zip", async (req, res) => {
    const { sinceMs, untilMs } = parseTraceWindowBounds(
      req.query as Record<string, unknown>,
    );
    const traces = filterTracesByWindow(await readTraceWindow(), sinceMs, untilMs).sort(
      (a, b) => a.at - b.at,
    );

    const exportedAt = Date.now();
    const files: Array<{ name: string; data: Buffer }> = [
      {
        name: "metadata.json",
        data: Buffer.from(
          JSON.stringify(
            {
              exportedAt,
              count: traces.length,
              filters: { sinceMs, untilMs },
            },
            null,
            2,
          ),
          "utf8",
        ),
      },
      {
        name: "traces.jsonl",
        data: Buffer.from(
          traces.map((t) => JSON.stringify(t)).join("\n") + (traces.length ? "\n" : ""),
          "utf8",
        ),
      },
    ];

    const zip = createZipBuffer(files);
    const stamp = new Date(exportedAt).toISOString().replace(/[:.]/g, "-");
    res.setHeader("content-type", "application/zip");
    res.setHeader(
      "content-disposition",
      `attachment; filename="traces-export-${stamp}.zip"`,
    );
    res.setHeader("content-length", String(zip.length));
    res.send(zip);
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
    const bySession = new Map<string, ReturnType<typeof createUsageAggregate>>();

    for (const trace of filtered) {
      addTraceToAggregate(globalAgg, trace);

      const accountKey = trace.accountId ?? "unknown";
      if (!byAccount.has(accountKey))
        byAccount.set(accountKey, createUsageAggregate());
      addTraceToAggregate(byAccount.get(accountKey)!, trace);

      const routeKey = trace.route ?? "unknown";
      if (!byRoute.has(routeKey)) byRoute.set(routeKey, createUsageAggregate());
      addTraceToAggregate(byRoute.get(routeKey)!, trace);

      const sessionKey =
        typeof trace.sessionId === "string" && trace.sessionId.trim()
          ? trace.sessionId.trim()
          : "";
      if (sessionKey) {
        if (!bySession.has(sessionKey))
          bySession.set(sessionKey, createUsageAggregate());
        addTraceToAggregate(bySession.get(sessionKey)!, trace);
      }
    }

    const accounts = await store.listAccounts();
    const accountMeta = new Map(
      accounts.map((a) => [
        a.id,
        {
          id: a.id,
          provider: a.provider ?? "openai",
          email: a.email,
          enabled: a.enabled,
        },
      ]),
    );

    const byAccountOut = Array.from(byAccount.entries())
      .map(([accountId, agg]) => ({
        accountId,
        account: accountMeta.get(accountId) ?? {
          id: accountId,
          provider: undefined,
          email: undefined,
          enabled: undefined,
        },
        ...finalizeAggregate(agg),
      }))
      .sort((a, b) => b.requests - a.requests);

    const byRouteOut = Array.from(byRoute.entries())
      .map(([route, agg]) => ({ route, ...finalizeAggregate(agg) }))
      .sort((a, b) => b.requests - a.requests);

    const bySessionOut = Array.from(bySession.entries())
      .map(([sessionId, agg]) => ({ sessionId, ...finalizeAggregate(agg) }))
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
      bySession: bySessionOut,
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseAccountPatch(body, true);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!parsed.patch?.accessToken) {
      return res.status(400).json({ error: "accessToken required" });
    }
    const account: Account = {
      id: parsed.patch.id ?? randomUUID(),
      provider: parsed.patch.provider ?? "openai",
      email: parsed.patch.email,
      accessToken: parsed.patch.accessToken,
      refreshToken: parsed.patch.refreshToken,
      expiresAt: parsed.patch.expiresAt,
      chatgptAccountId: parsed.patch.chatgptAccountId,
      enabled: parsed.patch.enabled ?? true,
      priority: parsed.patch.priority ?? 0,
      usage: undefined,
      state: {},
    };
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.patch("/accounts/:id", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseAccountPatch(body, false);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const updated = await store.patchAccount(req.params.id, parsed.patch ?? {});
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
    const usageBaseUrl =
      normalizeProvider(account) === "mistral" ? mistralBaseUrl : openaiBaseUrl;
    await refreshUsageIfNeeded(account, usageBaseUrl, true);
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.post("/usage/refresh", async (_req, res) => {
    const refreshed = await Promise.all(
      (await store.listAccounts()).map(async (account) => {
        const valid = await ensureValidToken(account, oauthConfig);
        const usageBaseUrl =
          normalizeProvider(valid) === "mistral"
            ? mistralBaseUrl
            : openaiBaseUrl;
        await refreshUsageIfNeeded(valid, usageBaseUrl, true);
        return valid;
      }),
    );
    await Promise.all(refreshed.map((account) => store.upsertAccount(account)));
    res.json({ ok: true, accounts: refreshed.map(redact) });
  });

  router.post("/oauth/start", async (req, res) => {
    const email = String(req.body?.email ?? "").trim();
    const targetAccountId = String(req.body?.accountId ?? "").trim() || undefined;
    if (!email) return res.status(400).json({ error: "email required" });
    if (targetAccountId) {
      const account = (await store.listAccounts()).find((a) => a.id === targetAccountId);
      if (!account) return res.status(404).json({ error: "account not found" });
      if ((account.provider ?? "openai") !== "openai") {
        return res.status(400).json({ error: "oauth reauth is only supported for OpenAI accounts" });
      }
    }
    const flow = createOAuthState(email, targetAccountId);
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
      let account: Account;
      if (flow.targetAccountId) {
        const existing = (await store.listAccounts()).find((a) => a.id === flow.targetAccountId);
        if (!existing) {
          throw new Error("target account not found for reauth");
        }
        account = mergeTokenIntoAccount(existing, tokenData);
      } else {
        account = accountFromOAuth(flow, tokenData);
      }
      clearAuthFailureState(account);
      account = await refreshUsageIfNeeded(account, openaiBaseUrl, true);
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
