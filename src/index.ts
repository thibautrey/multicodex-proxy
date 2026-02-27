import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AccountStore, OAuthStateStore } from "./store.js";
import {
  accountFromOAuth,
  buildAuthorizationUrl,
  createOAuthState,
  exchangeCodeForToken,
  mergeTokenIntoAccount,
  parseAuthorizationInput,
  refreshAccessToken,
  type OAuthConfig,
} from "./oauth.js";
import { chooseAccount, isQuotaErrorText, markQuotaHit, refreshUsageIfNeeded, rememberError } from "./quota.js";
import type { Account } from "./types.js";
import { createTraceManager } from "./traces.js";
import {
  chatCompletionObjectToSSE,
  chatCompletionsToResponsesPayload,
  convertResponsesSSEToChatCompletionSSE,
  ensureNonEmptyChatCompletion,
  extractUsageFromPayload,
  getSessionId,
  inspectAssistantPayload,
  normalizeResponsesPayload,
  parseResponsesSSEToChatCompletion,
  parseResponsesSSEToResponseObject,
  responseObjectToChatCompletion,
  sanitizeAssistantTextChunk,
  sanitizeChatCompletionObject,
  sanitizeResponsesSSEFrame,
  stripReasoningFromResponseObject,
} from "./responses-bridge.js";

const PORT = Number(process.env.PORT ?? 4010);
const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
const OAUTH_STATE_PATH = process.env.OAUTH_STATE_PATH ?? "/data/oauth-state.json";
const TRACE_FILE_PATH = process.env.TRACE_FILE_PATH ?? "/data/requests-trace.jsonl";
const TRACE_INCLUDE_BODY = (process.env.TRACE_INCLUDE_BODY ?? "true") === "true";
const CHATGPT_BASE_URL = process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
const UPSTREAM_PATH = process.env.UPSTREAM_PATH ?? "/backend-api/codex/responses";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const MAX_ACCOUNT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.MAX_ACCOUNT_RETRY_ATTEMPTS ?? 5));
const MAX_UPSTREAM_RETRIES = Math.max(0, Number(process.env.MAX_UPSTREAM_RETRIES ?? 3));
const UPSTREAM_BASE_DELAY_MS = Math.max(100, Number(process.env.UPSTREAM_BASE_DELAY_MS ?? 1000));
const PI_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;

const BUILD_GIT_SHA = process.env.APP_GIT_SHA ?? "unknown";
const BUILD_ID = process.env.APP_BUILD_ID ?? "unknown";
let APP_VERSION = process.env.APP_VERSION ?? "unknown";
try {
  const packageJsonPath = path.resolve(process.cwd(), "package.json");
  const packageRaw = await fs.readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(packageRaw);
  if (typeof pkg?.version === "string" && pkg.version) APP_VERSION = pkg.version;
} catch {}

const oauthConfig: OAuthConfig = {
  authorizationUrl: process.env.OAUTH_AUTHORIZATION_URL ?? "https://auth.openai.com/oauth/authorize",
  tokenUrl: process.env.OAUTH_TOKEN_URL ?? "https://auth.openai.com/oauth/token",
  clientId: process.env.OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: process.env.OAUTH_SCOPE ?? "openid profile email offline_access",
  audience: process.env.OAUTH_AUDIENCE,
  redirectUri: process.env.OAUTH_REDIRECT_URI ?? "http://localhost:1455/auth/callback",
};

const app = express();
app.use(express.json({ limit: "20mb" }));

const store = new AccountStore(STORE_PATH);
const oauthStore = new OAuthStateStore(OAUTH_STATE_PATH);
await store.init();
await oauthStore.init();
await fs.mkdir(path.dirname(TRACE_FILE_PATH), { recursive: true });

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

const traceManager = createTraceManager({ filePath: TRACE_FILE_PATH });
const {
  readTraceWindow,
  compactTraceStorageIfNeeded,
  appendTrace,
  readTracesLegacy,
  buildTraceStats,
  createUsageAggregate,
  addTraceToAggregate,
  finalizeAggregate,
  pageSizeMax,
} = traceManager;

function parseQueryNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function setForwardHeaders(from: Response, to: express.Response) {
  for (const [k, v] of from.headers.entries()) if (k.toLowerCase() !== "content-length") to.setHeader(k, v);
}

await compactTraceStorageIfNeeded();

