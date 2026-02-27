import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
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

const PORT = Number(process.env.PORT ?? 4010);
const STORE_PATH = process.env.STORE_PATH ?? "/data/accounts.json";
const OAUTH_STATE_PATH = process.env.OAUTH_STATE_PATH ?? "/data/oauth-state.json";
const TRACE_FILE_PATH = process.env.TRACE_FILE_PATH ?? "/data/requests-trace.jsonl";
const TRACE_INCLUDE_BODY = (process.env.TRACE_INCLUDE_BODY ?? "true") === "true";
const CHATGPT_BASE_URL = process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com";
const UPSTREAM_PATH = process.env.UPSTREAM_PATH ?? "/backend-api/codex/responses";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

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

type TraceEntry = {
  at: number;
  route: string;
  accountId?: string;
  accountEmail?: string;
  status: number;
  stream: boolean;
  latencyMs: number;
  usage?: any;
  requestBody?: any;
  error?: string;
};

async function appendTrace(entry: TraceEntry) {
  await fs.appendFile(TRACE_FILE_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readTraces(limit = 200): Promise<TraceEntry[]> {
  try {
    const raw = await fs.readFile(TRACE_FILE_PATH, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const sliced = lines.slice(-Math.max(1, Math.min(limit, 2000)));
    return sliced.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function extractUsageFromPayload(payload: any) {
  return payload?.usage ?? payload?.response?.usage ?? payload?.metrics?.usage;
}

function setForwardHeaders(from: Response, to: express.Response) {
  for (const [k, v] of from.headers.entries()) if (k.toLowerCase() !== "content-length") to.setHeader(k, v);
}

app.get("/health", (_req, res) => res.json({ ok: true }));
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
  const limit = Number(req.query.limit ?? 100);
  res.json({ traces: await readTraces(limit) });
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

function toUpstreamInputContent(content: any) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (Array.isArray(content)) {
    const out: any[] = [];
    for (const part of content) {
      if (typeof part === "string") out.push({ type: "input_text", text: part });
      else if (part?.type === "text" && typeof part?.text === "string") out.push({ type: "input_text", text: part.text });
      else if (part?.type === "input_text" && typeof part?.text === "string") out.push({ type: "input_text", text: part.text });
    }
    return out.length ? out : [{ type: "input_text", text: JSON.stringify(content) }];
  }
  return [{ type: "input_text", text: String(content ?? "") }];
}

function normalizeResponsesPayload(body: any) {
  const b = { ...(body ?? {}) };
  if (!b.instructions) b.instructions = "You are a helpful assistant.";
  if (!Array.isArray(b.input)) {
    const text = typeof b.input === "string" ? b.input : (typeof b.prompt === "string" ? b.prompt : "");
    b.input = [{ role: "user", content: [{ type: "input_text", text }] }];
  }
  if (typeof b.store === "undefined") b.store = false;

  // Upstream codex for recent GPT-5 models rejects max_output_tokens.
  const model = String(b.model ?? "");
  if (model.startsWith("gpt-5") && typeof b.max_output_tokens !== "undefined") {
    delete b.max_output_tokens;
  }

  b.stream = true;
  return b;
}

function parseResponsesSSEToResponseObject(sseText: string) {
  let response: any = null;
  let outputText = "";
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj?.type === "response.output_text.delta") outputText += obj?.delta ?? "";
      if (obj?.type === "response.completed") response = obj?.response;
    } catch {}
  }
  if (!response) {
    return {
      id: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] }],
    };
  }
  return response;
}

function chatCompletionsToResponsesPayload(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemInstructions = messages
    .filter((m: any) => m?.role === "system")
    .map((m: any) => (typeof m?.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");

  // Filter out system messages and convert roles
  let input = messages
    .filter((m: any) => m?.role !== "system")
    .map((m: any) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: toUpstreamInputContent(m?.content),
    }));

  // Ensure first message is a user message (Responses API requirement)
  if (input.length > 0 && input[0]?.role === "assistant") {
    // Prepend a dummy user message if the conversation starts with assistant
    input = [
      { role: "user", content: [{ type: "input_text", text: " " }] },
      ...input,
    ];
  }

  const payload: any = {
    model: body?.model,
    instructions: body?.instructions || systemInstructions || "You are a helpful assistant.",
    input,
    store: false,
    stream: true,
  };

  // Forward tools if present (convert to Responses API format)
  if (body?.tools && Array.isArray(body.tools)) {
    payload.tools = body.tools.map((tool: any) => {
      if (tool.type === "function" && tool.function) {
        return {
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters_json: tool.function.parameters,
          strict: tool.function.strict,
        };
      }
      return tool;
    });
  }
  if (body?.tool_choice) {
    payload.tool_choice = body.tool_choice;
  }
  if (body?.temperature !== undefined) {
    payload.temperature = body.temperature;
  }
  if (body?.max_tokens !== undefined) {
    payload.max_output_tokens = body.max_tokens;
  }
  if (body?.max_completion_tokens !== undefined) {
    payload.max_output_tokens = body.max_completion_tokens;
  }

  return payload;
}

