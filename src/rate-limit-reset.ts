import { randomUUID } from "node:crypto";
import { ensureValidToken } from "./account-utils.js";
import type { OAuthConfig } from "./oauth.js";
import { normalizeProvider, refreshUsageIfNeeded } from "./quota.js";
import type { Account } from "./types.js";
import type { AccountStore } from "./store.js";
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  MODELS_CLIENT_VERSION,
} from "./config.js";

export const WEEKLY_RESET_REMAINING_THRESHOLD_PERCENT = 0.5;
const WEEKLY_RESET_USED_THRESHOLD_PERCENT =
  100 - WEEKLY_RESET_REMAINING_THRESHOLD_PERCENT;
const AUTO_RESET_POLL_INTERVAL_MS = 60_000;

const resetAttempts = new Map<string, Promise<AutoResetResult>>();

export type AutoResetResult =
  | { status: "not-scheduled" | "threshold-not-reached" | "in-progress" }
  | { status: "consumed"; result: unknown }
  | { status: "failed"; error: string };

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

export async function rateLimitResetCreditRequest(
  account: Account,
  openaiBaseUrl: string,
  consume: boolean,
  idempotencyKey: string = randomUUID(),
): Promise<unknown> {
  const suffix = consume ? "/consume" : "";
  const endpoints = [
    {
      path: `/backend-api/api/codex/rate-limit-reset-credits${suffix}`,
      body: consume ? { idempotencyKey } : undefined,
    },
    {
      path: `/backend-api/wham/rate-limit-reset-credits${suffix}`,
      body: consume ? { redeem_request_id: idempotencyKey } : undefined,
    },
  ];
  let lastFailure = "";

  for (const endpoint of endpoints) {
    const response = await fetch(
      `${openaiBaseUrl.replace(/\/+$/, "")}${endpoint.path}`,
      {
        method: consume ? "POST" : "GET",
        headers: openAiAccountHeaders(account),
        ...(endpoint.body ? { body: JSON.stringify(endpoint.body) } : {}),
      },
    );
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (response.ok) return data;
    const detail =
      data && typeof data === "object" && "message" in data
        ? String((data as { message?: unknown }).message ?? "")
        : text;
    lastFailure = `${response.status}${detail ? `: ${detail}` : ""}`;
    if (response.status !== 404) break;
  }

  throw new Error(`rate-limit reset credit request failed ${lastFailure}`);
}

export function findAvailableResetCreditCount(
  value: unknown,
): number | undefined {
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
    const count = findAvailableResetCreditCount(child);
    if (count !== undefined) return count;
  }
  return undefined;
}

export function hasReachedScheduledWeeklyResetThreshold(
  account: Account,
): boolean {
  const usedPercent = account.usage?.secondary?.usedPercent;
  return (
    typeof usedPercent === "number" &&
    usedPercent >= WEEKLY_RESET_USED_THRESHOLD_PERCENT
  );
}

export async function maybeConsumeScheduledWeeklyReset(
  accountId: string,
  store: AccountStore,
  openaiBaseUrl: string,
): Promise<AutoResetResult> {
  const existingAttempt = resetAttempts.get(accountId);
  if (existingAttempt) {
    return { status: "in-progress" };
  }

  const account = store
    .getCachedAccounts()
    .find((candidate) => candidate.id === accountId);
  if (!account?.state?.scheduledWeeklyReset) {
    return { status: "not-scheduled" };
  }
  if (!hasReachedScheduledWeeklyResetThreshold(account)) {
    return { status: "threshold-not-reached" };
  }

  const attempt = (async (): Promise<AutoResetResult> => {
    const current = store
      .getCachedAccounts()
      .find((candidate) => candidate.id === accountId);
    const scheduled = current?.state?.scheduledWeeklyReset;
    if (!current || !scheduled) return { status: "not-scheduled" };
    if (!hasReachedScheduledWeeklyResetThreshold(current)) {
      return { status: "threshold-not-reached" };
    }

    current.state = {
      ...current.state,
      scheduledWeeklyReset: {
        ...scheduled,
        lastAttemptAt: Date.now(),
        lastError: undefined,
      },
    };
    await store.addOrUpdate(current);

    try {
      const result = await rateLimitResetCreditRequest(
        current,
        openaiBaseUrl,
        true,
        scheduled.idempotencyKey,
      );

      const { scheduledWeeklyReset: _completed, ...remainingState } =
        current.state ?? {};
      current.state = remainingState;
      // Persist completion before the optional usage refresh. The stable
      // idempotency key also prevents a duplicate redemption after a crash.
      await store.addOrUpdate(current);
      try {
        await refreshUsageIfNeeded(current, openaiBaseUrl, true);
        await store.addOrUpdate(current);
      } catch {
        // The reset succeeded; a failed display refresh must not re-arm it.
      }
      return { status: "consumed", result };
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const latest = store
        .getCachedAccounts()
        .find((candidate) => candidate.id === accountId);
      if (latest?.state?.scheduledWeeklyReset) {
        latest.state = {
          ...latest.state,
          scheduledWeeklyReset: {
            ...latest.state.scheduledWeeklyReset,
            lastAttemptAt: Date.now(),
            lastError: message,
          },
        };
        await store.addOrUpdate(latest);
      }
      return { status: "failed", error: message };
    }
  })();

  resetAttempts.set(accountId, attempt);
  try {
    return await attempt;
  } finally {
    resetAttempts.delete(accountId);
  }
}

export async function checkScheduledWeeklyResets(options: {
  store: AccountStore;
  oauthConfig: OAuthConfig;
  openaiBaseUrl: string;
}): Promise<void> {
  const { store, oauthConfig, openaiBaseUrl } = options;
  const scheduledAccounts = store
    .getCachedAccounts()
    .filter(
      (account) =>
        normalizeProvider(account) === "openai" &&
        Boolean(account.state?.scheduledWeeklyReset),
    );

  await Promise.all(
    scheduledAccounts.map(async (account) => {
      try {
        const valid = await ensureValidToken(account, oauthConfig);
        await refreshUsageIfNeeded(valid, openaiBaseUrl, true);
        await store.addOrUpdate(valid);
        if (valid.state?.lastError) {
          const scheduled = valid.state.scheduledWeeklyReset;
          if (scheduled) {
            valid.state = {
              ...valid.state,
              scheduledWeeklyReset: {
                ...scheduled,
                lastAttemptAt: Date.now(),
                lastError: valid.state.lastError,
              },
            };
            await store.addOrUpdate(valid);
          }
          return;
        }
        await maybeConsumeScheduledWeeklyReset(
          valid.id,
          store,
          openaiBaseUrl,
        );
      } catch (error: any) {
        const current = store
          .getCachedAccounts()
          .find((candidate) => candidate.id === account.id);
        if (!current?.state?.scheduledWeeklyReset) return;
        current.state = {
          ...current.state,
          scheduledWeeklyReset: {
            ...current.state.scheduledWeeklyReset,
            lastAttemptAt: Date.now(),
            lastError: error?.message ?? String(error),
          },
        };
        await store.addOrUpdate(current);
      }
    }),
  );
}

export function startScheduledWeeklyResetMonitor(options: {
  store: AccountStore;
  oauthConfig: OAuthConfig;
  openaiBaseUrl: string;
}): NodeJS.Timeout {
  void checkScheduledWeeklyResets(options);
  const timer = setInterval(() => {
    void checkScheduledWeeklyResets(options);
  }, AUTO_RESET_POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}
