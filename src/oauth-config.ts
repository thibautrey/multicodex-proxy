import type { OAuthConfig } from "./oauth.js";

export const oauthConfig: OAuthConfig = {
  authorizationUrl:
    process.env.OAUTH_AUTHORIZATION_URL ??
    "https://auth.openai.com/oauth/authorize",
  tokenUrl:
    process.env.OAUTH_TOKEN_URL ?? "https://auth.openai.com/oauth/token",
  clientId: process.env.OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: process.env.OAUTH_SCOPE ?? "openid profile email offline_access",
  audience: process.env.OAUTH_AUDIENCE,
  redirectUri:
    process.env.OAUTH_REDIRECT_URI ?? "http://localhost:1455/auth/callback",
};
