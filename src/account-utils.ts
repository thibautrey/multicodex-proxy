import { OAuthConfig } from "./oauth.js";
import { mergeTokenIntoAccount, refreshAccessToken } from "./oauth.js";
import {
  clearAuthFailureState,
  normalizeProvider,
  rememberError,
} from "./quota.js";
import type { Account } from "./types.js";
import {
  TOKEN_REFRESH_COOLDOWN_MS,
  TOKEN_REFRESH_MARGIN_MS,
} from "./config.js";

const refreshInFlight = new Map<string, Promise<Account>>();

export async function ensureValidToken(
  account: Account,
  oauthConfig: OAuthConfig,
): Promise<Account> {
  if (normalizeProvider(account) !== "openai") return account;
  if (!account.expiresAt || Date.now() < account.expiresAt - TOKEN_REFRESH_MARGIN_MS)
    return account;
  if (!account.refreshToken) return account;
  const refreshToken = account.refreshToken;
  if (
    typeof account.state?.refreshBlockedUntil === "number" &&
    Date.now() < account.state.refreshBlockedUntil
  ) {
    return account;
  }

  const existing = refreshInFlight.get(account.id);
  if (existing) return existing;

  const run = (async () => {
    try {
      const refreshed = await refreshAccessToken(
        oauthConfig,
        refreshToken,
      );
      const merged = mergeTokenIntoAccount(account, refreshed);
      clearAuthFailureState(merged);
      return merged;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      rememberError(account, `refresh token failed: ${message}`);
      const failureCount = (account.state?.refreshFailureCount ?? 0) + 1;
      account.state = {
        ...account.state,
        needsTokenRefresh: true,
        refreshFailureCount: failureCount,
        refreshBlockedUntil:
          Date.now() + TOKEN_REFRESH_COOLDOWN_MS * Math.min(failureCount, 6),
      };
      return account;
    } finally {
      refreshInFlight.delete(account.id);
    }
  })();

  refreshInFlight.set(account.id, run);
  return run;
}
