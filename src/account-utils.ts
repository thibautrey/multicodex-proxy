import { OAuthConfig } from "./oauth.js";
import { mergeTokenIntoAccount, refreshAccessToken } from "./oauth.js";
import {
  isUsageRefreshNeeded,
  normalizeProvider,
  rememberError,
} from "./quota.js";
import type { Account } from "./types.js";

export function isTokenRefreshNeeded(
  account: Account,
  now = Date.now(),
): account is Account & { expiresAt: number; refreshToken: string } {
  return (
    (account.provider ?? "openai") === "openai" &&
    typeof account.expiresAt === "number" &&
    account.expiresAt > 0 &&
    now >= account.expiresAt - 5 * 60_000 &&
    Boolean(account.refreshToken)
  );
}

export function accountNeedsRequestPreparation(
  account: Account,
  now = Date.now(),
): boolean {
  if (!account.enabled) return false;
  return (
    isTokenRefreshNeeded(account, now) ||
    isUsageRefreshNeeded(account) ||
    (normalizeProvider(account) === "openai" &&
      Boolean(account.state?.scheduledWeeklyReset))
  );
}

export async function ensureValidToken(
  account: Account,
  oauthConfig: OAuthConfig,
): Promise<Account> {
  if (!isTokenRefreshNeeded(account)) return account;

  try {
    const refreshed = await refreshAccessToken(
      oauthConfig,
      account.refreshToken,
    );
    const merged = mergeTokenIntoAccount(account, refreshed);
    merged.state = {
      ...merged.state,
      needsTokenRefresh: false,
    };
    return merged;
  } catch (err: any) {
    const failed = { ...account };
    rememberError(
      failed,
      `refresh token failed: ${err?.message ?? String(err)}`,
    );
    failed.state = {
      ...failed.state,
      needsTokenRefresh: true,
    };
    return failed;
  }
}
