import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnonymousModelOutputTotal } from "./traces.js";
import type { StoreSettings } from "./types.js";

const DAY_MS = 86_400_000;
const MAX_ALLOWLIST_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 32 * 1024;
const MAX_MODELS = 50;
const OUTPUT_TOKEN_THOUSANDS_CAP = 1_000_000;

export type AnonymousUsageEnvelope = {
  schemaVersion: 1;
  eventId: string;
  periodStart: string;
  periodEnd: string;
  models: Array<{
    modelId: string;
    outputTokenThousands: number;
  }>;
};

type AnonymousUsageState = {
  schemaVersion: 1;
  pending?: AnonymousUsageEnvelope;
  lastCompletedPeriodEnd?: string;
};

export type AnonymousUsageRunOutcome = "sent" | "empty" | "skipped" | "disabled" | "failed";

export type AnonymousUsageSharingController = {
  applySettings(settings: StoreSettings): Promise<void>;
};

export type AnonymousUsageSharingWorkerOptions = {
  settingsStore: { getSettings(): Promise<StoreSettings> };
  traceSource: {
    aggregateAnonymousOutputTokens(
      sinceMs: number,
      untilMs: number,
      modelAllowlist: Readonly<Record<string, string>>,
    ): Promise<AnonymousModelOutputTotal[]>;
  };
  statePath: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  clock?: () => Date;
  random?: () => number;
  requestTimeoutMs?: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validateEnvelope(value: unknown): AnonymousUsageEnvelope {
  if (!isObject(value) || value.schemaVersion !== 1 || !isUuidV4(value.eventId) ||
      !isUtcDay(value.periodStart) || !isUtcDay(value.periodEnd) ||
      new Date(value.periodEnd).getTime() - new Date(value.periodStart).getTime() !== DAY_MS ||
      !Array.isArray(value.models) || value.models.length < 1 || value.models.length > MAX_MODELS ||
      Object.keys(value).some((key) => !["schemaVersion", "eventId", "periodStart", "periodEnd", "models"].includes(key))) {
    throw new Error("anonymous usage state contains an invalid pending envelope");
  }
  const seen = new Set<string>();
  const models = value.models.map((item) => {
    if (!isObject(item) || Object.keys(item).some((key) => !["modelId", "outputTokenThousands"].includes(key)) ||
        typeof item.modelId !== "string" || !item.modelId || item.modelId.length > 512 || seen.has(item.modelId) ||
        !Number.isSafeInteger(item.outputTokenThousands) || (item.outputTokenThousands as number) < 1 ||
        (item.outputTokenThousands as number) > OUTPUT_TOKEN_THOUSANDS_CAP) {
      throw new Error("anonymous usage state contains an invalid model contribution");
    }
    seen.add(item.modelId);
    return { modelId: item.modelId, outputTokenThousands: item.outputTokenThousands as number };
  });
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    models,
  };
}

function validateState(value: unknown): AnonymousUsageState {
  if (!isObject(value) || value.schemaVersion !== 1 ||
      Object.keys(value).some((key) => !["schemaVersion", "pending", "lastCompletedPeriodEnd"].includes(key))) {
    throw new Error("anonymous usage state is invalid");
  }
  const lastCompletedPeriodEnd = value.lastCompletedPeriodEnd;
  if (lastCompletedPeriodEnd !== undefined && !isUtcDay(lastCompletedPeriodEnd)) {
    throw new Error("anonymous usage state has an invalid completed window");
  }
  return {
    schemaVersion: 1,
    ...(value.pending === undefined ? {} : { pending: validateEnvelope(value.pending) }),
    ...(lastCompletedPeriodEnd === undefined ? {} : { lastCompletedPeriodEnd }),
  };
}

function validateAllowlist(value: unknown): Record<string, string> {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.models)) {
    throw new Error("anonymous usage allowlist is invalid");
  }
  const entries = Object.entries(value.models);
  if (entries.length > 100_000) throw new Error("anonymous usage allowlist is too large");
  const models: Record<string, string> = {};
  for (const [alias, canonicalId] of entries) {
    if (!alias || alias.length > 512 || typeof canonicalId !== "string" || !canonicalId || canonicalId.length > 512) {
      throw new Error("anonymous usage allowlist contains an invalid model ID");
    }
    models[alias] = canonicalId;
  }
  return models;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    throw new Error("anonymous usage response exceeds its size limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error("anonymous usage response exceeds its size limit");
  return JSON.parse(bytes.toString("utf8"));
}

