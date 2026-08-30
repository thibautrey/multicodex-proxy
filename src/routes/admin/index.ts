import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { AccountStore, OAuthStateStore } from "../../store.js";
import type {
  Account,
  CompatibilityMode,
  CapacityProfile,
  ModelAlias,
  ApplicationWebhook,
  UpstreamMode,
} from "../../types.js";
import {
  isUsageRefreshNeeded,
  normalizeProvider,
  refreshUsageIfNeeded,
  USAGE_CACHE_TTL_MS,
} from "../../quota.js";
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
import { ensureValidToken, isTokenRefreshNeeded } from "../../account-utils.js";
import type { TraceManager } from "../../traces.js";
import { isHiddenTraceRoute } from "../../traces.js";
import { discoverModels } from "../proxy/index.js";
import {
  maybeConsumeScheduledWeeklyReset,
  rateLimitResetCreditRequest,
  WEEKLY_RESET_REMAINING_THRESHOLD_PERCENT,
} from "../../rate-limit-reset.js";
import {
  XAI_AUTH_PATH,
  XAI_BASE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_ISSUER,
  OPENCODE_BASE_URL,
} from "../../config.js";
import {
  accountFromXaiOAuth,
  loadXaiAuthFile,
  pollXaiDeviceCode,
  requestXaiDeviceCode,
} from "../../xai.js";
import {
  accountFromOpenCodeOAuth,
  pollOpenCodeDeviceCode,
  requestOpenCodeDeviceCode,
} from "../../opencode.js";
import type { CodexProjectRegistry } from "../../codex-projects.js";
import { aggregateProjectUsage } from "../../project-usage.js";
import { buildCodexHookInstallCommand } from "../../codex-hook-install.js";
import type { ProxyApiKey } from "../../proxy-api-keys.js";
import {
  evaluateAliasPolicy,
  inferAccountLocation,
  migrateModelAlias,
  parseRoutingHeaders,
  validateSmartAlias,
} from "../../smart-routing.js";
import type { SmartRoutingCoordinator } from "../../smart-routing-routes.js";

type StoragePaths = {
  accountsPath: string;
  oauthStatePath: string;
  tracePath: string;
  traceStatsHistoryPath: string;
  codexProjectsPath: string;
};

export type AdminRoutesOptions = {
  store: AccountStore;
  oauthStore: OAuthStateStore;
  traceManager: TraceManager;
  codexProjectRegistry: CodexProjectRegistry;
  oauthConfig: OAuthConfig;
  openaiBaseUrl: string;
  mistralBaseUrl: string;
  zaiBaseUrl: string;
  codexProjectRegistrationToken: string;
  configuredProxyApiKeys: ProxyApiKey[];
  storagePaths: StoragePaths;
  smartRouting?: SmartRoutingCoordinator;
};