app.get("/health", (_req, res) => res.json({ ok: true, version: APP_VERSION, gitSha: BUILD_GIT_SHA, buildId: BUILD_ID }));
app.get("/admin/config", adminGuard, (_req, res) => {
  res.json({
    ok: true,
    oauthRedirectUri: oauthConfig.redirectUri,
    storage: {
      accountsPath: STORE_PATH,
      oauthStatePath: OAUTH_STATE_PATH,
      tracePath: TRACE_FILE_PATH,
      persistenceLikelyEnabled: STORE_PATH.startsWith("/data/") || STORE_PATH.startsWith("/data"),
    },
  });
});
app.get("/admin/accounts", adminGuard, async (_req, res) => res.json({ accounts: (await store.listAccounts()).map(redact) }));
app.get("/admin/traces", adminGuard, async (req, res) => {
  const hasPaginationQuery = typeof req.query.page !== "undefined" || typeof req.query.pageSize !== "undefined";
  const hasLegacyLimit = typeof req.query.limit !== "undefined";

  if (hasLegacyLimit && !hasPaginationQuery) {
    const limit = Number(req.query.limit ?? 100);
    return res.json({ traces: await readTracesLegacy(limit) });
  }

  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(pageSizeMax, Number(req.query.pageSize ?? pageSizeMax) || pageSizeMax));
  const traces = await readTraceWindow();
  const sorted = [...traces].sort((a, b) => b.at - a.at);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const paged = start >= total ? [] : sorted.slice(start, start + pageSize);
  const stats = buildTraceStats(sorted);

  return res.json({
    traces: paged,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
    },
    stats,
  });
});
app.get("/admin/stats/usage", adminGuard, async (req, res) => {
  const limit = Math.max(1, Math.min(5000, parseQueryNumber(req.query.limit) ?? 500));
  const accountIdFilter = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
  const routeFilter = typeof req.query.route === "string" ? req.query.route.trim() : "";
  const sinceMs = parseQueryNumber(req.query.sinceMs);

  const windowed = await readTraceWindow();
  const traces = windowed.slice(-limit);
  const filtered = traces.filter((t) => {
    if (accountIdFilter && t.accountId !== accountIdFilter) return false;
    if (routeFilter && t.route !== routeFilter) return false;
    if (typeof sinceMs === "number" && Number.isFinite(sinceMs) && t.at < sinceMs) return false;
    return true;
  });

  const globalAgg = createUsageAggregate();
  const byAccount = new Map<string, ReturnType<typeof createUsageAggregate>>();
  const byRoute = new Map<string, ReturnType<typeof createUsageAggregate>>();

  for (const trace of filtered) {
    addTraceToAggregate(globalAgg, trace);

    const accountKey = trace.accountId ?? "unknown";
    if (!byAccount.has(accountKey)) byAccount.set(accountKey, createUsageAggregate());
    addTraceToAggregate(byAccount.get(accountKey)!, trace);

    const routeKey = trace.route ?? "unknown";
    if (!byRoute.has(routeKey)) byRoute.set(routeKey, createUsageAggregate());
    addTraceToAggregate(byRoute.get(routeKey)!, trace);
  }

  const accounts = await store.listAccounts();
  const accountMeta = new Map(accounts.map((a) => [a.id, { id: a.id, email: a.email, enabled: a.enabled }]));

  const byAccountOut = Array.from(byAccount.entries())
    .map(([accountId, agg]) => ({
      accountId,
      account: accountMeta.get(accountId) ?? { id: accountId, email: undefined, enabled: undefined },
      ...finalizeAggregate(agg),
    }))
    .sort((a, b) => b.requests - a.requests);

  const byRouteOut = Array.from(byRoute.entries())
    .map(([route, agg]) => ({ route, ...finalizeAggregate(agg) }))
    .sort((a, b) => b.requests - a.requests);

  res.json({
    ok: true,
    filters: {
      limit,
      accountId: accountIdFilter || undefined,
      route: routeFilter || undefined,
      sinceMs,
    },
    totals: finalizeAggregate(globalAgg),
    byAccount: byAccountOut,
    byRoute: byRouteOut,
    tracesEvaluated: traces.length,
    tracesMatched: filtered.length,
  });
});

