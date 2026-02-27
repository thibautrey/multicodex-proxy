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

type TraceEntry = {
  id: string;
  at: number;
  route: string;
  accountId?: string;
  accountEmail?: string;
  model?: string;
  status: number;
  isError: boolean;
  stream: boolean;
  latencyMs: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  usage?: any;
  requestBody?: any;
  error?: string;
  upstreamError?: string;
  upstreamContentType?: string;
};

type TraceTotals = {
  requests: number;
  errors: number;
  errorRate: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  latencyAvgMs: number;
};

type TraceModelStats = {
  model: string;
  count: number;
  tokensTotal: number;
};

type TraceTimeseriesBucket = {
  at: number;
  requests: number;
  errors: number;
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
};

type TraceStats = {
  totals: TraceTotals;
  models: TraceModelStats[];
  timeseries: TraceTimeseriesBucket[];
};

const TRACE_RETENTION_MAX = 1000;
const TRACE_PAGE_SIZE_MAX = 100;
const TRACE_LEGACY_LIMIT_MAX = 2000;

let traceWriteQueue: Promise<void> = Promise.resolve();

function safeNumber(v: any): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeTokenFields(usage: any, fallback?: { input?: number; output?: number; total?: number }) {
  const input = safeNumber(usage?.input_tokens) ?? safeNumber(usage?.prompt_tokens) ?? fallback?.input;
  const output = safeNumber(usage?.output_tokens) ?? safeNumber(usage?.completion_tokens) ?? fallback?.output;
  const total = safeNumber(usage?.total_tokens) ?? fallback?.total ?? ((input ?? 0) + (output ?? 0));
  return {
    tokensInput: input,
    tokensOutput: output,
    tokensTotal: total,
  };
}

function normalizeTrace(raw: any): TraceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const at = safeNumber(raw.at);
  const route = typeof raw.route === "string" ? raw.route : "";
  const status = safeNumber(raw.status);
  const latencyMs = safeNumber(raw.latencyMs);
  if (!at || !route || typeof status === "undefined" || typeof latencyMs === "undefined") return null;

  const fallbackModel = typeof raw.requestBody?.model === "string" ? raw.requestBody.model : undefined;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : fallbackModel;
  const normalizedTokens = normalizeTokenFields(raw.usage, {
    input: safeNumber(raw.tokensInput),
    output: safeNumber(raw.tokensOutput),
    total: safeNumber(raw.tokensTotal),
  });

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `${at}-${route}-${status}`,
    at,
    route,
    accountId: typeof raw.accountId === "string" ? raw.accountId : undefined,
    accountEmail: typeof raw.accountEmail === "string" ? raw.accountEmail : undefined,
    model,
    status,
    isError: typeof raw.isError === "boolean" ? raw.isError : status >= 400,
    stream: Boolean(raw.stream),
    latencyMs,
    tokensInput: normalizedTokens.tokensInput,
    tokensOutput: normalizedTokens.tokensOutput,
    tokensTotal: normalizedTokens.tokensTotal,
    usage: raw.usage,
    requestBody: raw.requestBody,
    error: typeof raw.error === "string" ? raw.error : undefined,
    upstreamError: typeof raw.upstreamError === "string" ? raw.upstreamError : undefined,
    upstreamContentType: typeof raw.upstreamContentType === "string" ? raw.upstreamContentType : undefined,
  };
}

