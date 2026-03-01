import { OAuthConfig } from "./oauth.js";
import { mergeTokenIntoAccount, refreshAccessToken } from "./oauth.js";
import { rememberError } from "./quota.js";
import type { Account } from "./types.js";

export async function ensureValidToken(
  account: Account,
  oauthConfig: OAuthConfig,
): Promise<Account> {
  if (!account.expiresAt || Date.now() < account.expiresAt - 5 * 60_000)
    return account;
  if (!account.refreshToken) return account;

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
    rememberError(
      account,
      `refresh token failed: ${err?.message ?? String(err)}`,
    );
    account.state = {
      ...account.state,
      needsTokenRefresh: true,
    };
    return account;
  }
}
