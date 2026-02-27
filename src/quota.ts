import type { Account, UsageSnapshot } from "./types.js";

export const USAGE_CACHE_TTL_MS = Number(process.env.USAGE_CACHE_TTL_MS ?? 300_000);
const USAGE_TIMEOUT_MS = Number(process.env.USAGE_TIMEOUT_MS ?? 10_000);
const BLOCK_FALLBACK_MS = Number(process.env.BLOCK_FALLBACK_MS ?? 30 * 60_000);

function parseUsage(data: any): UsageSnapshot {
  const primary = data?.rate_limit?.primary_window;
  const secondary = data?.rate_limit?.secondary_window;
  const toWindow = (w: any) =>
    w
      ? {
          usedPercent: typeof w.used_percent === "number" ? Math.max(0, Math.min(100, w.used_percent)) : undefined,
          resetAt: typeof w.reset_at === "number" ? w.reset_at * 1000 : undefined,
        }
      : undefined;
  return { primary: toWindow(primary), secondary: toWindow(secondary), fetchedAt: Date.now() };
}

export function rememberError(account: Account, message: string) {
  const next = [{ at: Date.now(), message }, ...(account.state?.recentErrors ?? [])].slice(0, 10);
  account.state = { ...account.state, lastError: message, recentErrors: next };
}

export function usageUntouched(usage?: UsageSnapshot): boolean {
  return usage?.primary?.usedPercent === 0 && usage?.secondary?.usedPercent === 0;
}

export function weeklyResetAt(usage?: UsageSnapshot): number | undefined {
  return usage?.secondary?.resetAt;
}

export function nextResetAt(usage?: UsageSnapshot): number | undefined {
  const list = [usage?.primary?.resetAt, usage?.secondary?.resetAt].filter((x): x is number => typeof x === "number");
  return list.length ? Math.min(...list) : undefined;
}

export function isQuotaErrorText(s: string): boolean {
  return /\b429\b|quota|usage limit|rate.?limit|too many requests|limit reached|capacity/i.test(s);
}

export function accountUsable(a: Account): boolean {
  if (!a.enabled) return false;
  const until = a.state?.blockedUntil;
  return !(typeof until === "number" && Date.now() < until);
}

export function chooseAccount(accounts: Account[]): Account | null {
  const pool = accounts.filter(accountUsable);
  if (!pool.length) return null;

  const untouched = pool.filter((a) => usageUntouched(a.usage));
  if (untouched.length) {
    untouched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return untouched[0];
  }

  const withWeekly = pool.filter((a) => typeof weeklyResetAt(a.usage) === "number");
  if (withWeekly.length) {
    withWeekly.sort((a, b) => {
      const d = (weeklyResetAt(a.usage) ?? Number.MAX_SAFE_INTEGER) - (weeklyResetAt(b.usage) ?? Number.MAX_SAFE_INTEGER);
      if (d !== 0) return d;
      return (b.priority ?? 0) - (a.priority ?? 0);
    });
    return withWeekly[0];
  }

  pool.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return pool[0];
}

export async function refreshUsageIfNeeded(account: Account, chatgptBaseUrl: string, force = false): Promise<Account> {
  if (!force && account.usage && Date.now() - account.usage.fetchedAt < USAGE_CACHE_TTL_MS) return account;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${account.accessToken}`,
      Accept: "application/json",
    };
    if (account.chatgptAccountId) headers["ChatGPT-Account-Id"] = account.chatgptAccountId;

    const res = await fetch(`${chatgptBaseUrl}/backend-api/wham/usage`, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`usage probe failed ${res.status}`);
    const json = await res.json();
    account.usage = parseUsage(json);
    account.state = { ...account.state, lastError: undefined };
    return account;
  } catch (err: any) {
    rememberError(account, err?.message ?? String(err));
    return account;
  } finally {
    clearTimeout(timeout);
  }
}

export function markQuotaHit(account: Account, message: string) {
  const until = nextResetAt(account.usage) ?? Date.now() + BLOCK_FALLBACK_MS;
  account.state = {
    ...account.state,
    blockedUntil: until,
    blockedReason: message,
  };
  rememberError(account, message);
}
