import test from "node:test";
import assert from "node:assert/strict";
import { startHttpServer } from "./helpers.js";

test("token refresh is single-flight per account", async () => {
  let refreshCalls = 0;
  const tokenServer = await startHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/oauth/token") {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const { ensureValidToken } = await import("../dist/account-utils.js");
    const account = {
      id: "acct-1",
      provider: "openai",
      accessToken: "expired-token",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1_000,
      enabled: true,
      state: {},
    };
    const oauthConfig = {
      authorizationUrl: `${tokenServer.url}/oauth/authorize`,
      tokenUrl: `${tokenServer.url}/oauth/token`,
      clientId: "client",
      scope: "openid",
      redirectUri: "http://localhost/callback",
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureValidToken(account, oauthConfig)),
    );

    assert.equal(refreshCalls, 1);
    for (const result of results) {
      assert.equal(result.accessToken, "fresh-token");
      assert.equal(result.refreshToken, "fresh-refresh");
    }
  } finally {
    await tokenServer.close();
  }
});