function proxyApiKeyPreview(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}••••`;
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

function normalizeApplicationName(value: unknown): string | null {
  const application = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(application)) return null;
  return application;
}

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

function normalizeCapacityProfile(value: unknown): CapacityProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capacityProfile must be an object");
  }
  const raw = value as Record<string, unknown>;
  const positive = (key: string, integer = false) => {
    if (raw[key] === undefined || raw[key] === "") return undefined;
    const parsed = Number(raw[key]);
    if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
      throw new Error(`${key} must be a positive ${integer ? "integer" : "number"}`);
    }
    return parsed;
  };
  const endpoint = (key: string) => {
    if (!raw[key]) return undefined;
    const parsed = new URL(String(raw[key]));
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${key} must be an HTTP(S) URL without credentials`);
    }
    return parsed.toString();
  };
  return {
    maxConcurrent: positive("maxConcurrent", true),
    prefillTokensPerSecond: positive("prefillTokensPerSecond"),
    decodeTokensPerSecond: positive("decodeTokensPerSecond"),
    contextWindow: positive("contextWindow", true),
    healthUrl: endpoint("healthUrl"),
    metricsUrl: endpoint("metricsUrl"),
  };
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
    codexProjectRegistry,
    oauthConfig,
    openaiBaseUrl,
    mistralBaseUrl,
    zaiBaseUrl,
    codexProjectRegistrationToken,
    configuredProxyApiKeys,
    storagePaths,
    smartRouting,
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

  const usageBaseUrlForAccount = (account: Account): string => {
    const provider = normalizeProvider(account);
    if (provider === "openai-compatible") return account.baseUrl ?? "";
    if (provider === "opencode") return account.baseUrl ?? OPENCODE_BASE_URL;
    if (provider === "mistral") return mistralBaseUrl;
    if (provider === "zai") return zaiBaseUrl;
    if (provider === "xai") return account.baseUrl ?? XAI_BASE_URL;
    return openaiBaseUrl;
  };

  const refreshAccountsUsage = async (force: boolean): Promise<Account[]> => {
    const refreshed = await Promise.all(
      (await store.listAccounts()).map(async (account) => {
        const tokenRefreshNeeded = isTokenRefreshNeeded(account);
        const usageRefreshNeeded = force || isUsageRefreshNeeded(account);
        if (!tokenRefreshNeeded && !usageRefreshNeeded) {
          return { account, modified: false };
        }
        const valid = tokenRefreshNeeded
          ? await ensureValidToken(account, oauthConfig)
          : account;
        await refreshUsageIfNeeded(valid, usageBaseUrlForAccount(valid), force);
        return { account: valid, modified: true };
      }),
    );
    await Promise.all(
      refreshed
        .filter(({ modified }) => modified)
        .map(({ account }) => store.addOrUpdate(account)),
    );
    const accounts = refreshed.map(({ account }) => account);
    await Promise.all(
      accounts
        .filter((account) => normalizeProvider(account) === "openai")
        .map((account) =>
          maybeConsumeScheduledWeeklyReset(account.id, store, openaiBaseUrl),
        ),
    );
    return store.getCachedAccounts();
  };

  let staleUsageRefresh: Promise<Account[]> | undefined;
  const refreshStaleAccountsUsage = (): Promise<Account[]> => {
    if (staleUsageRefresh) return staleUsageRefresh;
    const refresh = refreshAccountsUsage(false);
    staleUsageRefresh = refresh;
    void refresh.finally(() => {
      if (staleUsageRefresh === refresh) staleUsageRefresh = undefined;
    }).catch(() => undefined);
    return refresh;
  };

  router.get("/proxy-api-keys", async (_req, res) => {
    const managed = await store.listProxyApiKeys();
    res.json({
      proxyApiKeys: [
        ...configuredProxyApiKeys.map((entry, index) => ({
          id: `configured:${index}`,
          application: entry.application,
          keyPreview: proxyApiKeyPreview(entry.key),
          source: "environment" as const,
        })),
        ...managed.map((entry) => ({
          id: entry.id,
          application: entry.application,
          keyPreview: proxyApiKeyPreview(entry.key),
          createdAt: entry.createdAt,
          source: "dashboard" as const,
        })),
      ],
    });
  });

  router.post("/proxy-api-keys", async (req, res) => {
    const application = normalizeApplicationName(req.body?.application);
    if (!application) {
      return res.status(400).json({
        error: "application must contain only letters, numbers, dots, underscores, or hyphens",
      });
    }
    const existing = [
      ...configuredProxyApiKeys,
      ...store.getCachedProxyApiKeys(),
    ];
    if (existing.some((entry) => entry.application === application)) {
      return res.status(409).json({ error: "An API key already exists for this application" });
    }
    const entry = {
      id: randomUUID(),
      application,
      key: `mv_${randomBytes(32).toString("base64url")}`,
      createdAt: Date.now(),
    };
    await store.addProxyApiKey(entry);
    res.status(201).json({
      proxyApiKey: {
        id: entry.id,
        application: entry.application,
        key: entry.key,
        keyPreview: proxyApiKeyPreview(entry.key),
        createdAt: entry.createdAt,
        source: "dashboard",
      },
    });
  });

  router.delete("/proxy-api-keys/:id", async (req, res) => {
    const deleted = await store.deleteProxyApiKey(String(req.params.id));
    if (!deleted) return res.status(404).json({ error: "API key not found" });
    res.json({ ok: true });
  });

  router.get("/application-policies", (_req, res) => {
    res.json({
      applicationPolicies: store.getCachedApplicationPolicies().map((policy) => ({
        ...policy,
        webhooks: policy.webhooks.map(({ secret: _secret, ...webhook }) => webhook),
      })),
    });
  });

  router.patch("/application-policies/:application", async (req, res) => {
    const application = normalizeApplicationName(req.params.application);
    if (!application) return res.status(400).json({ error: "invalid application" });
    const current = store.getApplicationPolicy(application);
    const fairnessWeight = Number(req.body?.fairnessWeight ?? current.fairnessWeight);
    if (!Number.isFinite(fairnessWeight) || fairnessWeight < 0.1 || fairnessWeight > 100) {
      return res.status(400).json({ error: "fairnessWeight must be between 0.1 and 100" });
    }
    const policy = await store.upsertApplicationPolicy({
      ...current,
      fairnessWeight,
    });
    res.json({
      ok: true,
      applicationPolicy: {
        ...policy,
        webhooks: policy.webhooks.map(({ secret: _secret, ...webhook }) => webhook),
      },
    });
  });

  router.post("/application-policies/:application/webhooks", async (req, res) => {
    const application = normalizeApplicationName(req.params.application);
    if (!application) return res.status(400).json({ error: "invalid application" });
    let url: URL;
    try {
      url = new URL(String(req.body?.url ?? ""));
      if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
        throw new Error("invalid webhook URL");
      }
    } catch {
      return res.status(400).json({ error: "webhook URL must be an absolute HTTP(S) URL without credentials" });
    }
    const policy = store.getApplicationPolicy(application);
    const webhook: ApplicationWebhook = {
      id: randomUUID(),
      url: url.toString(),
      secret: randomBytes(32).toString("base64url"),
      enabled: true,
      createdAt: Date.now(),
    };
    policy.webhooks.push(webhook);
    await store.upsertApplicationPolicy(policy);
    res.status(201).json({ webhook });
  });

  router.delete("/application-policies/:application/webhooks/:id", async (req, res) => {
    const application = normalizeApplicationName(req.params.application);
    if (!application) return res.status(400).json({ error: "invalid application" });
    const policy = store.getApplicationPolicy(application);
    const before = policy.webhooks.length;
    policy.webhooks = policy.webhooks.filter((webhook) => webhook.id !== req.params.id);
    if (policy.webhooks.length === before) return res.status(404).json({ error: "not found" });
    await store.upsertApplicationPolicy(policy);
    res.status(204).end();
  });

  router.get("/config", (_req, res) => {
    res.json({
      ok: true,
      oauthRedirectUri: oauthConfig.redirectUri,
      xaiAuthPath: XAI_AUTH_PATH,
      usageCacheTtlMs: USAGE_CACHE_TTL_MS,
      storage: {
        accountsPath: storagePaths.accountsPath,
        oauthStatePath: storagePaths.oauthStatePath,
        tracePath: storagePaths.tracePath,
        traceStatsHistoryPath: storagePaths.traceStatsHistoryPath,
        codexProjectsPath: storagePaths.codexProjectsPath,
        persistenceLikelyEnabled:
          storagePaths.accountsPath.startsWith("/data/") ||
          storagePaths.accountsPath.startsWith("/data"),
        accountStore: store.getPersistenceStatus(),
        traces: traceManager.getPersistenceStatus(),
        codexProjects: codexProjectRegistry.getPersistenceStatus(),
      },
    });
  });

  router.get("/codex-projects", (_req, res) => {
    res.json({ ok: true, projects: codexProjectRegistry.listProjects() });
  });

  router.get("/codex-sessions", (_req, res) => {
    res.json({ ok: true, sessions: codexProjectRegistry.listSessions() });
  });

  router.post("/codex-hook-install-command", (req, res) => {
    try {
      const command = buildCodexHookInstallCommand(
        req.body?.baseUrl,
        codexProjectRegistrationToken,
      );
      res.json({ ok: true, command });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = message.includes("registration is disabled") ? 503 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get("/accounts", async (_req, res) =>
    res.json({ accounts: (await store.listAccounts()).map(redact) }),
  );

  router.post("/grok/import", async (_req, res) => {
    try {
      const credentials = await loadXaiAuthFile();
      const existingAccounts = await store.listAccounts();
      const imported: Account[] = [];
      for (const credential of credentials) {
        const existing = existingAccounts.find(
          (account) =>
            normalizeProvider(account) === "xai" &&
            account.xaiAuthScope === credential.scope &&
            (!credential.userId || account.xaiUserId === credential.userId),
        );
        const account: Account = {
          ...existing,
          id: existing?.id ?? randomUUID(),
          provider: "xai",
          upstreamMode: existing?.upstreamMode ?? "responses",
          email: credential.email ?? existing?.email,
          accessToken: credential.accessToken,
          refreshToken: credential.refreshToken ?? existing?.refreshToken,
          expiresAt: credential.expiresAt ?? existing?.expiresAt,
          xaiUserId: credential.userId ?? existing?.xaiUserId,
          xaiAuthScope: credential.scope,
          oidcIssuer: credential.oidcIssuer,
          oidcClientId: credential.oidcClientId,
          enabled: existing?.enabled ?? true,
          priority: existing?.priority ?? 0,
          state: {
            ...existing?.state,
            needsTokenRefresh: false,
            authBlockedUntil: undefined,
            lastError: undefined,
          },
        };
        await store.upsertAccount(account);
        imported.push(account);
      }
      await store.flushIfDirty();
      return res.json({
        ok: true,
        imported: imported.length,
        accounts: imported.map(redact),
      });
    } catch (err: any) {
      return res.status(400).json({
        error: `Grok auth import failed: ${err?.message ?? String(err)}`,
      });
    }
  });

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

  router.post("/model-aliases/simulate", (req, res) => {
    if (!smartRouting) return res.status(503).json({ error: "smart routing is unavailable" });
    const alias = migrateModelAlias(req.body?.alias ?? req.body);
    const errors = validateSmartAlias(alias);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const input = req.body?.request ?? {};
    const routing = parseRoutingHeaders(
      {
        "x-multivibe-priority": input.priority ?? "standard",
        "x-multivibe-execution": input.executionMode ?? "sync",
      },
      input.application ?? "simulation",
      typeof input.now === "number" ? input.now : Date.now(),
    );
    routing.effort = input.effort;
    routing.modalities = Array.isArray(input.modalities) ? input.modalities : ["text"];
    routing.requiresTools = Boolean(input.requiresTools);
    routing.estimatedInputTokens = Math.max(0, Number(input.inputTokens) || 0);
    const decision = evaluateAliasPolicy(
      alias,
      routing,
      smartRouting.resources(alias.id, alias),
      Math.max(1, Number(input.outputTokens) || 8_192),
    );
    res.json({
      rule: decision.rule?.id,
      onNoCapacity: decision.onNoCapacity,
      decision: decision.eligible[0]
        ? {
            model: decision.eligible[0].config.model,
            accountId: decision.eligible[0].resource.accountId,
            location: decision.eligible[0].resource.location,
            score: decision.eligible[0].score,
          }
        : undefined,
      candidates: decision.candidates,
    });
  });

  router.post("/model-aliases", async (req, res) => {
    const body = req.body ?? {};
    const id = sanitizeAliasId(body.id);
    if (!id) return res.status(400).json({ error: "id required" });

    if (typeof body.targets !== "undefined") {
      const targets = normalizeAliasTargets(body.targets);
      if (!targets.length)
        return res.status(400).json({ error: "at least one target is required" });
      const targetErr = validateAliasTargets(targets);
      if (targetErr) return res.status(400).json({ error: targetErr });
      body.targets = targets;
    }
    const alias = migrateModelAlias({ ...body, id });
    const errors = validateSmartAlias(alias);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    await store.upsertModelAlias(alias);
    res.json({ ok: true, modelAlias: alias });
  });

  router.patch("/model-aliases/:id", async (req, res) => {
    const body = req.body ?? {};
    const current = (await store.listModelAliases()).find(
      (alias) => alias.id === req.params.id,
    );
    if (!current) return res.status(404).json({ error: "not found" });
    const patch: Partial<ModelAlias> = {};

    if (typeof body.enabled !== "undefined") patch.enabled = Boolean(body.enabled);
    if (typeof body.description !== "undefined") patch.description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : undefined;
    if (typeof body.defaults !== "undefined") patch.defaults = body.defaults;
    if (typeof body.rules !== "undefined") patch.rules = body.rules;
    if (typeof body.targets !== "undefined") {
      const targets = normalizeAliasTargets(body.targets);
      if (!targets.length) {
        return res
          .status(400)
          .json({ error: "at least one target is required" });
      }
      const targetErr = validateAliasTargets(targets);
      if (targetErr) return res.status(400).json({ error: targetErr });
      patch.rules = migrateModelAlias({ ...current, schemaVersion: 1, targets }).rules;
    }
    const candidate = migrateModelAlias({ ...current, ...patch, id: current.id });
    const errors = validateSmartAlias(candidate);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const updated = await store.patchModelAlias(req.params.id, patch);
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
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
    const traces = filterVisibleTraces(await readTraceListWindow());
    const filtered = filterTracesByWindow(traces, sinceMs, untilMs).filter(
      (trace) => !projectId || trace.projectId === projectId,
    );
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
      filters: { sinceMs, untilMs, projectId: projectId || undefined },
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
    const applicationFilter =
      typeof req.query.application === "string"
        ? req.query.application.trim()
        : "";
    const projectIdFilter =
      typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
    const sinceMs = parseQueryNumber(req.query.sinceMs);
    const untilMs = parseQueryNumber(req.query.untilMs);

    const traces = filterVisibleTraces(await readStatsHistoryRange(sinceMs, untilMs));
    const filtered = traces.filter((t) => {
      if (accountIdFilter && t.accountId !== accountIdFilter) return false;
      if (routeFilter && t.route !== routeFilter) return false;
      if (applicationFilter && t.application !== applicationFilter) return false;
      if (projectIdFilter && t.projectId !== projectIdFilter) return false;
      return true;
    });

    const globalAgg = createUsageAggregate();
    const byAccount = new Map<string, ReturnType<typeof createUsageAggregate>>();
    const byRoute = new Map<string, ReturnType<typeof createUsageAggregate>>();
    const byApplication = new Map<string, ReturnType<typeof createUsageAggregate>>();

    for (const trace of filtered) {
      addTraceToAggregate(globalAgg, trace);

      const accountKey = trace.accountId ?? "unknown";
      if (!byAccount.has(accountKey))
        byAccount.set(accountKey, createUsageAggregate());
      addTraceToAggregate(byAccount.get(accountKey)!, trace);

      const routeKey = trace.route ?? "unknown";
      if (!byRoute.has(routeKey)) byRoute.set(routeKey, createUsageAggregate());
      addTraceToAggregate(byRoute.get(routeKey)!, trace);

      const applicationKey = trace.application ?? "unattributed";
      if (!byApplication.has(applicationKey))
        byApplication.set(applicationKey, createUsageAggregate());
      addTraceToAggregate(byApplication.get(applicationKey)!, trace);

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
    const byApplicationOut = Array.from(byApplication.entries())
      .map(([application, agg]) => ({ application, ...finalizeAggregate(agg) }))
      .sort((a, b) => b.requests - a.requests);
    const byProjectOut = aggregateProjectUsage(filtered);

    res.json({
      ok: true,
      filters: {
        accountId: accountIdFilter || undefined,
        route: routeFilter || undefined,
        application: applicationFilter || undefined,
        projectId: projectIdFilter || undefined,
        sinceMs,
        untilMs,
      },
      totals: finalizeAggregate(globalAgg),
      byAccount: byAccountOut,
      byRoute: byRouteOut,
      byApplication: byApplicationOut,
      byProject: byProjectOut,
      tracesEvaluated: traces.length,
      tracesMatched: filtered.length,
    });
  });

  router.get("/stats/traces", async (req, res) => {
    const sinceMs = parseQueryNumber(req.query.sinceMs);
    const untilMs = parseQueryNumber(req.query.untilMs);
    const { totalStored, matched, stats } = await getTraceStats(
      sinceMs,
      untilMs,
    );

    res.json({
      ok: true,
      filters: { sinceMs, untilMs },
      totalStored,
      matched,
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
          : body.provider === "xai"
            ? "xai"
          : body.provider === "opencode"
            ? "opencode"
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
    let capacityProfile: CapacityProfile | undefined;
    try {
      capacityProfile = normalizeCapacityProfile(body.capacityProfile);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message ?? String(error) });
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
      xaiUserId: body.xaiUserId,
      xaiAuthScope:
        provider === "xai"
          ? body.xaiAuthScope ??
            `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`
          : undefined,
      oidcIssuer:
        provider === "xai"
          ? body.oidcIssuer ?? XAI_OAUTH_ISSUER
          : body.oidcIssuer,
      oidcClientId:
        provider === "xai"
          ? body.oidcClientId ?? XAI_OAUTH_CLIENT_ID
          : body.oidcClientId,
      baseUrl: provider === "opencode" ? baseUrl ?? OPENCODE_BASE_URL : baseUrl,
      location:
        body.location === "local" || body.location === "cloud"
          ? body.location
          : inferAccountLocation({ provider, baseUrl }),
      capacityProfile,
      enabled: body.enabled ?? true,
      priority: body.priority ?? 0,
      usage: body.usage,
      state: body.state,
    };
    if (provider === "opencode") {
      await refreshUsageIfNeeded(account, account.baseUrl!, true);
    }
    await store.addOrUpdate(account);
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
    if ("location" in body && body.location !== "local" && body.location !== "cloud") {
      return res.status(400).json({ error: "location must be local or cloud" });
    }
    if ("capacityProfile" in body) {
      try {
        body.capacityProfile = normalizeCapacityProfile(body.capacityProfile);
      } catch (error: any) {
        return res.status(400).json({ error: error?.message ?? String(error) });
      }
    }
    const existing = (await store.listAccounts()).find((a) => a.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const next = { ...existing, ...body };
    if (normalizeProvider(next) === "openai-compatible" && !next.baseUrl) {
      return res.status(400).json({ error: "baseUrl required for openai-compatible accounts" });
    }
    const updated = await store.patchAccount(req.params.id, body);
    if (!updated) return res.status(404).json({ error: "not found" });
    await store.flushIfDirty();
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
    await store.addOrUpdate(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.post("/accounts/:id/refresh-usage", async (req, res) => {
    let account = (await store.listAccounts()).find(
      (a) => a.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    account = await ensureValidToken(account, oauthConfig);
    await refreshUsageIfNeeded(account, usageBaseUrlForAccount(account), true);
    await store.addOrUpdate(account);
    await maybeConsumeScheduledWeeklyReset(account.id, store, openaiBaseUrl);
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
    await store.addOrUpdate(account);
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
    await store.addOrUpdate(account);
    try {
      const result = await rateLimitResetCreditRequest(account, openaiBaseUrl, true);
      await refreshUsageIfNeeded(account, openaiBaseUrl, true);
      await store.addOrUpdate(account);
      res.json({ ok: true, result, account: redact(account) });
    } catch (error: any) {
      res.status(502).json({ error: error?.message ?? String(error) });
    }
  });

  router.post("/accounts/:id/rate-limit-reset-credit/schedule", async (req, res) => {
    let account = (await store.listAccounts()).find(
      (candidate) => candidate.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    if (normalizeProvider(account) !== "openai") {
      return res.status(400).json({ error: "only OpenAI accounts support reset credits" });
    }
    if (account.state?.scheduledWeeklyReset) {
      return res.status(409).json({ error: "an automatic weekly reset is already scheduled" });
    }

    // Scheduling is a local, persisted operation. Do not refresh usage,
    // refresh authentication, check credit availability, or contact the reset
    // endpoint until the monitor observes the configured quota threshold.
    account.state = {
      ...account.state,
      scheduledWeeklyReset: {
        scheduledAt: Date.now(),
        idempotencyKey: randomUUID(),
        thresholdRemainingPercent:
          WEEKLY_RESET_REMAINING_THRESHOLD_PERCENT,
      },
    };
    await store.addOrUpdate(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.delete("/accounts/:id/rate-limit-reset-credit/schedule", async (req, res) => {
    const account = (await store.listAccounts()).find(
      (candidate) => candidate.id === req.params.id,
    );
    if (!account) return res.status(404).json({ error: "not found" });
    const { scheduledWeeklyReset: _cancelled, ...remainingState } =
      account.state ?? {};
    account.state = remainingState;
    await store.addOrUpdate(account);
    res.json({ ok: true, account: redact(account) });
  });

  router.post("/usage/refresh", async (_req, res) => {
    const accounts = await refreshAccountsUsage(true);
    res.json({
      ok: true,
      accounts: accounts.map(redact),
    });
  });

  // The dashboard uses this endpoint for lightweight polling. Fresh usage
  // snapshots are left untouched; snapshots whose cache TTL or quota reset
  // has elapsed are refreshed before the current account state is returned.
  router.post("/usage/refresh-stale", async (_req, res) => {
    const accounts = await refreshStaleAccountsUsage();
    res.json({
      ok: true,
      accounts: accounts.map(redact),
    });
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
    const accounts = await store.listAccounts();
    if (flow.targetAccountId) {
      const existing = accounts.find((a) => a.id === flow.targetAccountId);
      if (!existing) {
        throw new Error("target account not found for reauth");
      }
      account = mergeTokenIntoAccount(existing, tokenData);
    } else {
      const created = accountFromOAuth(flow, tokenData);
      const duplicate = created.chatgptAccountId
        ? accounts.find((candidate) =>
            candidate.chatgptAccountId === created.chatgptAccountId,
          )
        : undefined;
      account = duplicate
        ? mergeTokenIntoAccount(duplicate, tokenData)
        : created;
    }
    account = await refreshUsageIfNeeded(account, openaiBaseUrl, true);
    await store.addOrUpdate(account);
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
    const provider =
      req.body?.provider === "xai"
        ? "xai"
        : req.body?.provider === "opencode"
          ? "opencode"
          : "openai";
    const method =
      provider === "xai" || provider === "opencode" || req.body?.method === "device"
        ? "device"
        : "browser";
    if (provider === "openai" && !email) {
      return res.status(400).json({ error: "email required" });
    }
    if (targetAccountId) {
      const account = (await store.listAccounts()).find((a) => a.id === targetAccountId);
      if (!account) return res.status(404).json({ error: "account not found" });
      if (normalizeProvider(account) !== provider) {
        return res.status(400).json({
          error: `oauth reauth target must be a ${provider} account`,
        });
      }
    }
    const flow = createOAuthState(email, targetAccountId, method, provider);
    if (method === "device") {
      try {
        if (provider === "xai") {
          const device = await requestXaiDeviceCode();
          await oauthStore.create({
            ...flow,
            deviceAuthId: device.deviceCode,
            userCode: device.userCode,
            verificationUrl:
              device.verificationUrlComplete ?? device.verificationUrl,
            intervalSeconds: device.intervalSeconds,
            expiresAt: device.expiresAt,
          });
          return res.json({
            ok: true,
            flowId: flow.id,
            provider,
            method,
            userCode: device.userCode,
            verificationUrl:
              device.verificationUrlComplete ?? device.verificationUrl,
            intervalSeconds: device.intervalSeconds,
            expiresAt: device.expiresAt,
          });
        }
        if (provider === "opencode") {
          const device = await requestOpenCodeDeviceCode();
          await oauthStore.create({
            ...flow,
            deviceAuthId: device.deviceCode,
            userCode: device.userCode,
            verificationUrl: device.verificationUrl,
            intervalSeconds: device.intervalSeconds,
            expiresAt: device.expiresAt,
          });
          return res.json({
            ok: true,
            flowId: flow.id,
            provider,
            method,
            userCode: device.userCode,
            verificationUrl: device.verificationUrl,
            intervalSeconds: device.intervalSeconds,
            expiresAt: device.expiresAt,
          });
        }
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
    res.json({
      ok: true,
      flow: {
        ...flow,
        codeVerifier: undefined,
        deviceAuthId: undefined,
      },
    });
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
    if (flow.provider === "xai" || flow.provider === "opencode") {
      return res.status(400).json({
        error: `${flow.provider === "xai" ? "Grok Build" : "OpenCode"} OAuth uses the device-code completion endpoint`,
      });
    }

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
      if (flow.provider === "opencode") {
        if (!flow.deviceAuthId) {
          throw new Error("OpenCode device authorization is missing its device code");
        }
        const result = await pollOpenCodeDeviceCode(
          flow.deviceAuthId,
          flow.intervalSeconds,
        );
        if (result.status === "pending") {
          await oauthStore.update(flow.id, {
            intervalSeconds: result.intervalSeconds,
          });
          return res.json({
            ok: true,
            status: "pending",
            intervalSeconds: result.intervalSeconds,
          });
        }
        const accounts = await store.listAccounts();
        const existing = flow.targetAccountId
          ? accounts.find((account) => account.id === flow.targetAccountId)
          : undefined;
        if (flow.targetAccountId && !existing) {
          throw new Error("target OpenCode account not found for reauth");
        }
        let account = await accountFromOpenCodeOAuth(flow, result.token, existing);
        if (!existing && account.opencodeAccountId) {
          const duplicate = accounts.find(
            (candidate) =>
              normalizeProvider(candidate) === "opencode" &&
              candidate.opencodeAccountId === account.opencodeAccountId &&
              candidate.opencodeOrgId === account.opencodeOrgId,
          );
          if (duplicate) {
            account = await accountFromOpenCodeOAuth(flow, result.token, duplicate);
          }
        }
        account = await refreshUsageIfNeeded(
          account,
          account.baseUrl ?? OPENCODE_BASE_URL,
          true,
        );
        await store.addOrUpdate(account);
        await oauthStore.update(flow.id, {
          status: "success",
          completedAt: Date.now(),
          accountId: account.id,
        });
        return res.json({
          ok: true,
          status: "success",
          account: redact(account),
        });
      }
      if (flow.provider === "xai") {
        if (!flow.deviceAuthId) {
          throw new Error("xAI device authorization is missing its device code");
        }
        const result = await pollXaiDeviceCode(
          flow.deviceAuthId,
          flow.intervalSeconds,
        );
        if (result.status === "pending") {
          await oauthStore.update(flow.id, {
            intervalSeconds: result.intervalSeconds,
          });
          return res.json({
            ok: true,
            status: "pending",
            intervalSeconds: result.intervalSeconds,
          });
        }
        const existing = flow.targetAccountId
          ? (await store.listAccounts()).find(
              (account) => account.id === flow.targetAccountId,
            )
          : undefined;
        if (flow.targetAccountId && !existing) {
          throw new Error("target xAI account not found for reauth");
        }
        const account = accountFromXaiOAuth(flow, result.token, existing);
        await refreshUsageIfNeeded(
          account,
          account.baseUrl ?? XAI_BASE_URL,
          true,
        );
        await store.addOrUpdate(account);
        await oauthStore.update(flow.id, {
          status: "success",
          completedAt: Date.now(),
          accountId: account.id,
        });
        return res.json({
          ok: true,
          status: "success",
          account: redact(account),
        });
      }
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
