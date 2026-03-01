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
    return mergeTokenIntoAccount(account, refreshed);
  } catch (err: any) {
    rememberError(
      account,
      `refresh token failed: ${err?.message ?? String(err)}`,
    );
    return account;
  }
}
