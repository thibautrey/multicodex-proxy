import type { Account, ProviderId, UsageSnapshot } from "./types.js";
import {
  EMPTY_RESPONSE_BLOCK_THRESHOLD,
  EMPTY_RESPONSE_BLOCK_DURATION_MS,
  EMPTY_RESPONSE_WINDOW_MS,
} from "./config.js";

export const USAGE_CACHE_TTL_MS = Number(process.env.USAGE_CACHE_TTL_MS ?? 300_000);
const USAGE_TIMEOUT_MS = Number(process.env.USAGE_TIMEOUT_MS ?? 10_000);
const BLOCK_FALLBACK_MS = Number(process.env.BLOCK_FALLBACK_MS ?? 30 * 60_000);
const DEFAULT_ROUTING_WINDOW_MS = Number(process.env.ROUTING_WINDOW_MS ?? 5 * 60 * 1000);

type RouteCache = {
  bucket: number;
  accountId?: string;
};

const routeCache: RouteCache = { bucket: -1, accountId: undefined };

export function normalizeProvider(account?: Pick<Account, "provider">): ProviderId {
  if (account?.provider === "openai-compatible") return "openai-compatible";
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

function bearerToken(token: string): string {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) return "";
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function isZaiQuotaBaseUrl(baseUrl?: string): boolean {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return false;
  try {
    const { hostname } = new URL(raw);
    return hostname === "api.z.ai" || hostname === "z.ai" || hostname === "open.bigmodel.cn";
  } catch {
    return /(^|\.)z\.ai\b|open\.bigmodel\.cn\b/i.test(raw);
  }
}

function zaiQuotaUrl(baseUrl: string): string {
  const raw = String(baseUrl ?? "").trim();
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    url.pathname = host === "open.bigmodel.cn"
      ? "/api/monitor/usage/quota/limit"
      : "/api/monitor/usage/quota/limit";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    const trimmed = raw.replace(/\/+$/, "");
    return `${trimmed}/api/monitor/usage/quota/limit`;
  }
}

function toPercent(used?: number, total?: number): number | undefined {
  if (typeof used !== "number" || Number.isNaN(used)) return undefined;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  return undefined;
}

function parseResetAt(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsedNumber = Number(value);
    if (Number.isFinite(parsedNumber)) {
      return parsedNumber > 1e12 ? parsedNumber : parsedNumber * 1000;
    }
    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }
  return undefined;
}