app.post("/admin/accounts", adminGuard, async (req, res) => {
  const body = req.body ?? {};
  if (!body.accessToken) return res.status(400).json({ error: "accessToken required" });
  const acc: Account = {
    id: body.id ?? randomUUID(), email: body.email, accessToken: body.accessToken, refreshToken: body.refreshToken,
    expiresAt: body.expiresAt, chatgptAccountId: body.chatgptAccountId, enabled: body.enabled ?? true,
    priority: body.priority ?? 0, usage: body.usage, state: body.state,
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
  const acc = (await store.listAccounts()).find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  acc.state = { ...acc.state, blockedUntil: undefined, blockedReason: undefined };
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});

app.post("/admin/accounts/:id/refresh-usage", adminGuard, async (req, res) => {
  let acc = (await store.listAccounts()).find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).json({ error: "not found" });
  acc = await ensureValidToken(acc);
  await refreshUsageIfNeeded(acc, CHATGPT_BASE_URL, true);
  await store.upsertAccount(acc);
  res.json({ ok: true, account: redact(acc) });
});
app.post("/admin/usage/refresh", adminGuard, async (_req, res) => {
  const refreshed = await Promise.all((await store.listAccounts()).map(async (a) => {
    const valid = await ensureValidToken(a);
    await refreshUsageIfNeeded(valid, CHATGPT_BASE_URL, true);
    return valid;
  }));
  await Promise.all(refreshed.map((a) => store.upsertAccount(a)));
  res.json({ ok: true, accounts: refreshed.map(redact) });
});

app.post("/admin/oauth/start", adminGuard, async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email required" });
  const flow = createOAuthState(email);
  await oauthStore.create(flow);
  const authorizeUrl = buildAuthorizationUrl(oauthConfig, flow);
  res.json({ ok: true, flowId: flow.id, authorizeUrl, expectedRedirectUri: oauthConfig.redirectUri });
});

app.get("/admin/oauth/status/:flowId", adminGuard, async (req, res) => {
  const flow = await oauthStore.get(req.params.flowId);
  if (!flow) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, flow: { ...flow, codeVerifier: undefined } });
});

app.post("/admin/oauth/complete", adminGuard, async (req, res) => {
  const flowId = String(req.body?.flowId ?? "").trim();
  const input = String(req.body?.input ?? "").trim();
  if (!flowId || !input) return res.status(400).json({ error: "flowId and input are required" });

  const flow = await oauthStore.get(flowId);
  if (!flow) return res.status(404).json({ error: "flow not found" });

  const parsed = parseAuthorizationInput(input);
  if (!parsed.code) return res.status(400).json({ error: "missing code in pasted input" });
  if (parsed.state && parsed.state !== flow.id) return res.status(400).json({ error: "state mismatch" });

  try {
    const tokenData = await exchangeCodeForToken(oauthConfig, parsed.code, flow.codeVerifier);
    let account = accountFromOAuth(flow, tokenData);
    account = await refreshUsageIfNeeded(account, CHATGPT_BASE_URL, true);
    await store.upsertAccount(account);
    await oauthStore.update(flow.id, { status: "success", completedAt: Date.now(), accountId: account.id });
    return res.json({ ok: true, account: redact(account) });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await oauthStore.update(flow.id, { status: "error", error: message, completedAt: Date.now() });
    return res.status(500).json({ error: `OAuth exchange failed: ${message}` });
  }
});

function isRetryableUpstreamError(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function takeNextSSEFrame(buffer: string): { frame: string; rest: string } | null {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  const lfBoundary = buffer.indexOf("\n\n");

  if (crlfBoundary === -1 && lfBoundary === -1) return null;

  if (crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary)) {
    return { frame: buffer.slice(0, crlfBoundary), rest: buffer.slice(crlfBoundary + 4) };
  }

  return { frame: buffer.slice(0, lfBoundary), rest: buffer.slice(lfBoundary + 2) };
}

