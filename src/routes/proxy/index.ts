import {
  MAX_ACCOUNT_RETRY_ATTEMPTS,
  MAX_UPSTREAM_RETRIES,
  MODELS_CACHE_MS,
  MODELS_CLIENT_VERSION,
  PI_USER_AGENT,
  PROXY_MODELS,
  TRACE_INCLUDE_BODY,
  UPSTREAM_BASE_DELAY_MS,
  UPSTREAM_COMPACT_PATH,
  UPSTREAM_PATH,
} from "../../config.js";
import type { ModelAlias, ProviderId, UpstreamMode } from "../../types.js";
import {
  chatCompletionObjectToSSE,
  chatCompletionObjectToResponseObject,
  convertResponsesSSEToChatCompletionSSE,
  convertChatCompletionSSEToResponseSSE,
  createChatStreamAccumulator,
  finalizeChatCompletionSSEToResponseSSE,
  parseChatCompletionSSEToChatCompletion,
  parseChatCompletionSSEToResponseObject,
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
  responsesToChatCompletionsPayload,
  sanitizeGenericChatCompletionsPayload,
} from "../../responses/payloads.js";
import {
  chooseAccountForProvider,
  clearEmptyResponseHistory,
  getZaiBlockDuration,
  isQuotaErrorText,
  markEmptyResponseError,
  markQuotaHit,
  normalizeProvider,
  parseZaiErrorCode,
  refreshUsageIfNeeded,
  rememberError,
  shouldBlockAccountForZaiError,
} from "../../quota.js";
import {
  chatCompletionHasAssistantOutput,
  ensureNonEmptyChatCompletion,
  responseHasAssistantOutput,
  sanitizeAssistantTextChunk,
  sanitizeChatCompletionObject,
  sanitizeResponsesSSEFrame,
  stripReasoningFromResponseObject,
} from "../../responses/sanitizers.js";

import { AccountStore } from "../../store.js";
import type { OAuthConfig } from "../../oauth.js";
import { TraceManager } from "../../traces.js";
import { ensureValidToken } from "../../account-utils.js";
import express from "express";
import { randomUUID } from "node:crypto";

type ProxyRoutesOptions = {
  store: AccountStore;
  traceManager: TraceManager;
  openaiBaseUrl: string;
  mistralBaseUrl: string;
  mistralUpstreamPath: string;
  mistralCompactUpstreamPath: string;
  zaiBaseUrl: string;
  zaiUpstreamPath: string;
  zaiCompactUpstreamPath: string;
  oauthConfig: OAuthConfig;
};

const modelsCache: { at: number; models: ExposedModel[] } = {
  at: 0,
  models: [],
};

// Separate cache for fast O(1) model validation using Set
const modelsValidationCache: {
  at: number;
  validModels: Set<string>;
  validModelKeys: Set<string>;
} = {
  at: 0,
  validModels: new Set(),
  validModelKeys: new Set(),
};

const MODELS_VALIDATION_CACHE_MS = 60_000; // Refresh every 60 seconds

type ExposedModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  metadata: {
    provider: ProviderId;
    provider_candidates?: ProviderId[];
    account_ids?: string[];
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function accountBaseUrl(
  account: { provider?: ProviderId; baseUrl?: string | undefined },
  openaiBaseUrl: string,
  mistralBaseUrl: string,
  zaiBaseUrl: string,
): string {
  const provider = normalizeProvider(account);
  if (provider === "openai-compatible") {
    return trimTrailingSlash(String(account.baseUrl ?? ""));
  }
  if (provider === "mistral") return mistralBaseUrl;
  if (provider === "zai") return zaiBaseUrl;
  return openaiBaseUrl;
}

function resolveUpstreamMode(
  account: {
    provider?: ProviderId;
    upstreamMode?: UpstreamMode;
    compatibilityMode?: string;
  },
  isChatCompletionsPath: boolean,
  isResponsesCompactPath: boolean,
): UpstreamMode {
  if (isResponsesCompactPath) return "responses";
  if (account.upstreamMode) return account.upstreamMode;
  const provider = normalizeProvider(account);
  if (provider === "openai-compatible") {
    if (account.compatibilityMode === "responses") return "responses";
    return "chat/completions";
  }
  return "responses";
}

function mergeModelAvailability(
  current: ExposedModel | undefined,
  nextModel: ExposedModel,
  provider: ProviderId,
  accountId: string,
): ExposedModel {
  const providers = Array.from(
    new Set([
      ...(current?.metadata.provider_candidates ??
        [current?.metadata.provider].filter((value): value is ProviderId =>
          Boolean(value),
        )),
      provider,
    ]),
  );
  const accountIds = Array.from(
    new Set([...(current?.metadata.account_ids ?? []), accountId]),
  );

  return {
    ...(current ?? nextModel),
    metadata: {
      ...(current?.metadata ?? nextModel.metadata),
      provider: current?.metadata.provider ?? nextModel.metadata.provider,
      provider_candidates: providers,
      account_ids: accountIds,
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
  if (discovered) {
    const candidates = discovered.metadata.provider_candidates ?? [
      discovered.metadata.provider,
    ];
    return candidates[0] ?? discovered.metadata.provider;
  }

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

  // z.ai / GLM models
  if (
    key.startsWith("glm-") ||
    key.startsWith("chatglm") ||
    key.startsWith("codegeex")
  ) {
    return "zai";
  }

  return "openai";
}

function providersForModel(
  model: string | undefined,
  discoveredModels: ExposedModel[],
): ProviderId[] {
  const key = normalizeModelLookupKey(model);
  if (!key) return ["openai"];

  const discovered = discoveredModels.find(
    (entry) => normalizeModelLookupKey(entry.id) === key,
  );
  if (discovered) {
    const candidates = discovered.metadata.provider_candidates ?? [
      discovered.metadata.provider,
    ];
    return Array.from(
      new Set(
        candidates.filter(
          (value): value is ProviderId =>
            typeof value === "string" && value.length > 0,
        ),
      ),
    );
  }

  return [inferProviderFromModel(model, discoveredModels)];
}

function accountSupportsModel(
  accountId: string,
  model: string | undefined,
  discoveredModels: ExposedModel[],
): boolean {
  const key = normalizeModelLookupKey(model);
  if (!key) return true;

  const discovered = discoveredModels.find(
    (entry) => normalizeModelLookupKey(entry.id) === key,
  );
  if (!discovered) return true;

  const accountIds = discovered.metadata.account_ids;
  if (!accountIds?.length) return true;
  return accountIds.includes(accountId);
}

function supportedToolTypesForRoute(
  provider: ProviderId,
  model: string | undefined,
  discoveredModels: ExposedModel[],
): Set<string> {
  const key = normalizeModelLookupKey(model);
  const discovered = key
    ? discoveredModels.find(
        (entry) =>
          normalizeModelLookupKey(entry.id) === key &&
          (entry.metadata.provider === provider ||
            entry.metadata.provider_candidates?.includes(provider)),
      )
    : undefined;

  const rawTypes = discovered?.metadata.supported_tool_types;
  if (Array.isArray(rawTypes) && rawTypes.length > 0) {
    return new Set(
      rawTypes.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    );
  }

  // OpenAI-compatible providers vary widely; default conservatively.
  if (provider === "openai-compatible") return new Set(["function"]);

  return new Set(["function"]);
}

function filterUnsupportedTools(
  payload: any,
  provider: ProviderId,
  model: string | undefined,
  discoveredModels: ExposedModel[],
) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) {
    return;
  }

  const supportedToolTypes = supportedToolTypesForRoute(
    provider,
    model,
    discoveredModels,
  );
  payload.tools = payload.tools.filter(
    (tool: any) =>
      typeof tool?.type === "string" && supportedToolTypes.has(tool.type),
  );

  if (payload.tools.length === 0) {
    delete payload.tools;
    if (payload.tool_choice === "auto" || payload.tool_choice === "required") {
      delete payload.tool_choice;
    }
  }
}

async function discoverModels(
  store: AccountStore,
  openaiBaseUrl: string,
  mistralBaseUrl: string,
  zaiBaseUrl: string,
): Promise<ExposedModel[]> {
  if (
    Date.now() - modelsCache.at < MODELS_CACHE_MS &&
    modelsCache.models.length
  )
    return modelsCache.models;

  try {
    const accounts = await store.listAccounts();
    const byId = new Map<string, ExposedModel>();
    const activeAccounts = accounts.filter((a) => a.enabled && a.accessToken);

    for (const account of activeAccounts) {
      const provider = normalizeProvider(account);
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${account.accessToken}`,
          accept: "application/json",
        };
        let url = "";

        if (provider === "openai") {
          if (account.chatgptAccountId) {
            headers["ChatGPT-Account-Id"] = account.chatgptAccountId;
          }
          url = `${accountBaseUrl(account, openaiBaseUrl, mistralBaseUrl, zaiBaseUrl)}/backend-api/codex/models?client_version=${encodeURIComponent(
            MODELS_CLIENT_VERSION,
          )}`;
        } else {
          const baseUrl = accountBaseUrl(
            account,
            openaiBaseUrl,
            mistralBaseUrl,
            zaiBaseUrl,
          );
          if (!baseUrl) continue;
          url = `${baseUrl}/v1/models`;
        }

        const r = await fetch(url, { headers });
        if (!r.ok) continue;
        const json: any = await r.json();

        if (provider === "openai") {
          const upstream = Array.isArray(json?.models) ? json.models : [];
          for (const entry of upstream) {
            const slug =
              typeof entry?.slug === "string" && entry.slug.trim()
                ? entry.slug.trim()
                : "";
            if (!slug) continue;
            byId.set(
              slug,
              mergeModelAvailability(
                byId.get(slug),
                modelObject(slug, provider, entry),
                provider,
                account.id,
              ),
            );
          }
          continue;
        }

        const upstream = Array.isArray(json?.data) ? json.data : [];
        for (const entry of upstream) {
          const id =
            typeof entry?.id === "string" && entry.id.trim()
              ? entry.id.trim()
              : "";
          if (!id) continue;
          byId.set(
            id,
            mergeModelAvailability(
              byId.get(id),
              modelObject(id, provider, entry),
              provider,
              account.id,
            ),
          );
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
      const providers = providersForModel(
        firstTarget,
        Array.from(byId.values()),
      );
      const provider =
        providers[0] ??
        inferProviderFromModel(firstTarget, Array.from(byId.values()));
      byId.set(alias.id, {
        ...modelObject(alias.id, provider),
        metadata: {
          ...modelObject(alias.id, provider).metadata,
          provider_candidates: providers,
          is_alias: true,
          alias_targets: [...alias.targets],
        },
      });
    }
    if (!byId.size) throw new Error("no models discovered");

    const merged = Array.from(byId.values());
    modelsCache.at = Date.now();
    modelsCache.models = merged;
    updateValidationCache(merged);
    return merged;
  } catch {
    const fallback = Array.from(new Set(PROXY_MODELS)).map((id) =>
      modelObject(id, "openai"),
    );
    modelsCache.at = Date.now();
    modelsCache.models = fallback;
    updateValidationCache(fallback);
    return fallback;
  }
}

function updateValidationCache(models: ExposedModel[]): void {
  const validModels = new Set<string>();
  const validModelKeys = new Set<string>();

  for (const model of models) {
    validModels.add(model.id);
    const key = normalizeModelLookupKey(model.id);
    if (key) validModelKeys.add(key);
  }

  modelsValidationCache.at = Date.now();
  modelsValidationCache.validModels = validModels;
  modelsValidationCache.validModelKeys = validModelKeys;
}

function isModelAllowed(model: string | undefined): boolean {
  if (!model) return true; // No model specified, let it pass
  const key = normalizeModelLookupKey(model);
  return modelsValidationCache.validModelKeys.has(key);
}

function startBackgroundModelRefresh(
  store: AccountStore,
  openaiBaseUrl: string,
  mistralBaseUrl: string,
  zaiBaseUrl: string,
): void {
  // Refresh validation cache every 60 seconds asynchronously
  setInterval(async () => {
    try {
      const models = await discoverModels(
        store,
        openaiBaseUrl,
        mistralBaseUrl,
        zaiBaseUrl,
      );
      console.log(
        `[model-cache] Background refresh: ${models.length} models available`,
      );
    } catch (err) {
      console.error("[model-cache] Background refresh failed:", err);
    }
  }, MODELS_VALIDATION_CACHE_MS);

  // Initial sync refresh after a short delay to populate cache on startup
  setTimeout(async () => {
    try {
      const models = await discoverModels(
        store,
        openaiBaseUrl,
        mistralBaseUrl,
        zaiBaseUrl,
      );
      console.log(
        `[model-cache] Initial refresh: ${models.length} models available`,
      );
    } catch (err) {
      console.error("[model-cache] Initial refresh failed:", err);
    }
  }, 1000);
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
  const alias = aliases.find(
    (a) => a.enabled && normalizeModelLookupKey(a.id) === key,
  );
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
    for (const provider of providersForModel(target, discoveredModels)) {
      const routeKey = `${targetKey}::${provider}`;
      if (seen.has(routeKey)) continue;
      seen.add(routeKey);
      out.push({
        requestedModel: requestModel,
        resolvedModel: target,
        provider,
      });
    }
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

type ResponsesStreamState = {
  accumulatedUsage: any;
  streamedFallbackText: string;
  sawResponseCompleted: boolean;
};

type BufferedResponsesStreamResult = {
  body: string;
  usage: any;
  upstreamEmptyBody: boolean;
  assistantEmptyOutput: boolean;
  tracePayload: any;
};

function inspectResponsesDataLine(
  line: string,
  state: ResponsesStreamState,
): void {
  if (!line.startsWith("data:")) return;

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;

  try {
    const event = JSON.parse(payload);
    if (
      event?.type === "response.output_text.delta" &&
      typeof event?.delta === "string"
    ) {
      state.streamedFallbackText += sanitizeAssistantTextChunk(event.delta);
    } else if (
      event?.type === "response.output_text.done" &&
      !state.streamedFallbackText &&
      typeof event?.text === "string"
    ) {
      state.streamedFallbackText = sanitizeAssistantTextChunk(event.text);
    } else if (event?.type === "response.completed") {
      state.sawResponseCompleted = true;
      state.accumulatedUsage = event?.response?.usage ?? state.accumulatedUsage;
    }
  } catch {}
}

function parseSSEDataPayloads(frame: string): any[] {
  const payloads: any[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(payload));
    } catch {}
  }
  return payloads;
}

function isChatCompletionSSEFrame(frame: string): boolean {
  return parseSSEDataPayloads(frame).some(
    (payload) => payload?.object === "chat.completion.chunk",
  );
}

function isDoneSSEFrame(frame: string): boolean {
  return frame
    .split(/\r?\n/)
    .some((line) => line.trim() === "data: [DONE]");
}

function synthesizeResponsesCompletedEvent(
  model: string,
  state: ResponsesStreamState,
): string | null {
  if (state.sawResponseCompleted) return null;
  const text = state.streamedFallbackText.trim();
  if (!text) return null;

  return responseObjectToSSE({
    id: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    usage: state.accumulatedUsage,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  });
}

function splitSSEFrames(text: string): string[] {
  const frames: string[] = [];
  let buffer = text;

  while (true) {
    const next = takeNextSSEFrame(buffer);
    if (!next) break;
    frames.push(next.frame);
    buffer = next.rest;
  }

  if (buffer.trim()) frames.push(buffer);
  return frames;
}

function appendSSEFrame(target: string[], frame: string): void {
  if (!frame) return;
  target.push(frame.endsWith("\n\n") ? frame : `${frame}\n\n`);
}

function renderBufferedResponsesStream(
  rawText: string,
  model: string,
): BufferedResponsesStreamResult {
  const frames = splitSSEFrames(rawText);
  const upstreamEmptyBody = !rawText.trim();
  const sawChatCompletionStream = frames.some(isChatCompletionSSEFrame);

  if (sawChatCompletionStream) {
    const body: string[] = [];
    const chatStreamState = createChatStreamAccumulator(model);

    for (const frame of frames) {
      if (isChatCompletionSSEFrame(frame)) {
        const converted = convertChatCompletionSSEToResponseSSE(
          frame,
          chatStreamState,
        );
        if (converted) body.push(converted);
        continue;
      }

      if (isDoneSSEFrame(frame)) {
        const completed = finalizeChatCompletionSSEToResponseSSE(
          chatStreamState,
        );
        if (completed) body.push(completed);
      }
    }

    const completed = finalizeChatCompletionSSEToResponseSSE(chatStreamState);
    if (completed) body.push(completed);

    const chat = parseChatCompletionSSEToChatCompletion(rawText, model);
    return {
      body: body.join(""),
      usage: chat?.usage,
      upstreamEmptyBody,
      assistantEmptyOutput: !chatCompletionHasAssistantOutput(chat),
      tracePayload: chat,
    };
  }

  const body: string[] = [];
  const streamState: ResponsesStreamState = {
    accumulatedUsage: null,
    streamedFallbackText: "",
    sawResponseCompleted: false,
  };

  for (const frame of frames) {
    for (const rawLine of frame.split(/\r?\n/)) {
      inspectResponsesDataLine(rawLine.trim(), streamState);
    }
    const filtered = sanitizeResponsesSSEFrame(frame);
    if (filtered !== null) appendSSEFrame(body, filtered);
  }

  const syntheticCompleted = synthesizeResponsesCompletedEvent(
    model,
    streamState,
  );
  if (syntheticCompleted) {
    body.push(syntheticCompleted);
    streamState.sawResponseCompleted = true;
  }

  const response = parseResponsesSSEToResponseObject(body.join("") || rawText);
  const hasAssistantOutput =
    responseHasAssistantOutput(response) ||
    Boolean(streamState.streamedFallbackText.trim());
  if (!responseHasAssistantOutput(response) && streamState.streamedFallbackText.trim()) {
    const repairedCompleted = responseObjectToSSE({
      ...response,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: streamState.streamedFallbackText },
          ],
        },
      ],
    });
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].includes('"response.completed"')) {
        body[i] = repairedCompleted;
        break;
      }
    }
  }

  return {
    body: body.join(""),
    usage: streamState.accumulatedUsage ?? response?.usage,
    upstreamEmptyBody,
    assistantEmptyOutput: !hasAssistantOutput,
    tracePayload: response,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function fetchCodexWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      const errorText = await response
        .clone()
        .text()
        .catch(() => "");
      if (
        attempt < MAX_UPSTREAM_RETRIES &&
        isRetryableUpstreamError(response.status, errorText)
      ) {
        const retryAfter = parseRetryAfter(response);
        const backoff = UPSTREAM_BASE_DELAY_MS * 2 ** attempt;
        const jitter = Math.random() * 500;
        const delay = Math.max(retryAfter ?? 0, backoff) + jitter;
        await sleep(delay);
        continue;
      }
      return response;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt < MAX_UPSTREAM_RETRIES &&
        !lastError.message.includes("usage limit")
      ) {
        const backoff = UPSTREAM_BASE_DELAY_MS * 2 ** attempt;
        const jitter = Math.random() * 500;
        await sleep(backoff + jitter);
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
    zaiBaseUrl,
    zaiUpstreamPath,
    zaiCompactUpstreamPath,
    oauthConfig,
  } = options;
  const { recordTrace } = traceManager;
  const router = express.Router();

  function rejectNonPost(routeLabel: string): express.RequestHandler {
    return (req, res, next) => {
      if (req.method === "POST") return next();

      res.setHeader(
        "Allow",
        routeLabel === "/v1/responses" ? "POST, GET" : "POST",
      );
      const upgradeHeader = String(req.header("upgrade") ?? "").toLowerCase();
      const attemptedWebsocket = upgradeHeader === "websocket";
      const protocolHint = attemptedWebsocket
        ? routeLabel === "/v1/responses"
          ? "WebSocket upgrades are handled before Express routing."
          : "This endpoint does not support WebSocket upgrades."
        : "This endpoint accepts HTTP POST only.";
      const usageHint =
        routeLabel === "/v1/responses"
          ? "Use POST /v1/responses over http(s):// with JSON, or connect via ws(s):// and send JSON frames with type='response.create'."
          : `Use POST ${routeLabel} over http(s):// with JSON.`;

      return res.status(405).json({
        error: {
          message: `${protocolHint} ${usageHint} For HTTP streaming, keep HTTP and set stream=true to receive text/event-stream.`,
          type: "invalid_request_error",
          code: "method_not_allowed",
        },
      });
    };
  }

  // Start background model cache refresh
  startBackgroundModelRefresh(store, openaiBaseUrl, mistralBaseUrl, zaiBaseUrl);

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

    let accounts = store.getCachedAccounts();
    if (!accounts.length)
      return res.status(503).json({ error: "no accounts configured" });

    accounts = await Promise.all(
      accounts.map(async (account) => {
        const valid = await ensureValidToken(account, oauthConfig);
        const usageBaseUrl = accountBaseUrl(
          valid,
          openaiBaseUrl,
          mistralBaseUrl,
          zaiBaseUrl,
        );
        await refreshUsageIfNeeded(valid, usageBaseUrl);
        return valid;
      }),
    );
    for (const account of accounts)
      store.markAccountModified(account.id, account);

    const requestModel =
      typeof req.body?.model === "string" && req.body.model.trim()
        ? req.body.model.trim()
        : undefined;

    // Fast O(1) validation against cached model set
    if (!isModelAllowed(requestModel)) {
      return res.status(400).json({
        error: {
          message: `Model '${requestModel}' is not supported. Use /v1/models to list available models.`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      });
    }

    const discoveredModels = await discoverModels(
      store,
      openaiBaseUrl,
      mistralBaseUrl,
      zaiBaseUrl,
    );
    const modelAliases = store.getCachedModelAliases();
    const routingCandidates = buildRoutingCandidates(
      requestModel,
      discoveredModels,
      modelAliases,
    );
    const tried = new Set<string>();
    const maxAttempts = Math.min(accounts.length, MAX_ACCOUNT_RETRY_ATTEMPTS);
    let providerTried = false;
    let sawEmptyAssistantOutput = false;

    for (const candidate of routingCandidates) {
      const providerAccounts = accounts.filter(
        (a) =>
          normalizeProvider(a) === candidate.provider &&
          accountSupportsModel(a.id, candidate.resolvedModel, discoveredModels),
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
        const upstreamMode = resolveUpstreamMode(
          selected,
          isChatCompletionsPath,
          isResponsesCompactPath,
        );
        const shouldSendChatCompletions = upstreamMode === "chat/completions";
        let payloadToUpstream = shouldSendChatCompletions
          ? isChatCompletionsPath
            ? { ...(req.body ?? {}) }
            : responsesToChatCompletionsPayload(req.body)
          : isChatCompletions
            ? chatCompletionsToResponsesPayload(req.body, sessionId)
            : normalizeResponsesPayload(req.body, sessionId);
        if (shouldSendChatCompletions && candidate.provider === "openai-compatible") {
          payloadToUpstream = sanitizeGenericChatCompletionsPayload(
            payloadToUpstream,
          );
        }

        if (
          isResponsesCompactPath &&
          payloadToUpstream &&
          typeof payloadToUpstream === "object"
        ) {
          delete payloadToUpstream.store;
          delete payloadToUpstream.stream;
          delete payloadToUpstream.include;
          delete payloadToUpstream.tool_choice;
          delete payloadToUpstream.parallel_tool_calls;
        }
        if (
          isResponsesCompactPath &&
          payloadToUpstream &&
          typeof payloadToUpstream === "object"
        ) {
          delete payloadToUpstream.store;
        }
        if (candidate.resolvedModel)
          payloadToUpstream.model = candidate.resolvedModel;
        filterUnsupportedTools(
          payloadToUpstream,
          candidate.provider,
          candidate.resolvedModel,
          discoveredModels,
        );
        const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;
        const tracedModel =
          requestModel ??
          (typeof payloadToUpstream?.model === "string" &&
          payloadToUpstream.model.trim()
            ? payloadToUpstream.model.trim()
            : undefined);

        const retryEmptyAssistantOutput = async (
          message: string,
          stream: boolean,
          details: {
            usage?: any;
            upstreamContentType?: string;
            upstreamEmptyBody?: boolean;
            tracePayload?: any;
          } = {},
        ) => {
          sawEmptyAssistantOutput = true;
          markEmptyResponseError(selected, message);
          await store.upsertAccount(selected);
          recordTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: tracedModel,
            status: 502,
            stream,
            latencyMs: Date.now() - startedAt,
            usage: details.usage,
            requestBody,
            error: message,
            upstreamContentType: details.upstreamContentType,
            upstreamEmptyBody: details.upstreamEmptyBody,
            assistantEmptyOutput: true,
            ...inspectAssistantPayload(details.tracePayload),
          });
        };

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
          let upstreamBaseUrl = accountBaseUrl(
            selected,
            openaiBaseUrl,
            mistralBaseUrl,
            zaiBaseUrl,
          );
          let upstreamPath = isResponsesCompactPath
            ? UPSTREAM_COMPACT_PATH
            : UPSTREAM_PATH;

          if (candidate.provider === "mistral") {
            upstreamBaseUrl = mistralBaseUrl;
            upstreamPath = isResponsesCompactPath
              ? mistralCompactUpstreamPath
              : mistralUpstreamPath;
          } else if (candidate.provider === "openai-compatible") {
            upstreamPath = shouldSendChatCompletions
              ? "/v1/chat/completions"
              : "/v1/responses";
          } else if (candidate.provider === "zai") {
            upstreamBaseUrl = zaiBaseUrl;
            upstreamPath = isResponsesCompactPath
              ? zaiCompactUpstreamPath
              : zaiUpstreamPath;
          }
          const upstream = await fetchCodexWithRetry(
            `${upstreamBaseUrl}${upstreamPath}`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(payloadToUpstream),
            },
          );

          const contentType = upstream.headers.get("content-type") ?? "";
          const isStream = contentType.includes("text/event-stream");

          if (isStream) {
            if (shouldReturnChatCompletions && clientRequestedStream) {
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");

              if (shouldSendChatCompletions) {
                if (!upstream.body) return res.end();
                const reader = upstream.body.getReader();
                const decoder = new TextDecoder();
                let sseBuffer = "";
                let doneSent = false;
                let accumulatedUsage: any = null;

                const forwardFrame = (frame: string) => {
                  res.write(frame.endsWith("\n\n") ? frame : `${frame}\n\n`);
                  if (frame.includes("[DONE]")) doneSent = true;
                  for (const payload of parseSSEDataPayloads(frame)) {
                    if (payload?.usage) accumulatedUsage = payload.usage;
                  }
                };

                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  sseBuffer += decoder.decode(value, { stream: true });
                  while (true) {
                    const next = takeNextSSEFrame(sseBuffer);
                    if (!next) break;
                    sseBuffer = next.rest;
                    forwardFrame(next.frame);
                  }
                }

                sseBuffer += decoder.decode();
                while (true) {
                  const next = takeNextSSEFrame(sseBuffer);
                  if (!next) break;
                  sseBuffer = next.rest;
                  forwardFrame(next.frame);
                }
                if (sseBuffer.trim()) forwardFrame(sseBuffer);
                if (!doneSent) res.write("data: [DONE]\n\n");
                res.end();

                recordTrace({
                  at: Date.now(),
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  status: upstream.status,
                  stream: true,
                  latencyMs: Date.now() - startedAt,
                  usage: accumulatedUsage,
                  requestBody,
                  upstreamContentType: contentType,
                });
                return;
              }

              const model =
                req.body?.model ?? payloadToUpstream?.model ?? "unknown";
              let accumulatedUsage: any = null;
              let streamedFallbackText = "";

              if (!upstream.body) return res.end();
              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              let doneSent = false;
              let sseBuffer = "";

              while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                sseBuffer += decoder.decode(value, { stream: true });
                while (true) {
                  const next = takeNextSSEFrame(sseBuffer);
                  if (!next) break;
                  sseBuffer = next.rest;

                  const lines = next.frame.split(/\r?\n/);
                  for (const rawLine of lines) {
                    const line = rawLine.trim();
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
              }

              sseBuffer += decoder.decode();
              while (true) {
                const next = takeNextSSEFrame(sseBuffer);
                if (!next) break;
                sseBuffer = next.rest;

                const lines = next.frame.split(/\r?\n/);
                for (const rawLine of lines) {
                  const line = rawLine.trim();
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
              if (sseBuffer.trim()) {
                const lines = sseBuffer.split(/\r?\n/);
                for (const rawLine of lines) {
                  const line = rawLine.trim();
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

              recordTrace({
                at: Date.now(),
                route: req.path,
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
              const txt = await upstream.text();
              const model = req.body?.model ?? payloadToUpstream?.model ?? "unknown";
              const parsedChat = txt.includes("chat.completion.chunk")
                ? parseChatCompletionSSEToChatCompletion(txt, model)
                : parseResponsesSSEToChatCompletion(txt, model);
              const normalized = ensureNonEmptyChatCompletion(parsedChat);

              // If response was empty/patched and upstream returned OK, retry with another account
              if (normalized.patched && upstream.ok) {
                sawEmptyAssistantOutput = true;
                markEmptyResponseError(
                  selected,
                  "empty assistant output in SSE",
                );
                await store.upsertAccount(selected);
                continue; // Try next account
              }

              res
                .status(upstream.ok ? 200 : upstream.status)
                .json(normalized.chat);

              const upstreamError = !upstream.ok
                ? txt.slice(0, 500)
                : undefined;
              recordTrace({
                at: Date.now(),
                route: req.path,
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
              const txt = await upstream.text();
              const model = req.body?.model ?? payloadToUpstream?.model ?? "unknown";
              const rendered = renderBufferedResponsesStream(txt, model);

              if (upstream.ok && rendered.assistantEmptyOutput) {
                await retryEmptyAssistantOutput(
                  "empty assistant output in responses stream",
                  false,
                  {
                    usage: rendered.usage,
                    upstreamContentType: contentType,
                    upstreamEmptyBody: rendered.upstreamEmptyBody,
                    tracePayload: rendered.tracePayload,
                  },
                );
                continue;
              }

              const respObj = parseResponsesSSEToResponseObject(
                rendered.body || txt,
              );
              res.status(upstream.ok ? 200 : upstream.status).json(respObj);
              const upstreamError = !upstream.ok
                ? txt.slice(0, 500)
                : undefined;
              recordTrace({
                at: Date.now(),
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                status: upstream.status,
                stream: false,
                latencyMs: Date.now() - startedAt,
                usage: rendered.usage ?? respObj?.usage,
                requestBody,
                upstreamError,
                upstreamContentType: contentType,
                upstreamEmptyBody: rendered.upstreamEmptyBody,
                ...inspectAssistantPayload(rendered.tracePayload ?? respObj),
              });
              return;
            }

            const rawText = upstream.body ? await upstream.text() : "";
            const rendered = renderBufferedResponsesStream(
              rawText,
              tracedModel ?? payloadToUpstream?.model ?? "unknown",
            );

            if (upstream.ok && rendered.assistantEmptyOutput) {
              sawEmptyAssistantOutput = true;
              markEmptyResponseError(
                selected,
                "empty assistant output in responses stream",
              );
              await store.upsertAccount(selected);
              recordTrace({
                at: Date.now(),
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                status: 502,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: rendered.usage,
                requestBody,
                error: "empty assistant output in responses stream",
                upstreamContentType: contentType,
                upstreamEmptyBody: rendered.upstreamEmptyBody,
                assistantEmptyOutput: true,
              });
              continue;
            }

            if (upstream.ok) {
              clearEmptyResponseHistory(selected);
              await store.upsertAccount(selected);
            }

            res.status(upstream.status);
            setForwardHeaders(upstream, res);
            res.set("Content-Type", "text/event-stream");
            res.set("Cache-Control", "no-cache");
            res.set("Connection", "keep-alive");
            res.write(rendered.body);
            res.end();

            recordTrace({
              at: Date.now(),
              route: req.path,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
              status: upstream.status,
              stream: true,
              latencyMs: Date.now() - startedAt,
              usage: rendered.usage,
              requestBody,
              upstreamContentType: contentType,
              upstreamEmptyBody: rendered.upstreamEmptyBody,
              ...inspectAssistantPayload(rendered.tracePayload),
            });
            return;
          }

          let bufferedText: string | undefined = undefined;
          if (shouldReturnChatCompletions && clientRequestedStream) {
            let raw = await upstream.text();
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

              // If response was empty/patched, retry with another account
              if (normalized.patched) {
                sawEmptyAssistantOutput = true;
                markEmptyResponseError(
                  selected,
                  "empty assistant output in chat.completion",
                );
                await store.upsertAccount(selected);
                continue; // Try next account
              }

              res.status(200);
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");
              res.write(chatCompletionObjectToSSE(normalized.chat));
              res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
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
              const sanitized = stripReasoningFromResponseObject(parsed);
              if (!responseHasAssistantOutput(sanitized)) {
                await retryEmptyAssistantOutput(
                  "empty assistant output in response object",
                  true,
                  {
                    upstreamContentType: contentType,
                    upstreamEmptyBody,
                    tracePayload: sanitized,
                  },
                );
                continue;
              }
              const converted = responseObjectToChatCompletion(
                sanitized,
                req.body?.model ?? payloadToUpstream?.model ?? "unknown",
              );
              res.status(200);
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");
              res.write(chatCompletionObjectToSSE(converted));
              res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
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

          let text = bufferedText ?? (await upstream.text());
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
              const normalized = ensureNonEmptyChatCompletion(
                sanitizeChatCompletionObject(parsed),
              );
              // If response was empty/patched, retry with another account
              if (normalized.patched) {
                sawEmptyAssistantOutput = true;
                markEmptyResponseError(
                  selected,
                  "empty assistant output in chat.completion",
                );
                await store.upsertAccount(selected);
                continue; // Try next account
              }
              chatResp = normalized.chat;
            } else if (parsed?.object === "response") {
              chatResp = responseObjectToChatCompletion(
                parsed,
                req.body?.model ?? payloadToUpstream?.model ?? "unknown",
              );
            } else if (text.includes("chat.completion.chunk")) {
              chatResp = parseChatCompletionSSEToChatCompletion(
                text,
                req.body?.model ?? payloadToUpstream?.model ?? "unknown",
              );
            } else if (text.includes("data:")) {
              chatResp = parseResponsesSSEToChatCompletion(
                text,
                req.body?.model ?? payloadToUpstream?.model ?? "unknown",
              );
            }

            if (chatResp) {
              const normalized = ensureNonEmptyChatCompletion(chatResp);

              // If response was empty/patched, retry with another account
              if (normalized.patched) {
                sawEmptyAssistantOutput = true;
                markEmptyResponseError(
                  selected,
                  "empty assistant output in chat completion",
                );
                await store.upsertAccount(selected);
                continue; // Try next account
              }

              chatResp = normalized.chat;
              res.status(200);
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");
              res.write(chatCompletionObjectToSSE(chatResp));
              res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
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
            if (parsed?.object === "chat.completion") {
              if (!chatCompletionHasAssistantOutput(parsed)) {
                await retryEmptyAssistantOutput(
                  "empty assistant output in chat.completion",
                  true,
                  {
                    upstreamContentType: contentType,
                    upstreamEmptyBody,
                    tracePayload: parsed,
                  },
                );
                continue;
              }
              const respObj = chatCompletionObjectToResponseObject(
                parsed,
                req.body?.model ?? payloadToUpstream?.model ?? "unknown",
              );
              res.status(200);
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");
              res.write(responseObjectToSSE(respObj));
              res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                status: upstream.status,
                stream: true,
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

            if (parsed?.object === "response") {
              const sanitized = stripReasoningFromResponseObject(parsed);
              if (!responseHasAssistantOutput(sanitized)) {
                await retryEmptyAssistantOutput(
                  "empty assistant output in response object",
                  true,
                  {
                    usage: sanitized?.usage,
                    upstreamContentType: contentType,
                    upstreamEmptyBody,
                    tracePayload: sanitized,
                  },
                );
                continue;
              }
              res.status(200);
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");
              res.write(responseObjectToSSE(sanitized));
              res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
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
              const rendered = renderBufferedResponsesStream(
                text,
                req.body?.model ?? payloadToUpstream?.model ?? "unknown",
              );
              if (rendered.assistantEmptyOutput) {
                await retryEmptyAssistantOutput(
                  "empty assistant output in responses stream",
                  true,
                  {
                    usage: rendered.usage,
                    upstreamContentType: contentType,
                    upstreamEmptyBody: rendered.upstreamEmptyBody,
                    tracePayload: rendered.tracePayload,
                  },
                );
                continue;
              }

              res.status(200);
              res.set("Content-Type", "text/event-stream");
              res.set("Cache-Control", "no-cache");
              res.set("Connection", "keep-alive");
              res.write(rendered.body);
              res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: rendered.usage,
                requestBody,
                upstreamError,
                upstreamContentType: contentType,
                upstreamEmptyBody: rendered.upstreamEmptyBody,
                ...inspectAssistantPayload(rendered.tracePayload),
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

              // If response was empty/patched and upstream returned OK, retry with another account
              if (normalized.patched && upstream.ok) {
                sawEmptyAssistantOutput = true;
                markEmptyResponseError(
                  selected,
                  "empty assistant output in response event",
                );
                await store.upsertAccount(selected);
                continue; // Try next account
              }

              res
                .status(upstream.ok ? 200 : upstream.status)
                .json(normalized.chat);
              recordTrace({
                at: Date.now(),
                route: req.path,
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

            const rendered = renderBufferedResponsesStream(
              text,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
            if (upstream.ok && rendered.assistantEmptyOutput) {
              await retryEmptyAssistantOutput(
                "empty assistant output in responses stream",
                false,
                {
                  usage: rendered.usage,
                  upstreamContentType: contentType,
                  upstreamEmptyBody: rendered.upstreamEmptyBody,
                  tracePayload: rendered.tracePayload,
                },
              );
              continue;
            }
            const respObj = parseResponsesSSEToResponseObject(
              rendered.body || text,
            );
            res.status(upstream.ok ? 200 : upstream.status).json(respObj);
            recordTrace({
              at: Date.now(),
              route: req.path,
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

          if (!shouldReturnChatCompletions && parsed?.object === "response") {
            const sanitized = stripReasoningFromResponseObject(parsed);
            if (upstream.ok && !responseHasAssistantOutput(sanitized)) {
              await retryEmptyAssistantOutput(
                "empty assistant output in response object",
                false,
                {
                  usage: sanitized?.usage,
                  upstreamContentType: contentType,
                  upstreamEmptyBody,
                  tracePayload: sanitized,
                },
              );
              continue;
            }
            res.status(upstream.ok ? 200 : upstream.status).json(sanitized);
            recordTrace({
              at: Date.now(),
              route: req.path,
              accountId: selected.id,
              accountEmail: selected.email,
              model: tracedModel,
              status: upstream.status,
              stream: false,
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

          if (!shouldReturnChatCompletions && parsed?.object === "chat.completion") {
            if (upstream.ok && !chatCompletionHasAssistantOutput(parsed)) {
              await retryEmptyAssistantOutput(
                "empty assistant output in chat.completion",
                false,
                {
                  upstreamContentType: contentType,
                  upstreamEmptyBody,
                  tracePayload: parsed,
                },
              );
              continue;
            }
            const respObj = chatCompletionObjectToResponseObject(
              parsed,
              req.body?.model ?? payloadToUpstream?.model ?? "unknown",
            );
            res.status(upstream.ok ? 200 : upstream.status).json(respObj);
            recordTrace({
              at: Date.now(),
              route: req.path,
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

          if (upstream.ok && upstreamEmptyBody) {
            await retryEmptyAssistantOutput("empty upstream body", clientRequestedStream, {
              upstreamContentType: contentType,
              upstreamEmptyBody,
            });
            continue;
          }

          res.status(upstream.status);
          setForwardHeaders(upstream, res);
          res.type(contentType || "application/json").send(text);

          const usage = extractUsageFromPayload(parsed);

          recordTrace({
            at: Date.now(),
            route: req.path,
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

          // Handle z.ai specific business error codes
          const zaiErrorCode =
            candidate.provider === "zai" ? parseZaiErrorCode(text) : null;
          if (zaiErrorCode && shouldBlockAccountForZaiError(zaiErrorCode)) {
            const blockDuration = getZaiBlockDuration(zaiErrorCode);
            const until = Date.now() + blockDuration;
            selected.state = {
              ...selected.state,
              blockedUntil: until,
              blockedReason: `z.ai error ${zaiErrorCode}`,
            };
            rememberError(
              selected,
              `z.ai error ${zaiErrorCode}: ${text.slice(0, 200)}`,
            );
            await store.upsertAccount(selected);
            continue;
          }

          if (upstream.status === 429 || isQuotaErrorText(text)) {
            markQuotaHit(selected, `quota/rate-limit: ${upstream.status}`);
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
          rememberError(selected, msg);
          await store.upsertAccount(selected);
          recordTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: tracedModel,
            status: 599,
            stream: false,
            latencyMs: Date.now() - startedAt,
            error: msg,
            requestBody,
          });
          if (res.headersSent) {
            res.end();
            return;
          }
        }
      }
    }
    if (!providerTried) {
      return res
        .status(503)
        .json({ error: "no provider accounts configured for requested model" });
    }
    if (!res.headersSent) {
      if (sawEmptyAssistantOutput) {
        res.status(502).json({
          error: {
            message:
              "Upstream returned no assistant output after retrying all eligible accounts.",
            type: "upstream_error",
            code: "empty_assistant_output",
          },
        });
        return;
      }
      res.status(429).json({ error: "all accounts exhausted or unavailable" });
    }
  }

  function setForwardHeaders(from: Response, to: express.Response) {
    for (const [k, v] of from.headers.entries())
      if (k.toLowerCase() !== "content-length") to.setHeader(k, v);
  }

  router.all("/chat/completions", rejectNonPost("/v1/chat/completions"));
  router.post("/chat/completions", (req, res, next) => {
    res.locals._multivibeTraced = true;
    proxyWithRotation(req, res).catch(next);
  });
  router.all("/responses", rejectNonPost("/v1/responses"));
  router.post("/responses", (req, res, next) => {
    res.locals._multivibeTraced = true;
    proxyWithRotation(req, res).catch(next);
  });
  router.all("/responses/compact", rejectNonPost("/v1/responses/compact"));
  router.post("/responses/compact", (req, res, next) => {
    res.locals._multivibeTraced = true;
    proxyWithRotation(req, res).catch(next);
  });

  function toOpenAiModelShape(model: ExposedModel) {
    return model;
  }

  router.get("/models", async (_req, res) => {
    const models = await discoverModels(
      store,
      openaiBaseUrl,
      mistralBaseUrl,
      zaiBaseUrl,
    );
    res.json({ object: "list", data: models.map(toOpenAiModelShape) });
  });

  router.get("/models/:id", async (req, res) => {
    const id = req.params.id;
    const models = await discoverModels(
      store,
      openaiBaseUrl,
      mistralBaseUrl,
      zaiBaseUrl,
    );
    const model = models.find((m) => m.id === id);
    if (!model)
      return res.status(404).json({
        error: {
          message: `The model '${id}' does not exist`,
          type: "invalid_request_error",
        },
      });
    res.json(toOpenAiModelShape(model));
  });

  return router;
}