async function readTraceWindow(): Promise<TraceEntry[]> {
  try {
    const raw = await fs.readFile(TRACE_FILE_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const parsed: TraceEntry[] = [];
    for (const line of lines) {
      try {
        const normalized = normalizeTrace(JSON.parse(line));
        if (normalized) parsed.push(normalized);
      } catch {}
    }
    return parsed.slice(-TRACE_RETENTION_MAX);
  } catch {
    return [];
  }
}

async function writeTraceWindow(entries: TraceEntry[]): Promise<void> {
  const tmp = `${TRACE_FILE_PATH}.tmp-${randomUUID()}`;
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(tmp, content ? `${content}\n` : "", "utf8");
  await fs.rename(tmp, TRACE_FILE_PATH);
}

async function compactTraceStorageIfNeeded() {
  const traces = await readTraceWindow();
  try {
    const raw = await fs.readFile(TRACE_FILE_PATH, "utf8");
    const lineCount = raw.split("\n").filter(Boolean).length;
    if (lineCount !== traces.length || traces.length > TRACE_RETENTION_MAX) {
      await writeTraceWindow(traces.slice(-TRACE_RETENTION_MAX));
    }
  } catch {}
}

async function appendTrace(entry: Omit<TraceEntry, "id" | "isError" | "tokensInput" | "tokensOutput" | "tokensTotal">) {
  const normalizedTokens = normalizeTokenFields(entry.usage);
  const finalEntry: TraceEntry = {
    ...entry,
    id: randomUUID(),
    isError: entry.status >= 400,
    tokensInput: normalizedTokens.tokensInput,
    tokensOutput: normalizedTokens.tokensOutput,
    tokensTotal: normalizedTokens.tokensTotal,
  };

  const run = traceWriteQueue.then(async () => {
    const current = await readTraceWindow();
    const next = [...current, finalEntry].slice(-TRACE_RETENTION_MAX);
    await writeTraceWindow(next);
  });
  traceWriteQueue = run.catch(() => undefined);
  await run;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function buildTraceStats(traces: TraceEntry[]): TraceStats {
  const requests = traces.length;
  const errors = traces.filter((t) => t.isError).length;
  const tokensInput = traces.reduce((sum, t) => sum + (t.tokensInput ?? 0), 0);
  const tokensOutput = traces.reduce((sum, t) => sum + (t.tokensOutput ?? 0), 0);
  const tokensTotal = traces.reduce((sum, t) => sum + (t.tokensTotal ?? ((t.tokensInput ?? 0) + (t.tokensOutput ?? 0))), 0);
  const latencyAvgMs = requests ? traces.reduce((sum, t) => sum + t.latencyMs, 0) / requests : 0;
  const errorRate = requests ? errors / requests : 0;

  const modelMap = new Map<string, TraceModelStats>();
  for (const trace of traces) {
    const key = trace.model || "unknown";
    const existing = modelMap.get(key);
    if (!existing) modelMap.set(key, { model: key, count: 1, tokensTotal: trace.tokensTotal ?? 0 });
    else {
      existing.count += 1;
      existing.tokensTotal += trace.tokensTotal ?? 0;
    }
  }
  const models = Array.from(modelMap.values()).sort((a, b) => b.count - a.count);

  const bucketMap = new Map<number, { requests: number; errors: number; tokensInput: number; tokensOutput: number; tokensTotal: number; latencies: number[] }>();
  for (const trace of traces) {
    const bucketAt = Math.floor(trace.at / 3_600_000) * 3_600_000;
    const bucket = bucketMap.get(bucketAt) ?? {
      requests: 0,
      errors: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensTotal: 0,
      latencies: [],
    };
    bucket.requests += 1;
    if (trace.isError) bucket.errors += 1;
    bucket.tokensInput += trace.tokensInput ?? 0;
    bucket.tokensOutput += trace.tokensOutput ?? 0;
    bucket.tokensTotal += trace.tokensTotal ?? 0;
    bucket.latencies.push(trace.latencyMs);
    bucketMap.set(bucketAt, bucket);
  }
  const timeseries = Array.from(bucketMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([at, bucket]) => ({
      at,
      requests: bucket.requests,
      errors: bucket.errors,
      tokensInput: bucket.tokensInput,
      tokensOutput: bucket.tokensOutput,
      tokensTotal: bucket.tokensTotal,
      latencyP50Ms: percentile(bucket.latencies, 50),
      latencyP95Ms: percentile(bucket.latencies, 95),
    }));

  return {
    totals: {
      requests,
      errors,
      errorRate,
      tokensInput,
      tokensOutput,
      tokensTotal,
      latencyAvgMs,
    },
    models,
    timeseries,
  };
}

async function readTracesLegacy(limit = 200): Promise<TraceEntry[]> {
  const traces = await readTraceWindow();
  const sliced = traces.slice(-Math.max(1, Math.min(limit, TRACE_LEGACY_LIMIT_MAX)));
  return sliced;
}

function extractUsageFromPayload(payload: any) {
  return payload?.usage ?? payload?.response?.usage ?? payload?.metrics?.usage;
}

function setForwardHeaders(from: Response, to: express.Response) {
  for (const [k, v] of from.headers.entries()) if (k.toLowerCase() !== "content-length") to.setHeader(k, v);
}

await compactTraceStorageIfNeeded();

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
  const hasPaginationQuery = typeof req.query.page !== "undefined" || typeof req.query.pageSize !== "undefined";
  const hasLegacyLimit = typeof req.query.limit !== "undefined";

  if (hasLegacyLimit && !hasPaginationQuery) {
    const limit = Number(req.query.limit ?? 100);
    return res.json({ traces: await readTracesLegacy(limit) });
  }

  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.max(1, Math.min(TRACE_PAGE_SIZE_MAX, Number(req.query.pageSize ?? TRACE_PAGE_SIZE_MAX) || TRACE_PAGE_SIZE_MAX));
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

function toUpstreamInputContent(content: any, role: "user" | "assistant") {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (Array.isArray(content)) {
    const out: any[] = [];
    for (const part of content) {
      if (typeof part === "string") out.push({ type: textType, text: part });
      else if ((part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") && typeof part?.text === "string") {
        out.push({ type: textType, text: part.text });
      }
    }
    return out.length ? out : [{ type: textType, text: JSON.stringify(content) }];
  }
  return [{ type: textType, text: String(content ?? "") }];
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
    .map((m: any) => {
      const role = m?.role === "assistant" ? "assistant" : "user";
      return {
        role,
        content: toUpstreamInputContent(m?.content, role),
      };
    });

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
  // Note: Responses API doesn't support max_output_tokens, so we skip it
  // if (body?.max_tokens !== undefined) { payload.max_output_tokens = body.max_tokens; }

  return payload;
}

function responseObjectToChatCompletion(resp: any, model: string) {
  let outputText = "";
  const toolCalls = Array.isArray(resp?.output)
    ? resp.output
      .flatMap((it: any) => {
        if (it?.type === "message") {
          const parts = Array.isArray(it?.content) ? it.content : [];
          for (const p of parts) {
            if ((p?.type === "output_text" || p?.type === "text") && typeof p?.text === "string") outputText += p.text;
          }
          return [];
        }
        if (it?.type === "function_call") {
          return [{
            id: it?.call_id || it?.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name: it?.name ?? "unknown",
              arguments: typeof it?.arguments === "string" ? it.arguments : JSON.stringify(it?.arguments ?? {}),
            },
          }];
        }
        return [];
      })
    : [];

  const usage = resp?.usage;
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: any = { role: "assistant", content: outputText || "" };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc: any, idx: number) => ({ ...tc, index: idx }));
  }

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
}

