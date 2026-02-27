import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AccountStore, OAuthStateStore } from "./store.js";
import {
  accountFromOAuth,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForToken,
  mergeTokenIntoAccount,
  refreshAccessToken,
  type OAuthConfig,
} from "./oauth.js";
import { chooseAccount, isQuotaErrorText, markQuotaHit, refreshUsageIfNeeded, rememberError } from "./quota.js";
import type { Account } from "./types.js";

const PORT = Number(process.env.PORT ?? 4010);
const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
const OAUTH_STATE_PATH = process.env.OAUTH_STATE_PATH ?? "/data/oauth-state.json";
const CHATGPT_BASE_URL = process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
const UPSTREAM_PATH = process.env.UPSTREAM_PATH ?? "/backend-api/codex/responses";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

const oauthConfig: OAuthConfig = {
  authorizationUrl: process.env.OAUTH_AUTHORIZATION_URL ?? "https://auth.openai.com/oauth/authorize",
  tokenUrl: process.env.OAUTH_TOKEN_URL ?? "https://auth.openai.com/oauth/token",
  clientId: process.env.OAUTH_CLIENT_ID ?? "openai-chatgpt",
  scope: process.env.OAUTH_SCOPE ?? "openid profile email offline_access",
  audience: process.env.OAUTH_AUDIENCE ?? "https://api.openai.com/v1",
  redirectUri: process.env.OAUTH_REDIRECT_URI ?? `${PUBLIC_BASE_URL}/admin/oauth/callback`,
};

const app = express();
app.use(express.json({ limit: "10mb" }));

const store = new AccountStore(STORE_PATH);
const oauthStore = new OAuthStateStore(OAUTH_STATE_PATH);
await store.init();
await oauthStore.init();

function adminGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!ADMIN_TOKEN) return next();
  const token = req.header("x-admin-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

function redact(a: Account) {
  return {
    ...a,
    accessToken: a.accessToken ? `${a.accessToken.slice(0, 8)}...` : "",
    refreshToken: a.refreshToken ? `${a.refreshToken.slice(0, 8)}...` : undefined,
  };
}

async function ensureValidToken(account: Account): Promise<Account> {
  if (!account.expiresAt || Date.now() < account.expiresAt - 5 * 60_000) return account;
  if (!account.refreshToken) return account;
  try {
    const refreshed = await refreshAccessToken(oauthConfig, account.refreshToken);
    return mergeTokenIntoAccount(account, refreshed);
  } catch (err: any) {
    rememberError(account, `refresh token failed: ${err?.message ?? String(err)}`);
    return account;
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/admin/config", adminGuard, (_req, res) => {
  res.json({ ok: true, publicBaseUrl: PUBLIC_BASE_URL, oauthRedirectUri: oauthConfig.redirectUri });
});

app.get("/admin/accounts", adminGuard, async (_req, res) => {
  const accounts = await store.listAccounts();
  res.json({ accounts: accounts.map(redact) });
});

app.post("/admin/accounts", adminGuard, async (req, res) => {
  const body = req.body ?? {};
  if (!body.accessToken) return res.status(400).json({ error: "accessToken required" });
  const acc: Account = {
    id: body.id ?? randomUUID(),
    email: body.email,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: body.expiresAt,
    chatgptAccountId: body.chatgptAccountId,
    enabled: body.enabled ?? true,
    priority: body.priority ?? 0,
    usage: body.usage,
    state: body.state,
  };
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});

app.patch("/admin/accounts/:id", adminGuard, async (req, res) => {
  const updated = await store.patchAccount(req.params.id, req.body ?? {});
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, account: redact(updated) });
});

app.delete("/admin/accounts/:id", adminGuard, async (req, res) => {
  const ok = await store.deleteAccount(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.post("/admin/accounts/:id/unblock", adminGuard, async (req, res) => {
  const accs = await store.listAccounts();
  const acc = accs.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  acc.state = { ...acc.state, blockedUntil: undefined, blockedReason: undefined };
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});

app.post("/admin/accounts/:id/refresh-usage", adminGuard, async (req, res) => {
  const accs = await store.listAccounts();
  let acc = accs.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  acc = await ensureValidToken(acc);
  await refreshUsageIfNeeded(acc, CHATGPT_BASE_URL, true);
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});

app.post("/admin/usage/refresh", adminGuard, async (_req, res) => {
  const refreshed = await Promise.all(
    (await store.listAccounts()).map(async (a) => {
      const valid = await ensureValidToken(a);
      await refreshUsageIfNeeded(valid, CHATGPT_BASE_URL, true);
      return valid;
    }),
  );
  await Promise.all(refreshed.map((a) => store.upsertAccount(a)));
  res.json({ ok: true, accounts: refreshed.map(redact) });
});

app.post("/admin/oauth/start", adminGuard, async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email required" });
  const flow = createOAuthState(email);
  await oauthStore.create(flow);
  const authorizeUrl = buildAuthorizationUrl(oauthConfig, flow);
  res.json({ ok: true, flowId: flow.id, authorizeUrl });
});

app.get("/admin/oauth/status/:flowId", adminGuard, async (req, res) => {
  const flow = await oauthStore.get(req.params.flowId);
  if (!flow) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, flow: { ...flow, codeVerifier: undefined } });
});