export function createAnonymousUsageSharingWorker(options: AnonymousUsageSharingWorkerOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const apiBaseUrl = new URL(options.apiBaseUrl ?? "https://api.multivibe.cloud");
  const allowlistUrl = new URL("/telemetry/v1/model-allowlist", apiBaseUrl);
  const usageUrl = new URL("/telemetry/v1/model-usage", apiBaseUrl);
  let cachedAllowlist: Record<string, string> | undefined;
  let cachedAllowlistEtag: string | undefined;
  let activeController: AbortController | undefined;
  let activeRun: Promise<AnonymousUsageRunOutcome> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let stopped = false;
  let sharingEnabled = true;
  let settingsEpoch = 0;

  async function readState(): Promise<AnonymousUsageState> {
    try {
      const bytes = await fs.readFile(options.statePath);
      if (bytes.length > MAX_STATE_BYTES) throw new Error("anonymous usage state exceeds its size limit");
      return validateState(JSON.parse(bytes.toString("utf8")));
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: 1 };
      throw error;
    }
  }

  async function writeState(state: AnonymousUsageState): Promise<void> {
    await fs.mkdir(path.dirname(options.statePath), { recursive: true });
    const temporaryPath = `${options.statePath}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, options.statePath);
      await fs.chmod(options.statePath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async function discardState(): Promise<void> {
    await fs.rm(options.statePath, { force: true });
  }

  async function request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      return await fetchFn(url, { ...init, redirect: "error", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = undefined;
    }
  }

  async function fetchAllowlist(): Promise<Record<string, string>> {
    const response = await request(allowlistUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(cachedAllowlistEtag ? { "if-none-match": cachedAllowlistEtag } : {}),
      },
    });
    if (response.status === 304 && cachedAllowlist) return cachedAllowlist;
    if (response.status !== 200) throw new Error("anonymous usage allowlist is unavailable");
    const allowlist = validateAllowlist(await readBoundedJson(response, MAX_ALLOWLIST_BYTES));
    cachedAllowlist = allowlist;
    cachedAllowlistEtag = response.headers.get("etag") ?? undefined;
    return allowlist;
  }

  async function sendPending(state: AnonymousUsageState, epoch: number): Promise<AnonymousUsageRunOutcome> {
    if (!state.pending) return "skipped";
    if (!sharingEnabled || settingsEpoch !== epoch) {
      await discardState();
      return "disabled";
    }
    const response = await request(usageUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(state.pending),
    });
    if (response.status !== 202) throw new Error("anonymous usage ingestion is unavailable");
    if (!sharingEnabled || settingsEpoch !== epoch) {
      await discardState();
      return "disabled";
    }
    await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: state.pending.periodEnd });
    return "sent";
  }

  async function runCycle(): Promise<AnonymousUsageRunOutcome> {
    if (stopped) return "skipped";
    const settings = await options.settingsStore.getSettings();
    sharingEnabled = settings.anonymousUsageSharingEnabled !== false;
    if (!sharingEnabled) {
      await discardState();
      return "disabled";
    }
    const epoch = settingsEpoch;
    const state = await readState();
    if (state.pending) return sendPending(state, epoch);

    const now = clock();
    const periodEnd = utcDayStart(now);
    const periodStart = new Date(periodEnd.getTime() - DAY_MS);
    const periodEndIso = periodEnd.toISOString();
    if (state.lastCompletedPeriodEnd === periodEndIso) return "skipped";
    const enabledAt = Date.parse(settings.anonymousUsageSharingEnabledAt ?? "");
    if (!Number.isFinite(enabledAt)) throw new Error("anonymous usage activation time is unavailable");
    const eligibleStart = Math.max(periodStart.getTime(), enabledAt);
    if (eligibleStart >= periodEnd.getTime()) {
      await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: periodEndIso });
      return "empty";
    }

    const allowlist = await fetchAllowlist();
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) return sharingEnabled ? "skipped" : "disabled";
    const totals = await options.traceSource.aggregateAnonymousOutputTokens(
      eligibleStart,
      periodEnd.getTime(),
      allowlist,
    );
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) return sharingEnabled ? "skipped" : "disabled";
    const models = totals
      .map((entry) => ({
        modelId: entry.modelId,
        outputTokenThousands: Math.min(
          OUTPUT_TOKEN_THOUSANDS_CAP,
          Math.floor(Math.max(0, entry.outputTokens) / 1_000),
        ),
      }))
      .filter((entry) => entry.outputTokenThousands > 0)
      .sort((left, right) => right.outputTokenThousands - left.outputTokenThousands || left.modelId.localeCompare(right.modelId))
      .slice(0, MAX_MODELS);
    if (!models.length) {
      await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: periodEndIso });
      return "empty";
    }
    const pending: AnonymousUsageEnvelope = {
      schemaVersion: 1,
      eventId: randomUUID(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEndIso,
      models,
    };
    const pendingState: AnonymousUsageState = { schemaVersion: 1, pending };
    await writeState(pendingState);
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) {
      if (!sharingEnabled || settingsEpoch !== epoch) await discardState();
      return sharingEnabled ? "skipped" : "disabled";
    }
    return sendPending(pendingState, epoch);
  }

  async function runOnce(): Promise<AnonymousUsageRunOutcome> {
    if (activeRun) return activeRun;
    activeRun = runCycle().catch(async (error: unknown) => {
      if (!sharingEnabled) {
        await discardState().catch(() => undefined);
        return "disabled";
      }
      console.warn("anonymous usage sharing cycle failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      return "failed";
    }).finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  }

  function clearSchedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delayMs: number): void {
    if (!started || stopped || !sharingEnabled || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().then((outcome) => {
        if (!started || stopped || !sharingEnabled) return;
        if (outcome === "failed") {
          schedule(15 * 60_000 + Math.floor(random() * 45 * 60_000));
          return;
        }
        const current = clock();
        const nextUtcDay = utcDayStart(new Date(current.getTime() + DAY_MS));
        schedule(Math.max(1_000, nextUtcDay.getTime() - current.getTime() + 5 * 60_000 + Math.floor(random() * 55 * 60_000)));
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  async function applySettings(settings: StoreSettings): Promise<void> {
    const nextEnabled = settings.anonymousUsageSharingEnabled !== false;
    if (!nextEnabled) {
      sharingEnabled = false;
      settingsEpoch += 1;
      clearSchedule();
      activeController?.abort();
      await discardState();
      return;
    }
    const wasEnabled = sharingEnabled;
    sharingEnabled = true;
    if (!wasEnabled) settingsEpoch += 1;
    if (started && !stopped) schedule(5_000 + Math.floor(random() * 295_000));
  }

  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;
    try {
      await applySettings(await options.settingsStore.getSettings());
    } catch (error: unknown) {
      console.warn("anonymous usage sharing startup failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      schedule(15 * 60_000 + Math.floor(random() * 45 * 60_000));
    }
  }

  function stop(): void {
    stopped = true;
    clearSchedule();
    activeController?.abort();
  }

  return { start, stop, runOnce, applySettings };
}
