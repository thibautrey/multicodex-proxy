import {
  MAX_ACCOUNT_RETRY_ATTEMPTS,
  MAX_GET_RETRIES,
  MODELS_CACHE_MS,
  MODELS_CLIENT_VERSION,
  MODEL_DISCOVERY_TIMEOUT_MS,
  PI_USER_AGENT,
  PROXY_MODELS,
  RETRY_BASE_DELAY_MS,
  TRACE_INCLUDE_BODY,
  UPSTREAM_PATH,
  UPSTREAM_COMPACT_PATH,
  UPSTREAM_REQUEST_TIMEOUT_MS,
} from "../../config.js";
import {
  chatCompletionObjectToSSE,
  convertResponsesSSEToChatCompletionSSE,
  parseResponsesSSEToChatCompletion,
  parseResponsesSSEToResponseObject,
  responseObjectToChatCompletion,
  responseObjectToSSE,
} from "../../responses/converters.js";
import {
  chatCompletionsToResponsesPayload,
  extractUsageFromPayload,
  getSessionId,
  inspectAssistantPayload,
  normalizeResponsesPayload,
} from "../../responses/payloads.js";
import {
  chooseAccountForProvider,
  accountSupportsModel,
  clearAuthFailureState,
  isQuotaErrorText,
  markModelCompatibility,
  markAuthFailure,
  markModelUnsupported,
  markQuotaHit,
  normalizeProvider,
  refreshUsageIfNeeded,
  rememberError,
  USAGE_CACHE_TTL_MS,
} from "../../quota.js";
import {
  ensureNonEmptyChatCompletion,
  sanitizeAssistantTextChunk,
  sanitizeChatCompletionObject,
  sanitizeResponsesSSEFrame,
  stripReasoningFromResponseObject,
} from "../../responses/sanitizers.js";

import { AccountStore } from "../../store.js";
import type { OAuthConfig } from "../../oauth.js";
import { TraceManager } from "../../traces.js";
import { ensureValidToken } from "../../account-utils.js";
import type { ModelAlias, ProviderId } from "../../types.js";
import express from "express";

type ProxyRoutesOptions = {
  store: AccountStore;
  traceManager: TraceManager;
  openaiBaseUrl: string;
  mistralBaseUrl: string;
  mistralUpstreamPath: string;
  mistralCompactUpstreamPath: string;
  oauthConfig: OAuthConfig;
  upstreamRequestTimeoutMs?: number;
};

const modelsCache: { at: number; models: ExposedModel[] } = {
  at: 0,
  models: [],
};

export function resetDiscoveredModelsCacheForTest() {
  modelsCache.at = 0;
  modelsCache.models = [];
}

type ExposedModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  metadata: {
    provider: ProviderId;
    context_window: number | null;
    max_output_tokens: number | null;
    supports_reasoning: boolean;
    supports_tools: boolean;
    supported_tool_types: string[];
    is_alias?: boolean;
    alias_targets?: string[];
  };
};

function toSafeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstKnownNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const found = toSafeNumber(source[key]);
    if (found !== null) return found;
  }
  return null;
}

function modelObject(
  id: string,
  provider: ProviderId,
  upstream?: Record<string, unknown>,
): ExposedModel {
  const upstreamObject = upstream ?? {};
  const contextWindow = firstKnownNumber(upstreamObject, [
    "context_window",
    "contextWindow",
    "max_context_tokens",
    "max_input_tokens",
  ]);
  const maxOutputTokens = firstKnownNumber(upstreamObject, [
    "max_output_tokens",
    "maxOutputTokens",
  ]);
  const toolTypesRaw = upstreamObject.tool_types;
  const supportedToolTypes = Array.isArray(toolTypesRaw)
    ? toolTypesRaw.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      )
    : ["function"];
  const supportsTools = supportedToolTypes.length > 0;
  const supportsReasoning =
    typeof upstreamObject.supports_reasoning === "boolean"
      ? upstreamObject.supports_reasoning
      : id.includes("gpt-5") || id.includes("codex");

  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: provider,
    metadata: {
      provider,
      context_window: contextWindow,
      max_output_tokens: maxOutputTokens,
      supports_reasoning: supportsReasoning,
      supports_tools: supportsTools,
      supported_tool_types: supportedToolTypes,
    },
  };
}

