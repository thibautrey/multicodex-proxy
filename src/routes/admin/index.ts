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
  StoreSettings,
} from "../../types.js";
import type { AnonymousUsageSharingController } from "../../anonymous-usage-sharing.js";
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
import { discoverAndPersistLocalRuntimes } from "../../local-runtime-discovery.js";
import {
  isValidProviderRuntimeEndpointInput,
  isValidProviderCapacityPolicy,
  isValidProviderCloudEnrollmentRequest,
  isValidProviderRelayShadowSessionRequest,
  isValidProviderSelectedModelId,
  ProviderAgentControlRequestError,
  type ProviderAgentControl,
} from "../../provider-agent-supervisor.js";
import type { ModuleManager } from "../../module-manager.js";
import {
  HostHarnessIntegrationError,
  type HostHarnessIntegrationManager,
} from "../../host-harness-integrations.js";
import {
  unavailableProviderWorkerEstimate,
  type ProviderWorkerEstimateClient,
} from "../../provider-worker-estimate.js";
import type { HostUpdateController, HostUpdateStatus } from "../../host-update-controller.js";

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
  anonymousUsageSharing?: AnonymousUsageSharingController;
  providerAgent?: ProviderAgentControl;
  hostApplication?: boolean;
  hostHarnessIntegrations?: HostHarnessIntegrationManager;
  providerWorkerEstimateClient?: ProviderWorkerEstimateClient;
  moduleManager?: ModuleManager;
  hostUpdateController?: HostUpdateController;
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
    moduleManager,
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

  router.get("/host-update", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    try {
      return res.json(await options.hostUpdateController.status());
    } catch (error: any) {
      return res.status(503).json({ error: error?.message ?? "Host updater failed" });
    }
  });

  router.post("/host-update/check", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    try {
      return res.json(await options.hostUpdateController.check());
    } catch (error: any) {
      return res.status(503).json({ error: error?.message ?? "Update check failed" });
    }
  });

  router.post("/host-update/download", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    try {
      return res.json(await options.hostUpdateController.download());
    } catch (error: any) {
      return res.status(503).json({ error: error?.message ?? "Update download failed" });
    }
  });

  router.patch("/host-update", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    const mode = String(req.body?.mode ?? "") as HostUpdateStatus["mode"];
    const channel = String(req.body?.channel ?? "") as HostUpdateStatus["channel"];
    if (!["automatic", "download", "notify"].includes(mode) || !["stable", "beta"].includes(channel)) {
      return res.status(400).json({ error: "Invalid Host update policy" });
    }
    try {
      return res.json(await options.hostUpdateController.configure(mode, channel));
    } catch (error: any) {
      return res.status(503).json({ error: error?.message ?? "Update policy failed" });
    }
  });

  router.post("/host-update/apply", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    try {
      return res.status(202).json(await options.hostUpdateController.apply());
    } catch (error: any) {
      return res.status(503).json({ error: error?.message ?? "Update installation could not be queued" });
    }
  });

  router.post("/host-update/drain", async (_req, res) => {
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    options.hostUpdateController.beginDrain();
    return res.json(await options.hostUpdateController.readiness());
  });

  router.post("/host-update/resume", (_req, res) => {
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    options.hostUpdateController.resume();
    return res.json({ resumed: true });
  });

  router.get("/host-update/readiness", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostUpdateController?.available()) {
      return res.status(404).json({ error: "Host updater is unavailable" });
    }
    try {
      return res.json(await options.hostUpdateController.readiness());
    } catch {
      return res.status(503).json({ error: "Host update readiness is unavailable" });
    }
  });

  router.get("/host-harnesses", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostHarnessIntegrations) {
      return res.json({ hostApplication: false, harnesses: [] });
    }
    try {
      const harnesses = (await options.hostHarnessIntegrations.list()).filter((entry) => entry.detected);
      return res.json({ hostApplication: true, harnesses });
    } catch (error: any) {
      const status = error instanceof HostHarnessIntegrationError ? error.status : 500;
      return res.status(status).json({ error: error?.message ?? "Harness detection failed" });
    }
  });

  router.post("/host-harnesses/:id/install", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostHarnessIntegrations) {
      return res.status(404).json({ error: "Harness integrations are available only in MultiVibe Host" });
    }
    const id = String(req.params.id ?? "");
    let createdId: string | undefined;
    try {
      const current = await options.hostHarnessIntegrations.get(id);
      if (current.configured || current.managed) return res.json({ harness: current });
      if (!current.canInstall) {
        return res.status(409).json({ error: current.unavailableReason ?? `${current.name} cannot be configured automatically` });
      }
      const application = `harness-${id}`;
      const existing = [...configuredProxyApiKeys, ...store.getCachedProxyApiKeys()]
        .find((entry) => entry.application === application);
      if (existing) {
        return res.status(409).json({ error: `An API key already exists for ${application}; revoke it before reconnecting this harness` });
      }
      createdId = randomUUID();
      const key = `mv_${randomBytes(32).toString("base64url")}`;
      await store.addProxyApiKey({ id: createdId, application, key, createdAt: Date.now() });
      const harness = await options.hostHarnessIntegrations.install(id, {
        apiKeyId: createdId,
        apiKey: key,
        application,
      });
      if (!harness.managed) {
        await store.deleteProxyApiKey(createdId);
        createdId = undefined;
      }
      return res.status(201).json({ harness });
    } catch (error: any) {
      if (createdId) await store.deleteProxyApiKey(createdId).catch(() => undefined);
      const status = error instanceof HostHarnessIntegrationError ? error.status : 500;
      return res.status(status).json({ error: error?.message ?? "Harness installation failed" });
    }
  });

  router.delete("/host-harnesses/:id/install", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.hostHarnessIntegrations) {
      return res.status(404).json({ error: "Harness integrations are available only in MultiVibe Host" });
    }
    try {
      const result = await options.hostHarnessIntegrations.uninstall(String(req.params.id ?? ""));
      if (result.apiKeyId) await store.deleteProxyApiKey(result.apiKeyId);
      return res.json({ harness: result.view });
    } catch (error: any) {
      const status = error instanceof HostHarnessIntegrationError ? error.status : 500;
      return res.status(status).json({ error: error?.message ?? "Harness removal failed" });
    }
  });

  router.get("/modules", (_req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    return res.json({ modules: moduleManager.list(), marketplace: moduleManager.marketplaceList() });
  });

  router.get("/provider-agent/local-worker", async (_req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!options.hostApplication || !options.providerAgent?.enabled) {
      return res.json({ localWorker: null });
    }
    try {
      const capability = await options.providerAgent.getCapability();
      const eligible = capability.supported &&
        ((capability.profile === "apple-silicon" && capability.accelerator === "metal") ||
         (capability.profile === "linux-nvidia" && capability.accelerator === "cuda"));
      if (!eligible) return res.json({ localWorker: null });

      const selectedGPU = capability.accelerator === "cuda"
        ? capability.gpus?.[capability.cuda_device ?? 0]
        : undefined;
      const [manifest, estimate] = await Promise.all([
        options.providerAgent.getManifest(),
        options.providerWorkerEstimateClient
          ? options.providerWorkerEstimateClient.estimate(capability).catch(() => unavailableProviderWorkerEstimate())
          : Promise.resolve(unavailableProviderWorkerEstimate()),
      ]);
      return res.json({
        localWorker: {
          id: "multivibe-worker-local",
          kind: "system-local-worker",
          name: "MultiVibe Worker",
          location: "local",
          configuration_state: manifest.state === "submitted" ? "submitted" : "unconfigured",
          agent_state: manifest.state,
          removable: false,
          routing_eligible: false,
          compensation_eligible: false,
          capability: {
            profile: capability.profile,
            accelerator: capability.accelerator,
            hardware: capability.hardware_model ?? selectedGPU?.name ?? capability.profile,
            accelerator_memory_bytes: capability.accelerator_memory_bytes ?? 0,
          },
          estimated_monthly_earnings: estimate,
          connect_url: "https://app.multivibe.cloud/earnings",
        },
      });
    } catch {
      return res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.post("/modules/submit", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      return res.status(201).json({ marketplaceModule: await moduleManager.submit(String(req.body?.url ?? "")) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/modules/install", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      return res.status(201).json({ module: await moduleManager.install(String(req.body?.url ?? "")) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/modules/:id/update", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      return res.json({ module: await moduleManager.update(req.params.id) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch("/modules/:id", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      let result;
      if ("enabled" in (req.body ?? {})) result = await moduleManager.setEnabled(req.params.id, Boolean(req.body.enabled));
      if ("settings" in (req.body ?? {})) result = await moduleManager.setSettings(req.params.id, req.body.settings);
      return res.json({ module: result ?? moduleManager.list().find((entry) => entry.id === req.params.id) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/modules/:id", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      await moduleManager.remove(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

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
      hostApplication: Boolean(options.hostApplication),
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

  router.post("/local-runtimes/discover", async (_req, res) => {
    try {
      const report = await discoverAndPersistLocalRuntimes(store);
      res.json({
        ok: true,
        results: report.results,
        accounts: report.accounts.map(redact),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.get("/provider-agent/selection", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.json(await options.providerAgent.getSelection());
    } catch {
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/manifest", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await options.providerAgent.getManifest());
    } catch {
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.post("/provider-agent/relay-shadow/session-open", async (req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    if (!isValidProviderRelayShadowSessionRequest(req.body)) {
      return res.status(400).json({ error: "invalid_provider_relay_shadow_session" });
    }
    try {
      const envelope = await options.providerAgent.openRelayShadowSession(req.body);
      res.setHeader("cache-control", "no-store");
      res.json(envelope);
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
        return res.status(400).json({ error: "invalid_provider_relay_shadow_session" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/cloud-shadow/enrollment", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await options.providerAgent.getCloudEnrollment());
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 404) {
        return res.status(404).json({ error: "provider_cloud_enrollment_not_found" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.post("/provider-agent/cloud-shadow/enroll", async (req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    if (!isValidProviderCloudEnrollmentRequest(req.body)) {
      return res.status(400).json({ error: "invalid_provider_cloud_enrollment" });
    }
    try {
      const enrollment = await options.providerAgent.enrollCloud(req.body);
      res.setHeader("cache-control", "no-store");
      res.status(201).json(enrollment);
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
        return res.status(400).json({ error: "invalid_provider_cloud_enrollment" });
      }
      if (error instanceof ProviderAgentControlRequestError && error.status === 409) {
        return res.status(409).json({ error: "provider_cloud_enrollment_conflict" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/adapters", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.json(await options.providerAgent.getAdapters());
    } catch {
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/runtime-endpoints", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await options.providerAgent.getRuntimeEndpoints());
    } catch {
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.put("/provider-agent/runtime-endpoints", async (req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    const revision = Number(req.body?.revision);
    const endpoints = req.body?.endpoints;
    if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(endpoints)
      || endpoints.length > 28 || endpoints.some((value) => !isValidProviderRuntimeEndpointInput(value))
      || new Set(endpoints.map((value) => value.adapter_id)).size !== endpoints.length) {
      return res.status(400).json({ error: "invalid_provider_runtime_endpoints" });
    }
    try {
      const result = await options.providerAgent.replaceRuntimeEndpoints(revision, endpoints);
      res.setHeader("cache-control", "no-store");
      res.status(result.conflict ? 409 : 200).json(result.endpoints);
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
        return res.status(400).json({ error: "invalid_provider_runtime_endpoints" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.put("/provider-agent/selection", async (req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    const revision = Number(req.body?.revision);
    const selectedModels = req.body?.selected_models;
    if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(selectedModels)
      || selectedModels.length > 100 || selectedModels.some((value) => !isValidProviderSelectedModelId(value))
      || new Set(selectedModels).size !== selectedModels.length) {
      return res.status(400).json({ error: "invalid_provider_selection" });
    }
    try {
      const result = await options.providerAgent.replaceSelection(revision, selectedModels);
      res.status(result.conflict ? 409 : 200).json(result.selection);
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
        return res.status(400).json({ error: "invalid_provider_selection" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/detected-models", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.json(await options.providerAgent.detectModels());
    } catch {
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/capacity-policy", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await options.providerAgent.getCapacityPolicy());
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 404) {
        return res.status(404).json({ error: "provider_capacity_policy_not_found" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.put("/provider-agent/capacity-policy", async (req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    if (!isValidProviderCapacityPolicy(req.body)) {
      return res.status(400).json({ error: "invalid_provider_capacity_policy" });
    }
    try {
      const result = await options.providerAgent.replaceCapacityPolicy(req.body);
      res.setHeader("cache-control", "no-store");
      res.status(result.conflict ? 409 : 200).json(result.policy);
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
        return res.status(400).json({ error: "invalid_provider_capacity_policy" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/cloud-shadow/demand-plan", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await options.providerAgent.getDemandPlan());
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 404) {
        return res.status(404).json({ error: "provider_demand_plan_not_found" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.post("/provider-agent/cloud-shadow/demand", async (req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "invalid_provider_demand" });
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(req.body);
    } catch {
      return res.status(400).json({ error: "invalid_provider_demand" });
    }
    if (Buffer.byteLength(encoded) > 64 * 1024) {
      return res.status(400).json({ error: "invalid_provider_demand" });
    }
    try {
      const result = await options.providerAgent.submitSignedDemand(req.body as Record<string, unknown>);
      res.setHeader("cache-control", "no-store");
      res.status(result.duplicate ? 200 : 201).json(result.plan);
    } catch (error) {
      if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
        return res.status(400).json({ error: "invalid_provider_demand" });
      }
      if (error instanceof ProviderAgentControlRequestError && error.status === 409) {
        return res.status(409).json({ error: "provider_demand_rejected" });
      }
      res.status(503).json({ error: "provider_agent_unavailable" });
    }
  });

  router.get("/provider-agent/managed-ollama/status", async (_req, res) => {
    if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
    try {
      res.setHeader("cache-control", "no-store");
      res.json(await options.providerAgent.getManagedOllamaStatus());
    } catch {
      res.status(503).json({ error: "provider_managed_ollama_unavailable" });
    }
  });

  for (const action of ["install", "start", "stop", "reconcile"] as const) {
    router.post(`/provider-agent/managed-ollama/${action}`, async (req, res) => {
      if (!options.providerAgent?.enabled) return res.status(503).json({ error: "provider_agent_unavailable" });
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "invalid_provider_managed_ollama_fence" });
      }
      const keys = Object.keys(body);
      const expectedKeys = action === "stop"
        ? []
        : action === "reconcile"
          ? ["envelope_digest", "plan_generation", "policy_revision"]
          : ["policy_revision"];
      if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !(key in body)) ||
        (action !== "stop" && (!Number.isSafeInteger(body.policy_revision) || body.policy_revision < 1)) ||
        (action === "reconcile" && (!Number.isSafeInteger(body.plan_generation) || body.plan_generation < 1 ||
          typeof body.envelope_digest !== "string" || !/^[a-f0-9]{64}$/u.test(body.envelope_digest)))) {
        return res.status(400).json({ error: "invalid_provider_managed_ollama_fence" });
      }
      try {
        const view = action === "install"
          ? await options.providerAgent.installManagedOllama(body.policy_revision)
          : action === "start"
            ? await options.providerAgent.startManagedOllama(body.policy_revision)
            : action === "stop"
              ? await options.providerAgent.stopManagedOllama()
              : await options.providerAgent.reconcileManagedOllama(body);
        res.setHeader("cache-control", "no-store");
        res.json(view);
      } catch (error) {
        if (error instanceof ProviderAgentControlRequestError && error.status === 409) {
          return res.status(409).json({ error: "provider_managed_ollama_operation_rejected" });
        }
        if (error instanceof ProviderAgentControlRequestError && error.status === 400) {
          return res.status(400).json({ error: "invalid_provider_managed_ollama_fence" });
        }
        res.status(503).json({ error: "provider_managed_ollama_unavailable" });
      }
    });
  }

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
      anonymousUsageSharingEnabled?: boolean;
    } = {};

    if ("anonymousUsageSharingEnabled" in body) {
      if (typeof body.anonymousUsageSharingEnabled !== "boolean") {
        return res.status(400).json({ error: "anonymousUsageSharingEnabled must be a boolean" });
      }
      patch.anonymousUsageSharingEnabled = body.anonymousUsageSharingEnabled;
    }

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

    const settings: StoreSettings = await store.patchSettings(patch);
    if ("anonymousUsageSharingEnabled" in patch && options.anonymousUsageSharing) {
      try {
        await options.anonymousUsageSharing.applySettings(settings);
      } catch {
        return res.status(500).json({
          error: "Anonymous usage sharing was disabled, but its unsent state could not be removed",
        });
      }
    }
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
    const usageTraces = filtered.filter(
      (trace) =>
        trace.traceKind === undefined || trace.traceKind === "upstream-attempt",
    );

    const globalAgg = createUsageAggregate();
    const byAccount = new Map<string, ReturnType<typeof createUsageAggregate>>();
    const byRoute = new Map<string, ReturnType<typeof createUsageAggregate>>();
    const byApplication = new Map<string, ReturnType<typeof createUsageAggregate>>();

    for (const trace of usageTraces) {
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
    const byProjectOut = aggregateProjectUsage(usageTraces);

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
      tracesMatched: usageTraces.length,
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