async function fetchCodexWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      const errorText = await response.clone().text().catch(() => "");
      if (attempt < MAX_UPSTREAM_RETRIES && isRetryableUpstreamError(response.status, errorText)) {
        await sleep(UPSTREAM_BASE_DELAY_MS * (2 ** attempt));
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_UPSTREAM_RETRIES && !lastError.message.includes("usage limit")) {
        await sleep(UPSTREAM_BASE_DELAY_MS * (2 ** attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("failed after retries");
}

async function proxyWithRotation(req: express.Request, res: express.Response) {
  const startedAt = Date.now();
  const isChatCompletionsPath = (req.path || "").includes("chat/completions") || (req.originalUrl || "").includes("chat/completions");
  // Detect payload format: Chat Completions uses 'messages', Responses API uses 'input'
  const isChatCompletionsPayload = Array.isArray(req.body?.messages);
  const isChatCompletions = isChatCompletionsPath && isChatCompletionsPayload;
  const clientRequestedStream = Boolean(req.body?.stream);
  const sessionId = getSessionId(req);

  let accounts = await store.listAccounts();
  if (!accounts.length) return res.status(503).json({ error: "no accounts configured" });

  accounts = await Promise.all(accounts.map(async (a) => {
    const valid = await ensureValidToken(a);
    await refreshUsageIfNeeded(valid, CHATGPT_BASE_URL);
    return valid;
  }));
  await Promise.all(accounts.map((a) => store.upsertAccount(a)));

  const tried = new Set<string>();
  const maxAttempts = Math.min(accounts.length, MAX_ACCOUNT_RETRY_ATTEMPTS);
  for (let i = 0; i < maxAttempts; i++) {
    const selected = chooseAccount(accounts.filter((a) => !tried.has(a.id)));
    if (!selected) break;

    tried.add(selected.id);
    selected.state = { ...selected.state, lastSelectedAt: Date.now() };
    await store.upsertAccount(selected);

    // Use path to determine response format, payload format to determine upstream conversion
    const shouldReturnChatCompletions = isChatCompletionsPath;
    const payloadToUpstream = isChatCompletions
      ? chatCompletionsToResponsesPayload(req.body, sessionId)
      : normalizeResponsesPayload(req.body, sessionId);
    const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;
    const requestModel =
      (typeof req.body?.model === "string" && req.body.model.trim()) ? req.body.model.trim()
      : ((typeof payloadToUpstream?.model === "string" && payloadToUpstream.model.trim()) ? payloadToUpstream.model.trim() : undefined);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${selected.accessToken}`,
      accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "pi",
      "User-Agent": PI_USER_AGENT,
    };
    if (selected.chatgptAccountId) headers["chatgpt-account-id"] = selected.chatgptAccountId;
    if (sessionId) headers.session_id = sessionId;

    try {
      const upstream = await fetchCodexWithRetry(`${CHATGPT_BASE_URL}${UPSTREAM_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payloadToUpstream),
      });

      const contentType = upstream.headers.get("content-type") ?? "";
      const isStream = contentType.includes("text/event-stream");

      if (isStream) {
        if (shouldReturnChatCompletions && clientRequestedStream) {
          // Forward SSE stream with conversion from Responses API to Chat Completions format
          res.set("Content-Type", "text/event-stream");
          res.set("Cache-Control", "no-cache");
          res.set("Connection", "keep-alive");

          const model = req.body?.model ?? payloadToUpstream?.model ?? "unknown";
          let accumulatedUsage: any = null;
          let streamedFallbackText = "";

          if (!upstream.body) return res.end();
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let doneSent = false;

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;

              const payload = line.slice(5).trim();
              if (payload && payload !== "[DONE]") {
                try {
                  const event = JSON.parse(payload);
                  if (event?.type === "response.output_text.delta" && typeof event?.delta === "string") {
                    streamedFallbackText += sanitizeAssistantTextChunk(event.delta);
                  } else if (event?.type === "response.output_text.done" && !streamedFallbackText && typeof event?.text === "string") {
                    streamedFallbackText = sanitizeAssistantTextChunk(event.text);
                  }
                } catch {}
              }

              const converted = convertResponsesSSEToChatCompletionSSE(line, model, streamedFallbackText);
              if (converted) {
                res.write(converted);
                if (converted.includes("[DONE]")) doneSent = true;
              } else if (line.includes("\"response.reasoning")) {
                // Keep streaming clients alive for hidden reasoning events.
                res.write(": keepalive\n\n");
              }

              if (line.includes("response.completed")) {
                try {
                  const payload = JSON.parse(line.slice(5).trim());
                  accumulatedUsage = payload?.response?.usage;
                } catch {}
              }
            }
          }
          if (!doneSent) res.write("data: [DONE]\n\n");
          res.end();

          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: accumulatedUsage,
            requestBody,
          });
          return;
        }

        if (shouldReturnChatCompletions) {
          const txt = await upstream.text();
          const parsedChat = parseResponsesSSEToChatCompletion(txt, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          const normalized = ensureNonEmptyChatCompletion(parsedChat);
          res.status(upstream.ok ? 200 : upstream.status).json(normalized.chat);

          const upstreamError = !upstream.ok ? txt.slice(0, 500) : undefined;
          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: normalized.chat?.usage,
            requestBody,
            upstreamError,
            upstreamContentType: contentType,
            ...inspectAssistantPayload(normalized.chat),
          });
          return;
        }

        if (!clientRequestedStream) {
          const txt = await upstream.text();
          const respObj = parseResponsesSSEToResponseObject(txt);
          res.status(upstream.ok ? 200 : upstream.status).json(respObj);
          const upstreamError = !upstream.ok ? txt.slice(0, 500) : undefined;
          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: false,
            latencyMs: Date.now() - startedAt,
            usage: respObj?.usage,
            requestBody,
            upstreamError,
            upstreamContentType: contentType,
          });
          return;
        }

        res.status(upstream.status);
        setForwardHeaders(upstream, res);
        if (!upstream.body) return res.end();
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          while (true) {
            const next = takeNextSSEFrame(sseBuffer);
            if (!next) break;
            sseBuffer = next.rest;
            const filtered = sanitizeResponsesSSEFrame(next.frame);
            if (filtered !== null) res.write(`${filtered}\n\n`);
          }
        }

        sseBuffer += decoder.decode();
        while (true) {
          const next = takeNextSSEFrame(sseBuffer);
          if (!next) break;
          sseBuffer = next.rest;
          const filtered = sanitizeResponsesSSEFrame(next.frame);
          if (filtered !== null) res.write(`${filtered}\n\n`);
        }
        if (sseBuffer.trim()) {
          const filtered = sanitizeResponsesSSEFrame(sseBuffer);
          if (filtered !== null) res.write(`${filtered}\n\n`);
        }
        res.end();

        await appendTrace({
          at: Date.now(),
          route: req.path,
          accountId: selected.id,
          accountEmail: selected.email,
          model: requestModel,
          status: upstream.status,
          stream: true,
          latencyMs: Date.now() - startedAt,
          requestBody,
        });
        return;
      }

      // Some upstream responses may return JSON even when stream=true was requested.
      // Convert JSON chat completion to SSE so streaming clients (pi/openclaw) still render output.
      let bufferedText: string | undefined = undefined;
      if (shouldReturnChatCompletions && clientRequestedStream) {
        let raw = await upstream.text();
        const upstreamEmptyBody = !raw;
        if (!raw) raw = JSON.stringify({ error: `upstream ${upstream.status} with empty body` });
        bufferedText = raw;

        let parsed: any = undefined;
        try { parsed = JSON.parse(raw); } catch {}

        if (upstream.ok && parsed && parsed.object === "chat.completion") {
          const normalized = ensureNonEmptyChatCompletion(sanitizeChatCompletionObject(parsed));
          res.status(200);
          res.set("Content-Type", "text/event-stream");
          res.set("Cache-Control", "no-cache");
          res.set("Connection", "keep-alive");
          res.write(chatCompletionObjectToSSE(normalized.chat));
          res.end();

          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: normalized.chat?.usage,
            requestBody,
            upstreamContentType: contentType,
            upstreamEmptyBody,
            ...inspectAssistantPayload(normalized.chat),
          });
          return;
        }

        // If it's a JSON Responses object, convert to chat completion first then to SSE.
        if (upstream.ok && parsed && parsed.object === "response") {
          const converted = responseObjectToChatCompletion(parsed, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          res.status(200);
          res.set("Content-Type", "text/event-stream");
          res.set("Cache-Control", "no-cache");
          res.set("Connection", "keep-alive");
          res.write(chatCompletionObjectToSSE(converted));
          res.end();

          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: converted?.usage,
            requestBody,
            upstreamContentType: contentType,
            upstreamEmptyBody,
            ...inspectAssistantPayload(converted),
          });
          return;
        }

        // On error, fall through to normal handling.
      }

      let text = bufferedText ?? await upstream.text();
      const upstreamEmptyBody = !text;
      if (!text) text = JSON.stringify({ error: `upstream ${upstream.status} with empty body` });
      const upstreamError = !upstream.ok ? text.slice(0, 500) : undefined;

      let parsed: any = undefined;
      try { parsed = JSON.parse(text); } catch {}
      if (parsed?.object === "chat.completion") {
        parsed = sanitizeChatCompletionObject(parsed);
        text = JSON.stringify(parsed);
      } else if (parsed?.object === "response") {
        parsed = stripReasoningFromResponseObject(parsed);
        text = JSON.stringify(parsed);
      }

      // Hard guarantee for chat-completions streaming clients:
      // always return SSE, even when upstream returns JSON or SSE-like text without content-type.
      if (shouldReturnChatCompletions && clientRequestedStream && upstream.ok) {
        let chatResp: any = undefined;

        if (parsed?.object === "chat.completion") {
          chatResp = ensureNonEmptyChatCompletion(sanitizeChatCompletionObject(parsed)).chat;
        } else if (parsed?.object === "response") {
          chatResp = responseObjectToChatCompletion(parsed, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
        } else if (text.includes("data:")) {
          chatResp = parseResponsesSSEToChatCompletion(text, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
        }

        if (chatResp) {
          chatResp = ensureNonEmptyChatCompletion(chatResp).chat;
          res.status(200);
          res.set("Content-Type", "text/event-stream");
          res.set("Cache-Control", "no-cache");
          res.set("Connection", "keep-alive");
          res.write(chatCompletionObjectToSSE(chatResp));
          res.end();

          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: chatResp?.usage,
            requestBody,
            upstreamError,
            upstreamContentType: contentType,
            upstreamEmptyBody,
            ...inspectAssistantPayload(chatResp),
          });
          return;
        }
      }

      if (text.includes("event: response.")) {
        if (shouldReturnChatCompletions) {
          const parsedChat = parseResponsesSSEToChatCompletion(text, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          const normalized = ensureNonEmptyChatCompletion(parsedChat);
          res.status(upstream.ok ? 200 : upstream.status).json(normalized.chat);
          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: false,
            latencyMs: Date.now() - startedAt,
            usage: normalized.chat?.usage,
            requestBody,
            upstreamError,
            upstreamContentType: contentType,
            upstreamEmptyBody,
            ...inspectAssistantPayload(normalized.chat),
          });
          return;
        }

        const respObj = parseResponsesSSEToResponseObject(text);
        res.status(upstream.ok ? 200 : upstream.status).json(respObj);
        await appendTrace({
          at: Date.now(),
          route: req.path,
          accountId: selected.id,
          accountEmail: selected.email,
          model: requestModel,
          status: upstream.status,
          stream: false,
          latencyMs: Date.now() - startedAt,
          usage: respObj?.usage,
          requestBody,
          upstreamError,
          upstreamContentType: contentType,
          upstreamEmptyBody,
          ...inspectAssistantPayload(respObj),
        });
        return;
      }

      res.status(upstream.status);
      setForwardHeaders(upstream, res);
      res.type(contentType || "application/json").send(text);

      const usage = extractUsageFromPayload(parsed);

      await appendTrace({
        at: Date.now(),
        route: req.path,
        accountId: selected.id,
        accountEmail: selected.email,
        model: requestModel,
        status: upstream.status,
        stream: false,
        latencyMs: Date.now() - startedAt,
        usage,
        requestBody,
        upstreamError,
        upstreamContentType: contentType,
        upstreamEmptyBody,
        ...inspectAssistantPayload(parsed),
      });

      if (upstream.ok) return;
      if (upstream.status === 429 || isQuotaErrorText(text)) {
        markQuotaHit(selected, `quota/rate-limit: ${upstream.status}`);
        await store.upsertAccount(selected);
        continue;
      }

      rememberError(selected, `upstream ${upstream.status}: ${text.slice(0, 200)}`);
      await store.upsertAccount(selected);
      return;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      rememberError(selected, msg);
      await store.upsertAccount(selected);
      await appendTrace({
        at: Date.now(),
        route: req.path,
        accountId: selected.id,
        accountEmail: selected.email,
        model: requestModel,
        status: 599,
        stream: false,
        latencyMs: Date.now() - startedAt,
        error: msg,
        requestBody,
      });
    }
  }

  res.status(429).json({ error: "all accounts exhausted or unavailable" });
}