function normalizeModelLookupKey(model?: string): string {
  const raw = (model ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (!raw.includes("/")) return raw;
  const tail = raw.split("/").pop()?.trim();
  return tail || raw;
}

function inferProviderFromModel(
  model: string | undefined,
  discoveredModels: ExposedModel[],
): ProviderId {
  const key = normalizeModelLookupKey(model);
  if (!key) return "openai";

  const discovered = discoveredModels.find(
    (m) => normalizeModelLookupKey(m.id) === key,
  );
  if (discovered) return discovered.metadata.provider;

  if (
    key.startsWith("gpt-") ||
    key.startsWith("o1") ||
    key.startsWith("o3") ||
    key.startsWith("o4") ||
    key.startsWith("text-embedding-") ||
    key.startsWith("whisper-") ||
    key.includes("codex")
  ) {
    return "openai";
  }

  if (
    key.startsWith("mistral") ||
    key.startsWith("codestral") ||
    key.startsWith("ministral") ||
    key.startsWith("pixtral") ||
    key.startsWith("open-mistral") ||
    key.startsWith("open-mixtral")
  ) {
    return "mistral";
  }

  return "openai";
}

async function discoverModels(
  store: AccountStore,
  openaiBaseUrl: string,
  mistralBaseUrl: string,
): Promise<ExposedModel[]> {
  if (
    Date.now() - modelsCache.at < MODELS_CACHE_MS &&
    modelsCache.models.length
  )
    return modelsCache.models;

  try {
    const accounts = await store.listAccounts();
    const byId = new Map<string, ExposedModel>();

    const openaiAccount = accounts.find(
      (a) => a.enabled && a.accessToken && normalizeProvider(a) === "openai",
    );
    if (openaiAccount) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${openaiAccount.accessToken}`,
          accept: "application/json",
        };
        if (openaiAccount.chatgptAccountId) {
          headers["ChatGPT-Account-Id"] = openaiAccount.chatgptAccountId;
        }
        const url = `${openaiBaseUrl}/backend-api/codex/models?client_version=${encodeURIComponent(
          MODELS_CLIENT_VERSION,
        )}`;
        const r = await fetchCodexWithRetry(url, { headers });
        if (r.ok) {
          const json: any = await r.json();
          const upstream = Array.isArray(json?.models) ? json.models : [];
          for (const entry of upstream) {
            const slug =
              typeof entry?.slug === "string" && entry.slug.trim()
                ? entry.slug.trim()
                : "";
            if (!slug) continue;
            byId.set(slug, modelObject(slug, "openai", entry));
          }
        }
      } catch {}
    }

    const mistralAccount = accounts.find(
      (a) => a.enabled && a.accessToken && normalizeProvider(a) === "mistral",
    );
    if (mistralAccount) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${mistralAccount.accessToken}`,
          accept: "application/json",
        };
        const r = await fetchCodexWithRetry(`${mistralBaseUrl}/v1/models`, {
          headers,
        });
        if (r.ok) {
          const json: any = await r.json();
          const upstream = Array.isArray(json?.data) ? json.data : [];
          for (const entry of upstream) {
            const id =
              typeof entry?.id === "string" && entry.id.trim()
                ? entry.id.trim()
                : "";
            if (!id) continue;
            byId.set(id, modelObject(id, "mistral", entry));
          }
        }
      } catch {}
    }

    for (const id of PROXY_MODELS) {
      if (!byId.has(id)) byId.set(id, modelObject(id, "openai"));
    }

    const aliases = store
      .getCachedModelAliases()
      .filter((a) => a.enabled && a.targets.length > 0);
    for (const alias of aliases) {
      const firstTarget = alias.targets[0];
      const provider = inferProviderFromModel(firstTarget, Array.from(byId.values()));
      byId.set(alias.id, {
        ...modelObject(alias.id, provider),
        metadata: {
          ...modelObject(alias.id, provider).metadata,
          is_alias: true,
          alias_targets: [...alias.targets],
        },
      });
    }
    if (!byId.size) throw new Error("no models discovered");

    const merged = Array.from(byId.values());
    modelsCache.at = Date.now();
    modelsCache.models = merged;
    return merged;
  } catch {
    const fallback = Array.from(new Set(PROXY_MODELS)).map((id) =>
      modelObject(id, "openai"),
    );
    modelsCache.at = Date.now();
    modelsCache.models = fallback;
    return fallback;
  }
}

type RoutingCandidate = {
  requestedModel: string | undefined;
  resolvedModel: string | undefined;
  provider: ProviderId;
};

function buildRoutingCandidates(
  requestModel: string | undefined,
  discoveredModels: ExposedModel[],
  aliases: ModelAlias[],
): RoutingCandidate[] {
  const key = normalizeModelLookupKey(requestModel);
  const alias = aliases.find((a) => a.enabled && normalizeModelLookupKey(a.id) === key);
  const targets =
    alias && alias.targets.length
      ? alias.targets
      : requestModel
        ? [requestModel]
        : [];

  const out: RoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const targetKey = normalizeModelLookupKey(target);
    if (!targetKey || seen.has(targetKey)) continue;
    seen.add(targetKey);
    out.push({
      requestedModel: requestModel,
      resolvedModel: target,
      provider: inferProviderFromModel(target, discoveredModels),
    });
  }

  if (out.length) return out;
  return [
    {
      requestedModel: requestModel,
      resolvedModel: requestModel,
      provider: inferProviderFromModel(requestModel, discoveredModels),
    },
  ];
}

