import type { OAuthConfig } from "./oauth.js";

export const oauthConfig: OAuthConfig = {
  authorizationUrl:
    process.env.OAUTH_AUTHORIZATION_URL ??
    "https://auth.openai.com/oauth/authorize",
  tokenUrl:
    process.env.OAUTH_TOKEN_URL ?? "https://auth.openai.com/oauth/token",
  deviceAuthorizationUrl:
    process.env.OAUTH_DEVICE_AUTHORIZATION_URL ??
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl:
    process.env.OAUTH_DEVICE_TOKEN_URL ??
    "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceVerificationUrl:
    process.env.OAUTH_DEVICE_VERIFICATION_URL ??
    "https://auth.openai.com/codex/device",
  deviceRedirectUri:
    process.env.OAUTH_DEVICE_REDIRECT_URI ??
    "https://auth.openai.com/deviceauth/callback",
  clientId: process.env.OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: process.env.OAUTH_SCOPE ?? "openid profile email offline_access",
  audience: process.env.OAUTH_AUDIENCE,
  redirectUri:
    process.env.OAUTH_REDIRECT_URI ?? "http://localhost:1455/auth/callback",
};
