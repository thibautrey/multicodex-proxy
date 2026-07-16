import {
  EXCLUDED_PROVIDER_MODELS,
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  HANG_RETRY_INTERVAL_MS,
  HANG_RETRY_MAX_DURATION_MS,
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
  accountUsable,
  chooseAccountForProvider,
  clearEmptyResponseHistory,
  getZaiBlockDuration,
  isQuotaErrorText,
  markEmptyResponseError,
  markModelNotFound,
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
  responseStreamHasAssistantOutput,
  sanitizeAssistantTextChunk,
  sanitizeChatCompletionObject,
  sanitizeResponsesSSEFrame,
  stripReasoningFromResponseObject,
} from "../../responses/sanitizers.js";
import {
  chatCompletionObjectToResponseObject,
  chatCompletionObjectToSSE,
  convertChatCompletionSSEToResponseSSE,
  convertResponsesSSEToChatCompletionSSE,
  createChatStreamAccumulator,
  createResponsesToChatCompletionStreamState,
  finalizeChatCompletionSSEToResponseSSE,
  finalizeResponsesSSEToChatCompletionSSE,
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

import { AccountStore } from "../../store.js";
import type { OAuthConfig } from "../../oauth.js";
import {
  TraceManager,
  type ResponseStreamDiagnostics,
} from "../../traces.js";
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

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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

type ImageTracePart = {
  path: string;
  type?: string;
  keys?: string[];
  imageUrl?: {
    kind: "url" | "data" | "object" | "unknown";
    length?: number;
    prefix?: string;
    mediaType?: string;
    detail?: string;
  };
  fileId?: string;
  mimeType?: string;
  dataLength?: number;
  textLength?: number;
};

type ImagePayloadTrace = {
  incoming: ImageTraceSummary;
  upstream: ImageTraceSummary;
  droppedImagePartCount: number;
};

type ImageTraceSummary = {
  format: "chat.completions" | "responses" | "unknown";
  hasImage: boolean;
  imagePartCount: number;
  textPartCount: number;
  messageCount?: number;
  inputItemCount?: number;
  parts: ImageTracePart[];
};

export function buildUpstreamRequestHeaders(
  provider: ProviderId,
  accessToken: string,
): Record<string, string> {
  const isOpenAI = provider === "openai";
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    accept: "text/event-stream",
    originator: isOpenAI ? CODEX_CLI_ORIGINATOR : "pi",
    "User-Agent": isOpenAI ? CODEX_CLI_USER_AGENT : PI_USER_AGENT,
    ...(isOpenAI ? { version: MODELS_CLIENT_VERSION } : {}),
  };
}

function truncateForTrace(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function objectKeysForTrace(value: any): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.keys(value).slice(0, 20);
}

function describeImageUrl(value: any): ImageTracePart["imageUrl"] {
  const raw = typeof value === "string" ? value : value?.url;
  const detail = typeof value?.detail === "string" ? value.detail : undefined;
  if (typeof raw !== "string") {
    return {
      kind: value && typeof value === "object" ? "object" : "unknown",
      detail,
    };
  }

  const imageUrl: NonNullable<ImageTracePart["imageUrl"]> = {
    kind: raw.startsWith("data:") ? "data" : "url",
    length: raw.length,
    prefix: truncateForTrace(raw, raw.startsWith("data:") ? 80 : 160),
    detail,
  };
  const mediaType = raw.match(/^data:([^;,]+)/)?.[1];
  if (mediaType) imageUrl.mediaType = mediaType;
  return imageUrl;
}

function imageUrlDetail(value: any, fallback: any): string | undefined {
  return typeof value?.detail === "string"
    ? value.detail
    : typeof fallback === "string"
      ? fallback
      : undefined;
}

function inspectContentPartForImages(part: any, path: string): ImageTracePart | null {
  const type = typeof part?.type === "string" ? part.type : undefined;
  const keys = objectKeysForTrace(part);

  if (type === "image_url") {
    const imageUrl = describeImageUrl(part?.image_url);
    const detail = imageUrlDetail(part?.image_url, part?.detail);
    if (imageUrl && detail) imageUrl.detail = detail;
    return {
      path,
      type,
      keys,
      imageUrl,
    };
  }

  if (type === "input_image") {
    return {
      path,
      type,
      keys,
      imageUrl:
        typeof part?.image_url !== "undefined"
          ? describeImageUrl(part.image_url)
          : undefined,
      fileId: typeof part?.file_id === "string" ? part.file_id : undefined,
      mimeType: typeof part?.mime_type === "string" ? part.mime_type : undefined,
      dataLength: typeof part?.data === "string" ? part.data.length : undefined,
    };
  }

  if (type && type.includes("image")) {
    return {
      path,
      type,
      keys,
      imageUrl:
        typeof part?.image_url !== "undefined" ? describeImageUrl(part.image_url) : undefined,
      fileId: typeof part?.file_id === "string" ? part.file_id : undefined,
      mimeType: typeof part?.mime_type === "string" ? part.mime_type : undefined,
      dataLength: typeof part?.data === "string" ? part.data.length : undefined,
    };
  }

  if (type === "text" || type === "input_text" || type === "output_text") {
    return {
      path,
      type,
      keys,
      textLength: typeof part?.text === "string" ? part.text.length : undefined,
    };
  }

  return null;
}