type SSEFrame = { frame: string; rest: string } | null;

function takeNextSSEFrame(buffer: string): SSEFrame {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  const lfBoundary = buffer.indexOf("\n\n");

  if (crlfBoundary === -1 && lfBoundary === -1) return null;

  if (crlfBoundary !== -1 && (lfBoundary === -1 || crlfBoundary < lfBoundary)) {
    return {
      frame: buffer.slice(0, crlfBoundary),
      rest: buffer.slice(crlfBoundary + 4),
    };
  }

  return {
    frame: buffer.slice(0, lfBoundary),
    rest: buffer.slice(lfBoundary + 2),
  };
}

function frameSignalsResponseCompleted(frame: string): boolean {
  return (
    /(?:^|\r?\n)event:\s*response\.completed\b/.test(frame) ||
    frame.includes('"response.completed"')
  );
}

function frameSignalsOutputTextDone(frame: string): boolean {
  return (
    /(?:^|\r?\n)event:\s*response\.output_text\.done\b/.test(frame) ||
    frame.includes('"response.output_text.done"')
  );
}

function frameSignalsResponseTerminal(frame: string): boolean {
  return (
    frameSignalsResponseCompleted(frame) || frameSignalsOutputTextDone(frame)
  );
}

function extractSSEDataPayload(frame: string): any | undefined {
  try {
    const dataLine = frame
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("data:"));
    if (!dataLine) return undefined;
    return JSON.parse(dataLine.slice(5).trim());
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRequestSignal(
  timeoutMs: number,
  upstreamAbort?: AbortSignal,
): { signal: AbortSignal; clearTimeout: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const clearTimeoutOnly = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const onAbort = () => controller.abort(upstreamAbort?.reason);
  if (upstreamAbort) {
    if (upstreamAbort.aborted) {
      controller.abort(upstreamAbort.reason);
    } else {
      upstreamAbort.addEventListener("abort", onAbort, { once: true });
    }
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeoutOnly();
      if (upstreamAbort) upstreamAbort.removeEventListener("abort", onAbort);
    },
    { once: true },
  );
  return {
    signal: controller.signal,
    clearTimeout: clearTimeoutOnly,
  };
}

