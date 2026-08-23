import { OAuthConfig } from "./oauth.js";
import { mergeTokenIntoAccount, refreshAccessToken } from "./oauth.js";
import {
  isUsageRefreshNeeded,
  normalizeProvider,
  rememberError,
} from "./quota.js";
import type { Account } from "./types.js";
import { refreshXaiAccessToken } from "./xai.js";

const xaiRefreshes = new Map<string, Promise<Account>>();

export function isTokenRefreshNeeded(
  account: Account,
  now = Date.now(),
): account is Account & { expiresAt: number; refreshToken: string } {
  const provider = normalizeProvider(account);
  return (
    (provider === "openai" || provider === "xai") &&
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

  if (normalizeProvider(account) === "xai") {
    const current = xaiRefreshes.get(account.id);
    if (current) return current;
    const refresh = refreshXaiAccessToken(account)
      .catch((err: any) => {
        const failed = { ...account };
        rememberError(
          failed,
          `xAI refresh token failed: ${err?.message ?? String(err)}`,
        );
        failed.state = {
          ...failed.state,
          needsTokenRefresh: true,
          authBlockedUntil: Date.now() + 60_000,
        };
        return failed;
      })
      .finally(() => {
        xaiRefreshes.delete(account.id);
      });
    xaiRefreshes.set(account.id, refresh);
    return refresh;
  }

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