function summarizeImagePayload(payload: any): ImageTraceSummary {
  const messages = Array.isArray(payload?.messages) ? payload.messages : undefined;
  const input = Array.isArray(payload?.input) ? payload.input : undefined;
  const summary: ImageTraceSummary = {
    format: messages ? "chat.completions" : input ? "responses" : "unknown",
    hasImage: false,
    imagePartCount: 0,
    textPartCount: 0,
    messageCount: messages?.length,
    inputItemCount: input?.length,
    parts: [],
  };

  const visitPart = (part: any, path: string) => {
    const inspected = inspectContentPartForImages(part, path);
    if (!inspected) return;
    if (inspected.type?.includes("image")) {
      summary.hasImage = true;
      summary.imagePartCount += 1;
    } else if (inspected.textLength !== undefined) {
      summary.textPartCount += 1;
    }
    summary.parts.push(inspected);
  };

  if (messages) {
    messages.forEach((message: any, messageIndex: number) => {
      const content = message?.content;
      if (Array.isArray(content)) {
        content.forEach((part: any, partIndex: number) =>
          visitPart(part, `messages[${messageIndex}].content[${partIndex}]`),
        );
      } else if (typeof content === "string") {
        summary.textPartCount += 1;
        summary.parts.push({
          path: `messages[${messageIndex}].content`,
          type: "string",
          textLength: content.length,
        });
      }
    });
  }

  if (input) {
    input.forEach((item: any, itemIndex: number) => {
      const content = item?.content;
      if (Array.isArray(content)) {
        content.forEach((part: any, partIndex: number) =>
          visitPart(part, `input[${itemIndex}].content[${partIndex}]`),
        );
      } else if (typeof content === "string") {
        summary.textPartCount += 1;
        summary.parts.push({
          path: `input[${itemIndex}].content`,
          type: "string",
          textLength: content.length,
        });
      }

      visitPart(item, `input[${itemIndex}]`);
    });
  }

  return summary;
}

function buildImagePayloadTrace(incomingPayload: any, upstreamPayload: any): ImagePayloadTrace | undefined {
  const incoming = summarizeImagePayload(incomingPayload);
  const upstream = summarizeImagePayload(upstreamPayload);
  if (!incoming.hasImage && !upstream.hasImage) return undefined;
  return {
    incoming,
    upstream,
    droppedImagePartCount: Math.max(0, incoming.imagePartCount - upstream.imagePartCount),
  };
}

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

function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
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