async function readChunkWithInactivityTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => {});
      reject(new Error(`response stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => {});
      const reason = abortSignal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function readResponseTextWithInactivityTimeout(
  response: Response,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  return readReaderTextWithInactivityTimeout(
    reader,
    new TextDecoder(),
    timeoutMs,
    abortSignal,
  );
}

async function readReaderTextWithInactivityTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  initialText = "",
): Promise<string> {
  let text = initialText;

  while (true) {
    const { value, done } = await readChunkWithInactivityTimeout(
      reader,
      timeoutMs,
      abortSignal,
    );
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

async function peekResponseTextStart(
  response: Response,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  decoder: TextDecoder;
  initialText: string;
}> {
  const decoder = new TextDecoder();
  if (!response.body) {
    return { reader: null, decoder, initialText: "" };
  }
  const reader = response.body.getReader();
  const { value, done } = await readChunkWithInactivityTimeout(
    reader,
    timeoutMs,
    abortSignal,
  );
  if (done) {
    return {
      reader,
      decoder,
      initialText: decoder.decode(),
    };
  }

  return {
    reader,
    decoder,
    initialText: decoder.decode(value, { stream: true }),
  };
}

function looksLikeSSEPayload(text: string): boolean {
  return /(?:^|\r?\n)(event:|data:)\s*/.test(text);
}

async function readResponsesSSETextUntilTerminalFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  initialText = "",
): Promise<string> {
  let text = initialText;
  let sseBuffer = initialText;
  let completed = false;

  while (true) {
    const { value, done } = await readChunkWithInactivityTimeout(
      reader,
      timeoutMs,
      abortSignal,
    );
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    while (true) {
      const next = takeNextSSEFrame(sseBuffer);
      if (!next) break;
      sseBuffer = next.rest;
      text += `${next.frame}\n\n`;
      if (frameSignalsResponseTerminal(next.frame)) {
        completed = true;
        break;
      }
    }

    if (completed) break;
  }

  if (!completed) {
    sseBuffer += decoder.decode();
    while (true) {
      const next = takeNextSSEFrame(sseBuffer);
      if (!next) break;
      sseBuffer = next.rest;
      text += `${next.frame}\n\n`;
      if (frameSignalsResponseTerminal(next.frame)) {
        completed = true;
        break;
      }
    }
    if (!completed && sseBuffer.trim()) text += sseBuffer;
  }

  if (completed) void reader.cancel().catch(() => {});
  return text;
}

async function readResponsesSSETextUntilTerminal(
  response: Response,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  return readResponsesSSETextUntilTerminalFromReader(
    response.body.getReader(),
    new TextDecoder(),
    timeoutMs,
    abortSignal,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /timed out|aborted/i.test(error.message))
  );
}

function isDownstreamClientDisconnect(
  error: unknown,
  abortSignal?: AbortSignal,
): boolean {
  return (
    Boolean(abortSignal?.aborted) ||
    (error instanceof Error &&
      /downstream client disconnected/i.test(error.message))
  );
}

function isRetryableUpstreamError(status: number, errorText: string): boolean {
  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
    return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function isAuthFailure(status: number, errorText: string): boolean {
  if (status === 401) return true;
  return /token_expired|invalid[_ -]?token|refresh[_ -]?token|unauthorized|auth/i.test(
    errorText,
  );
}

function isModelUnsupported(status: number, errorText: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /model.+not supported|unsupported model|does not exist|not available|unknown model/i.test(
    errorText,
  );
}

async function fetchCodexWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | undefined;
  const maxAttempts = Math.max(0, MAX_GET_RETRIES);
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const requestSignal = createRequestSignal(
        MODEL_DISCOVERY_TIMEOUT_MS,
        signal,
      );
      const response = await fetch(url, {
        ...init,
        signal: requestSignal.signal,
      });
      requestSignal.clearTimeout();
      if (response.ok) return response;
      const errorText = await response
        .clone()
        .text()
        .catch(() => "");
      if (
        attempt < maxAttempts &&
        isRetryableUpstreamError(response.status, errorText)
      ) {
        await sleep(
          Math.floor(
            RETRY_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random()),
          ),
        );
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt < maxAttempts &&
        !lastError.message.includes("usage limit") &&
        !isAbortError(lastError)
      ) {
        await sleep(
          Math.floor(
            RETRY_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random()),
          ),
        );
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("failed after retries");
}

export function createProxyRouter(options: ProxyRoutesOptions) {
    const {
      store,
      traceManager,
      openaiBaseUrl,
      mistralBaseUrl,
      mistralUpstreamPath,
      mistralCompactUpstreamPath,
      oauthConfig,
      upstreamRequestTimeoutMs = UPSTREAM_REQUEST_TIMEOUT_MS,
    } = options;
  const { appendTrace } = traceManager;
  const router = express.Router();

  function refreshUsageInBackground(account: any, usageBaseUrl: string) {
    void refreshUsageIfNeeded(account, usageBaseUrl)
      .then((refreshed) => store.upsertAccount(refreshed))
      .catch(() => undefined);
  }

  async function proxyWithRotation(
    req: express.Request,
    res: express.Response,
  ) {
    const startedAt = Date.now();
    const isChatCompletionsPath =
      (req.path || "").includes("chat/completions") ||
      (req.originalUrl || "").includes("chat/completions");
    const isChatCompletionsPayload = Array.isArray(req.body?.messages);
    const isChatCompletions = isChatCompletionsPath && isChatCompletionsPayload;
    const isResponsesCompactPath =
      (req.path || "").includes("responses/compact") ||
      (req.originalUrl || "").includes("responses/compact");
    const clientRequestedStream = Boolean(req.body?.stream);
    const sessionId = getSessionId(req);
    const clientAbort = new AbortController();
    const abortFromClient = () => {
      if (!clientAbort.signal.aborted) {
        clientAbort.abort(new Error("downstream client disconnected"));
      }
    };
    req.on("aborted", abortFromClient);
    res.on("close", () => {
      if (!res.writableEnded) abortFromClient();
    });

let accounts = store.getCachedAccounts();
    if (!accounts.length)
      return res.status(503).json({ error: "no accounts configured" });

    accounts = await Promise.all(
      accounts.map(async (account) => {
        const valid = await ensureValidToken(account, oauthConfig);
        const usageBaseUrl =
          normalizeProvider(valid) === "mistral" ? mistralBaseUrl : openaiBaseUrl;
        const usageFetchedAt = valid.usage?.fetchedAt ?? 0;
        if (Date.now() - usageFetchedAt >= USAGE_CACHE_TTL_MS) {
          refreshUsageInBackground(valid, usageBaseUrl);
        }
        return valid;
      }),
    );
    for (const account of accounts) store.markAccountModified(account.id, account);

    const requestModel =
      typeof req.body?.model === "string" && req.body.model.trim()
        ? req.body.model.trim()
        : undefined;
    const modelAliases = store.getCachedModelAliases();
    const routingCandidates = buildRoutingCandidates(
      requestModel,
      modelsCache.models,
      modelAliases,
    );
    const tried = new Set<string>();
    const maxAttempts = Math.min(accounts.length, MAX_ACCOUNT_RETRY_ATTEMPTS);
    let providerTried = false;
    let lastModelUnsupported:
      | { status: number; text: string; contentType: string }
      | undefined;

    for (const candidate of routingCandidates) {
      const providerAccounts = accounts.filter(
        (a) =>
          normalizeProvider(a) === candidate.provider &&
          accountSupportsModel(a, candidate.resolvedModel ?? requestModel),
      );
      if (!providerAccounts.length) continue;
      providerTried = true;

      const attemptsForProvider = Math.min(
        providerAccounts.length,
        maxAttempts,
      );
      for (let i = 0; i < attemptsForProvider; i++) {
        const selected = chooseAccountForProvider(
          providerAccounts.filter((a) => !tried.has(a.id)),
          candidate.provider,
        );
      if (!selected) break;

      tried.add(selected.id);
      selected.state = { ...selected.state, lastSelectedAt: Date.now() };
      await store.upsertAccount(selected);

      const shouldReturnChatCompletions = isChatCompletionsPath;
      let payloadToUpstream = isChatCompletions
        ? chatCompletionsToResponsesPayload(req.body, sessionId)
        : normalizeResponsesPayload(req.body, sessionId);
      if (isResponsesCompactPath && payloadToUpstream && typeof payloadToUpstream === "object") {
        delete payloadToUpstream.store;
        delete payloadToUpstream.stream;
        delete payloadToUpstream.include;
        delete payloadToUpstream.tool_choice;
        delete payloadToUpstream.parallel_tool_calls;
      }
      if (candidate.resolvedModel) payloadToUpstream.model = candidate.resolvedModel;
      const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;
      const tracedModel =
        requestModel ??
        (typeof payloadToUpstream?.model === "string" &&
        payloadToUpstream.model.trim()
          ? payloadToUpstream.model.trim()
          : undefined);

      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${selected.accessToken}`,
        accept: "text/event-stream",
        originator: "pi",
        "User-Agent": PI_USER_AGENT,
      };
      if (candidate.provider === "openai") {
        headers["OpenAI-Beta"] = "responses=experimental";
      }
      if (candidate.provider === "openai" && selected.chatgptAccountId) {
        headers["chatgpt-account-id"] = selected.chatgptAccountId;
      }
      if (sessionId) headers.session_id = sessionId;

      try {
        const upstreamBaseUrl =
          candidate.provider === "mistral" ? mistralBaseUrl : openaiBaseUrl;
        const upstreamPath =
          candidate.provider === "mistral"
            ? isResponsesCompactPath
              ? mistralCompactUpstreamPath
              : mistralUpstreamPath
            : isResponsesCompactPath
              ? UPSTREAM_COMPACT_PATH
              : UPSTREAM_PATH;
        const requestSignal = createRequestSignal(
          upstreamRequestTimeoutMs,
          clientAbort.signal,
        );
        const upstream = await fetch(`${upstreamBaseUrl}${upstreamPath}`, {
          method: "POST",
          headers,
          body: JSON.stringify(payloadToUpstream),
          signal: requestSignal.signal,
        });
        requestSignal.clearTimeout();

        const contentType = upstream.headers.get("content-type") ?? "";
        let isStream = contentType.includes("text/event-stream");
        let prefetchedText = "";
        let prefetchedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let prefetchedDecoder: TextDecoder | null = null;

        if (
          upstream.ok &&
          clientRequestedStream &&
          !shouldReturnChatCompletions &&
          !isStream &&
          upstream.body
        ) {
          const peeked = await peekResponseTextStart(
            upstream,
            upstreamRequestTimeoutMs,
            clientAbort.signal,
          );
          prefetchedText = peeked.initialText;
          prefetchedReader = peeked.reader;
          prefetchedDecoder = peeked.decoder;
          if (looksLikeSSEPayload(prefetchedText)) isStream = true;
        }
        if (upstream.ok) {
          clearAuthFailureState(selected);
          markModelCompatibility(
            selected,
            candidate.resolvedModel ?? requestModel,
            true,
          );
          await store.upsertAccount(selected);
        }

        if (isStream) {
          if (shouldReturnChatCompletions && clientRequestedStream) {
            res.set("Content-Type", "text/event-stream");
            res.set("Cache-Control", "no-cache");
            res.set("Connection", "keep-alive");

            const model =
              req.body?.model ?? payloadToUpstream?.model ?? "unknown";
            let accumulatedUsage: any = null;
            let streamedFallbackText = "";

            if (!upstream.body) return res.end();
            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            let doneSent = false;

            while (true) {
              const { value, done } = await readChunkWithInactivityTimeout(
                reader,
                upstreamRequestTimeoutMs,
                clientAbort.signal,
              );
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk.split("\n");

              for (const line of lines) {
                if (!line.startsWith("data:")) continue;

                const payload = line.slice(5).trim();
                if (payload && payload !== "[DONE]") {
                  try {
                    const event = JSON.parse(payload);
                    if (
                      event?.type === "response.output_text.delta" &&
                      typeof event?.delta === "string"
                    ) {
                      streamedFallbackText += sanitizeAssistantTextChunk(
                        event.delta,
                      );
                    } else if (
                      event?.type === "response.output_text.done" &&
                      !streamedFallbackText &&
                      typeof event?.text === "string"
                    ) {
                      streamedFallbackText = sanitizeAssistantTextChunk(
                        event.text,
                      );
                    }
                  } catch {}
                }

                const converted = convertResponsesSSEToChatCompletionSSE(
                  line,
                  model,
                  streamedFallbackText,
                );
                if (converted) {
                  res.write(converted);
                  if (converted.includes("[DONE]")) doneSent = true;
                } else if (line.includes('"response.reasoning')) {
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
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
              status: upstream.status,
              stream: true,
              latencyMs: Date.now() - startedAt,
              usage: accumulatedUsage,
              requestBody,
            });
            return;
          }

          if (shouldReturnChatCompletions) {
            const txt = await readResponsesSSETextUntilTerminal(
              upstream,
              upstreamRequestTimeoutMs,
              clientAbort.signal,
            );
            const parsedChat = parseResponsesSSEToChatCompletion(
              txt,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
            const normalized = ensureNonEmptyChatCompletion(parsedChat);
            res
              .status(upstream.ok ? 200 : upstream.status)
              .json(normalized.chat);

            const upstreamError = !upstream.ok ? txt.slice(0, 500) : undefined;
            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
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
            const txt = await readResponsesSSETextUntilTerminal(
              upstream,
              upstreamRequestTimeoutMs,
              clientAbort.signal,
            );
            const respObj = parseResponsesSSEToResponseObject(txt);
            res.status(upstream.ok ? 200 : upstream.status).json(respObj);
            const upstreamError = !upstream.ok ? txt.slice(0, 500) : undefined;
            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
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
          res.flushHeaders();
          const reader = prefetchedReader ?? upstream.body?.getReader() ?? null;
          const decoder = prefetchedDecoder ?? new TextDecoder();
          if (!reader) return res.end();
          let sseBuffer = "";
          let accumulatedUsage: any = null;

          const consumeChunkText = (chunkText: string) => {
            if (!chunkText) return;
            res.write(chunkText);
            sseBuffer += chunkText;

            while (true) {
              const next = takeNextSSEFrame(sseBuffer);
              if (!next) break;
              sseBuffer = next.rest;

              const payload = extractSSEDataPayload(next.frame);
              if (payload?.type === "response.completed") {
                if (payload?.response?.usage) {
                  accumulatedUsage = payload.response.usage;
                }
                continue;
              }
              if (
                payload?.type === "response.output_text.done" &&
                typeof payload?.text === "string"
              ) {
                continue;
              }
            }
          };

          consumeChunkText(prefetchedText);

          while (true) {
            const { value, done } = await readChunkWithInactivityTimeout(
              reader,
              upstreamRequestTimeoutMs,
              clientAbort.signal,
            );
            if (done) break;
            consumeChunkText(decoder.decode(value, { stream: true }));
          }

          consumeChunkText(decoder.decode());
          res.end();

          await appendTrace({
            at: Date.now(),
            route: req.path,
            sessionId,
            accountId: selected.id,
            accountEmail: selected.email,
            model: tracedModel,
            status: upstream.status,
            stream: true,
            latencyMs: Date.now() - startedAt,
            usage: accumulatedUsage,
            requestBody,
          });
          return;
        }

        let bufferedText: string | undefined = undefined;
        if (shouldReturnChatCompletions && clientRequestedStream) {
          let raw = await readResponseTextWithInactivityTimeout(
            upstream,
            upstreamRequestTimeoutMs,
            clientAbort.signal,
          );
          const upstreamEmptyBody = !raw;
          if (!raw)
            raw = JSON.stringify({
              error: `upstream ${upstream.status} with empty body`,
            });
          bufferedText = raw;

          let parsed: any = undefined;
          try {
            parsed = JSON.parse(raw);
          } catch {}

          if (upstream.ok && parsed && parsed.object === "chat.completion") {
            const normalized = ensureNonEmptyChatCompletion(
              sanitizeChatCompletionObject(parsed),
            );
            res.status(200);
            res.set("Content-Type", "text/event-stream");
            res.set("Cache-Control", "no-cache");
            res.set("Connection", "keep-alive");
            res.write(chatCompletionObjectToSSE(normalized.chat));
            res.end();

            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
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

          if (upstream.ok && parsed && parsed.object === "response") {
            const converted = responseObjectToChatCompletion(
              parsed,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
            res.status(200);
            res.set("Content-Type", "text/event-stream");
            res.set("Cache-Control", "no-cache");
            res.set("Connection", "keep-alive");
            res.write(chatCompletionObjectToSSE(converted));
            res.end();

            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
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
        }

        let text =
          bufferedText ??
          (prefetchedReader && prefetchedDecoder
            ? await readReaderTextWithInactivityTimeout(
                prefetchedReader,
                prefetchedDecoder,
                upstreamRequestTimeoutMs,
                clientAbort.signal,
                prefetchedText,
              )
            : await readResponseTextWithInactivityTimeout(
                upstream,
                upstreamRequestTimeoutMs,
                clientAbort.signal,
              ));
        const upstreamEmptyBody = !text;
        if (!text)
          text = JSON.stringify({
            error: `upstream ${upstream.status} with empty body`,
          });
        const upstreamError = !upstream.ok ? text.slice(0, 500) : undefined;

        let parsed: any = undefined;
        try {
          parsed = JSON.parse(text);
        } catch {}
        if (parsed?.object === "chat.completion") {
          parsed = sanitizeChatCompletionObject(parsed);
          text = JSON.stringify(parsed);
        } else if (parsed?.object === "response") {
          parsed = stripReasoningFromResponseObject(parsed);
          text = JSON.stringify(parsed);
        }

        if (
          shouldReturnChatCompletions &&
          clientRequestedStream &&
          upstream.ok
        ) {
          let chatResp: any = undefined;

          if (parsed?.object === "chat.completion") {
            chatResp = ensureNonEmptyChatCompletion(
              sanitizeChatCompletionObject(parsed),
            ).chat;
          } else if (parsed?.object === "response") {
            chatResp = responseObjectToChatCompletion(
              parsed,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
          } else if (text.includes("data:")) {
            chatResp = parseResponsesSSEToChatCompletion(
              text,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
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
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
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

        if (
          !shouldReturnChatCompletions &&
          clientRequestedStream &&
          upstream.ok
        ) {
          if (parsed?.object === "response") {
            const sanitized = stripReasoningFromResponseObject(parsed);
            res.status(200);
            res.set("Content-Type", "text/event-stream");
            res.set("Cache-Control", "no-cache");
            res.set("Connection", "keep-alive");
            res.write(responseObjectToSSE(sanitized));
            res.end();

            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
              status: upstream.status,
              stream: true,
              latencyMs: Date.now() - startedAt,
              usage: sanitized?.usage,
              requestBody,
              upstreamError,
              upstreamContentType: contentType,
              upstreamEmptyBody,
              ...inspectAssistantPayload(sanitized),
            });
            return;
          }

          if (!parsed && text.includes("data:")) {
            res.status(200);
            res.set("Content-Type", "text/event-stream");
            res.set("Cache-Control", "no-cache");
            res.set("Connection", "keep-alive");

            const rawFrames = text.split(/\n\n/).filter((f) => f.trim());
            let lastResponseObj: any = null;

            for (const rawFrame of rawFrames) {
              const filtered = sanitizeResponsesSSEFrame(rawFrame);
              if (filtered) {
                res.write(
                  filtered.endsWith("\n\n") ? filtered : filtered + "\n\n",
                );
                if (rawFrame.includes('"response.completed"')) {
                  try {
                    const dataLine = rawFrame
                      .split("\n")
                      .find((l) => l.startsWith("data:"));
                    if (dataLine) {
                      const obj = JSON.parse(dataLine.slice(5).trim());
                      if (obj?.response) lastResponseObj = obj.response;
                    }
                  } catch {}
                }
              }
            }

            res.end();

            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
              status: upstream.status,
              stream: true,
              latencyMs: Date.now() - startedAt,
              usage: lastResponseObj?.usage,
              requestBody,
              upstreamError,
              upstreamContentType: contentType,
              upstreamEmptyBody,
              ...inspectAssistantPayload(lastResponseObj),
            });
            return;
          }
        }

        if (text.includes("event: response.")) {
          if (shouldReturnChatCompletions) {
            const parsedChat = parseResponsesSSEToChatCompletion(
              text,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
            const normalized = ensureNonEmptyChatCompletion(parsedChat);
            res
              .status(upstream.ok ? 200 : upstream.status)
              .json(normalized.chat);
            await appendTrace({
              at: Date.now(),
              route: req.path,
              sessionId,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
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
            sessionId,
            accountId: selected.id,
            accountEmail: selected.email,
            model: tracedModel,
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

        const usage = extractUsageFromPayload(parsed);
        const quotaFailure =
          upstream.status === 429 || isQuotaErrorText(text);
        const authFailure = isAuthFailure(upstream.status, text);
        const modelUnsupported = isModelUnsupported(upstream.status, text);
        const shouldRotateAccount =
          !upstream.ok &&
          (quotaFailure || authFailure || modelUnsupported);

        if (!shouldRotateAccount) {
          res.status(upstream.status);
          res.type(contentType || "application/json").send(text);
        }

        await appendTrace({
          at: Date.now(),
          route: req.path,
          sessionId,
          accountId: selected.id,
          accountEmail: selected.email,
          model: tracedModel,
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
        if (quotaFailure) {
          markQuotaHit(selected, `quota/rate-limit: ${upstream.status}`);
          await store.upsertAccount(selected);
          continue;
        }
        if (authFailure) {
          markAuthFailure(selected, `auth failure: ${upstream.status}`);
          await store.upsertAccount(selected);
          continue;
        }
        if (modelUnsupported) {
          const failedModel =
            candidate.resolvedModel ?? requestModel ?? "unknown-model";
          lastModelUnsupported = {
            status: upstream.status,
            text,
            contentType,
          };
          markModelUnsupported(
            selected,
            `model unsupported for ${failedModel}: ${upstream.status}`,
          );
          await store.upsertAccount(selected);
          continue;
        }

        rememberError(
          selected,
          `upstream ${upstream.status}: ${text.slice(0, 200)}`,
        );
        await store.upsertAccount(selected);
        return;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const downstreamClientDisconnected = isDownstreamClientDisconnect(
          err,
          clientAbort.signal,
        );
        const status = downstreamClientDisconnected ? 499 : 599;
        if (!downstreamClientDisconnected) {
          rememberError(selected, msg);
          await store.upsertAccount(selected);
        }
        await appendTrace({
          at: Date.now(),
          route: req.path,
          sessionId,
          accountId: selected.id,
          accountEmail: selected.email,
          model: tracedModel,
          status,
          stream: false,
          latencyMs: Date.now() - startedAt,
          error: msg,
          requestBody,
          isError: downstreamClientDisconnected ? false : undefined,
        });
        if (downstreamClientDisconnected) return;
        if (isAbortError(err)) {
          if (clientRequestedStream) {
            if (!res.writableEnded) {
              if (shouldReturnChatCompletions) {
                res.write("data: [DONE]\n\n");
              }
              res.end();
            }
            return;
          }
          if (res.headersSent) {
            if (!res.writableEnded) {
              if (shouldReturnChatCompletions && clientRequestedStream) {
                res.write("data: [DONE]\n\n");
              }
              res.end();
            }
            return;
          }
          return res.status(504).json({ error: "upstream request timed out" });
        }
        if (res.headersSent && !res.writableEnded) {
          res.end();
          return;
        }
      }
    }
    }
    if (!providerTried) {
      return res.status(503).json({ error: "no provider accounts configured for requested model" });
    }
    if (lastModelUnsupported) {
      return res
        .status(lastModelUnsupported.status)
        .type(lastModelUnsupported.contentType || "application/json")
        .send(lastModelUnsupported.text);
    }
    res.status(429).json({ error: "all accounts exhausted or unavailable" });
  }

  function setForwardHeaders(from: Response, to: express.Response) {
    for (const [k, v] of from.headers.entries())
      if (k.toLowerCase() !== "content-length") to.setHeader(k, v);
  }

  router.post("/chat/completions", proxyWithRotation);
  router.post("/responses", proxyWithRotation);
  router.post("/responses/compact", proxyWithRotation);

  router.get("/models", async (_req, res) => {
    const models = await discoverModels(store, openaiBaseUrl, mistralBaseUrl);
    res.json({ object: "list", data: models });
  });

  router.get("/models/:id", async (req, res) => {
    const id = req.params.id;
    const models = await discoverModels(store, openaiBaseUrl, mistralBaseUrl);
    const model = models.find((m) => m.id === id);
    if (!model)
      return res.status(404).json({
        error: {
          message: `The model '${id}' does not exist`,
          type: "invalid_request_error",
        },
      });
    res.json(model);
  });

  return router;
}
