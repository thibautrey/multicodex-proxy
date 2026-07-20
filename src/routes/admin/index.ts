import express from "express";
import { randomUUID } from "node:crypto";
import { AccountStore, OAuthStateStore } from "../../store.js";
import type {
  Account,
  CompatibilityMode,
  ModelAlias,
  UpstreamMode,
} from "../../types.js";
import { normalizeProvider, refreshUsageIfNeeded } from "../../quota.js";
import {
  accountFromOAuth,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForToken,
  mergeTokenIntoAccount,
  parseAuthorizationInput,
  pollDeviceCode,
  requestDeviceCode,
  type OAuthConfig,
} from "../../oauth.js";
import { ensureValidToken } from "../../account-utils.js";
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  MODELS_CLIENT_VERSION,
} from "../../config.js";
import type { TraceManager } from "../../traces.js";
import { discoverModels } from "../proxy/index.js";

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
  zaiBaseUrl: string;
  storagePaths: StoragePaths;
};

function normalizeBaseUrl(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

function normalizeUpstreamMode(value: unknown): UpstreamMode | undefined {
  if (value === "responses") return "responses";
  if (value === "chat/completions") return "chat/completions";
  return undefined;
}

function normalizeCompatibilityMode(
  value: unknown,
): CompatibilityMode | undefined {
  if (value === "auto") return "auto";
  if (value === "responses") return "responses";
  if (value === "chat-completions-bridge")
    return "chat-completions-bridge";
  return undefined;
}

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

function openAiAccountHeaders(account: Account): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${account.accessToken}`,
    accept: "application/json",
    "content-type": "application/json",
    originator: CODEX_CLI_ORIGINATOR,
    "User-Agent": CODEX_CLI_USER_AGENT,
    version: MODELS_CLIENT_VERSION,
  };
  if (account.chatgptAccountId) {
    headers["ChatGPT-Account-Id"] = account.chatgptAccountId;
  }
  return headers;
}

async function rateLimitResetCreditRequest(
  account: Account,
  openaiBaseUrl: string,
  consume: boolean,
): Promise<unknown> {
  const path = consume
    ? "/backend-api/api/codex/rate-limit-reset-credits/consume"
    : "/backend-api/api/codex/rate-limit-reset-credits";
  const response = await fetch(`${openaiBaseUrl.replace(/\/+$/, "")}${path}`, {
    method: consume ? "POST" : "GET",
    headers: openAiAccountHeaders(account),
    // The backend picks the next available credit when creditId is omitted.
    // It still requires an idempotency key so a retry cannot spend two credits.
    ...(consume ? { body: JSON.stringify({ idempotencyKey: randomUUID() }) } : {}),
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "message" in data
        ? String((data as { message?: unknown }).message ?? "")
        : text;
    throw new Error(
      `rate-limit reset credit request failed ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return data;
}

function sanitizeAliasId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

const EFFORT_TIERS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const EFFORT_TARGET_RE = /^(minimal|low|medium|high|xhigh):(.+)$/;
const MODEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9._-]+)*$/;