/** Check whether a model is explicitly excluded from a provider via EXCLUDED_PROVIDER_MODELS. */
function isModelExcludedFromProvider(model: string | undefined, provider: ProviderId): boolean {
  const key = normalizeModelLookupKey(model);
  if (!key || !EXCLUDED_PROVIDER_MODELS.size) return false;
  const excluded = EXCLUDED_PROVIDER_MODELS.get(provider);
  return excluded ? excluded.has(key) : false;
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

export async function discoverModels(
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
            if (isModelExcludedFromProvider(slug, provider)) continue;
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
          if (isModelExcludedFromProvider(id, provider)) continue;
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

const EFFORT_TIERS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type EffortTier = (typeof EFFORT_TIERS)[number];

const EFFORT_TARGET_RE = /^(minimal|low|medium|high|xhigh):(.+)$/;

function hasReasoningEffort(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) {
    return true;
  }
  return (
    payload.reasoning &&
    typeof payload.reasoning === "object" &&
    Object.prototype.hasOwnProperty.call(payload.reasoning, "effort")
  );
}

function defaultChatGptReasoningEffort(
  payload: any,
  upstreamMode: UpstreamMode,
): void {
  if (!payload || typeof payload !== "object" || hasReasoningEffort(payload)) {
    return;
  }

  if (upstreamMode === "chat/completions") {
    payload.reasoning_effort = "low";
    return;
  }

  payload.reasoning =
    payload.reasoning && typeof payload.reasoning === "object"
      ? payload.reasoning
      : {};
  payload.reasoning.effort = "low";
}

function parseEffortTarget(target: string): { effort?: EffortTier; model: string } {
  const m = target.match(EFFORT_TARGET_RE);
  if (m) return { effort: m[1] as EffortTier, model: m[2] };
  return { model: target };
}

/**
 * Filters an alias's targets to the best matching effort tier.
 *
 * - If requestEffort is set: prefer exact-match qualified targets, then
 *   fall back one tier up (xhigh->high->...->minimal) for any missing tier,
 *   then fall back down, and finally use unqualified targets as catch-all.
 * - If requestEffort is undefined: use only unqualified targets.
 */
function resolveEffortTargets(
  targets: string[],
  requestEffort: EffortTier | undefined,
): string[] {
  const qualified = new Map<EffortTier, string[]>();
  const unqualified: string[] = [];

  for (const t of targets) {
    const { effort, model } = parseEffortTarget(t);
    if (effort) {
      const list = qualified.get(effort);
      if (list) list.push(model);
      else qualified.set(effort, [model]);
    } else {
      unqualified.push(model);
    }
  }

  if (!requestEffort) return unqualified;

  // Exact match first
  const exact = qualified.get(requestEffort);
  if (exact && exact.length) return exact;

  // Fallback: climb up then down the effort ladder
  const idx = EFFORT_TIERS.indexOf(requestEffort);
  if (idx === -1) return unqualified;

  // Try higher (more intensive) tiers first
  for (let i = idx + 1; i < EFFORT_TIERS.length; i++) {
    const fb = qualified.get(EFFORT_TIERS[i]);
    if (fb && fb.length) return fb;
  }
  // Then lower tiers
  for (let i = idx - 1; i >= 0; i--) {
    const fb = qualified.get(EFFORT_TIERS[i]);
    if (fb && fb.length) return fb;
  }

  return unqualified;
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
  requestEffort?: EffortTier,
): RoutingCandidate[] {
  const key = normalizeModelLookupKey(requestModel);
  const alias = aliases.find(
    (a) => a.enabled && normalizeModelLookupKey(a.id) === key,
  );

  let targets: string[];
  if (alias && alias.targets.length) {
    targets = resolveEffortTargets(alias.targets, requestEffort);
  } else if (requestModel) {
    targets = [requestModel];
  } else {
    targets = [];
  }

  const out: RoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const targetKey = normalizeModelLookupKey(target);
    if (!targetKey || seen.has(targetKey)) continue;
    seen.add(targetKey);
    for (const provider of providersForModel(target, discoveredModels)) {
      if (isModelExcludedFromProvider(target, provider)) continue;
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
  // Fallback: infer a provider, but still respect exclusions
  const fallbackProvider = inferProviderFromModel(requestModel, discoveredModels);
  if (isModelExcludedFromProvider(requestModel, fallbackProvider)) {
    // Try providers in order until we find a non-excluded one
    const tryProviders: ProviderId[] = ["openai", "openai-compatible", "mistral", "zai"];
    for (const p of tryProviders) {
      if (!isModelExcludedFromProvider(requestModel, p)) {
        return [
          {
            requestedModel: requestModel,
            resolvedModel: requestModel,
            provider: p,
          },
        ];
      }
    }
  }
  return [
    {
      requestedModel: requestModel,
      resolvedModel: requestModel,
      provider: fallbackProvider,
    },
  ];
}

export function buildImageAwareRoutingCandidates(
  requestBody: any,
  discoveredModels: ExposedModel[],
  aliases: ModelAlias[],
  imageRequestModelOverride?: string,
  requestEffort?: EffortTier,
): RoutingCandidate[] {
  const requestModel =
    typeof requestBody?.model === "string" && requestBody.model.trim()
      ? requestBody.model.trim()
      : undefined;
  const requestHasImage = summarizeImagePayload(requestBody).hasImage;
  const validOverride = imageRequestModelOverride
    ? discoveredModels.some(
        (model) =>
          normalizeModelLookupKey(model.id) ===
          normalizeModelLookupKey(imageRequestModelOverride),
      ) ||
      aliases.some(
        (alias) =>
          alias.enabled &&
          normalizeModelLookupKey(alias.id) ===
            normalizeModelLookupKey(imageRequestModelOverride),
      )
    : false;
  const routingRequestModel =
    requestHasImage && imageRequestModelOverride && validOverride
      ? imageRequestModelOverride
      : requestModel;
  return buildRoutingCandidates(
    routingRequestModel,
    discoveredModels,
    aliases,
    requestEffort,
  ).map((candidate) => ({
    ...candidate,
    requestedModel: requestModel,
  }));
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
  diagnostics: ResponseStreamDiagnostics;
};

type BufferedResponsesStreamResult = {
  body: string;
  usage: any;
  upstreamEmptyBody: boolean;
  assistantEmptyOutput: boolean;
  tracePayload: any;
  responseStreamDiagnostics: ResponseStreamDiagnostics;
};

function createResponseStreamDiagnostics(): ResponseStreamDiagnostics {
  return {
    eventCount: 0,
    eventTypes: {},
    customToolCalls: [],
    invalidDataPayloadCount: 0,
    outputTextDeltaCount: 0,
    outputTextDoneCount: 0,
    reasoningEventCount: 0,
    refusalEventCount: 0,
    functionCallCount: 0,
    hiddenFunctionCallCount: 0,
    sanitizerDroppedEventCount: 0,
    sanitizerDroppedTextEventCount: 0,
    sawResponseCompleted: false,
    sawChatCompletionChunk: false,
  };
}

function customToolCallKey(event: any): string | undefined {
  const itemId = event?.item_id ?? event?.item?.id;
  const callId = event?.call_id ?? event?.item?.call_id;
  const key = itemId ?? callId;
  return typeof key === "string" && key ? key : undefined;
}

function inspectCustomToolCallEvent(
  event: any,
  type: string,
  diagnostics: ResponseStreamDiagnostics,
): void {
  const item = event?.item ?? {};
  const isCustomToolItem = item?.type === "custom_tool_call";
  const isCustomToolEvent = type.startsWith("response.custom_tool_call_");
  if (!isCustomToolItem && !isCustomToolEvent) return;

  const key = customToolCallKey(event);
  let tool = key
    ? diagnostics.customToolCalls.find((entry: any) => entry._key === key)
    : undefined;
  if (!tool && diagnostics.customToolCalls.length < 8) {
    tool = {
      itemIdPresent: typeof (event?.item_id ?? item?.id) === "string",
      callIdPresent: typeof (event?.call_id ?? item?.call_id) === "string",
      name:
        typeof (event?.name ?? item?.name) === "string"
          ? (event?.name ?? item?.name).slice(0, 120)
          : undefined,
      status:
        typeof item?.status === "string" ? item.status : undefined,
      inputDeltaCount: 0,
      inputBytes: 0,
      sawInputDone: false,
      sawOutputItemAdded: false,
      sawOutputItemDone: false,
    };
    Object.defineProperty(tool, "_key", {
      value: key ?? `anonymous-${diagnostics.customToolCalls.length + 1}`,
      enumerable: false,
    });
    diagnostics.customToolCalls.push(tool);
  }
  if (!tool) return;

  if (type === "response.output_item.added") tool.sawOutputItemAdded = true;
  if (type === "response.output_item.done") tool.sawOutputItemDone = true;
  if (type === "response.custom_tool_call_input.delta") {
    tool.inputDeltaCount += 1;
    if (typeof event?.delta === "string") tool.inputBytes += Buffer.byteLength(event.delta);
  }
  if (type === "response.custom_tool_call_input.done") tool.sawInputDone = true;
}

function inspectResponseStreamEvent(
  event: any,
  diagnostics: ResponseStreamDiagnostics,
): void {
  diagnostics.eventCount += 1;
  const type = typeof event?.type === "string" ? event.type : "";
  if (type) {
    diagnostics.eventTypes[type] = (diagnostics.eventTypes[type] ?? 0) + 1;
  }
  if (event?.object === "chat.completion.chunk") {
    diagnostics.sawChatCompletionChunk = true;
  }
  if (type === "response.output_text.delta") diagnostics.outputTextDeltaCount += 1;
  if (type === "response.output_text.done") diagnostics.outputTextDoneCount += 1;
  if (type.startsWith("response.reasoning")) diagnostics.reasoningEventCount += 1;
  if (type.startsWith("response.refusal")) diagnostics.refusalEventCount += 1;
  if (type === "response.completed") diagnostics.sawResponseCompleted = true;
  inspectCustomToolCallEvent(event, type, diagnostics);

  const item = event?.item;
  if (item?.type === "function_call") {
    diagnostics.functionCallCount += 1;
    if (
      typeof item.name === "string" &&
      item.name.trim().toLowerCase().startsWith("functions.")
    ) {
      diagnostics.hiddenFunctionCallCount += 1;
    }
  }
}

function inspectResponsesDataLine(
  line: string,
  state: ResponsesStreamState,
): void {
  if (!line.startsWith("data:")) return;

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;

  try {
    const event = JSON.parse(payload);
    inspectResponseStreamEvent(event, state.diagnostics);
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
  } catch {
    state.diagnostics.invalidDataPayloadCount += 1;
  }
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
  const diagnostics = createResponseStreamDiagnostics();

  if (sawChatCompletionStream) {
    const body: string[] = [];
    const chatStreamState = createChatStreamAccumulator(model);

    for (const frame of frames) {
      for (const payload of parseSSEDataPayloads(frame)) {
        inspectResponseStreamEvent(payload, diagnostics);
      }
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
    const hasAssistantOutput = responseStreamHasAssistantOutput(body.join(""), {
      requireFunctionCallOutputItem: true,
    });
    return {
      body: body.join(""),
      usage: chat?.usage,
      upstreamEmptyBody,
      assistantEmptyOutput: !hasAssistantOutput,
      tracePayload: chat,
      responseStreamDiagnostics: diagnostics,
    };
  }

  const body: string[] = [];
  const streamState: ResponsesStreamState = {
    accumulatedUsage: null,
    streamedFallbackText: "",
    sawResponseCompleted: false,
    diagnostics,
  };

  for (const frame of frames) {
    for (const rawLine of frame.split(/\r?\n/)) {
      inspectResponsesDataLine(rawLine.trim(), streamState);
    }
    const filtered = sanitizeResponsesSSEFrame(frame);
    if (filtered === null) {
      streamState.diagnostics.sanitizerDroppedEventCount += 1;
      const event = parseSSEDataPayloads(frame)[0];
      if (
        event?.type === "response.output_text.delta" ||
        event?.type === "response.output_text.done"
      ) {
        streamState.diagnostics.sanitizerDroppedTextEventCount += 1;
      }
    }
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
  const hasAssistantOutput = responseStreamHasAssistantOutput(body.join(""), {
    requireFunctionCallOutputItem: true,
  });
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
    responseStreamDiagnostics: streamState.diagnostics,
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

function isModelNotFoundError(status: number, errorText: string): boolean {
  return (
    (status === 400 || status === 404) &&
    /\bmodel(?:\s+['"`]?[^'"`\s]+['"`]?)?\s+not\s+found\b|\bmodel_not_found\b/i.test(
      errorText,
    )
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

    // Only refresh tokens/usage for enabled accounts. Skipping disabled
    // accounts avoids wasting API calls and prevents a race where stale
    // account objects overwrite admin changes (e.g. re-enabling a disabled
    // account).
    accounts = await Promise.all(
      accounts.map(async (account) => {
        if (!account.enabled) return account;
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
    for (const account of accounts) {
      if (account.enabled) {
        store.markAccountModified(account.id, account);
      }
    }

    const requestModel =
      typeof req.body?.model === "string" && req.body.model.trim()
        ? req.body.model.trim()
        : undefined;

    // Extract reasoning effort from the request for effort-based alias routing.
    // Chat Completions uses flat reasoning_effort; Responses uses reasoning.effort.
    const rawEffort: string | undefined =
      typeof req.body?.reasoning_effort === "string"
        ? req.body.reasoning_effort
        : req.body?.reasoning?.effort;
    const requestEffort: EffortTier | undefined =
      rawEffort && (EFFORT_TIERS as readonly string[]).includes(rawEffort)
        ? (rawEffort as EffortTier)
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
    const imageRequestModelOverride = store.getCachedSettings().imageRequestModelOverride;
    const routingCandidates = buildImageAwareRoutingCandidates(
      req.body,
      discoveredModels,
      modelAliases,
      imageRequestModelOverride,
      requestEffort,
    );
    const maxAttempts = Math.min(accounts.length, MAX_ACCOUNT_RETRY_ATTEMPTS);
    let sawEmptyAssistantOutput = false;
    const hangStart = Date.now();

    // Outer hang loop: when all accounts are exhausted (e.g. all rate-limited),
    // sleep and retry instead of failing immediately, up to HANG_RETRY_MAX_DURATION_MS.
    while (true) {
      const tried = new Set<string>();
      let providerTried = false;

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
          providerAccounts.filter((a) => !tried.has(a.id) && accountUsable(a, candidate.resolvedModel)),
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
        if (candidate.resolvedModel && candidate.resolvedModel !== candidate.requestedModel)
          payloadToUpstream.model = candidate.resolvedModel;
        if (candidate.provider === "openai" && selected.chatgptAccountId) {
          defaultChatGptReasoningEffort(payloadToUpstream, upstreamMode);
        }
        filterUnsupportedTools(
          payloadToUpstream,
          candidate.provider,
          candidate.resolvedModel,
          discoveredModels,
        );
        const imageTrace = buildImagePayloadTrace(req.body, payloadToUpstream);
        if (imageTrace) {
          console.info(
            "[proxy:image-trace]",
            JSON.stringify({
              route: req.path,
              accountId: selected.id,
              provider: candidate.provider,
              upstreamMode,
              requestedModel: requestModel,
              resolvedModel: candidate.resolvedModel,
              incomingFormat: imageTrace.incoming.format,
              upstreamFormat: imageTrace.upstream.format,
              incomingImages: imageTrace.incoming.imagePartCount,
              upstreamImages: imageTrace.upstream.imagePartCount,
              droppedImagePartCount: imageTrace.droppedImagePartCount,
            }),
          );
        }
        const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;
        const traceImage = imageTrace ? { imageTrace } : {};
        const tracedModel =
          requestModel ??
          (typeof payloadToUpstream?.model === "string" &&
          payloadToUpstream.model.trim()
            ? payloadToUpstream.model.trim()
            : undefined);
        const blockModel = candidate.resolvedModel ?? tracedModel ?? "unknown";
        const traceModelResolution = {
          requestedModel: requestModel,
          resolvedModel:
            candidate.resolvedModel && candidate.resolvedModel !== requestModel
              ? candidate.resolvedModel
              : undefined,
        };

        const retryEmptyAssistantOutput = async (
          message: string,
          stream: boolean,
          details: {
            usage?: any;
            upstreamContentType?: string;
            upstreamEmptyBody?: boolean;
            tracePayload?: any;
            responseStreamDiagnostics?: ResponseStreamDiagnostics;
          } = {},
        ) => {
          sawEmptyAssistantOutput = true;
          markEmptyResponseError(selected, blockModel, message);
          await store.upsertAccount(selected);
          recordTrace({
            at: Date.now(),
            route: req.path,
            accountId: selected.id,
            accountEmail: selected.email,
            model: tracedModel,
            ...traceModelResolution,
            status: 502,
            stream,
            latencyMs: Date.now() - startedAt,
            usage: details.usage,
            requestBody,
            ...traceImage,
            error: message,
            upstreamContentType: details.upstreamContentType,
            ...inspectAssistantPayload(details.tracePayload),
            responseStreamDiagnostics: details.responseStreamDiagnostics,
            upstreamEmptyBody: details.upstreamEmptyBody,
            assistantEmptyOutput: true,
          });
        };

        const headers = buildUpstreamRequestHeaders(
          candidate.provider,
          selected.accessToken,
        );
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
                res.flushHeaders();
                res.write(": connected\n\n");
                const reader = upstream.body.getReader();
                const decoder = new TextDecoder();
                let sseBuffer = "";
                let doneSent = false;
                let accumulatedUsage: any = null;
                let clientDisconnected = false;
                const abortOnDisconnect = () => {
                  clientDisconnected = !res.writableEnded;
                  if (clientDisconnected) void reader.cancel();
                };
                res.once("close", abortOnDisconnect);
                const keepaliveTimer = setInterval(() => {
                  if (!res.writableEnded && !clientDisconnected) {
                    res.write(": keepalive\n\n");
                  }
                }, 15_000);
                keepaliveTimer.unref?.();

                const forwardFrame = (frame: string) => {
                  res.write(frame.endsWith("\n\n") ? frame : `${frame}\n\n`);
                  if (frame.includes("[DONE]")) doneSent = true;
                  for (const payload of parseSSEDataPayloads(frame)) {
                    if (payload?.usage) accumulatedUsage = payload.usage;
                  }
                };

                try {
                  while (!clientDisconnected) {
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
                } finally {
                  clearInterval(keepaliveTimer);
                  res.off("close", abortOnDisconnect);
                }

                if (clientDisconnected) return;
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
            ...traceModelResolution,
                  status: upstream.status,
                  stream: true,
                  latencyMs: Date.now() - startedAt,
                  usage: accumulatedUsage,
                  requestBody,
            ...traceImage,
                  upstreamContentType: contentType,
                });
                return;
              }

              const model =
                req.body?.model ?? payloadToUpstream?.model ?? "unknown";
              if (!upstream.body) {
                res.status(502);
                res.set("Content-Type", "text/event-stream");
                res.set("Cache-Control", "no-cache");
                res.set("Connection", "keep-alive");
                res.flushHeaders();
                res.write(
                  `data: ${JSON.stringify({
                    error: {
                      message: "Upstream returned an empty streaming body.",
                      type: "upstream_error",
                      code: "empty_stream_body",
                    },
                  })}\n\ndata: [DONE]\n\n`,
                );
                res.end();
                recordTrace({
                  at: Date.now(),
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  ...traceModelResolution,
                  status: 502,
                  stream: true,
                  latencyMs: Date.now() - startedAt,
                  error: "empty responses stream body",
                  requestBody,
                  ...traceImage,
                  upstreamContentType: contentType,
                  upstreamEmptyBody: true,
                });
                return;
              }

              if (!res.headersSent) {
                res.status(upstream.ok ? 200 : upstream.status);
                res.set("Content-Type", "text/event-stream");
                res.set("Cache-Control", "no-cache");
                res.set("Connection", "keep-alive");
                res.flushHeaders();
              }
              res.write(": connected\n\n");

              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              const streamState =
                createResponsesToChatCompletionStreamState(model);
              let sseBuffer = "";
              let clientDisconnected = false;
              let streamError: Error | undefined;
              const abortOnDisconnect = () => {
                clientDisconnected = !res.writableEnded;
                if (clientDisconnected) void reader.cancel();
              };
              res.once("close", abortOnDisconnect);
              const keepaliveTimer = setInterval(() => {
                if (!res.writableEnded && !clientDisconnected) {
                  res.write(": keepalive\n\n");
                }
              }, 15_000);
              keepaliveTimer.unref?.();

              const forwardConvertedFrame = (frame: string) => {
                const payloads = parseSSEDataPayloads(frame);
                for (const payload of payloads) {
                  inspectResponseStreamEvent(payload, streamStateDiagnostics);
                }
                const converted = convertResponsesSSEToChatCompletionSSE(
                  frame,
                  streamState,
                );
                if (converted && !res.writableEnded) {
                  res.write(converted);
                } else if (
                  !res.writableEnded &&
                  payloads.some((payload) =>
                    String(payload?.type ?? "").startsWith("response.reasoning"),
                  )
                ) {
                  res.write(": keepalive\n\n");
                }
              };
              const streamStateDiagnostics = createResponseStreamDiagnostics();

              try {
                while (!clientDisconnected) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  sseBuffer += decoder.decode(value, { stream: true });
                  while (true) {
                    const next = takeNextSSEFrame(sseBuffer);
                    if (!next) break;
                    sseBuffer = next.rest;
                    forwardConvertedFrame(next.frame);
                  }
                }

                if (!clientDisconnected) {
                  sseBuffer += decoder.decode();
                  while (true) {
                    const next = takeNextSSEFrame(sseBuffer);
                    if (!next) break;
                    sseBuffer = next.rest;
                    forwardConvertedFrame(next.frame);
                  }
                  if (sseBuffer.trim()) forwardConvertedFrame(sseBuffer);
                }
              } catch (error: any) {
                streamError =
                  error instanceof Error ? error : new Error(String(error));
              } finally {
                clearInterval(keepaliveTimer);
                res.off("close", abortOnDisconnect);
              }

              if (clientDisconnected) return;

              const completed =
                finalizeResponsesSSEToChatCompletionSSE(streamState);
              if (completed && !res.writableEnded) res.write(completed);

              if (streamError && !streamState.assistantOutputSent) {
                rememberError(selected, streamError.message);
                await store.upsertAccount(selected);
                recordTrace({
                  at: Date.now(),
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  ...traceModelResolution,
                  status: 599,
                  stream: true,
                  latencyMs: Date.now() - startedAt,
                  error: streamError.message,
                  requestBody,
                  ...traceImage,
                  upstreamContentType: contentType,
                  responseStreamDiagnostics: streamStateDiagnostics,
                });
                if (!res.writableEnded) {
                  res.write(
                    `data: ${JSON.stringify({
                      error: {
                        message: streamError.message,
                        type: "upstream_error",
                        code: "stream_interrupted",
                      },
                    })}\n\ndata: [DONE]\n\n`,
                  );
                  res.end();
                }
                return;
              }

              if (!streamState.assistantOutputSent && upstream.ok) {
                markEmptyResponseError(
                  selected,
                  blockModel,
                  "empty assistant output in responses stream",
                );
                await store.upsertAccount(selected);
                if (!res.writableEnded) {
                  res.write(
                    `data: ${JSON.stringify({
                      error: {
                        message: "Upstream returned no assistant output.",
                        type: "upstream_error",
                        code: "empty_assistant_output",
                      },
                    })}\n\ndata: [DONE]\n\n`,
                  );
                  res.end();
                }
                recordTrace({
                  at: Date.now(),
                  route: req.path,
                  accountId: selected.id,
                  accountEmail: selected.email,
                  model: tracedModel,
                  ...traceModelResolution,
                  status: 502,
                  stream: true,
                  latencyMs: Date.now() - startedAt,
                  usage: streamState.usage,
                  requestBody,
                  ...traceImage,
                  error: "empty assistant output in responses stream",
                  upstreamContentType: contentType,
                  upstreamEmptyBody: false,
                  assistantEmptyOutput: true,
                  responseStreamDiagnostics: streamStateDiagnostics,
                });
                return;
              }

              if (!res.writableEnded) res.end();

              recordTrace({
                at: Date.now(),
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: streamState.usage,
                requestBody,
            ...traceImage,
                upstreamContentType: contentType,
                upstreamEmptyBody: false,
                responseStreamDiagnostics: streamStateDiagnostics,
                error: streamError?.message,
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
                  blockModel,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: normalized.chat?.usage,
                requestBody,
            ...traceImage,
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
                    responseStreamDiagnostics: rendered.responseStreamDiagnostics,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: false,
                latencyMs: Date.now() - startedAt,
                usage: rendered.usage ?? respObj?.usage,
                requestBody,
            ...traceImage,
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
                blockModel,
                "empty assistant output in responses stream",
              );
              await store.upsertAccount(selected);
              recordTrace({
                at: Date.now(),
                route: req.path,
                accountId: selected.id,
                accountEmail: selected.email,
                model: tracedModel,
            ...traceModelResolution,
                status: 502,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: rendered.usage,
                requestBody,
            ...traceImage,
                error: "empty assistant output in responses stream",
                upstreamContentType: contentType,
                upstreamEmptyBody: rendered.upstreamEmptyBody,
                assistantEmptyOutput: true,
                responseStreamDiagnostics: rendered.responseStreamDiagnostics,
              });
              continue;
            }

            if (upstream.ok) {
              clearEmptyResponseHistory(selected, blockModel);
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
            ...traceModelResolution,
              status: upstream.status,
              stream: true,
              latencyMs: Date.now() - startedAt,
              usage: rendered.usage,
              requestBody,
            ...traceImage,
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
                  blockModel,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: normalized.chat?.usage,
                requestBody,
            ...traceImage,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: converted?.usage,
                requestBody,
            ...traceImage,
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
                  blockModel,
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
                  blockModel,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: chatResp?.usage,
                requestBody,
            ...traceImage,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: respObj?.usage,
                requestBody,
            ...traceImage,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: sanitized?.usage,
                requestBody,
            ...traceImage,
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
                    responseStreamDiagnostics: rendered.responseStreamDiagnostics,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: true,
                latencyMs: Date.now() - startedAt,
                usage: rendered.usage,
                requestBody,
            ...traceImage,
                upstreamError,
                upstreamContentType: contentType,
                upstreamEmptyBody: rendered.upstreamEmptyBody,
                responseStreamDiagnostics: rendered.responseStreamDiagnostics,
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
                  blockModel,
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
            ...traceModelResolution,
                status: upstream.status,
                stream: false,
                latencyMs: Date.now() - startedAt,
                usage: normalized.chat?.usage,
                requestBody,
            ...traceImage,
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
                  responseStreamDiagnostics: rendered.responseStreamDiagnostics,
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
            ...traceModelResolution,
              status: upstream.status,
              stream: false,
              latencyMs: Date.now() - startedAt,
              usage: respObj?.usage,
              requestBody,
            ...traceImage,
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
            ...traceModelResolution,
              status: upstream.status,
              stream: false,
              latencyMs: Date.now() - startedAt,
              usage: sanitized?.usage,
              requestBody,
            ...traceImage,
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
            ...traceModelResolution,
              status: upstream.status,
              stream: false,
              latencyMs: Date.now() - startedAt,
              usage: respObj?.usage,
              requestBody,
            ...traceImage,
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

          if (isModelNotFoundError(upstream.status, text)) {
            markModelNotFound(
              selected,
              blockModel,
              `model unavailable: ${text.slice(0, 200)}`,
            );
            await store.upsertAccount(selected);
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
            ...traceModelResolution,
            status: upstream.status,
            stream: false,
            latencyMs: Date.now() - startedAt,
            usage,
            requestBody,
            ...traceImage,
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
            const modelKey = (blockModel).toLowerCase();
            const modelBlocks = { ...selected.state?.modelBlocks };
            modelBlocks[modelKey] = { until, reason: `z.ai error ${zaiErrorCode}` };
            selected.state = { ...selected.state, modelBlocks };
            rememberError(
              selected,
              `z.ai error ${zaiErrorCode}: ${text.slice(0, 200)}`,
            );
            await store.upsertAccount(selected);
            continue;
          }

          if (upstream.status === 429 || isQuotaErrorText(text)) {
            markQuotaHit(selected, blockModel, `quota/rate-limit: ${upstream.status}`);
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
            ...traceModelResolution,
            status: 599,
            stream: false,
            latencyMs: Date.now() - startedAt,
            error: msg,
            requestBody,
            ...traceImage,
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
    if (res.headersSent) return;

    const elapsed = Date.now() - hangStart;
    if (elapsed >= HANG_RETRY_MAX_DURATION_MS) break; // fall through to final error response

    // Wait before retrying: some accounts may have had their rate-limit blocks expire
    await sleep(HANG_RETRY_INTERVAL_MS);
    // Reload accounts from store to pick up any blocks that expired
    accounts = store.getCachedAccounts();
    // sawEmptyAssistantOutput is preserved across retries
    }

    // Max hang duration exceeded — all accounts still exhausted
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
      if (!isHopByHopHeader(k)) to.setHeader(k, v);
  }

  function requestHeadersForPassthrough(
    req: express.Request,
    account: { accessToken: string; chatgptAccountId?: string },
  ): Record<string, string> {
    const forwarded: Record<string, string> = {};
    const originalHeaders = req.originalHeadersForPassthrough ?? req.headers;

    for (const [rawName, rawValue] of Object.entries(originalHeaders)) {
      const name = rawName.toLowerCase();
      if (isHopByHopHeader(name) || name === "authorization") continue;
      if (Array.isArray(rawValue)) {
        forwarded[rawName] = rawValue.join(", ");
      } else if (typeof rawValue === "string") {
        forwarded[rawName] = rawValue;
      }
    }

    forwarded.authorization = `Bearer ${account.accessToken}`;
    forwarded["OpenAI-Beta"] = "responses=experimental";
    if (account.chatgptAccountId) {
      forwarded["chatgpt-account-id"] = account.chatgptAccountId;
    }
    return forwarded;
  }

  function requestBodyForPassthrough(req: express.Request): BodyInit | undefined {
    const bufferToArrayBuffer = (buffer: Buffer): ArrayBuffer =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;

    if (req.method === "GET" || req.method === "HEAD") return undefined;
    if (req.rawBody) return bufferToArrayBuffer(req.rawBody);
    if (req.body === undefined) return undefined;
    if (Buffer.isBuffer(req.body)) return bufferToArrayBuffer(req.body);
    if (typeof req.body === "string") return req.body;
    return JSON.stringify(req.body);
  }

  function shouldHandleRootPassthrough(req: express.Request): boolean {
    const path = req.path || "/";
    if (
      path === "/" ||
      path === "/health" ||
      path === "/favicon.ico" ||
      path.startsWith("/admin") ||
      path.startsWith("/assets")
    ) {
      return false;
    }

    const accepts = String(req.header("accept") ?? "").toLowerCase();
    if (req.method === "GET" && accepts.includes("text/html")) return false;
    return true;
  }

  async function passthroughToDefaultChatGpt(
    req: express.Request,
    res: express.Response,
  ) {
    const startedAt = Date.now();
    const traceRoute = req.originalUrl || req.path;
    const settings = store.getCachedSettings();
    const defaultAccountId = settings.defaultPassthroughAccountId;
    const requestBody = TRACE_INCLUDE_BODY ? req.body : undefined;

    if (!defaultAccountId) {
      recordTrace({
        at: Date.now(),
        route: traceRoute,
        status: 503,
        stream: false,
        latencyMs: Date.now() - startedAt,
        requestBody,
        error: "default passthrough account not configured",
      });
      return res
        .status(503)
        .json({ error: "default passthrough account not configured" });
    }

    let selected = store
      .getCachedAccounts()
      .find((account) => account.id === defaultAccountId);
    if (!selected || normalizeProvider(selected) !== "openai" || !selected.enabled) {
      recordTrace({
        at: Date.now(),
        route: traceRoute,
        accountId: defaultAccountId,
        accountEmail: selected?.email,
        status: 503,
        stream: false,
        latencyMs: Date.now() - startedAt,
        requestBody,
        error: "default passthrough account unavailable",
      });
      return res
        .status(503)
        .json({ error: "default passthrough account unavailable" });
    }

    try {
      selected = await ensureValidToken(selected, oauthConfig);
      await store.upsertAccount(selected);

      const upstream = await fetch(`${trimTrailingSlash(openaiBaseUrl)}${req.originalUrl}`, {
        method: req.method,
        headers: requestHeadersForPassthrough(req, selected),
        body: requestBodyForPassthrough(req),
      });

      res.status(upstream.status);
      setForwardHeaders(upstream, res);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } else {
        res.end();
      }

      recordTrace({
        at: Date.now(),
        route: traceRoute,
        accountId: selected.id,
        accountEmail: selected.email,
        status: upstream.status,
        stream: Boolean(upstream.body),
        latencyMs: Date.now() - startedAt,
        requestBody,
        upstreamContentType: upstream.headers.get("content-type") ?? undefined,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      rememberError(selected, msg);
      await store.upsertAccount(selected);
      recordTrace({
        at: Date.now(),
        route: traceRoute,
        accountId: selected.id,
        accountEmail: selected.email,
        status: 599,
        stream: false,
        latencyMs: Date.now() - startedAt,
        requestBody,
        error: msg,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: msg });
      } else {
        res.end();
      }
    }
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

  async function listExposedModels() {
    return discoverModels(store, openaiBaseUrl, mistralBaseUrl, zaiBaseUrl);
  }

  router.get(["/models", "/api/v1/models"], async (_req, res) => {
    const models = await listExposedModels();
    res.json({ object: "list", data: models.map(toOpenAiModelShape) });
  });

  router.get(["/models/:id", "/api/v1/models/:id"], async (req, res) => {
    const id = req.params.id;
    const models = await listExposedModels();
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

  router.get("/api/tags", async (_req, res) => {
    const models = await listExposedModels();
    res.json({
      models: models.map((model) => ({
        name: model.id,
        model: model.id,
        modified_at: new Date(0).toISOString(),
        size: 0,
        digest: model.id,
        details: {
          family: model.metadata.provider,
          parameter_size: "unknown",
          quantization_level: "unknown",
        },
      })),
    });
  });

  router.get("/version", (_req, res) => {
    res.json({ version: process.env.APP_VERSION ?? "0.2.0" });
  });

  router.get("/props", (_req, res) => {
    res.json({
      default_model: PROXY_MODELS[0] ?? null,
      models_url: "/v1/models",
    });
  });

  router.get("/v1/props", (_req, res) => {
    res.json({
      default_model: PROXY_MODELS[0] ?? null,
      models_url: "/v1/models",
    });
  });

  router.all("*", (req, res, next) => {
    if (req.baseUrl !== "/v1" && !shouldHandleRootPassthrough(req)) {
      return next();
    }
    res.locals._multivibeTraced = true;
    passthroughToDefaultChatGpt(req, res).catch(next);
  });

  return router;
}