const PROXY_MODELS = (process.env.PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex").split(",").map((s) => s.trim()).filter(Boolean);
const MODELS_CLIENT_VERSION = process.env.MODELS_CLIENT_VERSION ?? "1.0.0";
const MODELS_CACHE_MS = Number(process.env.MODELS_CACHE_MS ?? 10 * 60_000);
type ExposedModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  metadata: {
    context_window: number | null;
    max_output_tokens: number | null;
    supports_reasoning: boolean;
    supports_tools: boolean;
    supported_tool_types: string[];
  };
};

let modelsCache: { at: number; models: ExposedModel[] } = { at: 0, models: [] };

function toSafeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstKnownNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const found = toSafeNumber(source[key]);
    if (found !== null) return found;
  }
  return null;
}

function modelObject(id: string, upstream?: Record<string, unknown>): ExposedModel {
  const upstreamObject = upstream ?? {};
  const contextWindow = firstKnownNumber(upstreamObject, ["context_window", "contextWindow", "max_context_tokens", "max_input_tokens"]);
  const maxOutputTokens = firstKnownNumber(upstreamObject, ["max_output_tokens", "maxOutputTokens"]);
  const toolTypesRaw = upstreamObject.tool_types;
  const supportedToolTypes = Array.isArray(toolTypesRaw)
    ? toolTypesRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : ["function"];
  const supportsTools = supportedToolTypes.length > 0;
  const supportsReasoning = typeof upstreamObject.supports_reasoning === "boolean"
    ? upstreamObject.supports_reasoning
    : id.includes("gpt-5") || id.includes("codex");

  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "multicodex-proxy",
    metadata: {
      context_window: contextWindow,
      max_output_tokens: maxOutputTokens,
      supports_reasoning: supportsReasoning,
      supports_tools: supportsTools,
      supported_tool_types: supportedToolTypes,
    },
  };
}