function parseResponsesSSEToChatCompletion(sseText: string, model: string) {
  let outputText = "";
  let usage: any = undefined;
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj?.type === "response.output_text.delta") outputText += obj?.delta ?? "";
      if (obj?.type === "response.output_text.done" && !outputText) outputText = obj?.text ?? "";
      if (obj?.type === "response.completed") usage = obj?.response?.usage;
    } catch {}
  }

  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: outputText }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
}

function convertResponsesSSEToChatCompletionSSE(upstreamLine: string, model: string): string | null {
  if (!upstreamLine.startsWith("data:")) return null;
  const payload = upstreamLine.slice(5).trim();
  if (!payload || payload === "[DONE]") return payload === "[DONE]" ? "data: [DONE]\n" : null;

  try {
    const obj = JSON.parse(payload);

    // Convert response.output_text.delta to chat completion delta
    if (obj?.type === "response.output_text.delta") {
      const delta = obj?.delta ?? "";
      // First chunk includes role, subsequent chunks only content
      const deltaObj: any = delta ? { content: delta } : {};
      const chatDelta = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: deltaObj, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chatDelta)}\n`;
    }

    // Convert response.output_text.done - contains full text, forward it
    if (obj?.type === "response.output_text.done") {
      const text = obj?.text ?? "";
      if (text) {
        const chatDelta = {
          id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
        return `data: ${JSON.stringify(chatDelta)}\n`;
      }
      return null;
    }

    // Convert response.completed to final chunk with usage
    if (obj?.type === "response.completed") {
      const usage = obj?.response?.usage;
      const finalChunk = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: usage?.total_tokens ?? 0,
        },
      };
      return `data: ${JSON.stringify(finalChunk)}\ndata: [DONE]\n`;
    }

    // Ignore other event types (response.created, etc.)
    return null;
  } catch {
    return null;
  }
}

async function proxyWithRotation(req: express.Request, res: express.Response) {
  const startedAt = Date.now();
  const isChatCompletions = (req.path || "").includes("chat/completions") || (req.originalUrl || "").includes("chat/completions");
  const clientRequestedStream = Boolean(req.body?.stream);

  let accounts = await store.listAccounts();
  if (!accounts.length) return res.status(503).json({ error: "no accounts configured" });

  accounts = await Promise.all(accounts.map(async (a) => {
    const valid = await ensureValidToken(a);
    await refreshUsageIfNeeded(valid, CHATGPT_BASE_URL);
    return valid;
  }));
  await Promise.all(accounts.map((a) => store.upsertAccount(a)));

  const tried = new Set<string>();
  for (let i = 0; i < accounts.length; i++) {
    const selected = chooseAccount(accounts.filter((a) => !tried.has(a.id)));
    if (!selected) break;

    tried.add(selected.id);
    selected.state = { ...selected.state, lastSelectedAt: Date.now() };
    await store.upsertAccount(selected);

    const payloadToUpstream = isChatCompletions ? chatCompletionsToResponsesPayload(req.body) : normalizeResponsesPayload(req.body);

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
        body: JSON.stringify(payloadToUpstream),
      });

      const contentType = upstream.headers.get("content-type") ?? "";
      const isStream = contentType.includes("text/event-stream");

      if (isStream) {
        if (isChatCompletions && clientRequestedStream) {
          // Forward SSE stream with conversion from Responses API to Chat Completions format
          res.set("Content-Type", "text/event-stream");
          res.set("Cache-Control", "no-cache");
          res.set("Connection", "keep-alive");

          const model = req.body?.model ?? payloadToUpstream?.model ?? "unknown";
          let accumulatedUsage: any = null;

          if (!upstream.body) return res.end();
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (line.startsWith("data:")) {
                const converted = convertResponsesSSEToChatCompletionSSE(line, model);
                if (converted) {
                  res.write(converted);
                  // Extract usage from final chunk
                  if (line.includes("response.completed")) {
                    try {
                      const payload = JSON.parse(line.slice(5).trim());
                      accumulatedUsage = payload?.response?.usage;
                    } catch {}
                  }
                }
              }
            }
          }

          res.write("data: [DONE]\n");
          res.end();

          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: accumulatedUsage,
            requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
          });
          return;
        }

        if (isChatCompletions) {
          const txt = await upstream.text();
          const chatResp = parseResponsesSSEToChatCompletion(txt, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          res.status(upstream.ok ? 200 : upstream.status).json(chatResp);

          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: chatResp?.usage,
            requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
          });
          return;
        }

        if (!clientRequestedStream) {
          const txt = await upstream.text();
          const respObj = parseResponsesSSEToResponseObject(txt);
          res.status(upstream.ok ? 200 : upstream.status).json(respObj);
          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            status: upstream.status,
            stream: false,
            latencyMs: Date.now() - startedAt,
            usage: respObj?.usage,
            requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
          });
          return;
        }

        res.status(upstream.status);
        setForwardHeaders(upstream, res);
        if (!upstream.body) return res.end();
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();

        await appendTrace({
          at: Date.now(),
          route: req.path,
          accountId: selected.id,
          accountEmail: selected.email,
          status: upstream.status,
          stream: true,
          latencyMs: Date.now() - startedAt,
          requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
        });
        return;
      }

      let text = await upstream.text();
      if (!text) text = JSON.stringify({ error: `upstream ${upstream.status} with empty body` });

      if (text.includes("event: response.")) {
        if (isChatCompletions) {
          const chatResp = parseResponsesSSEToChatCompletion(text, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          res.status(upstream.ok ? 200 : upstream.status).json(chatResp);
          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            status: upstream.status,
            stream: false,
            latencyMs: Date.now() - startedAt,
            usage: chatResp?.usage,
            requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
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
          status: upstream.status,
          stream: false,
          latencyMs: Date.now() - startedAt,
          usage: respObj?.usage,
          requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
        });
        return;
      }

      res.status(upstream.status);
      setForwardHeaders(upstream, res);
      res.type(contentType || "application/json").send(text);

      let parsed: any = undefined;
      try { parsed = JSON.parse(text); } catch {}
      const usage = extractUsageFromPayload(parsed);

      await appendTrace({
        at: Date.now(),
        route: req.path,
        accountId: selected.id,
        accountEmail: selected.email,
        status: upstream.status,
        stream: false,
        latencyMs: Date.now() - startedAt,
        usage,
        requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
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
        status: 599,
        stream: false,
        latencyMs: Date.now() - startedAt,
        error: msg,
        requestBody: TRACE_INCLUDE_BODY ? req.body : undefined,
      });
    }
  }

  res.status(429).json({ error: "all accounts exhausted or unavailable" });
}

const PROXY_MODELS = (process.env.PROXY_MODELS ?? "gpt-5.3-codex,gpt-5.2-codex,gpt-5-codex").split(",").map((s) => s.trim()).filter(Boolean);
const MODELS_CLIENT_VERSION = process.env.MODELS_CLIENT_VERSION ?? "1.0.0";
const MODELS_CACHE_MS = Number(process.env.MODELS_CACHE_MS ?? 10 * 60_000);
let modelsCache: { at: number; ids: string[] } = { at: 0, ids: [] };

function modelObject(id: string) {
  return { id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "multicodex-proxy" };
}

async function discoverModelIds(): Promise<string[]> {
  if (Date.now() - modelsCache.at < MODELS_CACHE_MS && modelsCache.ids.length) return modelsCache.ids;

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
    const ids = Array.isArray(json?.models)
      ? json.models.map((m: any) => m?.slug).filter((x: any) => typeof x === "string" && x)
      : [];

    const merged = Array.from(new Set([...PROXY_MODELS, ...ids]));
    modelsCache = { at: Date.now(), ids: merged };
    return merged;
  } catch {
    const fallback = Array.from(new Set(PROXY_MODELS));
    modelsCache = { at: Date.now(), ids: fallback };
    return fallback;
  }
}

app.get("/v1/models", async (_req, res) => {
  const ids = await discoverModelIds();
  res.json({ object: "list", data: ids.map(modelObject) });
});
app.get("/v1/models/:id", async (req, res) => {
  const id = req.params.id;
  const ids = await discoverModelIds();
  if (!ids.includes(id)) return res.status(404).json({ error: { message: `The model '${id}' does not exist`, type: "invalid_request_error" } });
  res.json(modelObject(id));
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