app.get("/admin/oauth/callback", async (req, res) => {
  const state = String(req.query.state ?? "");
  const code = String(req.query.code ?? "");
  const error = req.query.error ? String(req.query.error) : undefined;

  const flow = await oauthStore.get(state);
  if (!flow) return res.status(400).send("Invalid OAuth state");

  if (error) {
    await oauthStore.update(flow.id, { status: "error", error, completedAt: Date.now() });
    return res.status(400).send(`OAuth failed: ${error}`);
  }
  if (!code) {
    await oauthStore.update(flow.id, { status: "error", error: "missing code", completedAt: Date.now() });
    return res.status(400).send("Missing code");
  }

  try {
    const tokenData = await exchangeCodeForToken(oauthConfig, code, flow.codeVerifier);
    let account = accountFromOAuth(flow, tokenData);
    account = await refreshUsageIfNeeded(account, CHATGPT_BASE_URL, true);
    await store.upsertAccount(account);
    await oauthStore.update(flow.id, { status: "success", completedAt: Date.now(), accountId: account.id });

    return res.type("html").send(`<html><body style="font-family: sans-serif; padding: 2rem;"><h2>Login complete</h2><p>Account saved for ${account.email ?? "(unknown email)"}.</p><p>You can close this tab and return to the dashboard.</p></body></html>`);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await oauthStore.update(flow.id, { status: "error", error: message, completedAt: Date.now() });
    return res.status(500).send(`OAuth exchange failed: ${message}`);
  }
});

async function streamOrJson(resUp: Response, res: express.Response) {
  res.status(resUp.status);
  for (const [k, v] of resUp.headers.entries()) {
    if (k.toLowerCase() === "content-length") continue;
    res.setHeader(k, v);
  }
  if (!resUp.body) {
    res.end();
    return;
  }
  const reader = resUp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function proxyWithRotation(req: express.Request, res: express.Response) {
  let accounts = await store.listAccounts();
  if (!accounts.length) return res.status(503).json({ error: "no accounts configured" });

  accounts = await Promise.all(
    accounts.map(async (a) => {
      const valid = await ensureValidToken(a);
      await refreshUsageIfNeeded(valid, CHATGPT_BASE_URL);
      return valid;
    }),
  );
  await Promise.all(accounts.map((a) => store.upsertAccount(a)));

  const tried = new Set<string>();

  for (let i = 0; i < accounts.length; i++) {
    const selected = chooseAccount(accounts.filter((a) => !tried.has(a.id)));
    if (!selected) break;
    tried.add(selected.id);

    selected.state = { ...selected.state, lastSelectedAt: Date.now() };
    await store.upsertAccount(selected);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${selected.accessToken}`,
      accept: req.header("accept") ?? "application/json",
    };
    if (selected.chatgptAccountId) headers["ChatGPT-Account-Id"] = selected.chatgptAccountId;

    try {
      const upstream = await fetch(`${CHATGPT_BASE_URL}${UPSTREAM_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(req.body ?? {}),
      });

      if (upstream.ok) return streamOrJson(upstream, res);

      const text = await upstream.text();
      if (upstream.status === 429 || isQuotaErrorText(text)) {
        markQuotaHit(selected, `quota/rate-limit: ${upstream.status}`);
        await store.upsertAccount(selected);
        continue;
      }

      rememberError(selected, `upstream ${upstream.status}: ${text.slice(0, 200)}`);
      await store.upsertAccount(selected);
      return res.status(upstream.status).type("application/json").send(text);
    } catch (err: any) {
      rememberError(selected, err?.message ?? String(err));
      await store.upsertAccount(selected);
    }
  }

  res.status(429).json({ error: "all accounts exhausted or unavailable" });
}

app.post("/v1/chat/completions", proxyWithRotation);
app.post("/v1/responses", proxyWithRotation);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../web-dist");
app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/admin/") || req.path.startsWith("/v1/") || req.path === "/health") return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`multicodex-proxy listening on :${PORT}`);
  console.log(`store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} upstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH}`);
});