function validateAliasTargets(targets: string[]): string | null {
  for (const t of targets) {
    const m = t.match(EFFORT_TARGET_RE);
    if (m) {
      const model = m[2];
      if (!model || !MODEL_NAME_RE.test(model))
        return `Invalid model name after effort prefix in target "${t}"`;
    } else if (!MODEL_NAME_RE.test(t)) {
      return `Invalid target format: "${t}". Expected a model name or effort:model (e.g. xhigh:gpt-5.3-pro)`;
    }
  }
  return null;
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

function isHiddenTraceRoute(route: string | undefined): boolean {
  const normalized = String(route ?? "").trim();
  if (!normalized) return false;

  const routeWithoutMethod = normalized.replace(/^[A-Z]+\s+/, "");
  const [pathOnly] = routeWithoutMethod.split("?");

  return (
    pathOnly === "/" ||
    pathOnly === "/favicon.ico" ||
    pathOnly.startsWith("/admin/") ||
    pathOnly.startsWith("/assets/") ||
    pathOnly === "/v1/models" ||
    /^\/v1\/models\/[^/]+$/.test(pathOnly)
  );
}

function filterVisibleTraces<T extends { route?: string }>(traces: T[]): T[] {
  return traces.filter((trace) => !isHiddenTraceRoute(trace.route));
}

function isOpenAiEnabledAccount(account: Account | undefined): account is Account {
  return Boolean(account && (account.provider ?? "openai") === "openai" && account.enabled);
}

function normalizeModelLookupKey(model?: string): string {
  const raw = (model ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (!raw.includes("/")) return raw;
  const tail = raw.split("/").pop()?.trim();
  return tail || raw;
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
    zaiBaseUrl,
    storagePaths,
  } = options;

  const {
    readTraceWindow,
    readTraceById,
    readTraceListWindow,
    readTracesLegacy,
    readStatsHistory,
    readStatsHistoryRange,
    getTraceStats,
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

  router.get("/settings", async (_req, res) =>
    res.json({ ok: true, settings: await store.getSettings() }),
  );

  router.patch("/settings", async (req, res) => {
    const body = req.body ?? {};
    const patch: {
      defaultPassthroughAccountId?: string | undefined;
      imageRequestModelOverride?: string | undefined;
    } = {};

    if ("defaultPassthroughAccountId" in body) {
      const accountId = String(body.defaultPassthroughAccountId ?? "").trim();
      if (accountId) {
        const account = (await store.listAccounts()).find((a) => a.id === accountId);
        if (!isOpenAiEnabledAccount(account)) {
          return res.status(400).json({
            error: "defaultPassthroughAccountId must reference an enabled OpenAI account",
          });
        }
        patch.defaultPassthroughAccountId = accountId;
      } else {
        patch.defaultPassthroughAccountId = undefined;
      }
    }

    if ("imageRequestModelOverride" in body) {
      const model = String(body.imageRequestModelOverride ?? "").trim();
      if (model) {
        const discoveredModels = await discoverModels(
          store,
          openaiBaseUrl,
          mistralBaseUrl,
          zaiBaseUrl,
        );
        const aliases = await store.listModelAliases();
        const validModelKeys = new Set<string>([
          ...discoveredModels
            .map((entry: any) => normalizeModelLookupKey(entry?.id))
            .filter(Boolean),
          ...aliases
            .filter((alias) => alias.enabled)
            .map((alias) => normalizeModelLookupKey(alias.id))
            .filter(Boolean),
        ]);
        const modelKey = normalizeModelLookupKey(model);
        if (!validModelKeys.has(modelKey)) {
          return res.status(400).json({
            error: "imageRequestModelOverride must reference an exposed model or enabled alias",
          });
        }
        patch.imageRequestModelOverride = model;
      } else {
        patch.imageRequestModelOverride = undefined;
      }
    }

    const settings = await store.patchSettings(patch);
    res.json({ ok: true, settings });
  });

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

    const targetErr = validateAliasTargets(targets);
    if (targetErr) return res.status(400).json({ error: targetErr });

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
      const targetErr = validateAliasTargets(targets);
      if (targetErr) return res.status(400).json({ error: targetErr });
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
      return res.json({
        traces: filterVisibleTraces(await readTracesLegacy(limit)),
      });
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
    const traces = filterVisibleTraces(await readTraceListWindow());
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

  router.get("/traces/export.zip", async (req, res) => {
    const { sinceMs, untilMs } = parseTraceWindowBounds(
      req.query as Record<string, unknown>,
    );
    const traces = filterTracesByWindow(
      filterVisibleTraces(await readTraceWindow()),
      sinceMs,
      untilMs,
    ).sort((a, b) => a.at - b.at);

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

  router.get("/traces/:id", async (req, res) => {
    const trace = await readTraceById(req.params.id);
    if (!trace || isHiddenTraceRoute(trace.route)) {
      return res.status(404).json({ error: "not found" });
    }
    res.json({ trace });
  });

  router.get("/stats/usage", async (req, res) => {
    const accountIdFilter =
      typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
    const routeFilter =
      typeof req.query.route === "string" ? req.query.route.trim() : "";
    const sinceMs = parseQueryNumber(req.query.sinceMs);
    const untilMs = parseQueryNumber(req.query.untilMs);

    const traces = filterVisibleTraces(await readStatsHistoryRange(sinceMs, untilMs));
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
    const traces = filterTracesByWindow(
      filterVisibleTraces(await readStatsHistoryRange(sinceMs, untilMs)),
      sinceMs,
      untilMs,
    );
    const stats = buildTraceStats(traces);

    res.json({
      ok: true,
      filters: { sinceMs, untilMs },
      totalStored: traces.length,
      matched: traces.length,
      stats,
    });
  });

  router.post("/accounts", async (req, res) => {
    const body = req.body ?? {};
    if (!body.accessToken)
      return res.status(400).json({ error: "accessToken required" });
    const provider =
      body.provider === "mistral"
        ? "mistral"
        : body.provider === "zai"
          ? "zai"
          : body.provider === "openai-compatible"
            ? "openai-compatible"
            : "openai";
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const upstreamMode = normalizeUpstreamMode(body.upstreamMode);
    const compatibilityMode = normalizeCompatibilityMode(
      body.compatibilityMode,
    );
    if (provider === "openai-compatible" && !baseUrl) {
      return res.status(400).json({ error: "baseUrl required for openai-compatible accounts" });
    }
    const account: Account = {
      id: body.id ?? randomUUID(),
      provider,
      upstreamMode,
      compatibilityMode,
      email: body.email,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt,
      chatgptAccountId: body.chatgptAccountId,
      baseUrl,
      enabled: body.enabled ?? true,
      priority: body.priority ?? 0,
      usage: body.usage,
      state: body.state,
    };
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.patch("/accounts/:id", async (req, res) => {
    const body = { ...(req.body ?? {}) };
    if ("baseUrl" in body) {
      body.baseUrl = normalizeBaseUrl(body.baseUrl);
    }
    if ("upstreamMode" in body) {
      body.upstreamMode = normalizeUpstreamMode(body.upstreamMode);
    }
    if ("compatibilityMode" in body) {
      body.compatibilityMode = normalizeCompatibilityMode(
        body.compatibilityMode,
      );
    }
    const existing = (await store.listAccounts()).find((a) => a.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const next = { ...existing, ...body };
    if (normalizeProvider(next) === "openai-compatible" && !next.baseUrl) {
      return res.status(400).json({ error: "baseUrl required for openai-compatible accounts" });
    }
    const updated = await store.patchAccount(req.params.id, body);
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
    const targetModel = typeof req.query.model === "string" && req.query.model.trim()
      ? req.query.model.trim().toLowerCase()
      : undefined;
    if (targetModel) {
      const modelBlocks = { ...account.state?.modelBlocks };
      delete modelBlocks[targetModel];
      account.state = { ...account.state, modelBlocks };
    } else {
      account.state = { ...account.state, modelBlocks: {} };
    }
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.post("/accounts/:id/refresh-usage", async (req, res) => {
    let account = (await store.listAccounts()).find(
      (a) => a.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    account = await ensureValidToken(account, oauthConfig);
    const provider = normalizeProvider(account);
    let usageBaseUrl = openaiBaseUrl;
    if (provider === "openai-compatible") usageBaseUrl = account.baseUrl ?? "";
    else if (provider === "mistral") usageBaseUrl = mistralBaseUrl;
    else if (provider === "zai") usageBaseUrl = zaiBaseUrl;
    await refreshUsageIfNeeded(account, usageBaseUrl, true);
    await store.upsertAccount(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.get("/accounts/:id/rate-limit-reset-credit", async (req, res) => {
    let account = (await store.listAccounts()).find(
      (candidate) => candidate.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    if (normalizeProvider(account) !== "openai") {
      return res.status(400).json({ error: "only OpenAI accounts support reset credits" });
    }
    account = await ensureValidToken(account, oauthConfig);
    await store.upsertAccount(account);
    try {
      const credit = await rateLimitResetCreditRequest(account, openaiBaseUrl, false);
      res.json({ ok: true, credit });
    } catch (error: any) {
      res.status(502).json({ error: error?.message ?? String(error) });
    }
  });

  router.post("/accounts/:id/rate-limit-reset-credit/consume", async (req, res) => {
    let account = (await store.listAccounts()).find(
      (candidate) => candidate.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    if (normalizeProvider(account) !== "openai") {
      return res.status(400).json({ error: "only OpenAI accounts support reset credits" });
    }
    account = await ensureValidToken(account, oauthConfig);
    await store.upsertAccount(account);
    try {
      const result = await rateLimitResetCreditRequest(account, openaiBaseUrl, true);
      await refreshUsageIfNeeded(account, openaiBaseUrl, true);
      await store.upsertAccount(account);
      res.json({ ok: true, result, account: redact(account) });
    } catch (error: any) {
      res.status(502).json({ error: error?.message ?? String(error) });
    }
  });

  router.post("/usage/refresh", async (_req, res) => {
    const refreshed = await Promise.all(
      (await store.listAccounts()).map(async (account) => {
        const valid = await ensureValidToken(account, oauthConfig);
        const provider = normalizeProvider(valid);
        let usageBaseUrl = openaiBaseUrl;
        if (provider === "openai-compatible") usageBaseUrl = valid.baseUrl ?? "";
        else if (provider === "mistral") usageBaseUrl = mistralBaseUrl;
        else if (provider === "zai") usageBaseUrl = zaiBaseUrl;
        await refreshUsageIfNeeded(valid, usageBaseUrl, true);
        return valid;
      }),
    );
    await Promise.all(refreshed.map((account) => store.upsertAccount(account)));
    res.json({ ok: true, accounts: refreshed.map(redact) });
  });

  async function completeOpenAiOAuthFlow(
    flow: NonNullable<Awaited<ReturnType<OAuthStateStore["get"]>>>,
    code: string,
    codeVerifier: string,
    redirectUri?: string,
  ) {
    const tokenData = await exchangeCodeForToken(
      oauthConfig,
      code,
      codeVerifier,
      redirectUri,
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
    account = await refreshUsageIfNeeded(account, openaiBaseUrl, true);
    await store.upsertAccount(account);
    await oauthStore.update(flow.id, {
      status: "success",
      completedAt: Date.now(),
      accountId: account.id,
    });
    return account;
  }

  function deviceExpiresAt(device: { expires_at?: number | string; expires_in?: number | string }) {
    if (device.expires_at !== undefined) {
      const raw = device.expires_at;
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }
      const parsed = Date.parse(String(raw));
      if (Number.isFinite(parsed)) return parsed;
    }
    return Date.now() + (Number(device.expires_in ?? 900) || 900) * 1000;
  }

  router.post("/oauth/start", async (req, res) => {
    const email = String(req.body?.email ?? "").trim();
    const targetAccountId = String(req.body?.accountId ?? "").trim() || undefined;
    const method = req.body?.method === "device" ? "device" : "browser";
    if (!email) return res.status(400).json({ error: "email required" });
    if (targetAccountId) {
      const account = (await store.listAccounts()).find((a) => a.id === targetAccountId);
      if (!account) return res.status(404).json({ error: "account not found" });
      if ((account.provider ?? "openai") !== "openai") {
        return res.status(400).json({ error: "oauth reauth is only supported for OpenAI accounts" });
      }
    }
    const flow = createOAuthState(email, targetAccountId, method);
    if (method === "device") {
      try {
        const device = await requestDeviceCode(oauthConfig);
        const intervalSeconds = Number(device.interval ?? 5) || 5;
        const expiresAt = deviceExpiresAt(device);
        const verificationUrl =
          device.verification_url ??
          device.verification_uri ??
          oauthConfig.deviceVerificationUrl;
        await oauthStore.create({
          ...flow,
          deviceAuthId: device.device_auth_id,
          userCode: device.user_code,
          verificationUrl,
          intervalSeconds,
          expiresAt,
        });
        return res.json({
          ok: true,
          flowId: flow.id,
          method,
          userCode: device.user_code,
          verificationUrl,
          intervalSeconds,
          expiresAt,
        });
      } catch (err: any) {
        return res.status(500).json({
          error: `Device authorization failed: ${err?.message ?? String(err)}`,
        });
      }
    }

    await oauthStore.create(flow);
    const authorizeUrl = buildAuthorizationUrl(oauthConfig, flow);
    res.json({
      ok: true,
      flowId: flow.id,
      method,
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
      const account = await completeOpenAiOAuthFlow(flow, parsed.code, flow.codeVerifier);
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

  router.post("/oauth/device/poll", async (req, res) => {
    const flowId = String(req.body?.flowId ?? "").trim();
    if (!flowId) return res.status(400).json({ error: "flowId is required" });

    const flow = await oauthStore.get(flowId);
    if (!flow) return res.status(404).json({ error: "flow not found" });
    if (flow.method !== "device") {
      return res.status(400).json({ error: "flow is not a device authorization flow" });
    }
    if (flow.expiresAt && flow.expiresAt < Date.now()) {
      await oauthStore.update(flow.id, {
        status: "error",
        error: "device code expired",
        completedAt: Date.now(),
      });
      return res.status(410).json({ error: "device code expired" });
    }

    try {
      console.log("[oauth-device] polling OpenAI", {
        flowId: flow.id,
        userCode: flow.userCode,
      });
      const codeData = await pollDeviceCode(oauthConfig, flow);
      console.log("[oauth-device] OpenAI approved", { flowId: flow.id });
      if (!codeData.code_verifier) {
        throw new Error("device authorization response missing code_verifier");
      }
      const account = await completeOpenAiOAuthFlow(
        flow,
        codeData.authorization_code,
        codeData.code_verifier,
        oauthConfig.deviceRedirectUri,
      );
      return res.json({ ok: true, status: "success", account: redact(account) });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const pendingErrors = new Set([
        "authorization_pending",
        "deviceauth_authorization_pending",
        "deviceauth_authorization_unknown",
      ]);
      if (pendingErrors.has(message)) {
        console.log("[oauth-device] OpenAI pending", {
          flowId: flow.id,
          status: message,
        });
        return res.json({
          ok: true,
          status: "pending",
          intervalSeconds: flow.intervalSeconds ?? 5,
        });
      }
      await oauthStore.update(flow.id, {
        status: "error",
        error: message,
        completedAt: Date.now(),
      });
      console.error("[oauth-device] OpenAI poll failed", {
        flowId: flow.id,
        error: message,
      });
      return res.status(500).json({ error: `Device authorization failed: ${message}` });
    }
  });

  return router;
}