async function discoverModels(): Promise<ExposedModel[]> {
  if (Date.now() - modelsCache.at < MODELS_CACHE_MS && modelsCache.models.length) return modelsCache.models;

  try {
    const accounts = await store.listAccounts();
    const usable = accounts.find((a) => a.enabled && a.accessToken);
    if (!usable) throw new Error("no usable account");

    const headers: Record<string, string> = { authorization: `Bearer ${usable.accessToken}`, accept: "application/json" };
    if (usable.chatgptAccountId) headers["ChatGPT-Account-Id"] = usable.chatgptAccountId;

    const url = `${CHATGPT_BASE_URL}/backend-api/codex/models?client_version=${encodeURIComponent(MODELS_CLIENT_VERSION)}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`models upstream ${r.status}`);
    const json: any = await r.json();
    const upstream = Array.isArray(json?.models) ? json.models : [];
    const byId = new Map<string, ExposedModel>();

    for (const entry of upstream) {
      const slug = typeof entry?.slug === "string" && entry.slug.trim() ? entry.slug.trim() : "";
      if (!slug) continue;
      byId.set(slug, modelObject(slug, entry));
    }
    for (const id of PROXY_MODELS) {
      if (!byId.has(id)) byId.set(id, modelObject(id));
    }

    const merged = Array.from(byId.values());
    modelsCache = { at: Date.now(), models: merged };
    return merged;
  } catch {
    const fallback = Array.from(new Set(PROXY_MODELS)).map((id) => modelObject(id));
    modelsCache = { at: Date.now(), models: fallback };
    return fallback;
  }
}

app.get("/v1/models", async (_req, res) => {
  const models = await discoverModels();
  res.json({ object: "list", data: models });
});
app.get("/v1/models/:id", async (req, res) => {
  const id = req.params.id;
  const models = await discoverModels();
  const model = models.find((m) => m.id === id);
  if (!model) return res.status(404).json({ error: { message: `The model '${id}' does not exist`, type: "invalid_request_error" } });
  res.json(model);
});

app.post("/v1/chat/completions", proxyWithRotation);
app.post("/v1/responses", proxyWithRotation);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../web-dist");
app.use(express.static(webDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/admin/") || req.path.startsWith("/v1/") || req.path === "/health") return next();
  res.sendFile(path.join(webDist, "index.html"), (err) => { if (err) next(); });
});

app.listen(PORT, () => {
  console.log(`multicodex-proxy listening on :${PORT}`);
  console.log(`store=${STORE_PATH} oauth=${OAUTH_STATE_PATH} trace=${TRACE_FILE_PATH} redirect=${oauthConfig.redirectUri} upstream=${CHATGPT_BASE_URL}${UPSTREAM_PATH}`);
});