function pickFirstNumber(...values: any[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function parseZaiWindow(window: any): { usedPercent?: number; resetAt?: number } | undefined {
  if (!window || typeof window !== "object") return undefined;

  const usedPercent = pickFirstNumber(
    window.usedPercent,
    window.used_percent,
    window.usagePercent,
    window.usage_percent,
    window.percent,
    window.percentUsed,
  );
  const used = pickFirstNumber(window.used, window.usage, window.used_amount, window.consumed);
  const total = pickFirstNumber(window.total, window.limit, window.quota, window.max, window.capacity);
  const resetAt = parseResetAt(window.resetAt ?? window.reset_at ?? window.resetTime ?? window.reset_time ?? window.expireAt ?? window.expire_at);

  const percent = typeof usedPercent === "number"
    ? Math.max(0, Math.min(100, usedPercent))
    : toPercent(used, total);

  if (typeof percent !== "number" && typeof resetAt !== "number") return undefined;
  return { usedPercent: percent, resetAt };
}

function parseZaiUsage(data: any): UsageSnapshot {
  const root = data?.data && typeof data.data === "object" ? data.data : data;

  const primary = parseZaiWindow(
    root?.primary ??
      root?.fiveHour ??
      root?.five_hour ??
      root?.hour5 ??
      root?.shortTerm ??
      root?.short_term ??
      root?.rate_limit?.primary_window,
  );

  const secondary = parseZaiWindow(
    root?.secondary ??
      root?.weekly ??
      root?.week ??
      root?.weeklyQuota ??
      root?.weekly_quota ??
      root?.longTerm ??
      root?.long_term ??
      root?.rate_limit?.secondary_window,
  );

  return { primary, secondary, fetchedAt: Date.now() };
}

function setModelBlock(account: Account, model: string, until: number, reason: string) {
  const modelKey = model.toLowerCase();
  const modelBlocks = { ...account.state?.modelBlocks };
  modelBlocks[modelKey] = { until, reason };
  account.state = { ...account.state, modelBlocks };
}

export function rememberError(account: Account, message: string) {
  const next = [{ at: Date.now(), message }, ...(account.state?.recentErrors ?? [])].slice(0, 10);
  account.state = { ...account.state, lastError: message, recentErrors: next };
}

export function markEmptyResponseError(account: Account, model: string, message: string = "empty assistant output") {
  // Track consecutive empty responses to decide when to temporarily block the account+model
  const recentEmpty = account.state?.recentEmptyResponses ?? [];
  const next = [{ at: Date.now(), message }, ...recentEmpty].slice(0, 5);
  const consecutive = next.filter(e => Date.now() - e.at < EMPTY_RESPONSE_WINDOW_MS).length;
  
  account.state = { 
    ...account.state, 
    lastError: message, 
    recentEmptyResponses: next,
  };

  // Block model on account if threshold exceeded within window
  if (consecutive >= EMPTY_RESPONSE_BLOCK_THRESHOLD) {
    const blockUntil = Date.now() + EMPTY_RESPONSE_BLOCK_DURATION_MS;
    setModelBlock(account, model, blockUntil, `empty responses (${consecutive} in ${Math.round(EMPTY_RESPONSE_WINDOW_MS / 60_000)}m)`);
  }
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

export function accountUsable(a: Account, model?: string): boolean {
  if (!a.enabled) return false;
  if (!model) return true;
  const modelKey = model.toLowerCase();
  const block = a.state?.modelBlocks?.[modelKey];
  return !(block && Date.now() < block.until);
}

export function clearEmptyResponseHistory(account: Account, model?: string) {
  const modelKey = model?.toLowerCase();
  if (modelKey) {
    const modelBlocks = { ...account.state?.modelBlocks };
    delete modelBlocks[modelKey];
    account.state = {
      ...account.state,
      recentEmptyResponses: [],
      modelBlocks,
    };
  } else {
    account.state = {
      ...account.state,
      recentEmptyResponses: [],
    };
  }
}

export function chooseAccount(accounts: Account[]): Account | null {
  const now = Date.now();
  const windowMs = Number.isFinite(DEFAULT_ROUTING_WINDOW_MS) && DEFAULT_ROUTING_WINDOW_MS > 0 ? DEFAULT_ROUTING_WINDOW_MS : 5 * 60 * 1000;

  const available = accounts.filter((a) => a.enabled);

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
  const shouldUseZaiQuotaEndpoint =
    provider === "zai" || (provider === "openai-compatible" && isZaiQuotaBaseUrl(chatgptBaseUrl));

  // Mistral and generic OpenAI-compatible providers don't have supported usage endpoints - use internal tracking
  if (provider === "mistral" || (provider === "openai-compatible" && !shouldUseZaiQuotaEndpoint)) {
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
      authorization: bearerToken(account.accessToken),
      accept: "application/json",
    };

    if (shouldUseZaiQuotaEndpoint) {
      const usageUrl = zaiQuotaUrl(chatgptBaseUrl);
      const res = await fetch(usageUrl, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`usage probe failed ${res.status}`);
      const json = await res.json();
      account.usage = parseZaiUsage(json);
      account.state = { ...account.state, lastError: undefined };
      return account;
    }

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

const RATE_LIMIT_BLOCK_MS = Number(process.env.RATE_LIMIT_BLOCK_MS ?? 60_000);

export function markQuotaHit(account: Account, model: string, message: string) {
  const isRateLimit = /\b429\b/.test(message);
  const until = isRateLimit
    ? Date.now() + RATE_LIMIT_BLOCK_MS
    : (nextResetAt(account.usage) ?? Date.now() + BLOCK_FALLBACK_MS);
  setModelBlock(account, model, until, message);
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
