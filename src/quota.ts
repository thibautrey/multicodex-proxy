import type { Account, UsageSnapshot } from "./types.js";

export const USAGE_CACHE_TTL_MS = Number(process.env.USAGE_CACHE_TTL_MS ?? 300_000);
const USAGE_TIMEOUT_MS = Number(process.env.USAGE_TIMEOUT_MS ?? 10_000);
const BLOCK_FALLBACK_MS = Number(process.env.BLOCK_FALLBACK_MS ?? 30 * 60_000);
const DEFAULT_ROUTING_WINDOW_MS = Number(process.env.ROUTING_WINDOW_MS ?? 5 * 60 * 1000);

type RouteCache = {
  bucket: number;
  accountId?: string;
};

const routeCache: RouteCache = { bucket: -1, accountId: undefined };

function nowBucket(now: number, windowMs: number) {
  return Math.floor(now / windowMs);
}

function safePct(v?: number): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function scoreAccount(account: Account): number {
  const p = safePct(account.usage?.primary?.usedPercent);
  const w = safePct(account.usage?.secondary?.usedPercent);

  const mean = (p + w) / 2;
  const imbalance = Math.abs(p - w);
  return mean * 0.75 + imbalance * 0.25;
}

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
  const now = Date.now();
  const windowMs = Number.isFinite(DEFAULT_ROUTING_WINDOW_MS) && DEFAULT_ROUTING_WINDOW_MS > 0 ? DEFAULT_ROUTING_WINDOW_MS : 5 * 60 * 1000;

  const available = accounts.filter((a) => {
    if (!a.enabled) return false;
    const blockedUntil = a.state?.blockedUntil ?? 0;
    return blockedUntil <= now;
  });
  if (!available.length) return null;

  const bucket = nowBucket(now, windowMs);

  if (routeCache.bucket === bucket && routeCache.accountId) {
    const sticky = available.find((a) => a.id === routeCache.accountId);
    if (sticky) return sticky;
  }

  const untouched = available.filter((a) => {
    const p = safePct(a.usage?.primary?.usedPercent);
    const w = safePct(a.usage?.secondary?.usedPercent);
    return p === 0 && w === 0;
  });

  const pool = untouched.length ? untouched : available;

  const sorted = [...pool].sort((a, b) => {
    const sa = scoreAccount(a);
    const sb = scoreAccount(b);
    if (sa !== sb) return sa - sb;

    const ar = a.usage?.secondary?.resetAt ?? Number.MAX_SAFE_INTEGER;
    const br = b.usage?.secondary?.resetAt ?? Number.MAX_SAFE_INTEGER;
    if (ar !== br) return ar - br;

    const ap = a.priority ?? Number.MAX_SAFE_INTEGER;
    const bp = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (ap !== bp) return ap - bp;

    return a.id.localeCompare(b.id);
  });

  const winner = sorted[0] ?? null;
  routeCache.bucket = bucket;
  routeCache.accountId = winner?.id;

  return winner;
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