function parseResponsesSSEToChatCompletion(sseText: string, model: string) {
  let outputText = "";
  let usage: any = undefined;
  let completedResponse: any = undefined;

  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj?.type === "response.output_text.delta") outputText += obj?.delta ?? "";
      if (obj?.type === "response.output_text.done" && !outputText) outputText = obj?.text ?? "";
      if (obj?.type === "response.completed") {
        usage = obj?.response?.usage;
        completedResponse = obj?.response;
      }
    } catch {}
  }

  if (completedResponse) {
    const converted = responseObjectToChatCompletion(completedResponse, model);
    if (!converted?.choices?.[0]?.message?.content && outputText) {
      converted.choices[0].message.content = outputText;
    }
    return converted;
  }

  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const total = usage?.total_tokens ?? prompt + completion;

  return {
    id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: outputText || "" }, finish_reason: "stop" }],
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
      const chatDelta = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: delta ? { content: delta } : {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chatDelta)}\n`;
    }

    // Convert response.output_text.done - contains full text, forward it
    if (obj?.type === "response.output_text.done") {
      const text = obj?.text ?? "";
      if (!text) return null;
      const chatDelta = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chatDelta)}\n`;
    }

    // Convert response.completed to final chunk (supports tool_calls)
    if (obj?.type === "response.completed") {
      const usage = obj?.response?.usage;
      const toolCalls = Array.isArray(obj?.response?.output)
        ? obj.response.output
          .filter((it: any) => it?.type === "function_call")
          .map((it: any, idx: number) => ({
            index: idx,
            id: it?.call_id || it?.id || `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name: it?.name ?? "unknown",
              arguments: typeof it?.arguments === "string" ? it.arguments : JSON.stringify(it?.arguments ?? {}),
            },
          }))
        : [];

      const finalChunk = {
        id: `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: toolCalls.length ? { tool_calls: toolCalls } : {},
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        }],
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: usage?.total_tokens ?? 0,
        },
      };
      return `data: ${JSON.stringify(finalChunk)}\ndata: [DONE]\n`;
    }

    return null;
  } catch {
    return null;
  }
}

