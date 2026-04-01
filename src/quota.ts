import type { Account, ProviderId, UsageSnapshot } from "./types.js";

export const USAGE_CACHE_TTL_MS = Number(process.env.USAGE_CACHE_TTL_MS ?? 300_000);
const USAGE_TIMEOUT_MS = Number(process.env.USAGE_TIMEOUT_MS ?? 10_000);
const BLOCK_FALLBACK_MS = Number(process.env.BLOCK_FALLBACK_MS ?? 30 * 60_000);
const DEFAULT_ROUTING_WINDOW_MS = Number(process.env.ROUTING_WINDOW_MS ?? 5 * 60 * 1000);

type RouteCache = {
  bucket: number;
  accountId?: string;
};

const routeCache: RouteCache = { bucket: -1, accountId: undefined };

export function normalizeProvider(account?: Account): ProviderId {
  if (account?.provider === "mistral") return "mistral";
  if (account?.provider === "zai") return "zai";
  return "openai";
}

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

function parseOpenAIUsage(data: any): UsageSnapshot {
  return parseUsage(data);
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
  // Generic quota/rate limit patterns
  if (/\b429\b|quota|usage limit|rate.?limit|too many requests|limit reached|capacity/i.test(s)) {
    return true;
  }
  // z.ai specific business error codes
  // 1304: Daily call limit, 1305: Rate limit, 1308: Usage limit, 1309: Plan expired
  // 1310: Weekly/Monthly limit, 1312: High traffic, 1313: Fair Use Policy
  if (/"code":\s*"?(130[4-9]|131[0-3])"?/i.test(s)) {
    return true;
  }
  // z.ai error messages
  if (/daily call limit|usage limit reached|limit exhausted|fair use policy|high (concurrency|frequency|traffic)/i.test(s)) {
    return true;
  }
  return false;
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

export function chooseAccountForProvider(
  accounts: Account[],
  provider: ProviderId,
): Account | null {
  return chooseAccount(accounts.filter((a) => normalizeProvider(a) === provider));
}

export async function refreshUsageIfNeeded(account: Account, chatgptBaseUrl: string, force = false): Promise<Account> {
  if (!force && account.usage && Date.now() - account.usage.fetchedAt < USAGE_CACHE_TTL_MS) return account;
  const provider = normalizeProvider(account);
  // Mistral and z.ai don't have usage endpoints - use internal tracking
  if (provider === "mistral" || provider === "zai") {
    account.usage = {
      ...account.usage,
      fetchedAt: Date.now(),
    };
    return account;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${account.accessToken}`,
      accept: "application/json",
    };
    const usageUrl = `${chatgptBaseUrl}/backend-api/wham/usage`;
    if (provider === "openai" && account.chatgptAccountId) {
      headers["ChatGPT-Account-Id"] = account.chatgptAccountId;
    }
    const res = await fetch(usageUrl, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`usage probe failed ${res.status}`);
    const json = await res.json();
    account.usage = parseOpenAIUsage(json);
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

// z.ai business error code categories for smarter handling
const ZAI_AUTH_ERRORS = new Set([1000, 1001, 1002, 1003, 1004]);
const ZAI_ACCOUNT_ERRORS = new Set([1110, 1111, 1112, 1113, 1120, 1121]);
const ZAI_QUOTA_ERRORS = new Set([1304, 1305, 1308, 1309, 1310, 1312, 1313]);
const ZAI_RATE_LIMIT_ERRORS = new Set([1302, 1303, 1305]);

export function parseZaiErrorCode(errorText: string): number | null {
  const match = errorText.match(/"code":\s*"?(\d{4})"?/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

export function isZaiAuthError(errorCode: number): boolean {
  return ZAI_AUTH_ERRORS.has(errorCode);
}

export function isZaiAccountError(errorCode: number): boolean {
  return ZAI_ACCOUNT_ERRORS.has(errorCode);
}

export function isZaiQuotaError(errorCode: number): boolean {
  return ZAI_QUOTA_ERRORS.has(errorCode);
}

export function isZaiRateLimitError(errorCode: number): boolean {
  return ZAI_RATE_LIMIT_ERRORS.has(errorCode);
}

export function shouldBlockAccountForZaiError(errorCode: number): boolean {
  // Block account for auth errors, account errors, and quota errors
  return isZaiAuthError(errorCode) || isZaiAccountError(errorCode) || isZaiQuotaError(errorCode);
}

export function getZaiBlockDuration(errorCode: number): number {
  // For rate limits, block for shorter period (1-5 minutes)
  if (isZaiRateLimitError(errorCode)) {
    return 60_000; // 1 minute
  }
  // For quota limits, block until next reset or longer period
  if (isZaiQuotaError(errorCode)) {
    return BLOCK_FALLBACK_MS; // 30 minutes default
  }
  // For auth/account errors, block for longer
  return 5 * 60_000; // 5 minutes
}