function chatCompletionObjectToSSE(chatObj: any): string {
  const id = chatObj?.id || `chatcmpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const model = chatObj?.model || "unknown";
  const created = chatObj?.created || Math.floor(Date.now() / 1000);
  const choice = chatObj?.choices?.[0] || {};
  const content = choice?.message?.content ?? "";
  const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
  const finishReason = choice?.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop");
  const usage = chatObj?.usage || {};

  const chunks: string[] = [];
  if (content) {
    chunks.push(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n`);
  }

  chunks.push(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta: toolCalls.length ? { tool_calls: toolCalls } : {},
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
    },
  })}\n`);

  chunks.push("data: [DONE]\n");
  return chunks.join("");
}

async function proxyWithRotation(req: express.Request, res: express.Response) {
  const startedAt = Date.now();
  const isChatCompletionsPath = (req.path || "").includes("chat/completions") || (req.originalUrl || "").includes("chat/completions");
  // Detect payload format: Chat Completions uses 'messages', Responses API uses 'input'
  const isChatCompletionsPayload = Array.isArray(req.body?.messages);
  const isChatCompletions = isChatCompletionsPath && isChatCompletionsPayload;
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

    // Use path to determine response format, payload format to determine upstream conversion
    const shouldReturnChatCompletions = isChatCompletionsPath;
    const payloadToUpstream = isChatCompletions ? chatCompletionsToResponsesPayload(req.body) : normalizeResponsesPayload(req.body);
    const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;
    const requestModel =
      (typeof req.body?.model === "string" && req.body.model.trim()) ? req.body.model.trim()
      : ((typeof payloadToUpstream?.model === "string" && payloadToUpstream.model.trim()) ? payloadToUpstream.model.trim() : undefined);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${selected.accessToken}`,
      // Force SSE upstream when client requested stream to avoid JSON response passthrough mismatch
      accept: clientRequestedStream ? "text/event-stream" : (req.header("accept") ?? "application/json"),
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
        if (shouldReturnChatCompletions && clientRequestedStream) {
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
          const chatResp = parseResponsesSSEToChatCompletion(txt, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          res.status(upstream.ok ? 200 : upstream.status).json(chatResp);

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
            usage: chatResp?.usage,
            requestBody,
            upstreamError,
            upstreamContentType: contentType,
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
        if (!raw) raw = JSON.stringify({ error: `upstream ${upstream.status} with empty body` });
        bufferedText = raw;

        let parsed: any = undefined;
        try { parsed = JSON.parse(raw); } catch {}

        if (upstream.ok && parsed && parsed.object === "chat.completion") {
          res.status(200);
          res.set("Content-Type", "text/event-stream");
          res.set("Cache-Control", "no-cache");
          res.set("Connection", "keep-alive");
          res.write(chatCompletionObjectToSSE(parsed));
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
            usage: parsed?.usage,
            requestBody,
            upstreamContentType: contentType,
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
          });
          return;
        }

        // On error, fall through to normal handling.
      }

      let text = bufferedText ?? await upstream.text();
      if (!text) text = JSON.stringify({ error: `upstream ${upstream.status} with empty body` });
      const upstreamError = !upstream.ok ? text.slice(0, 500) : undefined;

      if (text.includes("event: response.")) {
        if (shouldReturnChatCompletions) {
          const chatResp = parseResponsesSSEToChatCompletion(text, req.body?.model ?? payloadToUpstream?.model ?? "unknown");
          res.status(upstream.ok ? 200 : upstream.status).json(chatResp);
          await appendTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: requestModel,
            status: upstream.status,
            stream: false,
            latencyMs: Date.now() - startedAt,
            usage: chatResp?.usage,
            requestBody,
            upstreamError,
            upstreamContentType: contentType,
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
        model: requestModel,
        status: upstream.status,
        stream: false,
        latencyMs: Date.now() - startedAt,
        usage,
        requestBody,
        upstreamError,
        upstreamContentType: contentType,
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
